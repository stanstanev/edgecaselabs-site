// Password gate for /practice (the piano Play Along app). Everything else on the site is untouched.
// The password lives in the Vercel environment variable PRACTICE_PASSWORD; without it, /practice stays locked.

declare const process: { env: Record<string, string | undefined> };

export const config = {
  matcher: ['/practice', '/practice/:path*'],
  runtime: 'nodejs',
};

const COOKIE = 'practice_session';
const YEAR = 60 * 60 * 24 * 365;

// Same response @vercel/functions' next() builds: let the request through to the static files.
const next = () => new Response(null, { headers: { 'x-middleware-next': '1' } });

async function sessionToken(password: string): Promise<string> {
  const data = new TextEncoder().encode(`play-along:${password}`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
}

function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

function loginPage(message: string, status: number): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Play Along">
<link rel="apple-touch-icon" href="/practice/icon-180.png">
<title>Play Along</title>
<style>
:root { --bg: #f6f3ee; --card: #fff; --ink: #1d2230; --muted: #6b7180; --line: #e2ddd4; --accent: #d9822b; --accent-ink: #fff; --bad: #b3261e; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg: #14171f; --card: #1e222d; --ink: #eef0f4; --muted: #9aa1b0; --line: #2e3442; --accent: #ec9a48; --accent-ink: #1a1206; --bad: #ff8a80; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; background: var(--bg); color: var(--ink);
  font: 16px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
form { width: 100%; max-width: 360px; background: var(--card); border: 1px solid var(--line); border-radius: 18px; padding: 22px; display: grid; gap: 14px; }
h1 { margin: 0; font-size: 26px; }
p { margin: 0; color: var(--muted); }
input { font: inherit; font-size: 18px; height: 52px; padding: 0 14px; border-radius: 12px; border: 2px solid var(--line); background: var(--bg); color: var(--ink); }
input:focus { outline: none; border-color: var(--accent); }
button { font: inherit; font-weight: 700; font-size: 18px; height: 54px; border: 0; border-radius: 14px; background: var(--accent); color: var(--accent-ink); }
.error { color: var(--bad); font-weight: 600; }
</style></head>
<body>
<form method="post" action="/practice/login">
  <h1>Play Along</h1>
  <p>Enter the practice password.</p>
  ${message ? `<p class="error">${message}</p>` : ''}
  <input type="password" name="password" autocomplete="current-password" aria-label="Password" required autofocus>
  <button type="submit">Open</button>
</form>
</body></html>`;
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' },
  });
}

export default async function middleware(request: Request): Promise<Response> {
  const password = process.env.PRACTICE_PASSWORD;
  if (!password) {
    return new Response('The practice area is locked: PRACTICE_PASSWORD is not set in Vercel.', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  const token = await sessionToken(password);
  const url = new URL(request.url);

  if (url.pathname === '/practice/login') {
    if (request.method !== 'POST') return Response.redirect(new URL('/practice/', url), 303);
    const form = await request.formData();
    const given = String(form.get('password') || '');
    if (!sameString(await sessionToken(given), token)) {
      return loginPage("That password didn't match. Try again.", 401);
    }
    return new Response(null, {
      status: 303,
      headers: {
        location: '/practice/',
        'set-cookie': `${COOKIE}=${token}; Path=/practice; Max-Age=${YEAR}; HttpOnly; Secure; SameSite=Lax`,
        'cache-control': 'no-store',
      },
    });
  }

  const session = readCookie(request, COOKIE);
  if (session && sameString(session, token)) return next();

  // The home-screen icon must load before login so "Add to Home Screen" shows it.
  if (url.pathname === '/practice/icon-180.png') return next();
  return loginPage('', 401);
}
