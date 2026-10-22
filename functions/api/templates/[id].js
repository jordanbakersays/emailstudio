import { json } from '../../_lib/auth.js';

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_NAME = 120;
const ID_RE = /^[0-9a-f-]{36}$/;

// GET /api/templates/:id -> full template including HTML
export async function onRequestGet({ params, env }) {
  if (!ID_RE.test(params.id)) return json({ error: 'Not found' }, 404);
  const raw = await env.TEMPLATES.get(`t:${params.id}`);
  if (!raw) return json({ error: 'Not found' }, 404);
  return json(JSON.parse(raw));
}

// PUT /api/templates/:id { name, html } -> update
export async function onRequestPut({ params, request, env }) {
  if (!ID_RE.test(params.id)) return json({ error: 'Not found' }, 404);
  const raw = await env.TEMPLATES.get(`t:${params.id}`);
  if (!raw) return json({ error: 'Not found' }, 404);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Bad request' }, 400);
  }
  const existing = JSON.parse(raw);
  const name = String(body.name ?? existing.name).trim().slice(0, MAX_NAME) || 'Untitled email';
  const html = String(body.html ?? existing.html);
  if (new TextEncoder().encode(html).length > MAX_HTML_BYTES) {
    return json({ error: 'Template is too large (2 MB max).' }, 413);
  }

  const updated = new Date().toISOString();
  const record = { ...existing, name, html, updated };
  await env.TEMPLATES.put(`t:${params.id}`, JSON.stringify(record), {
    metadata: { name, updated },
  });
  return json({ id: params.id, name, updated });
}

// DELETE /api/templates/:id
export async function onRequestDelete({ params, env }) {
  if (!ID_RE.test(params.id)) return json({ error: 'Not found' }, 404);
  await env.TEMPLATES.delete(`t:${params.id}`);
  return json({ ok: true });
}
