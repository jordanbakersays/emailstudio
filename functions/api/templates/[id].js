import { json } from '../../_lib/auth.js';
import { normalizeTags, buildMetadata } from '../../_lib/tags.js';
import { snapshot, deleteAllVersions } from '../../_lib/versions.js';

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_NAME = 120;
const ID_RE = /^[0-9a-f-]{36}$/;

// GET /api/templates/:id -> full template including HTML and tags
export async function onRequestGet({ params, env }) {
  if (!ID_RE.test(params.id)) return json({ error: 'Not found' }, 404);
  const raw = await env.TEMPLATES.get(`t:${params.id}`);
  if (!raw) return json({ error: 'Not found' }, 404);
  const record = JSON.parse(raw);
  // Templates saved before tags existed simply have none.
  return json({
    ...record,
    tags: Array.isArray(record.tags) ? record.tags : [],
    master: !!record.master,
    parent: record.parent || null,
  });
}

// PUT /api/templates/:id { name, html, tags } -> update
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
  const tags = body.tags === undefined ? normalizeTags(existing.tags) : normalizeTags(body.tags);
  if (new TextEncoder().encode(html).length > MAX_HTML_BYTES) {
    return json({ error: 'Template is too large (2 MB max).' }, 413);
  }

  const wasMaster = !!existing.master;
  const master = typeof body.master === 'boolean' ? body.master : wasMaster;
  const contentChanged =
    html !== existing.html ||
    name !== existing.name ||
    JSON.stringify(tags) !== JSON.stringify(normalizeTags(existing.tags));

  // Two people editing the same email: if it was saved by someone else after this
  // person opened it, don't silently overwrite. (The old version is kept in History.)
  if (
    contentChanged &&
    typeof body.baseUpdated === 'string' &&
    body.baseUpdated !== existing.updated &&
    body.force !== true
  ) {
    return json(
      { error: 'Someone else saved this email after you opened it.', conflict: true, updated: existing.updated },
      409,
    );
  }

  // Master templates can't be changed by accident: the request must say so.
  if (wasMaster && contentChanged && body.overwrite !== true) {
    return json({ error: 'This is a master template. Save your changes as a draft instead.', master: true }, 409);
  }
  // A draft can't also be a master.
  if (master && existing.parent) {
    return json({ error: 'A draft can\'t be a master. Replace its master with it instead.' }, 400);
  }

  // Keep the old content so it can always be restored.
  if (contentChanged) await snapshot(env, params.id, existing);

  const updated = contentChanged ? new Date().toISOString() : existing.updated;
  const record = { ...existing, name, tags, html, updated, master, parent: existing.parent || null };
  await env.TEMPLATES.put(`t:${params.id}`, JSON.stringify(record), {
    metadata: buildMetadata(name, tags, updated, { master, parent: record.parent }),
  });
  return json({ id: params.id, name, tags, updated, master, parent: record.parent });
}

// DELETE /api/templates/:id
export async function onRequestDelete({ params, env }) {
  if (!ID_RE.test(params.id)) return json({ error: 'Not found' }, 404);
  const raw = await env.TEMPLATES.get(`t:${params.id}`);
  if (raw && JSON.parse(raw).master) {
    return json({ error: 'This is a master template. Unlock it before deleting.', master: true }, 409);
  }
  await env.TEMPLATES.delete(`t:${params.id}`);
  await deleteAllVersions(env, params.id);
  return json({ ok: true });
}
