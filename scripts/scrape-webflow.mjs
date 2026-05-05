#!/usr/bin/env node
/**
 * Scrapes a Webflow site (kolo.xyz) and produces a 1:1 Astro mirror.
 *
 *   1. Reads URLs from /sitemap.xml (skips /blog/* by default).
 *   2. Downloads each page's HTML to src/_scraped/{path}.html
 *   3. Generates an .astro page at src/pages/{path}.astro that imports the raw HTML
 *      and renders via WebflowPage layout.
 *   4. Walks every page + downloaded CSS for asset references,
 *      downloads all same-origin and Webflow-CDN assets into /public/.
 *
 * Idempotent: re-running uses cache, only re-downloads missing files.
 *
 * Flags:
 *   --only=<substring>   only process URLs whose path contains <substring>
 *   --no-blog            skip /blog/* (default behavior)
 *   --include-blog       include blog pages
 *   --refresh            ignore cache, re-download everything
 *   --concurrency=N      parallel downloads (default 6)
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, dirname, extname, posix } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url';

const SITE = 'https://kolo.xyz';
const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const SCRAPED_DIR = join(ROOT, 'src', '_scraped');
const PAGES_DIR = join(ROOT, 'src', 'pages');
const PUBLIC_DIR = join(ROOT, 'public');
const CDN_HOST = 'cdn.prod.website-files.com';

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);
const ONLY = args.get('only') || null;
const INCLUDE_BLOG = args.get('include-blog') === true;
const REFRESH = args.get('refresh') === true;
const CONCURRENCY = Number(args.get('concurrency') || 6);

const SKIP_PATTERNS = INCLUDE_BLOG
  ? []
  : [/^\/blog\b/, /^\/ru\/blog\b/, /^\/ua\/blog\b/];

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) kolo-mirror/1.0';

// --- helpers ----------------------------------------------------------------

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

async function fetchText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.text();
}

async function fetchBuffer(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return Buffer.from(await r.arrayBuffer());
}

async function pool(items, n, worker) {
  const queue = [...items];
  const results = [];
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (queue.length) {
        const item = queue.shift();
        try {
          results.push(await worker(item));
        } catch (e) {
          log(`✗ error on ${item}: ${e.message}`);
        }
      }
    })
  );
  return results;
}

// --- sitemap & URL → file paths --------------------------------------------

async function getSitemapUrls() {
  const xml = await fetchText(`${SITE}/sitemap.xml`);
  const all = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const filtered = all
    .filter((u) => {
      try {
        const path = new NodeURL(u).pathname;
        if (SKIP_PATTERNS.some((p) => p.test(path))) return false;
        if (ONLY && !path.includes(ONLY)) return false;
        return true;
      } catch {
        return false;
      }
    });
  return [...new Set(filtered)];
}

function pathnameToCacheFile(pathname) {
  if (pathname === '/' || pathname === '') return '_root.html';
  return pathname.replace(/^\/+|\/+$/g, '').replace(/\//g, '__') + '.html';
}

function pathnameToAstroFile(pathname) {
  if (pathname === '/' || pathname === '') return 'index.astro';
  const trimmed = pathname.replace(/^\/+|\/+$/g, '');
  const parts = trimmed.split('/');
  // /ua → src/pages/ua/index.astro (so /ua/buy can also exist)
  if (parts.length === 1 && (parts[0] === 'ua' || parts[0] === 'ru')) {
    return `${parts[0]}/index.astro`;
  }
  return `${trimmed}.astro`;
}

function relativeImportPath(astroFile, target) {
  // astroFile is relative to src/pages/.
  // Layouts and _scraped live under src/, so we always need to go up at least one level.
  // index.astro          → ../target (1 up to reach src/)
  // ru/index.astro       → ../../target
  // for-business/biz.astro → ../../target
  const depth = astroFile.split('/').length;
  return '../'.repeat(depth) + target;
}

function detectLang(pathname) {
  if (pathname.startsWith('/ua')) return 'uk';
  if (pathname.startsWith('/ru')) return 'ru';
  return 'en';
}

// --- asset extraction -------------------------------------------------------

const assetUrls = new Set();

function collectAssetUrlsFromHtml(html, baseUrl) {
  const base = new NodeURL(baseUrl);
  // `&` excluded so we don't follow into JSON-encoded URL pairs like
  //   data-bg="https://.../foo.mp4&quot;https://.../bar.webm"
  // which would otherwise capture both URLs as one mangled string.
  // The last pattern is a catch-all for everything the structured patterns miss
  // (og:image, twitter:image, JSON-LD images, inline JS configs, etc.).
  // isLikelyAsset() filters the catch-all results down to real asset extensions.
  const patterns = [
    /<link[^>]+href=["']([^"'&]+)["&]/gi,
    /<script[^>]+src=["']([^"'&]+)["&]/gi,
    /<img[^>]+src=["']([^"'&]+)["&]/gi,
    /<source[^>]+srcset=["']([^"'&]+)["&]/gi,
    /<img[^>]+srcset=["']([^"'&]+)["&]/gi,
    /<video[^>]+src=["']([^"'&]+)["&]/gi,
    /<audio[^>]+src=["']([^"'&]+)["&]/gi,
    /<meta[^>]+content=["'](https:\/\/[^"'&]+)["&]/gi,
    /background[^"]*url\(["']?([^"')&]+)["']?\)/gi,
    /(https:\/\/(?:kolo\.xyz|cdn\.prod\.website-files\.com)\/[^"'\s)<>&]+)/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(html)) !== null) {
      const candidates = m[1].includes(',') ? m[1].split(',') : [m[1]];
      for (const c of candidates) {
        const url = c.trim().split(/\s+/)[0]; // drop srcset descriptor
        try {
          const abs = new NodeURL(url, base);
          maybeQueueAsset(abs.toString());
        } catch {
          // not a URL; skip
        }
      }
    }
  }
}

function collectAssetUrlsFromCss(css, baseUrl) {
  const base = new NodeURL(baseUrl);
  const re = /url\(\s*(?:"|')?([^"')]+)(?:"|')?\s*\)/gi;
  let m;
  while ((m = re.exec(css)) !== null) {
    const url = m[1].trim();
    if (url.startsWith('data:')) continue;
    try {
      const abs = new NodeURL(url, base);
      maybeQueueAsset(abs.toString());
    } catch {
      // skip
    }
  }
}

const ASSET_EXT_RE = /\.(css|js|mjs|map|png|jpe?g|gif|svg|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp4|webm|mov|m4v|mp3|wav|ogg|pdf|json|xml|txt|wasm)(\?.*)?$/i;

function isLikelyAsset(u) {
  // CDN host is always asset territory
  if (u.hostname === CDN_HOST) return true;
  // For our own host: must look like a file URL (extension)
  return ASSET_EXT_RE.test(u.pathname);
}

function maybeQueueAsset(absUrl) {
  let u;
  try {
    u = new NodeURL(absUrl);
  } catch {
    return;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return;
  if (u.hostname !== 'kolo.xyz' && u.hostname !== CDN_HOST) return;
  if (!isLikelyAsset(u)) return; // skip canonical/page references
  assetUrls.add(absUrl);
}

function assetUrlToLocalPath(absUrl) {
  const u = new NodeURL(absUrl);
  if (u.hostname === 'kolo.xyz') {
    // keep same path under /public/
    let p = u.pathname.replace(/^\/+/, '');
    if (!extname(p)) p += '/index.html';
    return join(PUBLIC_DIR, p);
  }
  // CDN: store under /public/cdn/<hash-from-path>
  const safePath = u.pathname.replace(/^\/+/, '').replace(/[^a-zA-Z0-9._/-]/g, '_');
  return join(PUBLIC_DIR, 'cdn', safePath);
}

function assetUrlToPublicHref(absUrl) {
  const u = new NodeURL(absUrl);
  if (u.hostname === 'kolo.xyz') {
    return u.pathname + (u.search || '');
  }
  const safePath = u.pathname.replace(/^\/+/, '').replace(/[^a-zA-Z0-9._/-]/g, '_');
  return '/cdn/' + safePath;
}

// --- main flow --------------------------------------------------------------

async function scrapePage(url) {
  const u = new NodeURL(url);
  const cacheFile = join(SCRAPED_DIR, pathnameToCacheFile(u.pathname));

  let html;
  if (!REFRESH && existsSync(cacheFile)) {
    html = await readFile(cacheFile, 'utf-8');
  } else {
    html = await fetchText(url);
    await mkdir(dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, html);
  }

  // Collect assets
  collectAssetUrlsFromHtml(html, url);

  // Generate .astro page
  const astroFile = pathnameToAstroFile(u.pathname);
  const astroFullPath = join(PAGES_DIR, astroFile);
  const lang = detectLang(u.pathname);
  const layoutImport = relativeImportPath(astroFile, 'layouts/WebflowPage.astro');
  const scrapedImport = relativeImportPath(astroFile, '_scraped/' + pathnameToCacheFile(u.pathname));

  const astroSrc = `---
import WebflowPage from '${layoutImport}';
import rawHtml from '${scrapedImport}?raw';
---
<WebflowPage rawHtml={rawHtml} lang="${lang}" />
`;

  await mkdir(dirname(astroFullPath), { recursive: true });
  await writeFile(astroFullPath, astroSrc);

  return { url, astroFile };
}

async function downloadAsset(absUrl) {
  const localPath = assetUrlToLocalPath(absUrl);
  if (!REFRESH && existsSync(localPath)) return { absUrl, cached: true };
  const buf = await fetchBuffer(absUrl);
  await mkdir(dirname(localPath), { recursive: true });
  await writeFile(localPath, buf);
  // If CSS, scan for nested url(...) references
  if (localPath.endsWith('.css')) {
    collectAssetUrlsFromCss(buf.toString('utf-8'), absUrl);
  }
  return { absUrl, cached: false };
}

async function rewriteCdnReferencesInScrapedHtml() {
  // Rewrite <link>/img/script src that point to CDN → /cdn/... in cached HTML
  // (so the served page references the local copies we downloaded)
  // Only rewrite hosts we actually downloaded.
  // Skip — first version keeps CDN references live so rendering matches 1:1.
  // Toggle later when we want full self-hosting.
}

// --- run --------------------------------------------------------------------

(async () => {
  await mkdir(SCRAPED_DIR, { recursive: true });
  await mkdir(PAGES_DIR, { recursive: true });
  await mkdir(PUBLIC_DIR, { recursive: true });

  log(`📋 Reading sitemap…`);
  const urls = await getSitemapUrls();
  log(`   ${urls.length} URLs (skipping blog: ${!INCLUDE_BLOG})${ONLY ? `, filter: "${ONLY}"` : ''}`);

  log(`\n📄 Downloading pages…`);
  const pagesDone = await pool(urls, CONCURRENCY, async (url) => {
    const r = await scrapePage(url);
    log(`   ✓ ${new NodeURL(url).pathname} → src/pages/${r.astroFile}`);
    return r;
  });
  log(`   ${pagesDone.length} pages`);

  log(`\n🎨 Downloading assets (${assetUrls.size} discovered)…`);
  // Snapshot — pool may discover more assets (from CSS) during download.
  let processed = 0;
  let total = assetUrls.size;
  const seen = new Set();
  while (processed < assetUrls.size) {
    const batch = [...assetUrls].filter((u) => !seen.has(u));
    batch.forEach((u) => seen.add(u));
    if (batch.length === 0) break;
    const results = await pool(batch, CONCURRENCY, downloadAsset);
    processed += results.length;
    total = assetUrls.size;
    log(`   downloaded ${processed}/${total} (CSS may add more)`);
  }
  log(`\n✅ Done.`);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
