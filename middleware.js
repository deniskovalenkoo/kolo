// Vercel Edge Middleware. Two jobs:
//
// 1. Basic-Auth gate for /migration-status (admin dashboard).
//    Set MIGRATION_STATUS_PASSWORD in Vercel env vars. Username is always
//    "admin". When the password is unset the dashboard is accessible to
//    everyone (handy locally; for a Hobby project the noindex on the page
//    is the second line of defence).
//
// 2. 301 redirects for /ua and /ru main pages → English equivalent.
//    On kolo.xyz the /ua and /ru locales were never actually translated for
//    main pages (Buy / Sell / Quiz / etc.) — they were URL aliases serving
//    English content. We dropped the duplicate Astro pages; this redirect
//    catches old bookmarks and external links so nothing 404s. The blog
//    paths /ua/blog/* and /ru/blog/* DO have real translated content and
//    are left alone.
//
// Runs at the edge before Astro's static HTML is served, so it works
// for fully-static routes.

export const config = {
  matcher: ['/migration-status/:path*', '/ua', '/ua/:path*', '/ru', '/ru/:path*'],
};

export default function middleware(request) {
  const url = new URL(request.url);
  const { pathname } = url;

  // --- /migration-status auth ---
  if (pathname.startsWith('/migration-status')) {
    const expected = process.env.MIGRATION_STATUS_PASSWORD;
    if (!expected) return; // unset → allow through (dev / first-deploy)

    const auth = request.headers.get('authorization');
    if (auth) {
      const [scheme, encoded] = auth.split(' ');
      if (scheme === 'Basic' && encoded) {
        const decoded = atob(encoded);
        const [user, pass] = decoded.split(':');
        if (user === 'admin' && pass === expected) {
          return; // pass through
        }
      }
    }
    return new Response('Migration Status — auth required', {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm="Migration Status"',
        'Content-Type': 'text/plain',
      },
    });
  }

  // --- /ua and /ru non-blog → 301 redirect to EN equivalent ---
  const langMatch = pathname.match(/^\/(ua|ru)(\/.*)?$/);
  if (langMatch) {
    const subpath = langMatch[2] || '';
    // /ua/blog and /ru/blog have real translated content — leave them alone.
    if (subpath.startsWith('/blog')) return;
    const target = subpath || '/';
    return Response.redirect(new URL(target, url.origin).toString(), 301);
  }
}
