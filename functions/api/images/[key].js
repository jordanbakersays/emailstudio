import { json } from '../../_lib/auth.js';

const KEY_RE = /^[a-z0-9][a-z0-9.-]{3,120}$/;

// DELETE /api/images/:key
// Heads up: any email that already used this image will show a broken image.
export async function onRequestDelete({ params, env }) {
  if (!KEY_RE.test(params.key)) return json({ error: 'Not found' }, 404);
  await env.IMAGES.delete(params.key);
  return json({ ok: true });
}
