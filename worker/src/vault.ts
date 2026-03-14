import type { Env, ParsedNote, SearchResult, GraphNode, GraphEdge, NoteRecord } from './types';
import { parseNote, checksum } from './parser';

const EMBEDDING_MODEL = '@cf/baai/bge-small-en-v1.5';

// --- Helpers ---

async function embed(env: Env, text: string): Promise<number[]> {
  const result = await env.AI.run(EMBEDDING_MODEL, { text: [text] }) as { data: number[][] };
  return result.data[0];
}

// --- CRUD ---

export async function readNote(env: Env, path: string): Promise<{ raw: string; parsed: ParsedNote } | null> {
  const obj = await env.PRIME_RADIANT_VAULT.get(path);
  if (!obj) return null;
  const raw = await obj.text();
  return { raw, parsed: parseNote(path, raw) };
}

export async function writeNote(env: Env, path: string, content: string): Promise<ParsedNote> {
  const parsed = parseNote(path, content);
  const hash = checksum(content);
  const embeddingText = (parsed.title + '\n' + parsed.plainText).slice(0, 8192);

  // R2 write, AI embedding, and D1 upsert are independent — run concurrently
  const [, embedding] = await Promise.all([
    env.PRIME_RADIANT_VAULT.put(path, content),
    embed(env, embeddingText),
    env.PRIME_RADIANT_DB.prepare(`
      INSERT INTO notes (path, title, content, type, status, created, modified, frontmatter, checksum)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
      ON CONFLICT(path) DO UPDATE SET
        title=?2, content=?3, type=?4, status=?5,
        modified=?7, frontmatter=?8, checksum=?9,
        indexed_at=datetime('now')
    `).bind(
      path, parsed.title, parsed.body, parsed.type, parsed.status,
      parsed.created, parsed.modified, JSON.stringify(parsed.frontmatter), hash
    ).run(),
  ]);

  // Get the note ID for tag/link inserts
  const row = await env.PRIME_RADIANT_DB.prepare('SELECT id FROM notes WHERE path=?').bind(path).first<{ id: number }>();
  if (!row) throw new Error('Index failed');

  // Update tags + links, and upsert embedding concurrently
  await Promise.all([
    env.PRIME_RADIANT_DB.batch([
      env.PRIME_RADIANT_DB.prepare('DELETE FROM tags WHERE note_id=?').bind(row.id),
      env.PRIME_RADIANT_DB.prepare('DELETE FROM links WHERE source_id=?').bind(row.id),
      ...parsed.tags.map(t =>
        env.PRIME_RADIANT_DB.prepare('INSERT INTO tags (note_id,tag) VALUES (?,?)').bind(row.id, t)
      ),
      ...parsed.links.map(l =>
        env.PRIME_RADIANT_DB.prepare('INSERT INTO links (source_id,target_path,display_text) VALUES (?,?,?)').bind(row.id, l.target, l.display)
      ),
    ]),
    env.PRIME_RADIANT_EMBEDDINGS.upsert([{
      id: path,
      values: embedding,
      metadata: { title: parsed.title, type: parsed.type, path },
    }]),
  ]);

  return parsed;
}

export async function appendNote(env: Env, path: string, content: string): Promise<ParsedNote> {
  const existing = await readNote(env, path);
  const newContent = existing ? existing.raw + '\n' + content : content;
  return writeNote(env, path, newContent);
}

export async function deleteNote(env: Env, path: string): Promise<boolean> {
  await Promise.all([
    env.PRIME_RADIANT_VAULT.delete(path),
    env.PRIME_RADIANT_DB.prepare('DELETE FROM notes WHERE path=?').bind(path).run(),
    env.PRIME_RADIANT_EMBEDDINGS.deleteByIds([path]),
  ]);
  return true;
}

// --- Search ---

export type SearchMode = 'hybrid' | 'keyword' | 'semantic';

export async function search(env: Env, query: string, mode: SearchMode = 'hybrid', limit = 10): Promise<SearchResult[]> {
  switch (mode) {
    case 'keyword': return searchKeyword(env, query, limit);
    case 'semantic': return searchSemantic(env, query, limit);
    default: return searchHybrid(env, query, limit);
  }
}

async function searchKeyword(env: Env, query: string, limit: number): Promise<SearchResult[]> {
  const results = await env.PRIME_RADIANT_DB.prepare(`
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

async function searchSemantic(env: Env, query: string, limit: number): Promise<SearchResult[]> {
  const embedding = await embed(env, query);
  const matches = await env.PRIME_RADIANT_EMBEDDINGS.query(embedding, {
    topK: limit,
    returnMetadata: 'all',
  });

  if (!matches.matches.length) return [];

  const paths = matches.matches.map(m => m.id);
  const placeholders = paths.map(() => '?').join(',');
  const notes = await env.PRIME_RADIANT_DB.prepare(
    `SELECT path, title, type, status FROM notes WHERE path IN (${placeholders})`
  ).bind(...paths).all<{ path: string; title: string; type: string; status: string }>();

  const noteMap = new Map(notes.results.map(n => [n.path, n]));

  return matches.matches.map(m => {
    const note = noteMap.get(m.id as string);
    return {
      path: m.id as string,
      title: note?.title || (m.metadata?.title as string) || '',
      type: note?.type || '',
      status: note?.status || '',
      score: m.score,
    };
  });
}

async function searchHybrid(env: Env, query: string, limit: number): Promise<SearchResult[]> {
  const [kw, sem] = await Promise.all([
    searchKeyword(env, query, limit * 2),
    searchSemantic(env, query, limit * 2),
  ]);

  // Reciprocal Rank Fusion
  const k = 60;
  const scores = new Map<string, { score: number; result: SearchResult }>();

  for (const [results] of [[kw], [sem]]) {
    results.forEach((r, i) => {
      const rrf = 1 / (k + i + 1);
      const existing = scores.get(r.path);
      scores.set(r.path, {
        score: (existing?.score || 0) + rrf,
        result: existing?.result || r,
      });
    });
  }

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

    const note = await env.PRIME_RADIANT_DB.prepare(
      'SELECT id, path, title, type FROM notes WHERE path=? OR title=?'
    ).bind(item.path, item.path).first<NoteRecord>();
    if (!note) continue;

    nodes.set(note.path, { path: note.path, title: note.title, type: note.type });

    // Fetch outgoing + backlinks concurrently
    const [outgoing, backlinks] = await Promise.all([
      env.PRIME_RADIANT_DB.prepare(
        'SELECT target_path, display_text FROM links WHERE source_id=?'
      ).bind(note.id).all<{ target_path: string; display_text: string }>(),
      env.PRIME_RADIANT_DB.prepare(`
        SELECT n.path, n.title, n.type, l.display_text
        FROM links l JOIN notes n ON l.source_id = n.id
        WHERE l.target_path = ? OR l.target_path = ?
      `).bind(note.path, note.title).all<{ path: string; title: string; type: string; display_text: string }>(),
    ]);

    for (const link of outgoing.results) {
      edges.push({ source: note.path, target: link.target_path, display: link.display_text });
      if (item.currentDepth < depth) {
        queue.push({ path: link.target_path, currentDepth: item.currentDepth + 1 });
      }
    }

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
    env.PRIME_RADIANT_DB.prepare('SELECT path, title, type FROM notes').all<GraphNode>(),
    env.PRIME_RADIANT_DB.prepare(`
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

  const from = opts.tag
    ? `notes n JOIN tags t ON t.note_id=n.id WHERE ${where} AND t.tag=?`
    : `notes n WHERE ${where}`;
  if (opts.tag) binds.push(opts.tag);

  const countBinds = [...binds];
  binds.push(opts.limit || 50, opts.offset || 0);

  const [countResult, results] = await Promise.all([
    env.PRIME_RADIANT_DB.prepare(`SELECT count(${opts.tag ? 'DISTINCT n.id' : '*'}) as total FROM ${from}`).bind(...countBinds).first<{ total: number }>(),
    env.PRIME_RADIANT_DB.prepare(`SELECT ${opts.tag ? 'DISTINCT ' : ''}n.path, n.title, n.type, n.status FROM ${from} ORDER BY n.modified DESC LIMIT ? OFFSET ?`).bind(...binds).all<SearchResult>(),
  ]);
  return { notes: results.results, total: countResult?.total || 0 };
}

export async function listTags(env: Env): Promise<{ tag: string; count: number }[]> {
  const results = await env.PRIME_RADIANT_DB.prepare(
    'SELECT tag, count(*) as count FROM tags GROUP BY tag ORDER BY count DESC'
  ).all<{ tag: string; count: number }>();
  return results.results;
}

export async function getBacklinks(env: Env, path: string): Promise<GraphNode[]> {
  const note = await env.PRIME_RADIANT_DB.prepare('SELECT title FROM notes WHERE path=?').bind(path).first<{ title: string }>();
  const title = note?.title || path.replace(/^.*\//, '').replace(/\.md$/, '');

  const results = await env.PRIME_RADIANT_DB.prepare(`
    SELECT DISTINCT n.path, n.title, n.type
    FROM links l JOIN notes n ON l.source_id = n.id
    WHERE l.target_path = ? OR l.target_path = ?
  `).bind(path, title).all<GraphNode>();
  return results.results;
}

// --- Stats ---

export async function getStats(env: Env): Promise<{ notes: number; tags: number; links: number; types: { type: string; count: number }[] }> {
  const [noteCount, tagCount, linkCount, typeDist] = await Promise.all([
    env.PRIME_RADIANT_DB.prepare('SELECT count(*) as n FROM notes').first<{ n: number }>(),
    env.PRIME_RADIANT_DB.prepare('SELECT count(DISTINCT tag) as n FROM tags').first<{ n: number }>(),
    env.PRIME_RADIANT_DB.prepare('SELECT count(*) as n FROM links').first<{ n: number }>(),
    env.PRIME_RADIANT_DB.prepare("SELECT type, count(*) as count FROM notes WHERE type != '' GROUP BY type ORDER BY count DESC").all<{ type: string; count: number }>(),
  ]);
  return {
    notes: noteCount?.n || 0,
    tags: tagCount?.n || 0,
    links: linkCount?.n || 0,
    types: typeDist.results,
  };
}

// --- Sync ---

export async function getManifest(env: Env): Promise<Record<string, string>> {
  const results = await env.PRIME_RADIANT_DB.prepare('SELECT path, checksum FROM notes').all<{ path: string; checksum: string }>();
  const manifest: Record<string, string> = {};
  for (const r of results.results) manifest[r.path] = r.checksum;
  return manifest;
}

export async function deleteStale(env: Env, activePaths: Set<string>): Promise<number> {
  const all = await env.PRIME_RADIANT_DB.prepare('SELECT path FROM notes').all<{ path: string }>();
  const stale = all.results.filter(r => !activePaths.has(r.path));
  await Promise.all(stale.map(r => deleteNote(env, r.path)));
  return stale.length;
}
