import type { GhostOptions, GhostResponse, RequestOptions } from './types.js';
import { selectNavHeaders } from './profiles/chrome.js';
import { CookieJar } from './session/cookie-jar.js';
import type { Adapter, AdapterResponse } from './adapters/types.js';
import { NativeAdapter } from './adapters/native.js';

// ---------------------------------------------------------------------------
// Response wrapper
// ---------------------------------------------------------------------------

function wrapResponse(raw: AdapterResponse, redirected: boolean): GhostResponse {
  // Decode bytes lazily but cache the result.
  let textCache: string | undefined;
  const getText = async (): Promise<string> => {
    if (textCache === undefined) textCache = new TextDecoder().decode(await raw.bytes());
    return textCache;
  };

  return {
    url: raw.url,
    status: raw.status,
    ok: raw.status >= 200 && raw.status < 300,
    redirected,
    headers: raw.headers,
    text: getText,
    json: async <T>() => JSON.parse(await getText()) as T,
    arrayBuffer: async () => {
      const b = await raw.bytes();
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    },
    blob: async () => { const b = await raw.bytes(); return new Blob([b.buffer as ArrayBuffer]); },
  };
}

// ---------------------------------------------------------------------------
// GhostBrowser
// ---------------------------------------------------------------------------

export class GhostBrowser {
  private readonly opts: {
    timeout: number;
    followRedirects: boolean;
    maxRedirects: number;
    cookies: boolean;
    proxy?: string;
    headers?: Record<string, string>;
    profile: 'chrome' | 'chrome-mobile';
  };
  private readonly jar: CookieJar;
  private readonly adapter: Adapter;
  /** URL of the most recent completed navigation — drives Sec-Fetch-Site. */
  private referer: string | null = null;

  constructor(options: GhostOptions = {}, adapter?: Adapter) {
    this.opts = {
      timeout:         options.timeout         ?? 30_000,
      followRedirects: options.followRedirects  ?? true,
      maxRedirects:    options.maxRedirects     ?? 10,
      cookies:         options.cookies          ?? true,
      proxy:           options.proxy,
      headers:         options.headers,
      profile:         options.profile          ?? 'chrome',
    };
    this.jar    = new CookieJar();
    this.adapter = adapter ?? new NativeAdapter();
  }

  // -------------------------------------------------------------------------
  // Core
  // -------------------------------------------------------------------------

  async fetch(url: string, options: RequestOptions = {}): Promise<GhostResponse> {
    const mobile  = this.opts.profile === 'chrome-mobile';
    const timeout = options.timeout ?? this.opts.timeout;

    let currentUrl = url;
    let prevUrl    = this.referer;
    let method     = (options.method ?? 'GET').toUpperCase();
    let body       = options.body as string | URLSearchParams | undefined;
    let redirects  = 0;
    let didRedirect = false;

    while (true) {
      // Build Chrome-fingerprint headers for this hop
      const baseHeaders = selectNavHeaders(prevUrl, currentUrl, mobile);
      const headers     = mergeHeaders(baseHeaders, this.opts.headers, options.headers);

      if (this.opts.cookies) {
        const cookieStr = this.jar.headerFor(currentUrl);
        if (cookieStr) headers['cookie'] = cookieStr;
      }

      const raw = await this.adapter.request(currentUrl, method, headers, body, timeout);

      // Ingest cookies from this hop
      if (this.opts.cookies) {
        this.jar.ingestLines(raw.setCookies, currentUrl);
      }

      const isRedirect = raw.status >= 300 && raw.status < 400;

      if (!isRedirect || !this.opts.followRedirects) {
        this.referer = currentUrl;
        return wrapResponse(raw, didRedirect);
      }

      const location = raw.headers['location'];
      if (!location || redirects >= this.opts.maxRedirects) {
        this.referer = currentUrl;
        return wrapResponse(raw, didRedirect);
      }

      prevUrl    = currentUrl;
      currentUrl = new URL(location, currentUrl).href;
      redirects++;
      didRedirect = true;

      // POST → GET on 301 / 302 / 303  (browser behaviour)
      if ((raw.status === 301 || raw.status === 302 || raw.status === 303) && method === 'POST') {
        method = 'GET';
        body   = undefined;
      }
    }
  }

  async get(url: string, options: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<GhostResponse> {
    return this.fetch(url, { ...options, method: 'GET' });
  }

  async post(
    url: string,
    body: string | URLSearchParams | undefined,
    options: Omit<RequestOptions, 'method' | 'body'> = {},
  ): Promise<GhostResponse> {
    const opts: RequestOptions = { ...options, method: 'POST' };
    if (body !== undefined) opts.body = body;
    return this.fetch(url, opts);
  }

  // -------------------------------------------------------------------------
  // Session helpers
  // -------------------------------------------------------------------------

  clearCookies(): void { this.jar.clear(); }

  reset(): void {
    this.jar.clear();
    this.referer = null;
  }

  get cookieCount(): number { return this.jar.size; }
  get cookies() { return this.jar.all(); }

  /** Which adapter is active: 'curl-impersonate' or 'native'. */
  get adapterName(): string {
    return this.adapter.constructor.name === 'CurlAdapter' ? 'curl-impersonate' : 'native';
  }
}

// ---------------------------------------------------------------------------
// Header assembly — preserves Chrome's insertion order
// ---------------------------------------------------------------------------

function mergeHeaders(
  base: ReadonlyArray<[string, string]>,
  global?: Record<string, string>,
  perRequest?: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of base)        out[k] = v;
  if (global)     for (const [k, v] of Object.entries(global))     out[k.toLowerCase()] = v;
  if (perRequest) for (const [k, v] of Object.entries(perRequest)) out[k.toLowerCase()] = v;
  return out;
}
