<p align="center">
  <img src="https://raw.githubusercontent.com/YATSKOVSKYI/GhostBrowse/main/docs/assets/ghostbrowse-hero.png" alt="GhostBrowse browserless parsing library banner" width="100%" />
</p>

# GhostBrowse

Lightweight browser-impersonating HTTP client for Bun and Node.js.

GhostBrowse is built for scraping pages that expose useful HTML, SSR JSON, or
internal JSON APIs without launching a full browser. It sends Chrome-like
navigation headers, keeps cookies between requests, follows redirects, and can
use an externally installed `curl-impersonate` binary for Chrome-like TLS
handshakes on bodyless navigation requests.

It is not a JavaScript-rendering browser. If a site requires DOM execution,
canvas/WebGL fingerprinting, clicks, or scroll events, use Playwright.

## Install

```sh
bun add ghost-browse
```

or:

```sh
npm install ghost-browse
```

GhostBrowse does not bundle browser binaries or `curl-impersonate`. The core
package stays lightweight and dependency-free; TLS impersonation is enabled when
an external `curl-impersonate` binary is available.

Optional TLS impersonation install:

```sh
# Linux / macOS
# Install curl-impersonate using your system package manager, Docker image,
# or the official project build instructions:
# https://github.com/lwthiker/curl-impersonate

# Windows
# Install a Windows curl-impersonate build and add it to PATH:
# https://github.com/depler/curl-impersonate-win
```

If the binary is not on `PATH`, point GhostBrowse at it explicitly:

```sh
GHOSTBROWSE_CURL_IMPERSONATE=/absolute/path/to/curl_chrome116
```

PowerShell:

```powershell
$env:GHOSTBROWSE_CURL_IMPERSONATE = 'C:\tools\curl-impersonate\curl-impersonate-chrome.exe'
```

## Usage

```ts
import { createBrowser } from 'ghost-browse';

const browser = await createBrowser();
const response = await browser.get('https://example.com');

console.log(response.status);
console.log(await response.text());
```

Native fallback without `curl-impersonate`:

```ts
import { createBrowserNative } from 'ghost-browse';

const browser = createBrowserNative();
const response = await browser.get('https://example.com');
```

POST requests:

```ts
const response = await browser.post(
  'https://httpbin.org/post',
  new URLSearchParams({ a: '1', b: '2' }),
  { headers: { 'content-type': 'application/x-www-form-urlencoded' } },
);

console.log(await response.json());
```

## Transport Notes

- `createBrowser()` uses `GHOSTBROWSE_CURL_IMPERSONATE` first, then compatible
  binaries in `PATH` such as `curl_chrome116`, `curl-impersonate-chrome`, or
  `curl-chrome`.
- GhostBrowse intentionally does not ship platform binaries in the npm package.
  This keeps installs small and lets Linux, macOS, Windows, Docker, and CI
  environments choose the right `curl-impersonate` build.
- CLI builds differ in POST body support. To avoid silently sending malformed
  bodies, GhostBrowse routes payload requests through the native adapter while
  keeping the same public browser API.
- `createBrowserNative()` uses the runtime's native `fetch` transport.

## Custom DNS

Custom DNS is a curl-adapter transport option. It lets GhostBrowse resolve a
hostname through user-selected DNS servers and pass the resolved edge IP to curl
with `--resolve`. This is useful for choosing a DNS view for a region, CDN, or
target site without adding a proxy or a full browser.

DNS does not change your outgoing IP address. The target site still sees the IP
of your machine, server, VPN, or proxy. DNS only affects which CDN or origin IP
the request connects to.

```ts
import { createBrowser } from 'ghost-browse';

const browser = await createBrowser({
  dns: {
    servers: ['223.5.5.5', '119.29.29.29'],
    strategy: 'rotate',
    ttlMs: 60_000,
    mode: 'auto',
  },
});

const page = await browser.get('https://example.com');
```

Cloudflare / Google DNS:

```ts
const browser = await createBrowser({
  dns: {
    servers: ['1.1.1.1', '8.8.8.8'],
    strategy: 'first',
  },
});
```

Strict mode without system DNS fallback:

```ts
const browser = await createBrowser({
  dns: {
    servers: ['223.5.5.5'],
    fallbackToSystem: false,
  },
});
```

Options:

| Option | Default | Notes |
| --- | --- | --- |
| `servers` | required | IPv4/IPv6 DNS servers, optionally with port, for example `1.1.1.1` or `1.1.1.1:53` |
| `strategy` | `first` | `first`, `rotate`, or `random` DNS server order |
| `ttlMs` | `60000` | Lazy in-memory DNS cache TTL |
| `ipv6` | `false` | Also resolve AAAA records when enabled |
| `mode` | `auto` | `auto` and `resolve` use `dns.Resolver + curl --resolve`; `curl-dns-servers` emits curl `--dns-servers` |
| `fallbackToSystem` | `true` | Try system DNS if custom DNS fails |

The DNS cache is bounded and cleaned lazily during requests; GhostBrowse does
not start background DNS workers or timers.

`createBrowserNative({ dns })` does not fail, but native `fetch` cannot
guarantee per-request DNS in Node/Bun, so GhostBrowse logs a warning and ignores
that option. Payload requests in the curl adapter still use the existing native
fallback to preserve request-body semantics across curl builds.

## Security Notes

GhostBrowse is an HTTP client, so network access is intentional and required.
Static scanners such as Socket.dev may report `networkAccess` because the native
adapter calls the runtime `fetch` API. That finding is expected for this package
and is documented here instead of being hidden through obfuscation.

The package is intentionally small:

- no install, postinstall, or prepare scripts;
- no telemetry;
- no runtime dependencies;
- no bundled browser, Chromium, or `curl-impersonate` binaries;
- optional TLS impersonation uses only a user-installed binary selected from
  `GHOSTBROWSE_CURL_IMPERSONATE` or `PATH`.

For deterministic environments, prefer `createBrowserNative()` or pin the
external `curl-impersonate` binary yourself.

## Troubleshooting

### `curl-impersonate not found in PATH`

`createBrowser()` requires an external `curl-impersonate` binary. Install a
platform build, then either add it to `PATH` or point GhostBrowse at the binary:

```sh
GHOSTBROWSE_CURL_IMPERSONATE=/absolute/path/to/curl_chrome116
```

PowerShell:

```powershell
$env:GHOSTBROWSE_CURL_IMPERSONATE = 'C:\tools\curl-impersonate\curl-impersonate-chrome.exe'
```

Verify detection:

```ts
import { detectCurlImpersonate } from 'ghost-browse';

console.log(await detectCurlImpersonate());
```

If TLS impersonation is not needed for a target site, use the zero-binary
native transport:

```ts
import { createBrowserNative } from 'ghost-browse';

const browser = createBrowserNative();
```

## API

```ts
createBrowser(options?): Promise<GhostBrowser>
createBrowserNative(options?): GhostBrowser
ghostFetch(url, options?): Promise<GhostResponse>
```

`GhostBrowser`:

```ts
browser.get(url, options?)
browser.post(url, body, options?)
browser.fetch(url, options?)
browser.reset()
browser.clearCookies()
browser.cookies
browser.cookieCount
browser.adapterName
```

## Development

```sh
bun install
bun run typecheck
bun run test:unit
bun run build
npm pack --dry-run
```

The default test suite includes:

- a local HTTP server smoke suite for deterministic client behavior;
- a public Books to Scrape benchmark that writes JSON and HTML artifacts.

The publish path runs only deterministic checks. Run the live benchmark
explicitly when you want fresh public demo metrics:

```sh
bun run benchmark:books
```

After `bun test`, inspect:

- `test-output/books-to-scrape.json`
- `test-output/books-to-scrape.html`
- `test-output/books-to-scrape-comparison.json`
- `test-output/books-to-scrape-comparison.html`

### Benchmark Study

The benchmark test scrapes [Books to Scrape](https://books.toscrape.com/),
a public sandbox that explicitly says "We love being scraped!" and is intended
for scraping practice.

<p align="center">
  <img src="https://raw.githubusercontent.com/YATSKOVSKYI/GhostBrowse/main/docs/assets/benchmark-chart.png" alt="Benchmark chart comparing GhostBrowse, Impit, and Playwright Chromium" width="100%" />
</p>

**Figure 1.** End-to-end scraping performance on a fixed 50-page workload.
All clients returned the same ordered list of 1000 book titles.

**Table 1. Experimental Setup**

| Property | Value |
| --- | --- |
| Dataset | Books to Scrape catalogue |
| Workload | 50 listing pages, 1000 books |
| Validation | page count, book count, first title, last title, ordered title equality |
| Output artifacts | JSON dataset, rendered HTML, comparison JSON, comparison HTML |
| Playwright mode | Headless Chromium, images/stylesheets/fonts/media blocked |
| Playwright memory accounting | Node runner plus new Chrome/Chromium process tree |

**Table 2. GhostBrowse Single-Client Run**

| Metric | Value |
| --- | ---: |
| Books scraped | 1000 |
| Pages requested | 50 |
| Duration | 23.61 s |
| Throughput | 42.36 books/s |
| Source HTML downloaded | 2.43 MB |
| Rendered result HTML | 0.48 MB |
| RSS memory delta | 35.01 MB |
| JS heapUsed delta | 4.89 MB |

**Table 3. Comparative Results**

The comparison test runs the same 50-page / 1000-book scrape through
GhostBrowse, [`impit`](https://www.npmjs.com/package/impit), and Playwright
Chromium. Competitors are development-only dependencies used for this benchmark;
they are not shipped as runtime dependencies of GhostBrowse.

| Client | Books | Pages | Duration | Throughput | Total RSS delta | Browser RSS delta | JS heapUsed delta |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| GhostBrowse NativeAdapter | 1000 | 50 | 29.09 s | 34.37 books/s | 13.62 MB | n/a | 4.97 MB |
| Impit | 1000 | 50 | 32.17 s | 31.08 books/s | 13.91 MB | n/a | 8.25 MB |
| Playwright Chromium | 1000 | 50 | 103.98 s | 9.62 books/s | 433.31 MB | 387.26 MB | 40.83 MB |

**Table 4. Playwright Memory Decomposition**

| Component | Start RSS | End RSS | Max RSS | Delta RSS | Process count |
| --- | ---: | ---: | ---: | ---: | ---: |
| Node runner / Playwright driver | 77.01 MB | 123.06 MB | 123.06 MB | 46.05 MB | 1 |
| Chromium process tree | 0 MB | 387.26 MB | 388.16 MB | 387.26 MB | 5 |
| Combined total | 77.01 MB | 510.32 MB | 510.32 MB | 433.31 MB | 6 |

Playwright is run in a Node.js subprocess because Playwright hangs under Bun in
this environment. Its total RSS includes both the Node runner process and the
new Chrome/Chromium process tree spawned during the benchmark.

Artifacts:

- `test-output/books-to-scrape.json`
- `test-output/books-to-scrape.html`
- `test-output/books-to-scrape-comparison.json`
- `test-output/books-to-scrape-comparison.html`

These numbers are live-network benchmarks, so they vary with connection,
runtime, and host environment.

## CI

The GitHub Actions workflow runs typecheck, unit tests, build, package dry-run,
import checks, and the Books to Scrape artifact demo on Ubuntu and Windows.
Scrape outputs are uploaded as workflow artifacts.

## License

MIT
