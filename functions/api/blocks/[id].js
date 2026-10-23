import { json } from '../../_lib/auth.js';

const ID_RE = /^[0-9a-f-]{36}$/;

// GET /api/blocks/:id -> the block including its HTML
export async function onRequestGet({ params, env }) {
  if (!ID_RE.test(params.id)) return json({ error: 'Not found' }, 404);
  const raw = await env.TEMPLATES.get(`b:${params.id}`);
  if (!raw) return json({ error: 'Not found' }, 404);
  return json(JSON.parse(raw));
}

// DELETE /api/blocks/:id  (emails that already used the block are not affected)
export async function onRequestDelete({ params, env }) {
  if (!ID_RE.test(params.id)) return json({ error: 'Not found' }, 404);
  await env.TEMPLATES.delete(`b:${params.id}`);
  return json({ ok: true });
}
