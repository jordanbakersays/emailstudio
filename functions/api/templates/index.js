import { json } from '../../_lib/auth.js';

const MAX_HTML_BYTES = 2 * 1024 * 1024; // 2 MB is far beyond any real email
const MAX_NAME = 120;

// GET  /api/templates  -> list (name + dates only, no HTML)
export async function onRequestGet({ env }) {
  const items = [];
  let cursor;
  do {
    const page = await env.TEMPLATES.list({ prefix: 't:', cursor });
    for (const k of page.keys) {
      const m = k.metadata || {};
      items.push({
        id: k.name.slice(2),
        name: m.name || 'Untitled',
        updated: m.updated || null,
      });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  items.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
  return json({ templates: items });
}

// POST /api/templates  { name, html } -> creates a template
export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Bad request' }, 400);
  }
  const name = String(body.name ?? '').trim().slice(0, MAX_NAME) || 'Untitled email';
  const html = String(body.html ?? '');
  if (new TextEncoder().encode(html).length > MAX_HTML_BYTES) {
    return json({ error: 'Template is too large (2 MB max).' }, 413);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const record = { id, name, html, created: now, updated: now };
  await env.TEMPLATES.put(`t:${id}`, JSON.stringify(record), {
    metadata: { name, updated: now },
  });
  return json({ id, name, updated: now }, 201);
}
