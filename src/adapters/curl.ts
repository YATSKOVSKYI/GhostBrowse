/**
 * curl-impersonate-win transport adapter.
 *
 * Uses the curl-impersonate-win binary (bogdanfinn/tls-client under the hood)
 * for bodyless navigation requests with Chrome's exact TLS fingerprint
 * (JA3 / JA4 / HTTP/2 SETTINGS). HTTP headers are controlled entirely by us.
 *
 * Payload requests currently fall back to NativeAdapter because the bundled
 * curl-impersonate-win binary does not support request bodies.
 *
 * Binary resolution order:
 *   1. <project-root>/bin/curl-impersonate-chrome.exe  (bundled)
 *   2. PATH: curl-impersonate-chrome, curl_impersonate_chrome, curl-chrome
 *
 * Redirect behaviour: the binary follows redirects internally (all hops use
 * Chrome TLS). Intermediate Set-Cookie headers are not exposed, so cookie
 * ingestion only happens from the final response. For sites that rely on TLS
 * fingerprinting this is the right trade-off.
 */

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import type { Adapter, AdapterResponse } from './types.js';
import { NativeAdapter } from './native.js';

// ---------------------------------------------------------------------------
// Binary detection
// ---------------------------------------------------------------------------

const PATH_CANDIDATES = [
  'curl-impersonate-chrome',
  'curl_impersonate_chrome',
  'curl-chrome',
];

/** Resolve <repo-root>/bin/ regardless of whether we run from src/ or dist/. */
function localBinaryPath(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  // src/adapters/curl.ts  → ../../bin
  // dist/adapters/curl.js → ../../bin
  const candidates = [
    resolve(dir, '..', 'bin', 'curl-impersonate-chrome.exe'),
    resolve(dir, '..', '..', 'bin', 'curl-impersonate-chrome.exe'),
  ];
  return candidates.find(existsSync) ?? candidates[0];
}

function probeInPath(name: string): Promise<boolean> {
  return new Promise(resolve => {
    // 'close' fires for any exit code (binary exists and ran).
    // 'error' fires only for ENOENT / permission denied (binary not found).
    const p = spawn(name, ['--version'], { stdio: 'ignore', windowsHide: true });
    p.on('close', () => resolve(true));
    p.on('error', () => resolve(false));
  });
}

let _detected: string | null | undefined;

/**
 * Returns the binary path/name to use, or null if not available.
 * Result is cached after the first call.
 */
export async function detectCurlImpersonate(): Promise<string | null> {
  if (_detected !== undefined) return _detected;

  // 1. Prefer the bundled binary when it is executable on this platform.
  const local = localBinaryPath();
  if (existsSync(local) && await probeInPath(local)) { _detected = local; return local; }

  // 2. Fall back to PATH
  for (const name of PATH_CANDIDATES) {
    if (await probeInPath(name)) { _detected = name; return name; }
  }

  _detected = null;
  return null;
}

// ---------------------------------------------------------------------------
// Response parsing  (curl -i output: headers \r\n\r\n body)
// ---------------------------------------------------------------------------

function parseRaw(buffer: Buffer, finalUrl: string): AdapterResponse {
  let offset = 0;
  let status = 0;
  let headers: Record<string, string> = {};
  let setCookies: string[] = [];

  while (offset < buffer.length) {
    // Find \r\n\r\n (preferred) or \n\n separator
    let sepIdx = -1;
    let sepLen = 4;

    for (let i = offset; i <= buffer.length - 4; i++) {
      if (buffer[i] === 0x0d && buffer[i+1] === 0x0a &&
          buffer[i+2] === 0x0d && buffer[i+3] === 0x0a) {
        sepIdx = i; break;
      }
    }
    if (sepIdx === -1) {
      sepLen = 2;
      for (let i = offset; i <= buffer.length - 2; i++) {
        if (buffer[i] === 0x0a && buffer[i+1] === 0x0a) { sepIdx = i; break; }
      }
    }
    if (sepIdx === -1) throw new Error('GhostBrowse/curl: malformed response — no header terminator');

    const headerStr = buffer.subarray(offset, sepIdx).toString('latin1');
    offset = sepIdx + sepLen;

    const lines = headerStr.split(/\r?\n/);
    const m = lines[0].match(/^HTTP\/[\d.]+ (\d+)/i);
    if (!m) throw new Error(`GhostBrowse/curl: unexpected status line: "${lines[0]}"`);

    status = parseInt(m[1], 10);
    headers = {};
    setCookies = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      const key = line.slice(0, colon).trim().toLowerCase();
      const val = line.slice(colon + 1).trim();
      if (key === 'set-cookie') setCookies.push(val);
      else headers[key] = val;
    }

    // Skip 1xx interim responses
    if (status >= 100 && status < 200) continue;
    break;
  }

  const body = buffer.subarray(offset);
  return {
    status,
    url: finalUrl,
    headers,
    setCookies,
    bytes: async () => new Uint8Array(body),
  };
}

// ---------------------------------------------------------------------------
// Subprocess runner
// ---------------------------------------------------------------------------

function runProcess(binary: string, args: string[], timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });

    const chunks: Buffer[] = [];
    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('GhostBrowse/curl: request timed out'));
    }, timeoutMs);

    proc.on('close', () => {
      clearTimeout(timer);
      const out = Buffer.concat(chunks);
      if (out.length > 0) resolve(out);
      else reject(new Error('GhostBrowse/curl: binary produced no output'));
    });

    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

// ---------------------------------------------------------------------------
// CurlAdapter
// ---------------------------------------------------------------------------

export class CurlAdapter implements Adapter {
  private readonly payloadFallback = new NativeAdapter();

  constructor(private readonly binary: string) {}

  async request(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | URLSearchParams | undefined,
    timeoutMs: number,
  ): Promise<AdapterResponse> {
    // The bundled curl-impersonate-win binary is intentionally tiny and only
    // supports method/headers/url. It ignores curl-style --data flags, which
    // would silently turn POST bodies into Content-Length: 0. Keep the Chrome
    // TLS handshake path for navigations, but route payload requests through
    // the native adapter so body semantics stay correct without new deps.
    if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
      return this.payloadFallback.request(url, method, headers, body, timeoutMs);
    }

    const args: string[] = [
      '--impersonate', 'chrome133',   // Chrome 133 TLS fingerprint
      '-s',                           // silent
      '-i',                           // include response headers in stdout
      '-X', method,
    ];

    // Our Chrome-profile headers — these override the binary's defaults
    for (const [k, v] of Object.entries(headers)) {
      args.push('-H', `${k}: ${v}`);
    }

    args.push(url);

    const buf = await runProcess(this.binary, args, timeoutMs);
    return parseRaw(buf, url);
  }
}
