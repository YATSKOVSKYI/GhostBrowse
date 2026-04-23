import { describe, expect, it } from 'bun:test';
import { createBrowser, createBrowserNative, detectCurlImpersonate } from '../src/index.ts';
import { DnsController, normalizeDnsOptions, shouldSkipCustomDns } from '../src/dns.ts';

describe('custom DNS options', () => {
  it('normalization accepts valid DNS options', () => {
    const dns = normalizeDnsOptions({
      servers: [' 1.1.1.1 ', '8.8.8.8:53', '2606:4700:4700::1111', '[2001:4860:4860::8888]:53'],
      strategy: 'rotate',
      ttlMs: 10_000,
      ipv6: true,
      mode: 'resolve',
      fallbackToSystem: false,
    });

    expect(dns).toEqual({
      servers: ['1.1.1.1', '8.8.8.8:53', '2606:4700:4700::1111', '[2001:4860:4860::8888]:53'],
      strategy: 'rotate',
      ttlMs: 10_000,
      ipv6: true,
      mode: 'resolve',
      fallbackToSystem: false,
    });
  });

  it('rejects invalid DNS options', () => {
    expect(() => normalizeDnsOptions({ servers: [] })).toThrow('dns.servers');
    expect(() => normalizeDnsOptions({ servers: ['dns.google'] })).toThrow('invalid DNS server');
    expect(() => normalizeDnsOptions({ servers: ['1.1.1.1'], strategy: 'bad' as never })).toThrow('dns.strategy');
    expect(() => normalizeDnsOptions({ servers: ['1.1.1.1'], mode: 'bad' as never })).toThrow('dns.mode');
    expect(() => normalizeDnsOptions({ servers: ['1.1.1.1'], ttlMs: -1 })).toThrow('dns.ttlMs');
  });

  it('manual resolve generates correct curl --resolve host:port:ip args', async () => {
    const dns = new DnsController({
      servers: ['1.1.1.1'],
      mode: 'resolve',
      fallbackToSystem: false,
    }, {
      lookup: async () => ['203.0.113.10'],
    });

    expect(await dns.curlArgsForUrl('https://example.com/path')).toEqual([
      '--resolve',
      'example.com:443:203.0.113.10',
    ]);
  });

  it('http defaults to port 80, https defaults to port 443, and explicit port is respected', async () => {
    const dns = new DnsController({ servers: ['1.1.1.1'], mode: 'resolve' }, {
      lookup: async () => ['203.0.113.10'],
    });

    expect(await dns.curlArgsForUrl('http://example.com/')).toEqual([
      '--resolve',
      'example.com:80:203.0.113.10',
    ]);
    expect(await dns.curlArgsForUrl('https://example.com/')).toEqual([
      '--resolve',
      'example.com:443:203.0.113.10',
    ]);
    expect(await dns.curlArgsForUrl('https://example.com:8443/')).toEqual([
      '--resolve',
      'example.com:8443:203.0.113.10',
    ]);
  });

  it('localhost, IP, data, file, and blob URLs skip DNS', async () => {
    let lookups = 0;
    const dns = new DnsController({ servers: ['1.1.1.1'], mode: 'resolve' }, {
      lookup: async () => {
        lookups++;
        return ['203.0.113.10'];
      },
    });

    expect(shouldSkipCustomDns('http://localhost/')).toBe(true);
    expect(await dns.curlArgsForUrl('http://localhost/')).toEqual([]);
    expect(await dns.curlArgsForUrl('https://127.0.0.1/')).toEqual([]);
    expect(await dns.curlArgsForUrl('https://[::1]/')).toEqual([]);
    expect(await dns.curlArgsForUrl('data:text/plain,ghost')).toEqual([]);
    expect(await dns.curlArgsForUrl('file:///tmp/a.html')).toEqual([]);
    expect(await dns.curlArgsForUrl('blob:https://example.com/id')).toEqual([]);
    expect(lookups).toBe(0);
  });

  it('first, rotate, and random strategies choose deterministic server orders', async () => {
    const seenFirst: string[][] = [];
    const first = new DnsController({ servers: ['1.1.1.1', '8.8.8.8'], strategy: 'first', ttlMs: 0 }, {
      lookup: async (_host, servers) => {
        seenFirst.push(servers);
        return ['203.0.113.10'];
      },
    });
    await first.curlArgsForUrl('https://a.example/');
    await first.curlArgsForUrl('https://b.example/');
    expect(seenFirst).toEqual([
      ['1.1.1.1', '8.8.8.8'],
      ['1.1.1.1', '8.8.8.8'],
    ]);

    const seenRotate: string[][] = [];
    const rotate = new DnsController({ servers: ['1.1.1.1', '8.8.8.8'], strategy: 'rotate', ttlMs: 0 }, {
      lookup: async (_host, servers) => {
        seenRotate.push(servers);
        return ['203.0.113.10'];
      },
    });
    await rotate.curlArgsForUrl('https://a.example/');
    await rotate.curlArgsForUrl('https://b.example/');
    expect(seenRotate).toEqual([
      ['1.1.1.1', '8.8.8.8'],
      ['8.8.8.8', '1.1.1.1'],
    ]);

    const seenRandom: string[][] = [];
    const random = new DnsController({ servers: ['1.1.1.1', '8.8.8.8'], strategy: 'random', ttlMs: 0 }, {
      random: () => 0,
      lookup: async (_host, servers) => {
        seenRandom.push(servers);
        return ['203.0.113.10'];
      },
    });
    await random.curlArgsForUrl('https://a.example/');
    expect(seenRandom).toEqual([['8.8.8.8', '1.1.1.1']]);
  });

  it('DNS cache respects TTL', async () => {
    let now = 1_000;
    let lookups = 0;
    const dns = new DnsController({ servers: ['1.1.1.1'], ttlMs: 100 }, {
      now: () => now,
      lookup: async () => {
        lookups++;
        return [`203.0.113.${lookups}`];
      },
    });

    expect(await dns.curlArgsForUrl('https://example.com/')).toEqual([
      '--resolve',
      'example.com:443:203.0.113.1',
    ]);
    expect(await dns.curlArgsForUrl('https://example.com/next')).toEqual([
      '--resolve',
      'example.com:443:203.0.113.1',
    ]);
    now += 101;
    expect(await dns.curlArgsForUrl('https://example.com/')).toEqual([
      '--resolve',
      'example.com:443:203.0.113.2',
    ]);
    expect(lookups).toBe(2);
  });

  it('DNS cache has a max size and does not grow forever', async () => {
    const dns = new DnsController({ servers: ['1.1.1.1'], ttlMs: 60_000 }, {
      maxCacheEntries: 2,
      lookup: async () => ['203.0.113.10'],
    });

    await dns.curlArgsForUrl('https://a.example/');
    await dns.curlArgsForUrl('https://b.example/');
    await dns.curlArgsForUrl('https://c.example/');

    expect(dns.cacheSize).toBe(2);
  });

  it('curl-dns-servers mode emits curl --dns-servers args', async () => {
    const dns = new DnsController({
      servers: ['1.1.1.1', '8.8.8.8'],
      mode: 'curl-dns-servers',
    });

    expect(await dns.curlArgsForUrl('https://example.com/')).toEqual([
      '--dns-servers',
      '1.1.1.1,8.8.8.8',
    ]);
  });

  it('native adapter warns and ignores custom DNS', () => {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };

    try {
      const browser = createBrowserNative({ dns: { servers: ['1.1.1.1'] } });
      expect(browser.adapterName).toBe('native');
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings.join('\n')).toContain('custom DNS is supported only by the curl adapter');
  });

  it('optional integration can request through custom DNS when curl is available', async () => {
    if (process.env.GHOST_BROWSE_DNS_INTEGRATION !== '1') return;

    const binary = await detectCurlImpersonate();
    if (!binary) return;

    const browser = await createBrowser({
      dns: {
        servers: ['1.1.1.1', '8.8.8.8'],
        strategy: 'first',
        fallbackToSystem: false,
      },
    });
    const response = await browser.get('https://example.com/');

    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(500);
  });
});
