// Vercel Edge Middleware — Basic Auth gate for /migration-status.
//
// Set MIGRATION_STATUS_PASSWORD in Vercel project settings → Environment
// Variables. Username is always "admin". When the password is unset the
// dashboard is accessible to everyone (handy locally; refuse-by-default
// would be safer in shared hosting, but for a Hobby project a reminder
// banner is enough).
//
// Runs at the edge before Astro's static HTML is served, so it works even
// for the fully-static /migration-status/index.html.

export const config = {
  matcher: '/migration-status/:path*',
};

export default function middleware(request) {
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
