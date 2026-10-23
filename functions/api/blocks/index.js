import { json } from '../../_lib/auth.js';

// Saved blocks: a section of an email (like "Elder Spotlight") that can be reused in any email.
// Stored in the same KV namespace as templates, under keys that start with "b:".
const MAX_HTML_BYTES = 300 * 1024;
const MAX_NAME = 80;

// GET /api/blocks -> [{ id, name, preview, created }]
export async function onRequestGet({ env }) {
  const blocks = [];
  let cursor;
  do {
    const page = await env.TEMPLATES.list({ prefix: 'b:', cursor });
    for (const k of page.keys) {
      const m = k.metadata || {};
      blocks.push({ id: k.name.slice(2), name: m.name || 'Untitled block', preview: m.preview || '', created: m.created || null });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  blocks.sort((a, b) => a.name.localeCompare(b.name));
  return json({ blocks });
}

// POST /api/blocks { name, html, preview } -> creates a saved block
export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Bad request' }, 400);
  }
  const name = String(body.name ?? '').trim().slice(0, MAX_NAME) || 'Untitled block';
  const html = String(body.html ?? '').trim();
  const preview = String(body.preview ?? '').replace(/\s+/g, ' ').trim().slice(0, 90);
  if (!html) return json({ error: 'That block is empty.' }, 400);
  if (new TextEncoder().encode(html).length > MAX_HTML_BYTES) {
    return json({ error: 'That block is too large to save (300 KB max).' }, 413);
  }
  const id = crypto.randomUUID();
  const created = new Date().toISOString();
  await env.TEMPLATES.put(`b:${id}`, JSON.stringify({ id, name, html, preview, created }), {
    metadata: { name, preview, created },
  });
  return json({ id, name, preview, created }, 201);
}
