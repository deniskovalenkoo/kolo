#!/usr/bin/env node
/**
 * Audits the current migration state and writes a snapshot to
 * src/data/migration-status.json. The /migration-status dashboard page
 * reads that JSON to render its UI.
 *
 * Run via: npm run audit
 *
 * No network access — everything is computed from local files. Safe to
 * run as often as you want; idempotent.
 */

import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const SCRAPED_DIR = join(ROOT, 'src', '_scraped');
const PAGES_DIR = join(ROOT, 'src', 'pages');
const PUBLIC_DIR = join(ROOT, 'public');
const CDN_DIR = join(PUBLIC_DIR, 'cdn');
const DATA_DIR = join(ROOT, 'src', 'data');
const OUTPUT = join(DATA_DIR, 'migration-status.json');

// ----------------------------------------------------------------------------

async function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

function pickMeta(html, prop) {
  // Match <meta property="X" content="Y"> or content first, property after
  const a = html.match(
    new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']*)["']`, 'i'),
  );
  if (a) return a[1];
  const b = html.match(
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${prop}["']`, 'i'),
  );
  return b ? b[1] : null;
}

function pickMetaName(html, name) {
  const a = html.match(
    new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']*)["']`, 'i'),
  );
  if (a) return a[1];
  const b = html.match(
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${name}["']`, 'i'),
  );
  return b ? b[1] : null;
}

function pickTitle(html) {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? m[1].trim() : null;
}

function detectLang(scrapedFilename) {
  if (scrapedFilename.startsWith('ua__') || scrapedFilename === 'ua.html') return 'ua';
  if (scrapedFilename.startsWith('ru__') || scrapedFilename === 'ru.html') return 'ru';
  return 'en';
}

function pathFromCacheFilename(name) {
  // Reverse of pathnameToCacheFile in scrape-webflow.mjs
  if (name === '_root.html') return '/';
  return '/' + name.replace(/\.html$/, '').replace(/__/g, '/');
}

function categoryFor(path) {
  if (path === '/' || /\/(ua|ru)$/.test(path) || path.endsWith('/old-home')) return 'Home';
  if (/^\/(ua\/|ru\/)?(buy|sell|swap|exchange|exchanger)/.test(path)) return 'Buy/Sell/Swap';
  if (/cryptowallet/.test(path)) return 'Wallet';
  if (/countries/.test(path)) return 'Countries';
  if (/for-business/.test(path)) return 'Business';
  if (/event/.test(path)) return 'Event';
  if (/quiz-collection/.test(path)) return 'Quiz Collections';
  if (/\/quiz\//.test(path)) return 'Quiz';
  if (/help/.test(path)) return 'Help';
  if (/docs|privacy|personal-data/.test(path)) return 'Legal';
  if (/test-page/.test(path)) return 'Test';
  return 'Other';
}

// ----------------------------------------------------------------------------

async function auditPages() {
  const files = (await readdir(SCRAPED_DIR)).filter((f) => f.endsWith('.html'));
  const pages = [];

  for (const f of files) {
    const fullPath = join(SCRAPED_DIR, f);
    const html = await readFile(fullPath, 'utf-8');
    const sz = (await stat(fullPath)).size;

    const path = pathFromCacheFilename(f);
    const lang = detectLang(f);
    const title = pickTitle(html);
    const description =
      pickMetaName(html, 'description') || pickMeta(html, 'og:description') || null;
    const ogImage = pickMeta(html, 'og:image');
    const canonical = (() => {
      const m = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
      return m ? m[1] : null;
    })();

    const issues = [];
    if (!title) issues.push('Missing <title>');
    else if (title.length > 60) issues.push(`Title too long (${title.length} > 60)`);
    if (!description) issues.push('Missing meta description');
    else if (description.length < 50) issues.push(`Description too short (${description.length} < 50)`);
    else if (description.length > 160) issues.push(`Description too long (${description.length} > 160)`);
    if (!ogImage) issues.push('Missing og:image');
    if (sz > 250_000) issues.push(`Page > 250 KB (${(sz / 1024).toFixed(0)} KB)`);

    // Detect leftover Webflow CDN refs (excluding the harmless preconnect link)
    const stalePattern = /https:\/\/cdn\.prod\.website-files\.com\/[^"'\s]+\.[a-z]{2,4}/gi;
    const staleRefs = [...html.matchAll(stalePattern)].length;
    if (staleRefs > 0) issues.push(`${staleRefs} unmigrated Webflow CDN URL(s)`);

    pages.push({
      path,
      lang,
      category: categoryFor(path),
      title: title || '',
      description: description || '',
      descriptionLength: description?.length || 0,
      titleLength: title?.length || 0,
      ogImage: ogImage || null,
      canonical: canonical || null,
      sizeBytes: sz,
      issues,
      hasIssues: issues.length > 0,
    });
  }

  pages.sort((a, b) => a.path.localeCompare(b.path));
  return pages;
}

// ----------------------------------------------------------------------------

async function auditAssets() {
  const files = await walk(CDN_DIR);
  let totalSize = 0;
  for (const f of files) totalSize += (await stat(f)).size;
  return { count: files.length, totalSizeBytes: totalSize };
}

async function auditAstroPages() {
  const files = (await walk(PAGES_DIR)).filter((f) => f.endsWith('.astro'));
  return files.length;
}

// ----------------------------------------------------------------------------

async function buildChecklist(pages, assets) {
  const c = (id, label, category, status, details) => ({
    id,
    label,
    category,
    status,
    details: details || '',
  });

  const checklist = [];

  // -- Infrastructure --
  checklist.push(
    c(
      'self-hosted-cdn',
      'All assets self-hosted (no Webflow CDN runtime deps)',
      'Infrastructure',
      pages.every((p) => !p.issues.some((i) => i.includes('Webflow CDN'))) ? 'done' : 'todo',
      pages.filter((p) => p.issues.some((i) => i.includes('Webflow CDN'))).length === 0
        ? 'No unmigrated CDN URLs detected.'
        : `${pages.filter((p) => p.issues.some((i) => i.includes('Webflow CDN'))).length} pages still reference Webflow CDN.`,
    ),
  );

  checklist.push(
    c(
      '404-page',
      'Custom 404 page exists',
      'Infrastructure',
      existsSync(join(PAGES_DIR, '404.astro')) ? 'done' : 'todo',
      existsSync(join(PAGES_DIR, '404.astro'))
        ? 'src/pages/404.astro present.'
        : 'Add src/pages/404.astro for a branded 404 instead of Vercel default.',
    ),
  );

  checklist.push(
    c(
      'dns-ready',
      'DNS for kolo.xyz ready to switch to Vercel',
      'Infrastructure',
      'todo',
      'Manual step before launch — add domain in Vercel project, update DNS at registrar.',
    ),
  );

  checklist.push(
    c(
      'kolo-in-redirect',
      'kolo.in → kolo.xyz redirect set up',
      'Infrastructure',
      'todo',
      '120 internal links point at https://kolo.in/... — those need to resolve after the cutover.',
    ),
  );

  // -- SEO --
  checklist.push(
    c(
      'sitemap',
      'sitemap.xml accessible',
      'SEO',
      existsSync(join(PUBLIC_DIR, 'sitemap.xml')) || existsSync(join(PAGES_DIR, 'sitemap.xml.js'))
        ? 'done'
        : 'todo',
      'Astro can generate a sitemap via @astrojs/sitemap, or copy sitemap.xml from kolo.xyz into public/.',
    ),
  );

  checklist.push(
    c(
      'robots',
      'robots.txt configured',
      'SEO',
      existsSync(join(PUBLIC_DIR, 'robots.txt')) ? 'done' : 'todo',
      'Add public/robots.txt to allow indexing on prod and block on preview.',
    ),
  );

  const allHaveOg = pages.every((p) => p.ogImage);
  checklist.push(
    c(
      'og-images',
      'Every page has og:image',
      'SEO',
      allHaveOg ? 'done' : 'warn',
      allHaveOg
        ? `${pages.length}/${pages.length} pages have og:image.`
        : `${pages.filter((p) => p.ogImage).length}/${pages.length} pages have og:image.`,
    ),
  );

  const allHaveDesc = pages.every((p) => p.description);
  checklist.push(
    c(
      'meta-descriptions',
      'Every page has meta description',
      'SEO',
      allHaveDesc ? 'done' : 'warn',
      allHaveDesc
        ? `${pages.length}/${pages.length} pages have descriptions.`
        : `${pages.filter((p) => !p.description).length} pages are missing descriptions.`,
    ),
  );

  // -- Content --
  const hasBlog = (await walk(PAGES_DIR)).some((f) => f.includes('/blog/'));
  checklist.push(
    c(
      'blog-migrated',
      'Blog (~120 posts) migrated',
      'Content',
      hasBlog ? 'done' : 'todo',
      hasBlog
        ? 'Blog pages present in src/pages/.'
        : 'Currently /blog and /blog/* pages do not exist — losing all blog SEO if cutover happens before this is done.',
    ),
  );

  // -- Functional --
  let formCount = 0;
  let wfFormCount = 0;
  for (const p of pages) {
    const file = await readFile(
      join(SCRAPED_DIR, p.path === '/' ? '_root.html' : p.path.slice(1).replace(/\//g, '__') + '.html'),
      'utf-8',
    ).catch(() => '');
    formCount += (file.match(/<form\b/g) || []).length;
    wfFormCount += (file.match(/wf-form/g) || []).length;
  }
  checklist.push(
    c(
      'forms-verified',
      'Forms verified or replaced',
      'Functional',
      'todo',
      `${formCount} form tags total. Most are likely Finsweet cookie consent (frontend only). ${wfFormCount} wf-form references — those would post to webflow.com and break after cutover.`,
    ),
  );

  // -- Tracking --
  const homepageHtml = await readFile(join(SCRAPED_DIR, '_root.html'), 'utf-8').catch(() => '');
  const hasGA = /G-[A-Z0-9]{6,}/.test(homepageHtml);
  const hasGTM = /GTM-[A-Z0-9]{6,}/.test(homepageHtml);
  checklist.push(
    c(
      'analytics',
      'GA4 / GTM wired up',
      'Tracking',
      hasGA && hasGTM ? 'done' : 'warn',
      hasGA && hasGTM
        ? 'Both GA4 and GTM detected on homepage.'
        : `GA4: ${hasGA ? '✅' : '❌'}, GTM: ${hasGTM ? '✅' : '❌'}`,
    ),
  );

  // -- Legal --
  const hasPrivacy = pages.some((p) => /privacy|personal-data/.test(p.path));
  checklist.push(
    c(
      'privacy',
      'Privacy policy / data deletion accessible',
      'Legal',
      hasPrivacy ? 'done' : 'todo',
      hasPrivacy ? 'Pages found in src/pages/.' : 'Add privacy/terms pages.',
    ),
  );

  return checklist;
}

// ----------------------------------------------------------------------------

(async () => {
  console.log('🔍 Auditing migration state…');
  const pages = await auditPages();
  console.log(`   ✓ ${pages.length} pages scanned`);

  const assets = await auditAssets();
  console.log(`   ✓ ${assets.count} assets, ${(assets.totalSizeBytes / 1024 / 1024).toFixed(1)} MB`);

  const astroPages = await auditAstroPages();
  console.log(`   ✓ ${astroPages} .astro routes`);

  const checklist = await buildChecklist(pages, assets);

  const langs = [...new Set(pages.map((p) => p.lang))].sort();
  const uniquePaths = [...new Set(pages.map((p) => p.path.replace(/^\/(ua|ru)/, '')))].length;

  const totalIssues = pages.reduce((acc, p) => acc + p.issues.length, 0);
  const checklistDone = checklist.filter((c) => c.status === 'done').length;
  const checklistTotal = checklist.length;
  const healthScore = Math.round(
    (checklistDone / checklistTotal) * 0.6 * 100 +
      (1 - Math.min(totalIssues / pages.length, 1)) * 0.4 * 100,
  );

  const data = {
    generatedAt: new Date().toISOString(),
    site: {
      name: 'kolo',
      deployUrl: 'https://kolo-seven.vercel.app',
      sourceUrl: 'https://kolo.xyz',
      repoUrl: 'https://github.com/deniskovalenkoo/kolo',
    },
    overview: {
      totalPages: pages.length,
      uniquePaths,
      languages: langs,
      assetsCount: assets.count,
      assetsSizeBytes: assets.totalSizeBytes,
      astroRoutes: astroPages,
      totalIssues,
      checklistDone,
      checklistTotal,
      healthScore,
    },
    pages,
    checklist,
  };

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(OUTPUT, JSON.stringify(data, null, 2));
  const checks = `${checklistDone}/${checklistTotal}`;
  console.log(`\n📊 Health score: ${healthScore}/100 — checklist ${checks}, page issues ${totalIssues}`);
  console.log(`   Output: ${relative(ROOT, OUTPUT)}`);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
