import type { Cookie } from '../types.js';

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseSetCookie(header: string, requestUrl: string): Cookie | null {
  const [main, ...attrs] = header.split(';');
  const eq = main.indexOf('=');
  if (eq === -1) return null;

  const name = main.slice(0, eq).trim();
  const value = main.slice(eq + 1).trim();
  if (!name) return null;

  let domain = '';
  let path = '/';
  let secure = false;
  let httpOnly = false;
  let expires: number | null = null;
  let sameSite: Cookie['sameSite'] = 'Lax';

  for (const attr of attrs) {
    const a = attr.trim();
    const lower = a.toLowerCase();

    if (lower === 'secure')   { secure = true; continue; }
    if (lower === 'httponly') { httpOnly = true; continue; }

    const sep = a.indexOf('=');
    if (sep === -1) continue;

    const key = a.slice(0, sep).trim().toLowerCase();
    const val = a.slice(sep + 1).trim();

    switch (key) {
      case 'domain':
        domain = val.startsWith('.') ? val.slice(1) : val;
        break;
      case 'path':
        path = val || '/';
        break;
      case 'expires': {
        const ms = Date.parse(val);
        if (!isNaN(ms)) expires = ms;
        break;
      }
      case 'max-age': {
        const n = parseInt(val, 10);
        if (!isNaN(n)) expires = Date.now() + n * 1000;
        break;
      }
      case 'samesite':
        sameSite = val.toLowerCase() === 'strict' ? 'Strict'
                 : val.toLowerCase() === 'none'   ? 'None'
                 : 'Lax';
        break;
    }
  }

  if (!domain) {
    try { domain = new URL(requestUrl).hostname; } catch { return null; }
  }

  return { name, value, domain, path, secure, httpOnly, expires, sameSite };
}

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

function domainMatches(cookieDomain: string, host: string): boolean {
  return host === cookieDomain || host.endsWith('.' + cookieDomain);
}

function pathMatches(cookiePath: string, urlPath: string): boolean {
  if (cookiePath === '/') return true;
  if (urlPath === cookiePath) return true;
  return urlPath.startsWith(cookiePath + '/');
}

// ---------------------------------------------------------------------------
// CookieJar
// ---------------------------------------------------------------------------

export class CookieJar {
  private store = new Map<string, Cookie>();

  private key(c: Cookie): string {
    return `${c.domain}\0${c.path}\0${c.name}`;
  }

  /** Add or update a cookie; removes it if it's expired. */
  set(cookie: Cookie): void {
    const k = this.key(cookie);
    if (cookie.expires !== null && cookie.expires <= Date.now()) {
      this.store.delete(k);
    } else {
      this.store.set(k, cookie);
    }
  }

  /** Store cookies from an already-split array of Set-Cookie header values. */
  ingestLines(lines: string[], requestUrl: string): void {
    for (const line of lines) {
      const cookie = parseSetCookie(line, requestUrl);
      if (cookie) this.set(cookie);
    }
  }

  /**
   * Extract Set-Cookie headers from a native fetch Response and store them.
   * Uses getSetCookie() (WHATWG spec, Bun + Node ≥18.14) when available.
   */
  ingest(response: Response, requestUrl: string): void {
    const headers = response.headers as Headers & { getSetCookie?(): string[] };
    const lines: string[] = typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : splitSetCookieFallback(headers.get('set-cookie') ?? '');
    this.ingestLines(lines, requestUrl);
  }

  /** Returns the Cookie header value for a given URL. */
  headerFor(urlStr: string): string {
    let url: URL;
    try { url = new URL(urlStr); } catch { return ''; }

    const host = url.hostname;
    const path = url.pathname || '/';
    const isSecure = url.protocol === 'https:';
    const now = Date.now();
    const cookies: Cookie[] = [];

    for (const [k, c] of this.store) {
      if (c.expires !== null && c.expires <= now) { this.store.delete(k); continue; }
      if (c.secure && !isSecure) continue;
      if (!domainMatches(c.domain, host)) continue;
      if (!pathMatches(c.path, path)) continue;
      cookies.push(c);
    }

    // Longest path first (most specific wins per RFC 6265 §5.4)
    cookies.sort((a, b) => b.path.length - a.path.length);
    return cookies.map(c => `${c.name}=${c.value}`).join('; ');
  }

  clear(): void { this.store.clear(); }

  get size(): number { return this.store.size; }

  /** Enumerate all non-expired cookies for inspection. */
  all(): Cookie[] {
    const now = Date.now();
    return [...this.store.values()].filter(c => c.expires === null || c.expires > now);
  }
}

// ---------------------------------------------------------------------------
// Fallback: split combined Set-Cookie header value
// The combined value uses ", " as separator but cookie dates also contain ", "
// so we split only on ", " that look like the start of a new attribute list.
// ---------------------------------------------------------------------------
function splitSetCookieFallback(raw: string): string[] {
  if (!raw) return [];
  // Split on `, ` followed by a token= pattern (new cookie name=value start)
  return raw.split(/,\s*(?=[^;,=\s]+=[^;,]*)/);
}
