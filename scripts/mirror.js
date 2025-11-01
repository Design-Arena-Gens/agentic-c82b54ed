#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cheerio from 'cheerio';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const MIRROR_DIR = path.join(PUBLIC_DIR, 'mirror');

const ORIGIN = process.env.MIRROR_BASE_URL || 'https://www.osteopathieapeldoorn.nl';
const ORIGIN_HOST = new URL(ORIGIN).host;

const MAX_PAGES = parseInt(process.env.MIRROR_MAX_PAGES || '500', 10);
const CONCURRENCY = parseInt(process.env.MIRROR_CONCURRENCY || '5', 10);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function normalizeUrl(href, base) {
  try {
    const absolute = new URL(href, base).toString();
    // Remove fragments and default ports
    const url = new URL(absolute);
    url.hash = '';
    if (url.host !== ORIGIN_HOST) return null; // only same-host
    // normalize trailing slash for directories
    return url.toString();
  } catch {
    return null;
  }
}

function toMirrorPath(urlString) {
  const u = new URL(urlString);
  let filePath = u.pathname;
  if (filePath.endsWith('/')) {
    filePath = path.join(filePath, 'index.html');
  } else if (!path.extname(filePath)) {
    // no extension, treat as html
    filePath = filePath + '.html';
  }
  return path.join(MIRROR_DIR, filePath);
}

function toLocalHref(urlString) {
  const u = new URL(urlString);
  // keep path and trailing slash; remove filename .html
  if (u.pathname.endsWith('/')) return u.pathname;
  if (u.pathname.endsWith('.html')) return u.pathname.replace(/\.html$/, '');
  return u.pathname;
}

async function fetchPage(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Failed ${res.status} ${url}`);
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) {
    return { html: null, contentType, buffer: Buffer.from(await res.arrayBuffer()) };
  }
  const html = await res.text();
  return { html, contentType, buffer: null };
}

function transformHtml(url, html) {
  const $ = cheerio.load(html);

  // Rewrite anchor hrefs to local paths
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    const normalized = normalizeUrl(href, url);
    if (!normalized) return;
    $(el).attr('href', toLocalHref(normalized));
  });

  // Make asset URLs absolute to origin (img, script, link rel=stylesheet)
  $('img[src]').each((_, el) => {
    const v = $(el).attr('src');
    try { $(el).attr('src', new URL(v, url).toString()); } catch {}
  });
  $('script[src]').each((_, el) => {
    const v = $(el).attr('src');
    try { $(el).attr('src', new URL(v, url).toString()); } catch {}
  });
  $('link[rel="stylesheet"][href]').each((_, el) => {
    const v = $(el).attr('href');
    try { $(el).attr('href', new URL(v, url).toString()); } catch {}
  });

  return $.html();
}

async function saveFile(filePath, data) {
  ensureDir(path.dirname(filePath));
  await fs.promises.writeFile(filePath, data);
}

async function crawl() {
  console.log(`Mirroring from ${ORIGIN} ...`);
  ensureDir(MIRROR_DIR);

  const queue = [ORIGIN];
  const seen = new Set(queue);
  let processed = 0;

  const pending = new Set();

  async function worker() {
    while (queue.length && processed < MAX_PAGES) {
      const current = queue.shift();
      if (!current) break;
      processed++;
      try {
        const { html, contentType, buffer } = await fetchPage(current);
        const outputPath = toMirrorPath(current);
        if (html === null) {
          // Non-HTML: skip saving unless it's likely linked as a page resource; we don't mirror assets
          console.log(`Skip non-HTML ${contentType} ${current}`);
        } else {
          const transformed = transformHtml(current, html);
          await saveFile(outputPath, transformed);

          const $ = cheerio.load(html);
          $('a[href]').each((_, el) => {
            const href = $(el).attr('href');
            const normalized = normalizeUrl(href, current);
            if (!normalized) return;
            if (!seen.has(normalized)) {
              seen.add(normalized);
              queue.push(normalized);
            }
          });
        }
        console.log(`Saved ${current} -> ${path.relative(PROJECT_ROOT, outputPath)}`);
      } catch (err) {
        console.warn(`Error fetching ${current}: ${err.message}`);
      }
    }
  }

  for (let i = 0; i < CONCURRENCY; i++) {
    const p = worker();
    pending.add(p);
    p.finally(() => pending.delete(p));
  }
  await Promise.all([...pending]);

  console.log(`Done. Processed ${processed} pages.`);
}

crawl().catch((e) => {
  console.error(e);
  process.exit(1);
});
