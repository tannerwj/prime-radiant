import type { ParsedNote, NoteLink } from './types';

export function parseNote(path: string, raw: string): ParsedNote {
  const { frontmatter, body } = parseFrontmatter(raw);
  const links = extractWikilinks(body);
  const contentTags = extractTags(body);
  const fmTags = Array.isArray(frontmatter.tags)
    ? (frontmatter.tags as string[])
    : [];
  const tags = [...new Set([...fmTags, ...contentTags])];
  const title =
    (frontmatter.title as string) ||
    path.replace(/^.*\//, '').replace(/\.md$/, '');
  const plainText = stripMarkdown(body);

  return {
    frontmatter,
    body,
    title,
    type: (frontmatter.type as string) || '',
    status: (frontmatter.status as string) || '',
    created: String(frontmatter.created || ''),
    modified: String(frontmatter.modified || ''),
    tags,
    links,
    plainText,
  };
}

function parseFrontmatter(raw: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: raw };
  return { frontmatter: parseYaml(match[1]), body: match[2] };
}

function parseYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split('\n');
  let currentKey = '';
  let currentList: string[] | null = null;

  for (const line of lines) {
    const listItem = line.match(/^\s+-\s+(.*)$/);
    if (listItem) {
      if (currentList) currentList.push(unquote(listItem[1].trim()));
      continue;
    }

    const kv = line.match(/^([\w][\w-]*)\s*:\s*(.*)$/);
    if (kv) {
      if (currentList !== null && currentKey) {
        result[currentKey] = currentList;
        currentList = null;
      }

      currentKey = kv[1];
      const val = kv[2].trim();

      if (val === '' || val === '[]') {
        currentList = [];
      } else if (val.startsWith('[') && val.endsWith(']')) {
        result[currentKey] = val
          .slice(1, -1)
          .split(',')
          .map((s) => unquote(s.trim()));
        currentList = null;
      } else {
        result[currentKey] = unquote(val);
        currentList = null;
      }
    }
  }

  if (currentList !== null && currentKey) {
    result[currentKey] = currentList;
  }

  return result;
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function extractWikilinks(text: string): NoteLink[] {
  const seen = new Map<string, NoteLink>();
  const re = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const target = m[1].trim();
    if (!seen.has(target)) {
      seen.set(target, { target, display: (m[2] || m[1]).trim() });
    }
  }
  return [...seen.values()];
}

function extractTags(text: string): string[] {
  const tags: string[] = [];
  const re = /(?:^|\s)#([a-zA-Z][a-zA-Z0-9_/\-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) tags.push(m[1]);
  return tags;
}

function stripMarkdown(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a, b) => b || a)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`]/g, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\s*>\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function checksum(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) - hash + content.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}
