#!/usr/bin/env node
/**
 * Rewrites Webflow CDN URLs to local /cdn/ paths.
 *
 * Run after `scrape-webflow.mjs` so local copies exist in public/cdn/.
 * Operates on:
 *   - All HTML files under src/_scraped/
 *   - All CSS files under public/cdn/ (which themselves reference more CDN URLs)
 *
 * Sanitization MUST match scrape-webflow.mjs `assetUrlToLocalPath` — both
 * functions translate URL pathnames to filesystem paths the same way, otherwise
 * rewritten <link>/img/etc URLs won't match the files on disk.
 *
 * Idempotent: running twice is a no-op (regex won't match anymore).
 *
 * Verifies after rewrite: any /cdn/<path> reference must exist on disk.
 * Missing files are logged so you can re-run the scraper for them.
 */

import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const SCRAPED_DIR = join(ROOT, 'src', '_scraped');
const PUBLIC_CDN_DIR = join(ROOT, 'public', 'cdn');

// HTML context: URLs live inside attribute quotes (`src="..."`, `srcset="..."`).
// `)` is allowed inside the URL because Webflow file names frequently have
// parens (e.g. `bg iban (2).avif`) — stopping at `)` would truncate the URL
// before `.avif` and leave a stale `)` in the rewritten HTML pointing at a
// non-existent file.
const CDN_HOST_RE_HTML = /https:\/\/cdn\.prod\.website-files\.com\/([^"'\s<>&]*)/g;

// CSS context: URLs live inside `url(...)` and may not have surrounding
// quotes, so `)` MUST be a stop char or we slurp the entire @font-face
// declaration (`url(.../foo.otf) format("opentype")`).
const CDN_HOST_RE_CSS = /https:\/\/cdn\.prod\.website-files\.com\/([^"'\s<>&)]*)/g;

// Must match scrape-webflow.mjs assetUrlToLocalPath sanitization:
//   safePath = pathname.replace(/^\/+/, '').replace(/[^a-zA-Z0-9._/-]/g, '_')
function sanitizePath(pathPart) {
  return pathPart.replace(/^\/+/, '').replace(/[^a-zA-Z0-9._/-]/g, '_');
}

const referencedPaths = new Set();

async function rewriteFile(path) {
  const original = await readFile(path, 'utf-8');
  let rewriteCount = 0;
  // Pick the regex matching this file's syntax — see the comment above
  // each regex for why HTML and CSS need different stop sets.
  const re = path.endsWith('.css') ? CDN_HOST_RE_CSS : CDN_HOST_RE_HTML;
  let updated = original.replace(re, (_match, pathPart) => {
    const safe = sanitizePath(pathPart);
    referencedPaths.add(safe);
    rewriteCount++;
    return '/cdn/' + safe;
  });
  // One-shot fixup for HTML files: legacy passes (before the regex split)
  // left some `/cdn/...)...` URLs with a stray `)` from Webflow filenames
  // like `bg iban (2).avif` — turn the `)` into `_` so the rewritten URL
  // matches the on-disk filename.
  if (!path.endsWith('.css')) {
    updated = updated.replace(/\/cdn\/[^"'\s<>]*?\)[^"'\s<>]*\.[a-zA-Z0-9]{2,5}/g, (m) => {
      const fixed = m.replace(/\)/g, '_');
      if (fixed !== m) {
        const safe = fixed.replace(/^\/cdn\//, '');
        referencedPaths.add(safe);
        rewriteCount++;
      }
      return fixed;
    });
  }
  // Strip Subresource Integrity (SRI) from any <link>/<script> tag pointing to /cdn/.
  // Webflow ships SRI hashes computed against the original CDN file. Once we rewrite
  // URLs inside CSS files (which the URL pass above does), the file bytes change and
  // the hash no longer matches → browser refuses to load the file → site renders
  // unstyled. Local-hosted assets don't need SRI (we control the file).
  if (path.endsWith('.html')) {
    updated = updated.replace(
      /<(link|script)\b[^>]*?\b(href|src)=["']\/cdn\/[^"']+["'][^>]*>/g,
      (match) => {
        const cleaned = match
          .replace(/\s+integrity="[^"]*"/g, '')
          .replace(/\s+crossorigin="[^"]*"/g, '');
        if (cleaned !== match) rewriteCount++;
        return cleaned;
      },
    );
  }
  if (updated !== original) {
    await writeFile(path, updated);
  }
  return rewriteCount;
}

async function walk(dir, ext) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full, ext)));
    } else if (entry.name.endsWith(ext)) {
      out.push(full);
    }
  }
  return out;
}

console.log('🔄 Rewriting CDN URLs in scraped HTML…');
const htmlFiles = await walk(SCRAPED_DIR, '.html');
let htmlRewrites = 0;
for (const f of htmlFiles) htmlRewrites += await rewriteFile(f);
console.log(`   ${htmlRewrites} URL rewrites across ${htmlFiles.length} HTML files`);

console.log('🔄 Rewriting CDN URLs in mirrored CSS…');
const cssFiles = await walk(PUBLIC_CDN_DIR, '.css');
let cssRewrites = 0;
for (const f of cssFiles) cssRewrites += await rewriteFile(f);
console.log(`   ${cssRewrites} URL rewrites across ${cssFiles.length} CSS files`);

console.log('\n🔍 Verifying every referenced /cdn/ file exists on disk…');
const missing = [];
for (const safePath of referencedPaths) {
  const localPath = join(PUBLIC_CDN_DIR, safePath);
  if (!existsSync(localPath)) missing.push(safePath);
}

if (missing.length === 0) {
  console.log(`   ✅ All ${referencedPaths.size} referenced files exist locally.`);
} else {
  // Common harmless cases:
  //   - merged/garbage URLs from broken Webflow source (e.g. URL strings with embedded
  //     `_https_//` because the source HTML literally concatenates two URLs without separator)
  //   - JSON/Lottie config strings inside data-* attributes that the browser never fetches
  // We log the count but don't fail — the page still renders correctly because the
  // browser only requests resources from real DOM tags, not these literal strings.
  const garbage = missing.filter((m) => /_https_|_quot_/.test(m));
  const real = missing.filter((m) => !/_https_|_quot_/.test(m));
  console.log(`   ⚠️  ${missing.length}/${referencedPaths.size} referenced paths missing:`);
  console.log(`      - ${garbage.length} look like malformed source HTML (safe to ignore)`);
  console.log(`      - ${real.length} look like real assets that didn't download`);
  if (real.length) {
    console.log(`   Real-asset misses:`);
    for (const m of real.slice(0, 20)) console.log(`      - /cdn/${m}`);
    if (real.length > 20) console.log(`      … and ${real.length - 20} more`);
    console.log(`   To retry: npm run scrape -- --refresh`);
  }
}
