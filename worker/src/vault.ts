import type { Env, ParsedNote, SearchResult, GraphNode, GraphEdge, NoteRecord } from './types';
import { parseNote, checksum } from './parser';

// --- CRUD ---

export async function readNote(env: Env, path: string): Promise<{ raw: string; parsed: ParsedNote } | null> {
  const obj = await env.BRAIN_VAULT.get(path);
  if (!obj) return null;
  const raw = await obj.text();
  return { raw, parsed: parseNote(path, raw) };
}

export async function writeNote(env: Env, path: string, content: string): Promise<ParsedNote> {
  const parsed = parseNote(path, content);
  const hash = checksum(content);

  // Write to R2
  await env.BRAIN_VAULT.put(path, content);

  // Upsert into D1
  await env.BRAIN_DB.prepare(`
    INSERT INTO notes (path, title, content, type, status, created, modified, frontmatter, checksum)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    ON CONFLICT(path) DO UPDATE SET
      title=?2, content=?3, type=?4, status=?5,
      modified=?7, frontmatter=?8, checksum=?9,
      indexed_at=datetime('now')
  `).bind(
    path, parsed.title, parsed.body, parsed.type, parsed.status,
    parsed.created, parsed.modified, JSON.stringify(parsed.frontmatter), hash
  ).run();

  const row = await env.BRAIN_DB.prepare('SELECT id FROM notes WHERE path=?').bind(path).first<{ id: number }>();
  if (!row) throw new Error('Index failed');

  // Update tags + links in a batch
  const batch: D1PreparedStatement[] = [
    env.BRAIN_DB.prepare('DELETE FROM tags WHERE note_id=?').bind(row.id),
    env.BRAIN_DB.prepare('DELETE FROM links WHERE source_id=?').bind(row.id),
    ...parsed.tags.map(t =>
      env.BRAIN_DB.prepare('INSERT INTO tags (note_id,tag) VALUES (?,?)').bind(row.id, t)
    ),
    ...parsed.links.map(l =>
      env.BRAIN_DB.prepare('INSERT INTO links (source_id,target_path,display_text) VALUES (?,?,?)').bind(row.id, l.target, l.display)
    ),
  ];
  await env.BRAIN_DB.batch(batch);

  // Generate embedding and upsert into Vectorize
  const embeddingText = (parsed.title + '\n' + parsed.plainText).slice(0, 8192);
  const aiResult = await env.AI.run('@cf/baai/bge-small-en-v1.5', { text: [embeddingText] }) as { data: number[][] };
  await env.BRAIN_EMBEDDINGS.upsert([{
    id: path,
    values: aiResult.data[0],
    metadata: { title: parsed.title, type: parsed.type, path },
  }]);

  return parsed;
}

export async function appendNote(env: Env, path: string, content: string): Promise<ParsedNote> {
  const existing = await readNote(env, path);
  const newContent = existing ? existing.raw + '\n' + content : content;
  return writeNote(env, path, newContent);
}

export async function deleteNote(env: Env, path: string): Promise<boolean> {
  await env.BRAIN_VAULT.delete(path);
  await env.BRAIN_DB.prepare('DELETE FROM notes WHERE path=?').bind(path).run();
  await env.BRAIN_EMBEDDINGS.deleteByIds([path]);
  return true;
}

// --- Search ---

export async function searchKeyword(env: Env, query: string, limit = 10): Promise<SearchResult[]> {
  const results = await env.BRAIN_DB.prepare(`
    SELECT n.path, n.title, n.type, n.status,
           snippet(notes_fts, 2, '<mark>', '</mark>', '...', 32) as snippet,
           rank
    FROM notes_fts
    JOIN notes n ON notes_fts.rowid = n.id
    WHERE notes_fts MATCH ?1
    ORDER BY rank
    LIMIT ?2
  `).bind(query, limit).all<SearchResult & { rank: number }>();
  return results.results.map(r => ({
    path: r.path, title: r.title, type: r.type, status: r.status,
    snippet: r.snippet, score: -r.rank,
  }));
}

export async function searchSemantic(env: Env, query: string, limit = 10): Promise<SearchResult[]> {
  const aiResult = await env.AI.run('@cf/baai/bge-small-en-v1.5', { text: [query] }) as { data: number[][] };
  const matches = await env.BRAIN_EMBEDDINGS.query(aiResult.data[0], {
    topK: limit,
    returnMetadata: 'all',
  });

  if (!matches.matches.length) return [];

  const paths = matches.matches.map(m => m.id);
  const placeholders = paths.map(() => '?').join(',');
  const notes = await env.BRAIN_DB.prepare(
    `SELECT path, title, type, status FROM notes WHERE path IN (${placeholders})`
  ).bind(...paths).all<{ path: string; title: string; type: string; status: string }>();

  const noteMap = new Map(notes.results.map(n => [n.path, n]));

  return matches.matches.map(m => ({
    path: m.id as string,
    title: noteMap.get(m.id as string)?.title || (m.metadata?.title as string) || '',
    type: noteMap.get(m.id as string)?.type || '',
    status: noteMap.get(m.id as string)?.status || '',
    score: m.score,
  }));
}

export async function searchHybrid(env: Env, query: string, limit = 10): Promise<SearchResult[]> {
  const [keyword, semantic] = await Promise.all([
    searchKeyword(env, query, limit * 2),
    searchSemantic(env, query, limit * 2),
  ]);

  // Reciprocal Rank Fusion
  const k = 60;
  const scores = new Map<string, { score: number; result: SearchResult }>();

  keyword.forEach((r, i) => {
    const rrf = 1 / (k + i + 1);
    const existing = scores.get(r.path);
    scores.set(r.path, {
      score: (existing?.score || 0) + rrf,
      result: existing?.result || r,
    });
  });

  semantic.forEach((r, i) => {
    const rrf = 1 / (k + i + 1);
    const existing = scores.get(r.path);
    scores.set(r.path, {
      score: (existing?.score || 0) + rrf,
      result: existing?.result || r,
    });
  });

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => ({ ...s.result, score: s.score }));
}

// --- Graph ---

export async function getGraph(env: Env, path: string, depth = 1): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const visited = new Set<string>();
  const queue: { path: string; currentDepth: number }[] = [{ path, currentDepth: 0 }];

  while (queue.length > 0) {
    const item = queue.shift()!;
    if (visited.has(item.path) || item.currentDepth > depth) continue;
    visited.add(item.path);

    const note = await env.BRAIN_DB.prepare(
      'SELECT id, path, title, type FROM notes WHERE path=? OR title=?'
    ).bind(item.path, item.path).first<NoteRecord>();
    if (!note) continue;

    nodes.set(note.path, { path: note.path, title: note.title, type: note.type });

    // Outgoing links
    const outgoing = await env.BRAIN_DB.prepare(
      'SELECT target_path, display_text FROM links WHERE source_id=?'
    ).bind(note.id).all<{ target_path: string; display_text: string }>();

    for (const link of outgoing.results) {
      edges.push({ source: note.path, target: link.target_path, display: link.display_text });
      if (item.currentDepth < depth) {
        queue.push({ path: link.target_path, currentDepth: item.currentDepth + 1 });
      }
    }

    // Backlinks
    const backlinks = await env.BRAIN_DB.prepare(`
      SELECT n.path, n.title, n.type, l.display_text
      FROM links l JOIN notes n ON l.source_id = n.id
      WHERE l.target_path = ? OR l.target_path = ?
    `).bind(note.path, note.title).all<{ path: string; title: string; type: string; display_text: string }>();

    for (const bl of backlinks.results) {
      nodes.set(bl.path, { path: bl.path, title: bl.title, type: bl.type });
      edges.push({ source: bl.path, target: note.path, display: bl.display_text });
      if (item.currentDepth < depth) {
        queue.push({ path: bl.path, currentDepth: item.currentDepth + 1 });
      }
    }
  }

  return { nodes: [...nodes.values()], edges };
}

export async function getFullGraph(env: Env): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const [nodesResult, edgesResult] = await Promise.all([
    env.BRAIN_DB.prepare('SELECT path, title, type FROM notes').all<GraphNode>(),
    env.BRAIN_DB.prepare(`
      SELECT n.path as source, l.target_path as target, l.display_text as display
      FROM links l JOIN notes n ON l.source_id = n.id
    `).all<GraphEdge>(),
  ]);
  return { nodes: nodesResult.results, edges: edgesResult.results };
}

// --- List / Filter ---

export async function listNotes(env: Env, opts: {
  type?: string; status?: string; tag?: string; limit?: number; offset?: number;
} = {}): Promise<{ notes: SearchResult[]; total: number }> {
  let where = '1=1';
  const binds: unknown[] = [];

  if (opts.type) { where += ' AND n.type=?'; binds.push(opts.type); }
  if (opts.status) { where += ' AND n.status=?'; binds.push(opts.status); }

  let query: string;
  if (opts.tag) {
    query = `SELECT DISTINCT n.path, n.title, n.type, n.status FROM notes n JOIN tags t ON t.note_id=n.id WHERE ${where} AND t.tag=?`;
    binds.push(opts.tag);
  } else {
    query = `SELECT n.path, n.title, n.type, n.status FROM notes n WHERE ${where}`;
  }

  const countQ = query.replace(/SELECT .* FROM/, 'SELECT count(*) as total FROM');
  const countResult = await env.BRAIN_DB.prepare(countQ).bind(...binds).first<{ total: number }>();

  query += ' ORDER BY n.modified DESC LIMIT ? OFFSET ?';
  binds.push(opts.limit || 50, opts.offset || 0);

  const results = await env.BRAIN_DB.prepare(query).bind(...binds).all<SearchResult>();
  return { notes: results.results, total: countResult?.total || 0 };
}

export async function listTags(env: Env): Promise<{ tag: string; count: number }[]> {
  const results = await env.BRAIN_DB.prepare(
    'SELECT tag, count(*) as count FROM tags GROUP BY tag ORDER BY count DESC'
  ).all<{ tag: string; count: number }>();
  return results.results;
}

export async function getBacklinks(env: Env, path: string): Promise<GraphNode[]> {
  const note = await env.BRAIN_DB.prepare('SELECT title FROM notes WHERE path=?').bind(path).first<{ title: string }>();
  const title = note?.title || path.replace(/^.*\//, '').replace(/\.md$/, '');

  const results = await env.BRAIN_DB.prepare(`
    SELECT DISTINCT n.path, n.title, n.type
    FROM links l JOIN notes n ON l.source_id = n.id
    WHERE l.target_path = ? OR l.target_path = ?
  `).bind(path, title).all<GraphNode>();
  return results.results;
}

// --- Sync ---

export async function getManifest(env: Env): Promise<Record<string, string>> {
  const results = await env.BRAIN_DB.prepare('SELECT path, checksum FROM notes').all<{ path: string; checksum: string }>();
  const manifest: Record<string, string> = {};
  for (const r of results.results) manifest[r.path] = r.checksum;
  return manifest;
}

export async function deleteStale(env: Env, activePaths: Set<string>): Promise<number> {
  const all = await env.BRAIN_DB.prepare('SELECT path FROM notes').all<{ path: string }>();
  let deleted = 0;
  for (const row of all.results) {
    if (!activePaths.has(row.path)) {
      await deleteNote(env, row.path);
      deleted++;
    }
  }
  return deleted;
}
