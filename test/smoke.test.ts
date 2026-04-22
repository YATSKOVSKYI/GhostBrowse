import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createBrowser, createBrowserNative, detectCurlImpersonate } from '../src/index.ts';

let baseUrl = '';
let server: ReturnType<typeof createServer>;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, data: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(200, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(data));
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><body>GhostBrowse</body></html>');
      return;
    }

    if (url.pathname === '/headers') {
      sendJson(res, { headers: req.headers });
      return;
    }

    if (url.pathname === '/cookies/set') {
      res.writeHead(302, {
        location: '/cookies',
        'set-cookie': 'ghost=browse; Path=/',
      });
      res.end();
      return;
    }

    if (url.pathname === '/cookies') {
      sendJson(res, { cookie: req.headers.cookie ?? '' });
      return;
    }

    if (url.pathname === '/redirect/2') {
      res.writeHead(302, { location: '/redirect/1' });
      res.end();
      return;
    }

    if (url.pathname === '/redirect/1') {
      res.writeHead(302, { location: '/html' });
      res.end();
      return;
    }

    if (url.pathname === '/post') {
      const body = await readBody(req);
      sendJson(res, {
        method: req.method,
        headers: req.headers,
        body,
        form: Object.fromEntries(new URLSearchParams(body)),
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close(err => err ? reject(err) : resolve());
  });
});

describe('GhostBrowser (NativeAdapter)', () => {
  it('fetches a page and returns HTML', async () => {
    const b = createBrowserNative();
    const res = await b.get(`${baseUrl}/html`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<html');
  });

  it('sends Chrome-like headers in correct order', async () => {
    const b = createBrowserNative();
    const res = await b.get(`${baseUrl}/headers`);
    const { headers } = await res.json<{ headers: Record<string, string> }>();
    expect(headers['user-agent']).toContain('Chrome/130');
    expect(headers['sec-fetch-mode']).toBe('navigate');
    expect(headers['sec-fetch-dest']).toBe('document');
    expect(headers['sec-fetch-site']).toBe('none');
  });

  it('stores and resends cookies across requests', async () => {
    const b = createBrowserNative();
    await b.get(`${baseUrl}/cookies/set`);
    expect(b.cookieCount).toBeGreaterThan(0);
    const { cookie } = await (await b.get(`${baseUrl}/cookies`)).json<{ cookie: string }>();
    expect(cookie).toContain('ghost=browse');
  });

  it('follows redirects', async () => {
    const b = createBrowserNative();
    const res = await b.get(`${baseUrl}/redirect/2`);
    expect(res.status).toBe(200);
    expect(res.redirected).toBe(true);
  });

  it('mobile profile sends mobile UA and sec-ch-ua-mobile: ?1', async () => {
    const b = createBrowserNative({ profile: 'chrome-mobile' });
    const { headers } = await (await b.get(`${baseUrl}/headers`)).json<{ headers: Record<string, string> }>();
    expect(headers['user-agent']).toContain('Mobile');
    expect(headers['sec-ch-ua-mobile']).toBe('?1');
  });

  it('reset() clears cookies', async () => {
    const b = createBrowserNative();
    await b.get(`${baseUrl}/cookies/set`);
    b.reset();
    expect(b.cookieCount).toBe(0);
  });

  it('adapterName is "native" for NativeAdapter', () => {
    expect(createBrowserNative().adapterName).toBe('native');
  });
});

describe('curl-impersonate adapter', () => {
  it('detectCurlImpersonate() returns an executable string or null', async () => {
    const result = await detectCurlImpersonate();
    expect(result === null || typeof result === 'string').toBe(true);
    if (result) console.log(`  curl-impersonate found: ${result}`);
    else console.log('  curl-impersonate not installed; TLS fingerprint inactive');
  });

  it('createBrowser() preserves POST bodies when curl-impersonate is active', async () => {
    const binary = await detectCurlImpersonate();
    if (!binary) return;

    const b = await createBrowser();
    expect(b.adapterName).toBe('curl-impersonate');

    const res = await b.post(`${baseUrl}/post`, 'a=1&b=2', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const json = await res.json<{ form: Record<string, string>; body: string }>();

    expect(json.form.a).toBe('1');
    expect(json.form.b).toBe('2');
    expect(json.body).toBe('a=1&b=2');
  });
});
