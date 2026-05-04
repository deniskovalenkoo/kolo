# kolo.xyz — Astro mirror of the Webflow site

A 1:1 mirror of [kolo.xyz](https://kolo.xyz) built with Astro.
Same stack as the eResidency site so we don't maintain two different setups.

## Quick start

```bash
npm install
npm run dev          # http://localhost:4321
npm run build        # production build → /dist
```

## Re-scraping from kolo.xyz

The pages under `src/pages/` and assets under `public/cdn/` are generated from
the live kolo.xyz site by the scraper:

```bash
npm run scrape                 # mirrors all sitemap URLs (skips /blog/*)
npm run scrape -- --refresh    # ignore cache, re-download everything
npm run scrape -- --only=/buy  # only URLs whose path contains "/buy"
npm run scrape -- --include-blog
```

## Project layout

```
/
├── astro.config.mjs           # Astro config (static, trailingSlash: never)
├── scripts/
│   └── scrape-webflow.mjs     # mirror script (kolo.xyz → src/pages + public/)
├── src/
│   ├── _scraped/              # raw HTML snapshots from kolo.xyz (committed)
│   ├── layouts/
│   │   └── WebflowPage.astro  # renders raw scraped HTML inside an Astro doc
│   ├── pages/                 # one .astro file per kolo.xyz URL (auto-generated)
│   ├── components/
│   ├── i18n/                  # for new content not from Webflow
│   └── lib/
└── public/
    ├── css/, js/, images/, fonts/   # if anything served from kolo.xyz/<file>
    └── cdn/                          # Webflow CDN assets, mirrored locally
```

## Languages

`en` (default, no prefix), `ua` (`/ua/...`), `ru` (`/ru/...`).

## Deployment

Hosted on Vercel. Pushing to `main` deploys to production automatically.

## Status

- Phase 1 — main pages mirrored 1:1 from kolo.xyz (excluding blog) — **in progress**
- Phase 2 — blog (Sanity CMS) — pending
- Phase 3 — programmatic SEO `crypto-card/*` pages (~41) — pending
