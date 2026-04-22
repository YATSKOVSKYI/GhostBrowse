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
