import { passwordMatches, makeSessionCookie, json } from '../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  if (!env.APP_PASSWORD) {
    return json({ error: 'APP_PASSWORD secret is not set on the server.' }, 500);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Bad request' }, 400);
  }

  const ok = await passwordMatches(body && body.password, env.APP_PASSWORD);
  if (!ok) {
    // Small delay slows down guessing.
    await new Promise((r) => setTimeout(r, 800));
    return json({ error: 'Wrong password' }, 401);
  }

  const isHttps = new URL(request.url).protocol === 'https:';
  return json({ ok: true }, 200, { 'Set-Cookie': await makeSessionCookie(env, isHttps) });
}
