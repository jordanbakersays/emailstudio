// Shared rules for template tags (categories like "Kids Ministry").

export const MAX_TAGS = 5;
export const MAX_TAG_LEN = 30;

// Clean up whatever the browser sent: trim, collapse spaces, shorten,
// drop blanks, drop duplicates (ignoring upper/lower case), cap the count.
export function normalizeTags(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    const tag = String(raw ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_TAG_LEN)
      .trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

// KV list metadata is limited to 1 KB. Real tags never come close, but this
// guarantees a save can never fail because of it.
const enc = new TextEncoder();
// extra: { master: boolean, parent: string|null } - short flags the sidebar needs.
export function buildMetadata(name, tags, updated, extra = {}) {
  const keep = [...tags];
  const flags = {};
  if (extra.master) flags.master = true;
  if (extra.parent) flags.parent = extra.parent;
  let meta = { name, tags: keep, updated, ...flags };
  while (keep.length && enc.encode(JSON.stringify(meta)).length > 1000) {
    keep.pop();
    meta = { name, tags: keep, updated, ...flags };
  }
  return meta;
}
