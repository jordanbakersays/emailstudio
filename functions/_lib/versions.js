// Version history: every time a template's content changes, the previous
// content is kept under a key like  v:<templateId>:<timestamp>.
// The newest KEEP versions are retained; older ones are removed.

export const KEEP_VERSIONS = 20;

export async function snapshot(env, id, record) {
  const key = `v:${id}:${record.updated || new Date().toISOString()}`;
  const size = new TextEncoder().encode(record.html || '').length;
  await env.TEMPLATES.put(
    key,
    JSON.stringify({ name: record.name, tags: record.tags || [], html: record.html || '', saved: record.updated }),
    { metadata: { name: record.name, saved: record.updated, size } },
  );
  await prune(env, id);
}

export async function listVersions(env, id) {
  const out = [];
  let cursor;
  do {
    const page = await env.TEMPLATES.list({ prefix: `v:${id}:`, cursor });
    for (const k of page.keys) {
      const m = k.metadata || {};
      out.push({ ts: k.name.slice(`v:${id}:`.length), name: m.name || '', saved: m.saved || null, size: m.size || 0 });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  out.sort((a, b) => b.ts.localeCompare(a.ts));
  return out;
}

async function prune(env, id) {
  const all = await listVersions(env, id);
  for (const v of all.slice(KEEP_VERSIONS)) await env.TEMPLATES.delete(`v:${id}:${v.ts}`);
}

export async function deleteAllVersions(env, id) {
  for (const v of await listVersions(env, id)) await env.TEMPLATES.delete(`v:${id}:${v.ts}`);
}
