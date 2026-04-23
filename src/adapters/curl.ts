/**
 * curl-impersonate transport adapter.
 *
 * Uses an externally installed curl-impersonate-compatible binary for
 * bodyless navigation requests with Chrome-like TLS fingerprints. HTTP headers
 * are controlled by GhostBrowse.
 *
 * Binary resolution order:
 *   1. GHOSTBROWSE_CURL_IMPERSONATE=/absolute/path/to/binary
 *   2. PATH candidates such as curl-impersonate-chrome or curl_chrome116
 *
 * Payload requests fall back to NativeAdapter because CLI builds differ in
 * POST body support and flags. This keeps request body semantics correct
 * without forcing native dependencies into the package.
 */

import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import type { Adapter, AdapterResponse } from './types.js';
import { NativeAdapter } from './native.js';
import { DnsController } from '../dns.js';
import type { GhostBrowseDnsOptions } from '../types.js';

const PATH_CANDIDATES = [
  'curl_chrome116',
  'curl_chrome110',
  'curl_chrome101',
  'curl-impersonate',
  'curl-impersonate-chrome',
  'curl-impersonate-chrome.exe',
  'curl_impersonate_chrome',
  'curl_impersonate_chrome.exe',
  'curl-chrome',
];

function probeInPath(name: string): Promise<boolean> {
  return new Promise(resolve => {
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

  const explicitPath = process.env.GHOSTBROWSE_CURL_IMPERSONATE?.trim();
  if (explicitPath && await probeInPath(explicitPath)) {
    _detected = explicitPath;
    return explicitPath;
  }

  for (const name of PATH_CANDIDATES) {
    if (await probeInPath(name)) {
      _detected = name;
      return name;
    }
  }

  _detected = null;
  return null;
}

function parseRaw(buffer: Buffer, finalUrl: string): AdapterResponse {
  let offset = 0;
  let status = 0;
  let headers: Record<string, string> = {};
  let setCookies: string[] = [];

  while (offset < buffer.length) {
    let sepIdx = -1;
    let sepLen = 4;

    for (let i = offset; i <= buffer.length - 4; i++) {
      if (buffer[i] === 0x0d && buffer[i + 1] === 0x0a &&
          buffer[i + 2] === 0x0d && buffer[i + 3] === 0x0a) {
        sepIdx = i;
        break;
      }
    }

    if (sepIdx === -1) {
      sepLen = 2;
      for (let i = offset; i <= buffer.length - 2; i++) {
        if (buffer[i] === 0x0a && buffer[i + 1] === 0x0a) {
          sepIdx = i;
          break;
        }
      }
    }

    if (sepIdx === -1) {
      throw new Error('GhostBrowse/curl: malformed response - no header terminator');
    }

    const headerStr = buffer.subarray(offset, sepIdx).toString('latin1');
    offset = sepIdx + sepLen;

    const lines = headerStr.split(/\r?\n/);
    const match = lines[0].match(/^HTTP\/[\d.]+ (\d+)/i);
    if (!match) {
      throw new Error(`GhostBrowse/curl: unexpected status line: "${lines[0]}"`);
    }

    status = parseInt(match[1], 10);
    headers = {};
    setCookies = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const colon = line.indexOf(':');
      if (colon === -1) continue;

      const key = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (key === 'set-cookie') setCookies.push(value);
      else headers[key] = value;
    }

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

    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export class CurlAdapter implements Adapter {
  private readonly payloadFallback = new NativeAdapter();
  private readonly dns?: DnsController;

  constructor(private readonly binary: string, dns?: GhostBrowseDnsOptions) {
    this.dns = dns ? new DnsController(dns) : undefined;
  }

  async request(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | URLSearchParams | undefined,
    timeoutMs: number,
  ): Promise<AdapterResponse> {
    // CLI builds differ in request-body support. Keep the Chrome TLS path for
    // navigations, but route payload requests through native fetch so POST
    // semantics stay correct without forcing a native dependency.
    if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
      return this.payloadFallback.request(url, method, headers, body, timeoutMs);
    }

    const args: string[] = [
      '--impersonate', 'chrome133',
      '-s',
      '-i',
      '-X', method,
    ];

    for (const [key, value] of Object.entries(headers)) {
      args.push('-H', `${key}: ${value}`);
    }

    if (this.dns) {
      args.push(...await this.dns.curlArgsForUrl(url));
    }

    args.push(url);

    const buffer = await runProcess(this.binary, args, timeoutMs);
    return parseRaw(buffer, url);
  }
}
