/** Raw result of a single HTTP request (no redirect handling). */
export interface AdapterResponse {
  readonly status: number;
  /** Final URL (may differ from requested URL if the adapter internally resolved it). */
  readonly url: string;
  /** Lowercased response headers. Set-Cookie is NOT in here — use setCookies. */
  readonly headers: Record<string, string>;
  /** Every Set-Cookie header value as a separate string (RFC 6265 §5.2). */
  readonly setCookies: string[];
  /** Returns the raw body bytes. Result is cached — safe to call multiple times. */
  bytes(): Promise<Uint8Array>;
}

/** Minimal transport abstraction — a single request, no cookie/redirect logic. */
export interface Adapter {
  request(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | URLSearchParams | undefined,
    timeoutMs: number,
  ): Promise<AdapterResponse>;
}
