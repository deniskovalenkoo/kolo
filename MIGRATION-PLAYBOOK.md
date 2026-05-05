# Webflow → Astro + Vercel migration playbook

A repeatable process to mirror any Webflow site as a static Astro project hosted on Vercel.
Same stack as the eResidency project — see `INFRASTRUCTURE.md` of that repo for reference architecture.

**Time budget for a typical site (60–150 pages):** 1.5–2 hours of human time, 10–20 min of waiting.

---

## When to use this playbook

You're migrating an existing Webflow site to a hand-controllable codebase because you want:
- Cheaper hosting (Vercel Hobby is free, Pro is ~$20/mo per project; Webflow CMS plans start at $29/mo)
- Faster pages (Astro ships 0 KB of JS by default)
- Code ownership (git history, PRs, rollback to any commit)
- AI-driven editing (this playbook + Claude Code unlock copy/translation edits in plain language)
- Programmatic SEO (auto-generate hundreds of landing pages)

If the source isn't Webflow, skip the scrape step and adapt — the rest stays the same.

---

## Prerequisites (one-time, per machine)

| What | Why | How |
|---|---|---|
| **Node.js 20+** | Run Astro and the scraper | https://nodejs.org → LTS |
| **Git** | Version control | macOS: `xcode-select --install`. Or GitHub Desktop. |
| **GitHub account** | Host the repo + give Claude push access | https://github.com/signup |
| **Vercel account** | Hosting + auto-deploy | https://vercel.com/signup → "Continue with GitHub" |
| **SSH key in GitHub** | Lets Claude push from CLI | See "GitHub auth" section below |
| **Claude Code (this tool)** | Drives the migration | Already in use. |

---

## Phase 0 — Discovery (10 min)

**Goal:** know what you're migrating before writing a single line of code.

1. **Read the source sitemap** to count pages and detect languages:
   ```bash
   curl -s https://YOUR-SITE.com/sitemap.xml | grep -oE '<loc>[^<]+</loc>' | sed 's/<\/\?loc>//g' | sort -u | tee /tmp/sitemap.txt | wc -l
   ```
2. **Detect language sub-paths** (look for `/ru/`, `/ua/`, `/de/`, etc.):
   ```bash
   awk -F'/' '{print "/"$4}' /tmp/sitemap.txt | sort -u | head
   ```
3. **Find tracking IDs** (you'll need these later for Phase 4 analytics):
   ```bash
   curl -s https://YOUR-SITE.com/ | grep -oE '(G-[A-Z0-9]+|GTM-[A-Z0-9]+|UA-[0-9-]+)' | sort -u
   ```
4. **Note the technical specifics** — write them down, you'll feed this to Claude later:
   - Source platform (Webflow / Wix / WordPress / hand-coded)
   - Languages (and which is the default — the one without a URL prefix)
   - URL pattern (trailing slash? `/page` or `/page/`?)
   - Forms? — destinations (waitlist, contact, etc.)
   - Blog / CMS? — current platform, is migration needed
   - Existing analytics (GA4, GTM, Facebook Pixel, etc.)
   - Anything dynamic (auth, dashboards) — these usually CAN'T be statically mirrored

**Output:** a one-paragraph brief you'll paste to Claude at the start of Phase 1.

---

## Phase 1 — Local project + GitHub auth (15 min)

### 1.1 Create a working directory
```bash
mkdir -p ~/Documents/SITE-NAME && cd ~/Documents/SITE-NAME
```

### 1.2 Configure git identity (once per machine; skip if already set)
```bash
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
git config --global init.defaultBranch main
```

### 1.3 Set up GitHub auth via SSH (once per machine)

Generate the key:
```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_github -N "" -C "your-email@example.com"
cat > ~/.ssh/config <<'EOF'
Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_github
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config
cat ~/.ssh/id_ed25519_github.pub        # copy this
```

Add to GitHub:
1. Open https://github.com/settings/ssh/new
2. Paste the public key, give it a title like "Mac — site-name"
3. Save → enter your GitHub password when prompted

Verify:
```bash
ssh -T git@github.com    # expect: "Hi YOUR-USERNAME!"
```

### 1.4 Create the GitHub repo

You must do this in the browser — Claude can't create repos for you.

1. Open https://github.com/new
2. Name: `your-site-name`
3. Owner: your GitHub user or org
4. Visibility: **Private** for client work, **Public** for open code
5. Do NOT add README/.gitignore/license (we'll commit our own)
6. Click "Create repository"
7. Copy the SSH URL: `git@github.com:USER/REPO.git`

### 1.5 Initialize the Astro project

In the working directory, ask Claude:
> "Initialize an Astro 5 project with TypeScript strict, static output, trailingSlash: never, and the same structure as the kolo migration. Languages are XX/YY/ZZ with XX as default. Add a .gitignore, README, CLAUDE.md, .env.example. Do not run `npm install` yet."

Or copy these files manually from this repo:
- `package.json`, `astro.config.mjs`, `tsconfig.json`, `.gitignore`, `.env.example`
- `src/layouts/WebflowPage.astro`
- `scripts/scrape-webflow.mjs` (edit `SITE` constant at top)

Install:
```bash
npm install
```

### 1.6 Wire up the GitHub remote
```bash
git init
git remote add origin git@github.com:USER/REPO.git
```

---

## Phase 2 — Scrape and mirror (10–20 min, mostly waiting)

### 2.1 Tweak the scraper for this site

Open `scripts/scrape-webflow.mjs` and adjust:
- `SITE` → the source URL (`https://your-site.com`)
- `SKIP_PATTERNS` → which paths to skip (usually `/blog/*` if migrating later, or any auth-walled paths)
- `CDN_HOST` → if the source uses a different CDN (Webflow uses `cdn.prod.website-files.com`)

### 2.2 Run a dry pass on one page first

```bash
npm run scrape -- --only=/some-known-path
```

Check that:
- An `.astro` page was generated under `src/pages/`
- The matching raw HTML landed in `src/_scraped/`
- Some assets were downloaded to `public/cdn/`
- `npm run dev` serves the page without 500 errors

### 2.3 Run the full scrape

```bash
npm run scrape           # uses cache
# or
npm run scrape -- --refresh    # ignore cache
```

This downloads:
- All sitemap URLs (except SKIP_PATTERNS) → `src/_scraped/*.html`
- All same-origin assets and CDN-hosted assets → `public/`

### 2.4 Verify locally

```bash
npm run dev    # http://localhost:4321
npm run build  # must pass without errors before committing
```

Open the local URLs in a browser and click around. They should look identical to the source site.

**Expected gotchas at this stage:**
- Build fails with "Could not import" → check the relative path generated in `src/pages/*.astro`. The script computes paths relative to `src/pages/` — verify with the homepage `src/pages/index.astro`.
- Pages render but assets 404 → check `public/cdn/` was populated. If empty, the scraper's asset-extension filter may be too aggressive — log `assetUrls` in the scraper to see what was queued.
- A specific page is missing → it wasn't in the sitemap. Add it manually to the URL list in the scraper or curl + paste.

### 2.5 Stage and commit

```bash
git add -A
git status --short | wc -l    # sanity-check the file count
git commit -m "Initial Webflow → Astro mirror"
git push -u origin main
```

---

## Phase 3 — Vercel deploy (5–10 min)

### 3.1 Connect the repo
1. Open https://vercel.com/new
2. Find the repo in the list → "Import"
3. Accept the auto-detected Astro preset
4. No environment variables needed yet
5. Click "Deploy" → wait 1–2 min
6. Vercel returns a `*.vercel.app` URL

### 3.2 Verify the deploy

```bash
curl -sI https://your-site.vercel.app/ | head -1                   # expect 200
curl -s https://your-site.vercel.app/ | wc -c                       # compare to source
diff <(curl -s https://your-site.com/) <(curl -s https://your-site.vercel.app/) | head -30
```

If the diff is "67 bytes" small (whitespace, Webflow build comments, attribute order) — you're good.
If the diff is huge — something's wrong in the layout or scraper output. Inspect.

### 3.3 Auto-deploy is now wired up

Every push to `main` triggers a Vercel deploy. Rollback via Vercel UI: Project → Deployments → ⋯ → Promote to Production.

---

## Phase 4 — Optional add-ons

These are independent — pick what you need.

### 4.1 Connect the real domain
Vercel → Project → Settings → Domains → Add → enter `your-site.com` → follow DNS instructions.
Plan the cutover: on the day of switch, lower the old DNS TTL to 60s a day in advance.

### 4.2 Add analytics
Add to `src/layouts/WebflowPage.astro` (or a new layout for hand-built pages):
```astro
<!-- Google Analytics 4 -->
<script async src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`}></script>
<script set:html={`window.dataLayer = window.dataLayer || []; function gtag(){dataLayer.push(arguments);} gtag('js', new Date()); gtag('config', '${GA_ID}');`}></script>
```
Or, since this is a Webflow mirror, the original `<script>` tags are usually already in the scraped `<head>` — verify with curl + grep. Just check the IDs are correct for the new site.

For privacy-respecting analytics you may want **Vercel Analytics** + **Speed Insights** instead:
```bash
npm install @vercel/analytics @vercel/speed-insights
```
Then in the layout:
```astro
---
import Analytics from '@vercel/analytics/astro';
import SpeedInsights from '@vercel/speed-insights/astro';
---
<Analytics />
<SpeedInsights />
```

### 4.3 Self-host the CDN assets — **REQUIRED before disconnecting the source**

By default the scraped HTML still references `cdn.prod.website-files.com` (Webflow's CDN).
While the source Webflow site stays alive, those URLs work — but the moment you cancel
the Webflow plan or the source project gets deleted, the CDN goes with it and your
mirror loses every image, font, and stylesheet.

**Before switching DNS to the new mirror, run self-hosting.**

The scraper already downloaded all referenced CDN assets into `public/cdn/`. The
`scripts/self-host-cdn.mjs` script rewrites every `https://cdn.prod.website-files.com/<path>`
reference inside scraped HTML and CSS to `/cdn/<sanitized-path>` — pointing browsers
at your Vercel deployment instead of Webflow.

```bash
npm run self-host-cdn
```

The script:
1. Walks `src/_scraped/*.html` and `public/cdn/**/*.css`, rewrites CDN URLs to `/cdn/...`
2. Verifies every rewritten reference exists on disk
3. Reports any missing files, separating real misses from broken-source-HTML noise

Idempotent — running twice is a no-op.

#### What to watch for

- **The scraper's URL discovery must catch `<meta>` tags too.** Open Graph and Twitter
  card images live in `<meta property="og:image" content="...">`, not in `<link>`/`<img>`.
  If you skip these, the og:image returns 404 after self-hosting. The scraper here
  includes a catch-all pattern for `https://(yoursite|cdn-host)/...` that covers this.

- **HTML entity-encoded URLs trip up regex extraction.** Some Webflow attributes embed
  JSON-encoded URLs separated by `&quot;`, e.g.
  `data-bg="https://cdn.prod.../foo.mp4&quot;https://cdn.prod.../bar.webm"`. A naive
  regex captures both URLs as one mangled string. Fix: include `&` in the URL
  stop-char set so the regex stops at the entity boundary.

- **Some "missing" references are broken at the source.** Webflow occasionally emits
  HTML where two URLs are concatenated literally with no separator (look for `_https_//`
  in the safe-path output). The browser ignores these — they live in CSS `url()` calls
  or data-attrs that are never evaluated. The script labels these as "malformed source
  HTML (safe to ignore)".

- **`%2F`-encoded slashes survive sanitization as `_2F`.** Webflow sometimes URL-encodes
  the slashes in CDN paths (`/path%2Fto%2Ffile.png`). The sanitizer treats `%` as a
  special char and rewrites to `_2F`. As long as the scraper and the rewriter use the
  same sanitizer function, the rewritten reference and the file on disk match.

- **`<link rel="preconnect" href="https://cdn.prod.website-files.com">`** stays in the
  HTML even after self-hosting. It's harmless (browser opens a connection but never
  loads anything from it), but if you want a fully clean diff, add an extra rewrite
  step to drop those preconnect tags.

After self-hosting, repeat the size check:
```bash
diff <(curl -s https://your-vercel-url/) <(curl -s https://your-source.com/) | wc -l
```
The diff grows (because every CDN URL changed), but visiting the page in a browser
should look identical and DevTools → Network should show all assets loading from
your Vercel domain.

### 4.4 Add a CMS for a blog

Two patterns work — see "Blog content strategy" in the project README.

- **Sanity Studio** (recommended for non-tech editors): free, visual editor, same setup as eResidency. ~30 min.
- **Notion as CMS**: pull posts from a Notion database at build time. Good if the team already lives in Notion. ~45 min.
- **Markdown in repo**: simplest for devs, hardest for non-tech editors.

### 4.5 Programmatic SEO pages

Pattern: one Astro template + a CSV/JSON data file → generates N pages at build time.
See `WEBFLOW_PROGRAMMATIC_SEO_BRIEF.md` for the kolo crypto-card example (~41 pages across 5 languages).

---

## Repeating this for a new site (quick reference)

After the first migration, the repeatable steps boil down to:

1. (5 min) Phase 0 — discovery: inventory pages, languages, tracking IDs.
2. (5 min) `mkdir`, copy template files from this repo, edit `SITE` constant in scraper.
3. (5 min) Create new GitHub repo, `git init`, add remote.
4. (10 min) `npm install` && `npm run scrape` && verify locally.
5. (5 min) `npm run self-host-cdn` && verify dev server still renders. (Phase 4.3 — do this NOW for new sites, not later. The sooner you cut the source CDN dependency, the lower the risk that you forget before going live.)
6. (5 min) Push to GitHub, import into Vercel, click Deploy.
7. (5 min) Smoke-test the Vercel URL.

**Total: ~40 min for a new mirror.** First time is slower because of the auth setup.

---

## Common gotchas (bookmark this list)

| Symptom | Cause | Fix |
|---|---|---|
| `git push` asks for password | SSH key not added to GitHub | Re-do step 1.3 |
| `Permission denied (publickey)` | SSH key permissions wrong | `chmod 600 ~/.ssh/id_ed25519_github` |
| Astro build error: "Could not import `./layouts/WebflowPage.astro`" | Relative path bug — pages 1 level deep need `../`, not `./` | Re-check `relativeImportPath` in scraper |
| Page count in `src/pages/` matches but `public/` has rogue dirs | Asset filter let canonical/page URLs through | Confirm `ASSET_EXT_RE` in scraper covers your site, then `rm -rf public/<rogue-dir>` |
| Pages render in dev but Vercel returns 404 | `trailingSlash` mismatch | Set `trailingSlash: 'never'` in `astro.config.mjs` for sites that use `/foo` |
| Vercel build OOMs | Too many pages × big HTML | Move scraped HTML out of `src/_scraped/`, keep only relative imports — Vite hits memory limits with 500+ raw imports |
| Quotes break in zsh: `git add src/pages/[lang]/foo` | zsh expands `[lang]` as a glob | Quote: `git add 'src/pages/[lang]/foo'` |
| Source site has `Last-Modified` Webflow comment that breaks our diff | Webflow build artifact | Cosmetic, ignore — our scraper already strips it |

---

## Roles & ongoing workflow

After the migration, your team can use this content split (mirrors the eResidency `ONBOARDING.md`):

- **Content Editor** — uses Sanity Studio (if Phase 4.4 done). No code, no terminal.
- **Designer** — clones the repo via GitHub Desktop, edits `.astro` files locally with Claude Desktop, commits via GitHub Desktop UI.
- **Developer** — full CLI access, can re-scrape, refactor, set up forms, edit the scraper.
- **Admin** — owns the Vercel project, manages GitHub access, handles domain/DNS.

Push to `main` = production deploy in ~1 min. Roll back via Vercel UI in seconds.

---

## What this playbook intentionally does NOT do

- **Doesn't redesign the site.** A 1:1 mirror keeps the original look. Redesign is a separate phase, after the mirror is live and the team is comfortable editing.
- **Doesn't migrate CMS data automatically.** Blog posts, FAQs, partner lists — these are explicit Phase 4.4 work.
- **Doesn't set up forms.** Webflow forms post to Webflow's backend; once you cut over, you need a replacement (Notion + Vercel function, Resend, etc.). Plan it before the cutover.
- **Doesn't handle dynamic features.** Member-only areas, cart/checkout, dashboards — those need a real backend, not a static mirror.

If any of those apply, scope them as separate engagements after Phase 3 is live.
