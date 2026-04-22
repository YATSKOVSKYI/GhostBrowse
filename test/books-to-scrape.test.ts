import { describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createBrowserNative } from '../src/index.ts';

const START_URL = 'https://books.toscrape.com/';
const EXPECTED_BOOK_COUNT = 1000;
const EXPECTED_PAGE_COUNT = 50;
const OUTPUT_DIR = join(process.cwd(), 'test-output');
const OUTPUT_JSON = join(OUTPUT_DIR, 'books-to-scrape.json');
const OUTPUT_HTML = join(OUTPUT_DIR, 'books-to-scrape.html');
const OUTPUT_COMPARE_JSON = join(OUTPUT_DIR, 'books-to-scrape-comparison.json');
const OUTPUT_COMPARE_HTML = join(OUTPUT_DIR, 'books-to-scrape-comparison.html');

interface Book {
  index: number;
  title: string;
  price: string;
  availability: string;
  rating: string;
  url: string;
  imageUrl: string;
}

interface MemorySnapshot {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

type HumanMemorySnapshot = Record<keyof MemorySnapshot, string>;

interface BrowserProcessTreeMemory {
  rss: string;
  processCount: number;
}

interface ScrapeResult {
  clientName: string;
  books: Book[];
  pageCount: number;
  totalSourceHtmlBytes: number;
  renderedHtml: string;
  renderedHtmlBytes: number;
  benchmark: Benchmark;
}

interface Benchmark {
  duration: { ms: string; seconds: string };
  requestCount: number;
  sourceHtmlSize: string;
  renderedHtmlSize: string;
  booksPerSecond: number;
  pagesPerSecond: number;
  memory: {
    start: HumanMemorySnapshot;
    end: HumanMemorySnapshot;
    max: HumanMemorySnapshot;
    delta: HumanMemorySnapshot;
    maxDelta: HumanMemorySnapshot;
    total?: {
      start: HumanMemorySnapshot;
      end: HumanMemorySnapshot;
      max: HumanMemorySnapshot;
      delta: HumanMemorySnapshot;
      maxDelta: HumanMemorySnapshot;
    };
    driver?: {
      start: HumanMemorySnapshot;
      end: HumanMemorySnapshot;
      max: HumanMemorySnapshot;
      delta: HumanMemorySnapshot;
      maxDelta: HumanMemorySnapshot;
    };
    browserProcessTree?: {
      start: BrowserProcessTreeMemory;
      end: BrowserProcessTreeMemory;
      max: BrowserProcessTreeMemory;
      delta: BrowserProcessTreeMemory;
      maxDelta: BrowserProcessTreeMemory;
    };
  };
  raw: {
    durationMs: number;
    sourceHtmlBytes: number;
    renderedHtmlBytes: number;
    memoryBytes: {
      start: MemorySnapshot;
      end: MemorySnapshot;
      max: MemorySnapshot;
      delta: MemorySnapshot;
      maxDelta: MemorySnapshot;
    };
  };
}

interface HttpClient {
  getText(url: string): Promise<{ status: number; text: string }>;
  close?(): Promise<void> | void;
}

function getMemorySnapshot(): MemorySnapshot {
  const memory = process.memoryUsage();
  return {
    rss: memory.rss,
    heapTotal: memory.heapTotal,
    heapUsed: memory.heapUsed,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
  };
}

function updateMaxMemory(max: MemorySnapshot, current: MemorySnapshot): MemorySnapshot {
  return {
    rss: Math.max(max.rss, current.rss),
    heapTotal: Math.max(max.heapTotal, current.heapTotal),
    heapUsed: Math.max(max.heapUsed, current.heapUsed),
    external: Math.max(max.external, current.external),
    arrayBuffers: Math.max(max.arrayBuffers, current.arrayBuffers),
  };
}

function getMemoryDelta(after: MemorySnapshot, before: MemorySnapshot): MemorySnapshot {
  return {
    rss: after.rss - before.rss,
    heapTotal: after.heapTotal - before.heapTotal,
    heapUsed: after.heapUsed - before.heapUsed,
    external: after.external - before.external,
    arrayBuffers: after.arrayBuffers - before.arrayBuffers,
  };
}

function bytesToMegabytes(bytes: number): number {
  return Number((bytes / 1024 / 1024).toFixed(2));
}

function humanizeMemory(snapshot: MemorySnapshot): Record<keyof MemorySnapshot, string> {
  return {
    rss: `${bytesToMegabytes(snapshot.rss)} MB`,
    heapTotal: `${bytesToMegabytes(snapshot.heapTotal)} MB`,
    heapUsed: `${bytesToMegabytes(snapshot.heapUsed)} MB`,
    external: `${bytesToMegabytes(snapshot.external)} MB`,
    arrayBuffers: `${bytesToMegabytes(snapshot.arrayBuffers)} MB`,
  };
}

function humanizeDuration(ms: number): { ms: string; seconds: string } {
  return {
    ms: `${Number(ms.toFixed(2))} ms`,
    seconds: `${Number((ms / 1000).toFixed(2))} s`,
  };
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&pound;/g, '\u00a3')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

function absoluteUrl(url: string, baseUrl: string): string {
  return new URL(url, baseUrl).href;
}

function getNextPageUrl(html: string, pageUrl: string): string | null {
  const match = html.match(/<li class="next">\s*<a href="([^"]+)">next<\/a>/i);
  return match ? absoluteUrl(match[1], pageUrl) : null;
}

function parseBooks(html: string, pageUrl: string, startIndex: number): Book[] {
  const matches = html.matchAll(/<article class="product_pod">([\s\S]*?)<\/article>/g);
  const books: Book[] = [];

  for (const match of matches) {
    const block = match[1];
    const imageMatch = block.match(/<img src="([^"]+)" alt="([^"]+)"/i);
    const linkMatch = block.match(/<h3>\s*<a href="([^"]+)" title="([^"]+)"/i);
    const ratingMatch = block.match(/<p class="star-rating ([^"]+)"/i);
    const priceMatch = block.match(/<p class="price_color">([^<]+)<\/p>/i);
    const availabilityMatch = block.match(/<p class="instock availability">\s*<i[^>]*><\/i>\s*([^<]+)\s*<\/p>/i);

    if (!linkMatch || !priceMatch || !availabilityMatch) continue;

    const title = decodeHtmlEntities(linkMatch[2]);
    books.push({
      index: startIndex + books.length + 1,
      title,
      price: decodeHtmlEntities(priceMatch[1]),
      availability: availabilityMatch[1].trim(),
      rating: ratingMatch?.[1] ?? '',
      url: absoluteUrl(linkMatch[1], pageUrl),
      imageUrl: imageMatch ? absoluteUrl(imageMatch[1], pageUrl) : '',
    });
  }

  return books;
}

function renderBooksHtml(books: Book[]): string {
  const items = books.map(book => [
    `    <article class="book" data-index="${book.index}">`,
    `      <img src="${escapeHtml(book.imageUrl)}" alt="${escapeHtml(book.title)}" loading="lazy" />`,
    `      <h2>${escapeHtml(book.title)}</h2>`,
    `      <p class="price">${escapeHtml(book.price)}</p>`,
    `      <p class="availability">${escapeHtml(book.availability)}</p>`,
    `      <p class="rating">${escapeHtml(book.rating)}</p>`,
    `      <a href="${escapeHtml(book.url)}">details</a>`,
    '    </article>',
  ].join('\n'));

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    '  <title>Books to Scrape Result</title>',
    '  <style>',
    '    body { font-family: Arial, sans-serif; margin: 24px; }',
    '    main { display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }',
    '    .book { border: 1px solid #ddd; padding: 12px; }',
    '    img { max-width: 100%; height: 180px; object-fit: contain; }',
    '    h2 { font-size: 16px; line-height: 1.3; }',
    '  </style>',
    '</head>',
    '<body>',
    `  <h1>Books to Scrape: ${books.length} books</h1>`,
    '  <main>',
    items.join('\n'),
    '  </main>',
    '</body>',
    '</html>',
  ].join('\n');
}

function renderComparisonHtml(results: ScrapeResult[]): string {
  const rows = results.map(result => [
    '<tr>',
    `<td>${escapeHtml(result.clientName)}</td>`,
    `<td>${result.books.length}</td>`,
    `<td>${result.pageCount}</td>`,
    `<td>${escapeHtml(result.benchmark.duration.seconds)}</td>`,
    `<td>${result.benchmark.booksPerSecond}</td>`,
    `<td>${escapeHtml(result.benchmark.memory.total?.delta.rss ?? result.benchmark.memory.delta.rss)}</td>`,
    `<td>${escapeHtml(result.benchmark.memory.browserProcessTree?.delta.rss ?? 'n/a')}</td>`,
    `<td>${escapeHtml(result.benchmark.memory.delta.heapUsed)}</td>`,
    '</tr>',
  ].join(''));

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    '  <title>GhostBrowse vs Impit vs Playwright Books Benchmark</title>',
    '  <style>',
    '    body { font-family: Arial, sans-serif; margin: 24px; }',
    '    table { border-collapse: collapse; min-width: 760px; }',
    '    th, td { border: 1px solid #ddd; padding: 8px 10px; text-align: left; }',
    '    th { background: #f5f5f5; }',
    '  </style>',
    '</head>',
    '<body>',
    '  <h1>GhostBrowse vs Impit vs Playwright: Books to Scrape</h1>',
    '  <table>',
    '    <thead><tr><th>Client</th><th>Books</th><th>Pages</th><th>Duration</th><th>Books/s</th><th>Total RSS delta</th><th>Browser RSS delta</th><th>Heap delta</th></tr></thead>',
    `    <tbody>${rows.join('')}</tbody>`,
    '  </table>',
    '</body>',
    '</html>',
  ].join('\n');
}

async function scrapeBooks(clientName: string, client: HttpClient): Promise<ScrapeResult> {
  const startedAt = performance.now();
  const memoryStart = getMemorySnapshot();
  let memoryMax = memoryStart;
  let totalSourceHtmlBytes = 0;
  let pageCount = 0;
  let nextUrl: string | null = START_URL;
  const books: Book[] = [];

  try {
    while (nextUrl) {
      const pageUrl = nextUrl;
      const response = await client.getText(pageUrl);
      expect(response.status).toBe(200);

      const html = response.text;
      totalSourceHtmlBytes += Buffer.byteLength(html, 'utf8');
      pageCount++;

      books.push(...parseBooks(html, pageUrl, books.length));
      nextUrl = getNextPageUrl(html, pageUrl);
      memoryMax = updateMaxMemory(memoryMax, getMemorySnapshot());
    }

    const renderedHtml = renderBooksHtml(books);
    memoryMax = updateMaxMemory(memoryMax, getMemorySnapshot());

    expect(pageCount).toBe(EXPECTED_PAGE_COUNT);
    expect(books).toHaveLength(EXPECTED_BOOK_COUNT);
    expect(books[0]?.title).toBe('A Light in the Attic');
    expect(books.at(-1)?.title).toBe('1,000 Places to See Before You Die');

    const memoryEnd = getMemorySnapshot();
    const durationMs = performance.now() - startedAt;
    const memoryDelta = getMemoryDelta(memoryEnd, memoryStart);
    const memoryMaxDelta = getMemoryDelta(memoryMax, memoryStart);
    const renderedHtmlBytes = Buffer.byteLength(renderedHtml, 'utf8');

    return {
      clientName,
      books,
      pageCount,
      totalSourceHtmlBytes,
      renderedHtml,
      renderedHtmlBytes,
      benchmark: {
        duration: humanizeDuration(durationMs),
        requestCount: pageCount,
        sourceHtmlSize: `${bytesToMegabytes(totalSourceHtmlBytes)} MB`,
        renderedHtmlSize: `${bytesToMegabytes(renderedHtmlBytes)} MB`,
        booksPerSecond: Number((books.length / (durationMs / 1000)).toFixed(2)),
        pagesPerSecond: Number((pageCount / (durationMs / 1000)).toFixed(2)),
        memory: {
          start: humanizeMemory(memoryStart),
          end: humanizeMemory(memoryEnd),
          max: humanizeMemory(memoryMax),
          delta: humanizeMemory(memoryDelta),
          maxDelta: humanizeMemory(memoryMaxDelta),
        },
        raw: {
          durationMs,
          sourceHtmlBytes: totalSourceHtmlBytes,
          renderedHtmlBytes,
          memoryBytes: {
            start: memoryStart,
            end: memoryEnd,
            max: memoryMax,
            delta: memoryDelta,
            maxDelta: memoryMaxDelta,
          },
        },
      },
    };
  } finally {
    await client.close?.();
  }
}

function ghostBrowseClient(): HttpClient {
  const browser = createBrowserNative({
    timeout: 30_000,
    headers: {
      'accept-language': 'en-US,en;q=0.9',
    },
  });

  return {
    async getText(url: string) {
      const response = await browser.get(url);
      return { status: response.status, text: await response.text() };
    },
  };
}

async function impitClient(): Promise<HttpClient> {
  const { Impit } = await import('impit');
  const impit = new Impit({
    browser: 'chrome',
    headers: {
      'accept-language': 'en-US,en;q=0.9',
    },
  });

  return {
    async getText(url: string) {
      const response = await impit.fetch(url);
      return { status: response.status, text: await response.text() };
    },
  };
}

async function nodePlaywrightChromiumResult(): Promise<ScrapeResult> {
  const scriptPath = join(process.cwd(), 'test', 'playwright-books-runner.mjs');
  const child = spawn('node', [scriptPath], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Playwright Chromium benchmark timed out after 240000ms'));
    }, 240_000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timeout);
      resolve(code);
    });
  });

  if (exitCode !== 0) {
    throw new Error(`Playwright Chromium benchmark failed with exit code ${exitCode}: ${stderr}`);
  }

  const result = JSON.parse(stdout.replace(/^\uFEFF/, '')) as ScrapeResult;
  result.renderedHtml = '';
  return result;
}

describe('Books to Scrape live demo', () => {
  it('scrapes all 1000 books and writes benchmark artifacts', async () => {
    const result = await scrapeBooks('GhostBrowse NativeAdapter', ghostBrowseClient());
    const books = result.books;

    await mkdir(OUTPUT_DIR, { recursive: true });
    await writeFile(OUTPUT_HTML, result.renderedHtml, 'utf8');
    await writeFile(
      OUTPUT_JSON,
      JSON.stringify(
        {
          sourceUrl: START_URL,
          outputHtml: OUTPUT_HTML,
          count: books.length,
          pageCount: result.pageCount,
          benchmark: result.benchmark,
          books,
        },
        null,
        2,
      ),
      'utf8',
    );

    console.log([
      '',
      'Books to Scrape artifact summary:',
      `  JSON: ${OUTPUT_JSON}`,
      `  HTML: ${OUTPUT_HTML}`,
      `  Books: ${books.length}`,
      `  Pages: ${result.pageCount}`,
      `  Duration: ${result.benchmark.duration.seconds}`,
      `  Throughput: ${result.benchmark.booksPerSecond} books/s`,
      `  RSS delta: ${result.benchmark.memory.delta.rss}`,
      `  Heap used delta: ${result.benchmark.memory.delta.heapUsed}`,
    ].join('\n'));
  }, 60_000);

  it('compares GhostBrowse with Impit and Playwright on the same 1000-book scrape', async () => {
    const ghost = await scrapeBooks('GhostBrowse NativeAdapter', ghostBrowseClient());
    const impit = await scrapeBooks('Impit', await impitClient());
    const playwright = await nodePlaywrightChromiumResult();
    const comparisonHtml = renderComparisonHtml([ghost, impit, playwright]);

    expect(ghost.books.map(book => book.title)).toEqual(impit.books.map(book => book.title));
    expect(ghost.books.map(book => book.title)).toEqual(playwright.books.map(book => book.title));

    await mkdir(OUTPUT_DIR, { recursive: true });
    await writeFile(OUTPUT_COMPARE_HTML, comparisonHtml, 'utf8');
    await writeFile(
      OUTPUT_COMPARE_JSON,
      JSON.stringify(
        {
          sourceUrl: START_URL,
          outputHtml: OUTPUT_COMPARE_HTML,
          notes: [
            'Playwright Chromium runs in a Node.js subprocess because Playwright hangs under Bun in this environment.',
            'Playwright total RSS includes the Node runner process plus the new Chrome/Chromium process tree spawned during the benchmark.',
          ],
          competitors: [
            {
              clientName: ghost.clientName,
              count: ghost.books.length,
              pageCount: ghost.pageCount,
              benchmark: ghost.benchmark,
            },
            {
              clientName: impit.clientName,
              count: impit.books.length,
              pageCount: impit.pageCount,
              benchmark: impit.benchmark,
            },
            {
              clientName: playwright.clientName,
              count: playwright.books.length,
              pageCount: playwright.pageCount,
              benchmark: playwright.benchmark,
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );

    console.log([
      '',
      'Books to Scrape comparison summary:',
      `  JSON: ${OUTPUT_COMPARE_JSON}`,
      `  HTML: ${OUTPUT_COMPARE_HTML}`,
      `  GhostBrowse: ${ghost.benchmark.duration.seconds}, ${ghost.benchmark.booksPerSecond} books/s, RSS ${ghost.benchmark.memory.delta.rss}`,
      `  Impit: ${impit.benchmark.duration.seconds}, ${impit.benchmark.booksPerSecond} books/s, RSS ${impit.benchmark.memory.delta.rss}`,
      `  Playwright Chromium: ${playwright.benchmark.duration.seconds}, ${playwright.benchmark.booksPerSecond} books/s, total RSS ${playwright.benchmark.memory.total?.delta.rss ?? playwright.benchmark.memory.delta.rss}`,
    ].join('\n'));
  }, 260_000);
});
