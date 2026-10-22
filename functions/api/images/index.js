import { json } from '../../_lib/auth.js';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB per image
const TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

// Identify the real format from the file's first bytes, not the filename.
function sniff(bytes) {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return 'webp';
  return null;
}

function baseUrl(request, env) {
  const configured = (env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  return configured || new URL(request.url).origin;
}

function slug(filename) {
  const stem = filename.replace(/\.[^.]+$/, '');
  return (
    stem
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'image'
  );
}

function describe(obj, base) {
  return {
    key: obj.key,
    url: `${base}/img/${obj.key}`,
    name: (obj.customMetadata && obj.customMetadata.originalName) || obj.key,
    size: obj.size,
    uploaded: obj.uploaded,
  };
}

// GET /api/images -> every uploaded image, newest first
export async function onRequestGet({ request, env }) {
  const base = baseUrl(request, env);
  const images = [];
  let cursor;
  do {
    const page = await env.IMAGES.list({ cursor, include: ['customMetadata'] });
    for (const obj of page.objects) images.push(describe(obj, base));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  images.sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));
  return json({ images });
}

// POST /api/images  (multipart form, field name "file", one or many)
export async function onRequestPost({ request, env }) {
  const base = baseUrl(request, env);
  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'Bad upload' }, 400);
  }

  const files = form.getAll('file').filter((f) => typeof f !== 'string');
  if (!files.length) return json({ error: 'No file received' }, 400);

  const uploaded = [];
  const rejected = [];

  for (const file of files) {
    if (file.size > MAX_BYTES) {
      rejected.push({ name: file.name, reason: 'Over 10 MB' });
      continue;
    }
    const buf = await file.arrayBuffer();
    const kind = sniff(new Uint8Array(buf.slice(0, 16)));
    if (!kind) {
      rejected.push({ name: file.name, reason: 'Not a PNG, JPG, GIF or WebP image' });
      continue;
    }

    const rand = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    const key = `${Date.now().toString(36)}-${rand}-${slug(file.name)}.${kind}`;
    await env.IMAGES.put(key, buf, {
      httpMetadata: { contentType: TYPES[kind] },
      customMetadata: { originalName: file.name.slice(0, 200) },
    });
    uploaded.push({
      key,
      url: `${base}/img/${key}`,
      name: file.name,
      size: file.size,
      uploaded: new Date().toISOString(),
    });
  }

  return json({ uploaded, rejected }, uploaded.length ? 201 : 400);
}
