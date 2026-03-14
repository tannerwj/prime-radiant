export interface Env {
  BRAIN_DB: D1Database;
  BRAIN_VAULT: R2Bucket;
  BRAIN_EMBEDDINGS: VectorizeIndex;
  AI: Ai;
  API_TOKEN: string;
}

export interface ParsedNote {
  frontmatter: Record<string, unknown>;
  body: string;
  title: string;
  type: string;
  status: string;
  created: string;
  modified: string;
  tags: string[];
  links: NoteLink[];
  plainText: string;
}

export interface NoteLink {
  target: string;
  display: string;
}

export interface NoteRecord {
  id: number;
  path: string;
  title: string;
  content: string;
  type: string;
  status: string;
  created: string;
  modified: string;
  frontmatter: string;
  checksum: string;
  indexed_at: string;
}

export interface SearchResult {
  path: string;
  title: string;
  type: string;
  status: string;
  snippet?: string;
  score?: number;
}

export interface GraphNode {
  path: string;
  title: string;
  type: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  display: string;
}
