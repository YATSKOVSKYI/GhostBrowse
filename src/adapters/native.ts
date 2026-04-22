import type { Adapter, AdapterResponse } from './types.js';

function flattenHeaders(response: Response): Record<string, string> {
  const out: Record<string, string> = {};
  response.headers.forEach((v, k) => {
    if (k.toLowerCase() !== 'set-cookie') out[k.toLowerCase()] = v;
  });
  return out;
}

function extractSetCookies(response: Response): string[] {
  const h = response.headers as Headers & { getSetCookie?(): string[] };
  if (typeof h.getSetCookie === 'function') return h.getSetCookie();
  // Fallback: parse combined value (imperfect but handles simple cases)
  const combined = response.headers.get('set-cookie');
  if (!combined) return [];
  return combined.split(/,\s*(?=[^;,=\s]+=[^;,]*)/);
}

/**
 * Transport adapter backed by the runtime's native fetch (Bun / Node 18+).
 * TLS fingerprint is whatever the runtime uses — close to Chrome on Bun
 * (BoringSSL) but not identical.
 */
export class NativeAdapter implements Adapter {
  async request(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | URLSearchParams | undefined,
    timeoutMs: number,
  ): Promise<AdapterResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('GhostBrowse: timeout')), timeoutMs);

    try {
      const response = await globalThis.fetch(url, {
        method,
        headers,
        body: (method === 'GET' || method === 'HEAD' ? undefined : body) as BodyInit | null,
        signal: controller.signal,
        redirect: 'manual',
        // Bun-specific: ensure decompression even with manual Accept-Encoding
        // @ts-ignore
        decompress: true,
      });

      // Consume body eagerly — Response body can only be read once.
      const buf = new Uint8Array(await response.arrayBuffer());
      const setCookies = extractSetCookies(response);
      const respHeaders = flattenHeaders(response);

      return {
        status: response.status,
        url: response.url || url,
        headers: respHeaders,
        setCookies,
        bytes: async () => buf,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
