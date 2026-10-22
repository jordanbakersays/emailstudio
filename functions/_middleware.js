import { isAuthed, json } from './_lib/auth.js';

// Everything under /api/ requires a valid session, except login and the
// session check. Images under /img/ are public on purpose (email clients
// must be able to load them), and static files are public.
const PUBLIC_API = new Set(['/api/login', '/api/session']);

export async function onRequest(context) {
  const { request, env, next } = context;
  const { pathname } = new URL(request.url);

  if (pathname.startsWith('/api/') && !PUBLIC_API.has(pathname)) {
    if (!env.APP_PASSWORD) {
      return json({ error: 'APP_PASSWORD secret is not set on the server.' }, 500);
    }
    if (!(await isAuthed(request, env))) {
      return json({ error: 'Not signed in' }, 401);
    }
  }
  return next();
}
