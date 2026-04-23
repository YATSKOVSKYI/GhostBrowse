import { Resolver, lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { DnsStrategy, GhostBrowseDnsOptions } from './types.js';

export type DnsMode = 'auto' | 'curl-dns-servers' | 'resolve';

export interface NormalizedDnsOptions {
  servers: string[];
  strategy: DnsStrategy;
  ttlMs: number;
  ipv6: boolean;
  mode: DnsMode;
  fallbackToSystem: boolean;
}

export type DnsLookup = (
  hostname: string,
  servers: string[],
  ipv6: boolean,
) => Promise<string[]>;

interface DnsCacheEntry {
  ips: string[];
  expiresAt: number;
}

interface DnsControllerHooks {
  lookup?: DnsLookup;
  now?: () => number;
  random?: () => number;
  maxCacheEntries?: number;
}

const DEFAULT_DNS_TTL_MS = 60_000;
const DEFAULT_DNS_CACHE_MAX = 512;

export function normalizeDnsOptions(dns: GhostBrowseDnsOptions | undefined): NormalizedDnsOptions | undefined {
  if (dns === undefined) return undefined;
  if (!Array.isArray(dns.servers) || dns.servers.length === 0) {
    throw new Error('[GhostBrowse] dns.servers must be a non-empty string array');
  }

  const servers = dns.servers.map(server => normalizeDnsServer(server));
  const strategy = dns.strategy ?? 'first';
  if (strategy !== 'first' && strategy !== 'rotate' && strategy !== 'random') {
    throw new Error('[GhostBrowse] dns.strategy must be "first", "rotate", or "random"');
  }

  const mode = dns.mode ?? 'auto';
  if (mode !== 'auto' && mode !== 'curl-dns-servers' && mode !== 'resolve') {
    throw new Error('[GhostBrowse] dns.mode must be "auto", "curl-dns-servers", or "resolve"');
  }

  const ttlMs = dns.ttlMs ?? DEFAULT_DNS_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new Error('[GhostBrowse] dns.ttlMs must be a finite number >= 0');
  }

  return {
    servers,
    strategy,
    ttlMs,
    ipv6: dns.ipv6 ?? false,
    mode,
    fallbackToSystem: dns.fallbackToSystem ?? true,
  };
}

export function shouldSkipCustomDns(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return true;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;

  const hostname = normalizeUrlHostname(parsed.hostname).toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  return isIP(hostname) !== 0;
}

export function defaultPortForUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  if (parsed.port) return parsed.port;
  return parsed.protocol === 'https:' ? '443' : '80';
}

export class DnsController {
  private readonly options: NormalizedDnsOptions;
  private readonly lookupHost: DnsLookup;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly maxCacheEntries: number;
  private readonly cache = new Map<string, DnsCacheEntry>();
  private rotateOffset = 0;

  constructor(dns: GhostBrowseDnsOptions, hooks: DnsControllerHooks = {}) {
    const normalized = normalizeDnsOptions(dns);
    if (!normalized) throw new Error('[GhostBrowse] dns options are required');
    this.options = normalized;
    this.lookupHost = hooks.lookup ?? resolveWithDnsServers;
    this.now = hooks.now ?? (() => Date.now());
    this.random = hooks.random ?? Math.random;
    this.maxCacheEntries = hooks.maxCacheEntries ?? DEFAULT_DNS_CACHE_MAX;
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  async curlArgsForUrl(rawUrl: string): Promise<string[]> {
    if (shouldSkipCustomDns(rawUrl)) return [];

    const parsed = new URL(rawUrl);
    const hostname = normalizeUrlHostname(parsed.hostname);
    const port = defaultPortForUrl(rawUrl);

    if (this.options.mode === 'curl-dns-servers') {
      return ['--dns-servers', this.options.servers.join(',')];
    }

    // Auto prefers manual --resolve because it works across curl builds without
    // depending on c-ares / --dns-servers support.
    const ip = await this.resolve(hostname, port);
    return ['--resolve', `${hostname}:${port}:${formatCurlResolveIp(ip)}`];
  }

  private async resolve(hostname: string, port: string): Promise<string> {
    const key = `${hostname.toLowerCase()}:${port}`;
    const now = this.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) return cached.ips[0];
    if (cached) this.cache.delete(key);

    const servers = this.nextServerOrder();
    let ips: string[];

    try {
      ips = await this.lookupHost(hostname, servers, this.options.ipv6);
    } catch (customError) {
      if (!this.options.fallbackToSystem) {
        throw new Error(
          `[GhostBrowse] custom DNS failed for ${hostname}: ${errorMessage(customError)}`,
        );
      }
      ips = await resolveWithSystemDns(hostname, this.options.ipv6);
    }

    if (ips.length === 0) {
      throw new Error(`[GhostBrowse] DNS returned no records for ${hostname}`);
    }

    this.setCache(key, ips);
    return ips[0];
  }

  private nextServerOrder(): string[] {
    const servers = this.options.servers;

    if (this.options.strategy === 'first' || servers.length <= 1) return [...servers];

    if (this.options.strategy === 'rotate') {
      const offset = this.rotateOffset % servers.length;
      this.rotateOffset++;
      return [...servers.slice(offset), ...servers.slice(0, offset)];
    }

    const out = [...servers];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  private setCache(key: string, ips: string[]): void {
    const now = this.now();
    const expiresAt = now + this.options.ttlMs;
    this.cache.set(key, { ips, expiresAt });
    this.pruneCache(now);
  }

  private pruneCache(now: number): void {
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(key);
    }

    while (this.cache.size > this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}

async function resolveWithDnsServers(hostname: string, servers: string[], ipv6: boolean): Promise<string[]> {
  const resolver = new Resolver();
  resolver.setServers(servers);

  const v4 = await resolver.resolve4(hostname).catch(() => []);
  if (!ipv6) {
    if (v4.length === 0) throw new Error(`no A records for ${hostname}`);
    return v4;
  }

  const v6 = await resolver.resolve6(hostname).catch(() => []);
  const ips = [...v4, ...v6];
  if (ips.length === 0) throw new Error(`no A/AAAA records for ${hostname}`);
  return ips;
}

async function resolveWithSystemDns(hostname: string, ipv6: boolean): Promise<string[]> {
  const records = await lookup(hostname, {
    all: true,
    family: ipv6 ? 0 : 4,
  });
  return records.map(record => record.address);
}

function normalizeDnsServer(server: string): string {
  if (typeof server !== 'string') {
    throw new Error('[GhostBrowse] dns.servers entries must be strings');
  }

  const trimmed = server.trim();
  if (!trimmed) throw new Error('[GhostBrowse] dns.servers entries must not be empty');

  const bracketPort = trimmed.match(/^\[([^\]]+)\]:(\d+)$/);
  if (bracketPort) {
    assertIp(bracketPort[1], trimmed);
    assertPort(bracketPort[2], trimmed);
    return trimmed;
  }

  if (isIP(trimmed) !== 0) return trimmed;

  const ipv4Port = trimmed.match(/^([^:]+):(\d+)$/);
  if (ipv4Port) {
    assertIp(ipv4Port[1], trimmed);
    assertPort(ipv4Port[2], trimmed);
    return trimmed;
  }

  throw new Error(`[GhostBrowse] invalid DNS server "${server}". Use an IPv4/IPv6 address, optionally with a port.`);
}

function normalizeUrlHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function assertIp(value: string, original: string): void {
  if (isIP(value) === 0) {
    throw new Error(`[GhostBrowse] invalid DNS server "${original}". Use an IPv4/IPv6 address.`);
  }
}

function assertPort(value: string, original: string): void {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`[GhostBrowse] invalid DNS server port in "${original}"`);
  }
}

function formatCurlResolveIp(ip: string): string {
  return isIP(ip) === 6 ? `[${ip}]` : ip;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
