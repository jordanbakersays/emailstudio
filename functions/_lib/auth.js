// Password auth with no passwords in code.
// APP_PASSWORD is a Cloudflare secret. Sessions are a signed, expiring cookie
// whose signature is keyed by the password, so changing the password logs
// everyone out.

const enc = new TextEncoder();
export const SESSION_SECONDS = 60 * 60 * 24 * 30; // 30 days

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Compare passwords without leaking length or early-exit timing.
export async function passwordMatches(input, secret) {
  const [a, b] = await Promise.all([
    hmacHex('pw-compare', String(input ?? '')),
    hmacHex('pw-compare', String(secret ?? '')),
  ]);
  return safeEqual(a, b);
}

export async function makeSessionCookie(env, isHttps) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const sig = await hmacHex(env.APP_PASSWORD + ':session', String(exp));
  const parts = [
    `session=${exp}.${sig}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${SESSION_SECONDS}`,
  ];
  if (isHttps) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie(isHttps) {
  const parts = ['session=', 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (isHttps) parts.push('Secure');
  return parts.join('; ');
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

export async function isAuthed(request, env) {
  if (!env.APP_PASSWORD) return false;
  const value = readCookie(request, 'session');
  if (!value) return false;
  const [exp, sig] = value.split('.');
  if (!exp || !sig) return false;
  if (!/^\d+$/.test(exp) || Number(exp) < Math.floor(Date.now() / 1000)) return false;
  const expected = await hmacHex(env.APP_PASSWORD + ':session', exp);
  return safeEqual(sig, expected);
}

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}
