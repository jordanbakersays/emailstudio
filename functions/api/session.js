import { isAuthed, clearSessionCookie, json } from '../_lib/auth.js';

// GET  -> { authed: true|false }
// DELETE -> log out
export async function onRequestGet({ request, env }) {
  return json({ authed: await isAuthed(request, env) });
}

export async function onRequestDelete({ request }) {
  const isHttps = new URL(request.url).protocol === 'https:';
  return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie(isHttps) });
}
