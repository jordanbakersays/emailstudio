import { json } from '../../../_lib/auth.js';
import { listVersions } from '../../../_lib/versions.js';

const ID_RE = /^[0-9a-f-]{36}$/;

// GET /api/templates/versions/:id            -> list of saved versions (newest first)
// GET /api/templates/versions/:id?ts=<time>  -> one version including its HTML
export async function onRequestGet({ params, request, env }) {
  if (!ID_RE.test(params.id)) return json({ error: 'Not found' }, 404);
  const ts = new URL(request.url).searchParams.get('ts');
  if (ts) {
    if (!/^[0-9T:.\-Z]+$/.test(ts)) return json({ error: 'Not found' }, 404);
    const raw = await env.TEMPLATES.get(`v:${params.id}:${ts}`);
    if (!raw) return json({ error: 'Not found' }, 404);
    return json(JSON.parse(raw));
  }
  return json({ versions: await listVersions(env, params.id) });
}
