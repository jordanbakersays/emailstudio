// Public image URLs used inside your emails:  https://your-domain/img/<key>
// No login required (email apps must be able to fetch them).
// Keys are random and never reused, so the files are cached for a year.

const KEY_RE = /^[a-z0-9][a-z0-9.-]{3,120}$/;

async function serve({ params, request, env }, withBody) {
  if (!KEY_RE.test(params.key)) return new Response('Not found', { status: 404 });

  const obj = await env.IMAGES.get(params.key);
  if (!obj) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('ETag', obj.httpEtag);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Access-Control-Allow-Origin', '*');

  if (request.headers.get('If-None-Match') === obj.httpEtag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(withBody ? obj.body : null, { headers });
}

export const onRequestGet = (ctx) => serve(ctx, true);
export const onRequestHead = (ctx) => serve(ctx, false);
