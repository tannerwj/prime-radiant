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
  const mode = c.req.query('mode') || 'hybrid';

  let results;
  switch (mode) {
    case 'keyword': results = await vault.searchKeyword(c.env, query, limit); break;
    case 'semantic': results = await vault.searchSemantic(c.env, query, limit); break;
    default: results = await vault.searchHybrid(c.env, query, limit);
  }
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
  const results: { path: string; status: string }[] = [];
  const activePaths = new Set<string>();

  for (const file of body.files) {
    activePaths.add(file.path);
    try {
      // Check if content changed
      const existing = await vault.readNote(c.env, file.path);
      if (existing && checksum(existing.raw) === checksum(file.content)) {
        results.push({ path: file.path, status: 'unchanged' });
        continue;
      }
      await vault.writeNote(c.env, file.path, file.content);
      results.push({ path: file.path, status: existing ? 'updated' : 'created' });
    } catch (e) {
      results.push({ path: file.path, status: `error: ${e}` });
    }
  }

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
  const [noteCount, tagCount, linkCount] = await Promise.all([
    c.env.BRAIN_DB.prepare('SELECT count(*) as n FROM notes').first<{ n: number }>(),
    c.env.BRAIN_DB.prepare('SELECT count(DISTINCT tag) as n FROM tags').first<{ n: number }>(),
    c.env.BRAIN_DB.prepare('SELECT count(*) as n FROM links').first<{ n: number }>(),
  ]);
  const typeDist = await c.env.BRAIN_DB.prepare(
    "SELECT type, count(*) as count FROM notes WHERE type != '' GROUP BY type ORDER BY count DESC"
  ).all<{ type: string; count: number }>();

  return c.json({
    notes: noteCount?.n || 0,
    tags: tagCount?.n || 0,
    links: linkCount?.n || 0,
    types: typeDist.results,
  });
});

export default api;
