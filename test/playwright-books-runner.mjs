import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

const START_URL = 'https://books.toscrape.com/';
const EXPECTED_BOOK_COUNT = 1000;
const EXPECTED_PAGE_COUNT = 50;
const execFileAsync = promisify(execFile);

function getMemorySnapshot() {
  const memory = process.memoryUsage();
  return {
    rss: memory.rss,
    heapTotal: memory.heapTotal,
    heapUsed: memory.heapUsed,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
  };
}

function updateMaxMemory(max, current) {
  return {
    rss: Math.max(max.rss, current.rss),
    heapTotal: Math.max(max.heapTotal, current.heapTotal),
    heapUsed: Math.max(max.heapUsed, current.heapUsed),
    external: Math.max(max.external, current.external),
    arrayBuffers: Math.max(max.arrayBuffers, current.arrayBuffers),
  };
}

function getMemoryDelta(after, before) {
  return {
    rss: after.rss - before.rss,
    heapTotal: after.heapTotal - before.heapTotal,
    heapUsed: after.heapUsed - before.heapUsed,
    external: after.external - before.external,
    arrayBuffers: after.arrayBuffers - before.arrayBuffers,
  };
}

function bytesToMegabytes(bytes) {
  return Number((bytes / 1024 / 1024).toFixed(2));
}

function humanizeMemory(snapshot) {
  return {
    rss: `${bytesToMegabytes(snapshot.rss)} MB`,
    heapTotal: `${bytesToMegabytes(snapshot.heapTotal)} MB`,
    heapUsed: `${bytesToMegabytes(snapshot.heapUsed)} MB`,
    external: `${bytesToMegabytes(snapshot.external)} MB`,
    arrayBuffers: `${bytesToMegabytes(snapshot.arrayBuffers)} MB`,
  };
}

function humanizeBrowserProcessTree(snapshot) {
  return {
    rss: `${bytesToMegabytes(snapshot.rss)} MB`,
    processCount: snapshot.processCount,
  };
}

function getBrowserProcessTreeDelta(after, before) {
  return {
    rss: after.rss - before.rss,
    processCount: after.processCount - before.processCount,
  };
}

function updateMaxBrowserProcessTree(max, current) {
  return {
    rss: Math.max(max.rss, current.rss),
    processCount: Math.max(max.processCount, current.processCount),
  };
}

function combineMemorySnapshot(driver, browserProcessTree) {
  return {
    ...driver,
    rss: driver.rss + browserProcessTree.rss,
  };
}

function normalizeProcessName(value) {
  return String(value ?? '').toLowerCase();
}

function isBrowserProcess(processInfo) {
  const haystack = normalizeProcessName(`${processInfo.name} ${processInfo.command}`);
  return (
    haystack.includes('chrome') ||
    haystack.includes('chromium') ||
    haystack.includes('headless_shell')
  );
}

async function getProcessList() {
  if (process.platform === 'win32') {
    const command = [
      '$ErrorActionPreference = "Stop";',
      'Get-CimInstance Win32_Process |',
      'Select-Object ProcessId, ParentProcessId, Name, WorkingSetSize, CommandLine |',
      'ConvertTo-Json -Compress',
    ].join(' ');
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', command], {
      maxBuffer: 16 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout || '[]');
    const rows = Array.isArray(parsed) ? parsed : [parsed];

    return rows.map(row => ({
      pid: Number(row.ProcessId),
      ppid: Number(row.ParentProcessId),
      rss: Number(row.WorkingSetSize ?? 0),
      name: String(row.Name ?? ''),
      command: String(row.CommandLine ?? ''),
    })).filter(row => Number.isFinite(row.pid));
  }

  const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid=,rss=,comm=,args='], {
    maxBuffer: 16 * 1024 * 1024,
  });

  return stdout.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (!match) return [];

    return [{
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rss: Number(match[3]) * 1024,
      name: match[4],
      command: match[5] ?? '',
    }];
  });
}

async function getBrowserProcessTreeSnapshot(baselinePids) {
  const processList = await getProcessList();
  const browserProcesses = processList.filter(processInfo => (
    !baselinePids.has(processInfo.pid) &&
    processInfo.pid !== process.pid &&
    isBrowserProcess(processInfo)
  ));

  return {
    rss: browserProcesses.reduce((total, processInfo) => total + processInfo.rss, 0),
    processCount: browserProcesses.length,
  };
}

function humanizeDuration(ms) {
  return {
    ms: `${Number(ms.toFixed(2))} ms`,
    seconds: `${Number((ms / 1000).toFixed(2))} s`,
  };
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&pound;/g, '\u00a3')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function escapeHtml(value) {
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

function absoluteUrl(url, baseUrl) {
  return new URL(url, baseUrl).href;
}

function getNextPageUrl(html, pageUrl) {
  const match = html.match(/<li class="next">\s*<a href="([^"]+)">next<\/a>/i);
  return match ? absoluteUrl(match[1], pageUrl) : null;
}

function parseBooks(html, pageUrl, startIndex) {
  const matches = html.matchAll(/<article class="product_pod">([\s\S]*?)<\/article>/g);
  const books = [];

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

function renderBooksHtml(books) {
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

const startedAt = performance.now();
const baselineProcesses = await getProcessList();
const baselinePids = new Set(baselineProcesses.map(processInfo => processInfo.pid));
const memoryStart = getMemorySnapshot();
let memoryMax = memoryStart;
const browserProcessTreeStart = { rss: 0, processCount: 0 };
let browserProcessTreeMax = browserProcessTreeStart;
let totalMemoryMax = combineMemorySnapshot(memoryStart, browserProcessTreeStart);
let totalSourceHtmlBytes = 0;
let pageCount = 0;
let nextUrl = START_URL;
const books = [];

const browser = await chromium.launch({ headless: true });
let context;
let page;
try {
  const browserProcessTreeAfterLaunch = await getBrowserProcessTreeSnapshot(baselinePids);
  browserProcessTreeMax = updateMaxBrowserProcessTree(browserProcessTreeMax, browserProcessTreeAfterLaunch);
  totalMemoryMax = updateMaxMemory(
    totalMemoryMax,
    combineMemorySnapshot(getMemorySnapshot(), browserProcessTreeAfterLaunch),
  );

  context = await browser.newContext({
    extraHTTPHeaders: {
      'accept-language': 'en-US,en;q=0.9',
    },
  });

  await context.route('**/*', route => {
    const resourceType = route.request().resourceType();
    if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
      return route.abort();
    }

    return route.continue();
  });

  page = await context.newPage();
  while (nextUrl) {
    const pageUrl = nextUrl;
    const response = await page.goto(pageUrl, {
      timeout: 30_000,
      waitUntil: 'domcontentloaded',
    });

    if (response?.status() !== 200) {
      throw new Error(`Unexpected status ${response?.status()} for ${pageUrl}`);
    }

    const html = await page.content();
    totalSourceHtmlBytes += Buffer.byteLength(html, 'utf8');
    pageCount++;
    books.push(...parseBooks(html, pageUrl, books.length));
    nextUrl = getNextPageUrl(html, pageUrl);
    const currentDriverMemory = getMemorySnapshot();
    memoryMax = updateMaxMemory(memoryMax, currentDriverMemory);

    if (pageCount % 10 === 0 || !nextUrl) {
      const currentBrowserProcessTree = await getBrowserProcessTreeSnapshot(baselinePids);
      browserProcessTreeMax = updateMaxBrowserProcessTree(browserProcessTreeMax, currentBrowserProcessTree);
      totalMemoryMax = updateMaxMemory(
        totalMemoryMax,
        combineMemorySnapshot(currentDriverMemory, currentBrowserProcessTree),
      );
    }
  }

  const renderedHtml = renderBooksHtml(books);
  const memoryEnd = getMemorySnapshot();
  const browserProcessTreeEnd = await getBrowserProcessTreeSnapshot(baselinePids);
  memoryMax = updateMaxMemory(memoryMax, memoryEnd);
  browserProcessTreeMax = updateMaxBrowserProcessTree(browserProcessTreeMax, browserProcessTreeEnd);
  totalMemoryMax = updateMaxMemory(
    totalMemoryMax,
    combineMemorySnapshot(memoryEnd, browserProcessTreeEnd),
  );

  if (pageCount !== EXPECTED_PAGE_COUNT) {
    throw new Error(`Expected ${EXPECTED_PAGE_COUNT} pages, got ${pageCount}`);
  }

  if (books.length !== EXPECTED_BOOK_COUNT) {
    throw new Error(`Expected ${EXPECTED_BOOK_COUNT} books, got ${books.length}`);
  }

  if (books[0]?.title !== 'A Light in the Attic') {
    throw new Error(`Unexpected first title: ${books[0]?.title}`);
  }

  if (books.at(-1)?.title !== '1,000 Places to See Before You Die') {
    throw new Error(`Unexpected last title: ${books.at(-1)?.title}`);
  }

  const durationMs = performance.now() - startedAt;
  const memoryDelta = getMemoryDelta(memoryEnd, memoryStart);
  const memoryMaxDelta = getMemoryDelta(memoryMax, memoryStart);
  const browserProcessTreeDelta = getBrowserProcessTreeDelta(
    browserProcessTreeEnd,
    browserProcessTreeStart,
  );
  const browserProcessTreeMaxDelta = getBrowserProcessTreeDelta(
    browserProcessTreeMax,
    browserProcessTreeStart,
  );
  const totalMemoryStart = combineMemorySnapshot(memoryStart, browserProcessTreeStart);
  const totalMemoryEnd = combineMemorySnapshot(memoryEnd, browserProcessTreeEnd);
  const totalMemoryDelta = getMemoryDelta(totalMemoryEnd, totalMemoryStart);
  const totalMemoryMaxDelta = getMemoryDelta(totalMemoryMax, totalMemoryStart);
  const renderedHtmlBytes = Buffer.byteLength(renderedHtml, 'utf8');

  process.stdout.write(JSON.stringify({
    clientName: 'Playwright Chromium',
    books,
    pageCount,
    totalSourceHtmlBytes,
    renderedHtml: '',
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
        driver: {
          start: humanizeMemory(memoryStart),
          end: humanizeMemory(memoryEnd),
          max: humanizeMemory(memoryMax),
          delta: humanizeMemory(memoryDelta),
          maxDelta: humanizeMemory(memoryMaxDelta),
        },
        browserProcessTree: {
          start: humanizeBrowserProcessTree(browserProcessTreeStart),
          end: humanizeBrowserProcessTree(browserProcessTreeEnd),
          max: humanizeBrowserProcessTree(browserProcessTreeMax),
          delta: humanizeBrowserProcessTree(browserProcessTreeDelta),
          maxDelta: humanizeBrowserProcessTree(browserProcessTreeMaxDelta),
        },
        total: {
          start: humanizeMemory(totalMemoryStart),
          end: humanizeMemory(totalMemoryEnd),
          max: humanizeMemory(totalMemoryMax),
          delta: humanizeMemory(totalMemoryDelta),
          maxDelta: humanizeMemory(totalMemoryMaxDelta),
        },
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
          driver: {
            start: memoryStart,
            end: memoryEnd,
            max: memoryMax,
            delta: memoryDelta,
            maxDelta: memoryMaxDelta,
          },
          browserProcessTree: {
            start: browserProcessTreeStart,
            end: browserProcessTreeEnd,
            max: browserProcessTreeMax,
            delta: browserProcessTreeDelta,
            maxDelta: browserProcessTreeMaxDelta,
          },
          total: {
            start: totalMemoryStart,
            end: totalMemoryEnd,
            max: totalMemoryMax,
            delta: totalMemoryDelta,
            maxDelta: totalMemoryMaxDelta,
          },
        },
      },
    },
  }, null, 2));
} finally {
  await page?.close();
  await context?.close();
  await browser.close();
}
