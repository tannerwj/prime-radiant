import { Hono } from 'hono';
import type { Env } from './types';
import * as vault from './vault';
import { checksum } from './parser';

const api = new Hono<{ Bindings: Env }>();

// --- Notes CRUD ---

// Read note
api.get('/notes/*', async (c) => {
  const path = c.req.path.replace('/api/notes/', '');
  if (!path) {
    const result = await vault.listNotes(c.env, {
      type: c.req.query('type'),
      status: c.req.query('status'),
      tag: c.req.query('tag'),
      limit: Number(c.req.query('limit')) || 50,
      offset: Number(c.req.query('offset')) || 0,
    });
    return c.json(result);
  }

  const note = await vault.readNote(c.env, decodeURIComponent(path));
  if (!note) return c.json({ error: 'Not found' }, 404);
  return c.json({ path: decodeURIComponent(path), ...note.parsed, raw: note.raw });
});

// Create/update note
api.put('/notes/*', async (c) => {
  const path = decodeURIComponent(c.req.path.replace('/api/notes/', ''));
  if (!path) return c.json({ error: 'Path required' }, 400);
  const content = await c.req.text();
  const parsed = await vault.writeNote(c.env, path, content);
  return c.json({ path, ...parsed });
});

// Append to note
api.post('/notes/*', async (c) => {
  const path = decodeURIComponent(c.req.path.replace('/api/notes/', ''));
  if (!path) return c.json({ error: 'Path required' }, 400);
  const content = await c.req.text();
  const parsed = await vault.appendNote(c.env, path, content);
  return c.json({ path, ...parsed });
});

// Delete note
api.delete('/notes/*', async (c) => {
  const path = decodeURIComponent(c.req.path.replace('/api/notes/', ''));
  if (!path) return c.json({ error: 'Path required' }, 400);
  await vault.deleteNote(c.env, path);
  return c.json({ ok: true });
});

// --- Search ---

api.get('/search', async (c) => {
  const query = c.req.query('q');
  if (!query) return c.json({ error: 'Query parameter q required' }, 400);
  const limit = Number(c.req.query('limit')) || 10;
  const mode = (c.req.query('mode') || 'hybrid') as vault.SearchMode;
  const results = await vault.search(c.env, query, mode, limit);
  return c.json({ query, mode, results });
});

// --- Graph ---

api.get('/graph', async (c) => {
  const path = c.req.query('path');
  if (path) {
    const depth = Number(c.req.query('depth')) || 1;
    return c.json(await vault.getGraph(c.env, path, depth));
  }
  return c.json(await vault.getFullGraph(c.env));
});

api.get('/backlinks/*', async (c) => {
  const path = decodeURIComponent(c.req.path.replace('/api/backlinks/', ''));
  if (!path) return c.json({ error: 'Path required' }, 400);
  return c.json(await vault.getBacklinks(c.env, path));
});

// --- Tags ---

api.get('/tags', async (c) => {
  return c.json(await vault.listTags(c.env));
});

// --- Sync ---

api.get('/manifest', async (c) => {
  return c.json(await vault.getManifest(c.env));
});

api.post('/sync', async (c) => {
  const body = await c.req.json<{ files: { path: string; content: string }[]; prune?: boolean }>();
  const activePaths = new Set<string>();

  // Fetch existing checksums from D1 in one query (avoids N R2 reads)
  const manifest = await vault.getManifest(c.env);

  const results = await Promise.all(body.files.map(async (file) => {
    activePaths.add(file.path);
    try {
      const existingHash = manifest[file.path];
      if (existingHash && existingHash === checksum(file.content)) {
        return { path: file.path, status: 'unchanged' };
      }
      await vault.writeNote(c.env, file.path, file.content);
      return { path: file.path, status: existingHash ? 'updated' : 'created' };
    } catch (e) {
      return { path: file.path, status: `error: ${e}` };
    }
  }));

  let pruned = 0;
  if (body.prune) {
    pruned = await vault.deleteStale(c.env, activePaths);
  }

  return c.json({
    synced: results.length,
    created: results.filter(r => r.status === 'created').length,
    updated: results.filter(r => r.status === 'updated').length,
    unchanged: results.filter(r => r.status === 'unchanged').length,
    pruned,
    results,
  });
});

// --- Stats ---

api.get('/stats', async (c) => {
  return c.json(await vault.getStats(c.env));
});

export default api;
