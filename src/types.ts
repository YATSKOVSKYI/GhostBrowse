export type DnsStrategy = 'first' | 'rotate' | 'random';

export interface GhostBrowseDnsOptions {
  /** DNS resolver IPs. Optional ports are supported, e.g. "1.1.1.1" or "1.1.1.1:53". */
  servers: string[];
  /** DNS server ordering strategy. Default: 'first' */
  strategy?: DnsStrategy;
  /** DNS result cache TTL in milliseconds. Default: 60000 */
  ttlMs?: number;
  /** Resolve AAAA records in addition to A records. Default: false */
  ipv6?: boolean;
  /** Curl DNS transport mode. Default: 'auto' */
  mode?: 'auto' | 'curl-dns-servers' | 'resolve';
  /** Fall back to system DNS if custom DNS fails. Default: true */
  fallbackToSystem?: boolean;
}

export interface GhostOptions {
  /** Request timeout ms. Default: 30000 */
  timeout?: number;
  /** Follow HTTP redirects. Default: true */
  followRedirects?: boolean;
  /** Max redirects before stopping. Default: 10 */
  maxRedirects?: number;
  /** Persist cookies across requests. Default: true */
  cookies?: boolean;
  /** HTTP proxy URL (e.g. "http://user:pass@host:port") */
  proxy?: string;
  /** Extra headers merged into every request */
  headers?: Record<string, string>;
  /** Browser fingerprint profile. Default: 'chrome' */
  profile?: 'chrome' | 'chrome-mobile';
  /** Custom DNS for curl-based requests. Native fetch cannot guarantee per-request DNS. */
  dns?: GhostBrowseDnsOptions;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD' | 'PATCH';
  headers?: Record<string, string>;
  body?: string | URLSearchParams | FormData | ArrayBuffer;
  timeout?: number;
}

export interface GhostResponse {
  readonly url: string;
  readonly status: number;
  readonly ok: boolean;
  readonly redirected: boolean;
  readonly headers: Record<string, string>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  arrayBuffer(): Promise<ArrayBuffer>;
  blob(): Promise<Blob>;
}

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** Unix timestamp ms. null = session cookie */
  expires: number | null;
  sameSite: 'Strict' | 'Lax' | 'None' | '';
}
