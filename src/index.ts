export { GhostBrowser } from './browser.js';
export { NativeAdapter } from './adapters/native.js';
export { CurlAdapter, detectCurlImpersonate } from './adapters/curl.js';
export type { Adapter, AdapterResponse } from './adapters/types.js';
export type {
  Cookie,
  DnsStrategy,
  GhostBrowseDnsOptions,
  GhostOptions,
  GhostResponse,
  RequestOptions,
} from './types.js';

import { GhostBrowser } from './browser.js';
import { NativeAdapter } from './adapters/native.js';
import { CurlAdapter, detectCurlImpersonate } from './adapters/curl.js';
import type { GhostOptions, GhostResponse } from './types.js';

const INSTALL_HINT =
  'Install curl-impersonate separately and add it to PATH, or set:\n' +
  '  GHOSTBROWSE_CURL_IMPERSONATE=/absolute/path/to/curl-impersonate-binary\n\n' +
  'Install references:\n' +
  '  Linux/macOS: https://github.com/lwthiker/curl-impersonate\n' +
  '  Windows    : https://github.com/depler/curl-impersonate-win';

/**
 * Primary factory. Uses curl-impersonate for Chrome-identical TLS fingerprint.
 * Throws if the binary is not found in PATH.
 */
export async function createBrowser(options?: GhostOptions): Promise<GhostBrowser> {
  const binary = await detectCurlImpersonate();
  if (!binary) throw new Error(`[GhostBrowse] curl-impersonate not found in PATH.\n${INSTALL_HINT}`);
  return new GhostBrowser(options, new CurlAdapter(binary, options?.dns));
}

/**
 * Native-fetch fallback — no TLS fingerprint spoofing.
 * Use only for testing / environments where curl-impersonate can't be installed.
 */
export function createBrowserNative(options?: GhostOptions): GhostBrowser {
  return new GhostBrowser(options, new NativeAdapter(options?.dns));
}

/**
 * One-shot GET via curl-impersonate.
 * For multi-request sessions use createBrowser() to reuse cookies/state.
 */
export async function ghostFetch(url: string, options?: GhostOptions): Promise<GhostResponse> {
  return (await createBrowser(options)).get(url);
}
