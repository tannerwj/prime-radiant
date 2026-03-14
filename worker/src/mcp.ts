import type { Env } from './types';
import * as vault from './vault';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: Tool[] = [
  {
    name: 'vault_search',
    description: 'Search notes by keyword, semantic similarity, or hybrid (default). Returns ranked results with snippets.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        mode: { type: 'string', enum: ['hybrid', 'keyword', 'semantic'], description: 'Search mode (default: hybrid)' },
        limit: { type: 'number', description: 'Max results (default: 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'vault_read',
    description: 'Read the full content of a note by its path.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Note path (e.g. "02-notes/My Note.md")' },
      },
      required: ['path'],
    },
  },
  {
    name: 'vault_list',
    description: 'List notes with optional filtering by type, status, or tag.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Filter by note type' },
        status: { type: 'string', description: 'Filter by status' },
        tag: { type: 'string', description: 'Filter by tag' },
        limit: { type: 'number', description: 'Max results (default: 50)' },
        offset: { type: 'number', description: 'Pagination offset' },
      },
    },
  },
  {
    name: 'vault_graph',
    description: 'Get the connection graph for a note (outgoing links + backlinks). Use without path for full vault graph.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Note path (omit for full graph)' },
        depth: { type: 'number', description: 'Traversal depth (default: 1)' },
      },
    },
  },
  {
    name: 'vault_tags',
    description: 'List all tags with usage counts.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'vault_backlinks',
    description: 'Get all notes that link to the specified note.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Note path' },
      },
      required: ['path'],
    },
  },
  {
    name: 'vault_stats',
    description: 'Get vault statistics: note count, tag count, link count, type distribution.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function handleToolCall(env: Env, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'vault_search':
      return vault.search(env, args.query as string, (args.mode as vault.SearchMode) || 'hybrid', (args.limit as number) || 10);
    case 'vault_read': {
      const note = await vault.readNote(env, args.path as string);
      if (!note) return { error: 'Not found' };
      return { path: args.path, ...note.parsed, raw: note.raw };
    }
    case 'vault_list':
      return vault.listNotes(env, {
        type: args.type as string, status: args.status as string,
        tag: args.tag as string, limit: args.limit as number, offset: args.offset as number,
      });
    case 'vault_graph': {
      if (args.path) return vault.getGraph(env, args.path as string, (args.depth as number) || 1);
      return vault.getFullGraph(env);
    }
    case 'vault_tags':
      return vault.listTags(env);
    case 'vault_backlinks':
      return vault.getBacklinks(env, args.path as string);
    case 'vault_stats':
      return vault.getStats(env);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  const body = await request.json<JsonRpcRequest>();

  const respond = (id: string | number | undefined, result: unknown) =>
    Response.json({ jsonrpc: '2.0', id, result });

  const respondError = (id: string | number | undefined, code: number, message: string) =>
    Response.json({ jsonrpc: '2.0', id, error: { code, message } });

  switch (body.method) {
    case 'initialize':
      return respond(body.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'prime-radiant', version: '1.0.0' },
      });

    case 'notifications/initialized':
      return new Response(null, { status: 204 });

    case 'tools/list':
      return respond(body.id, { tools: TOOLS });

    case 'tools/call': {
      const { name, arguments: args } = body.params as { name: string; arguments: Record<string, unknown> };
      try {
        const result = await handleToolCall(env, name, args || {});
        return respond(body.id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        });
      } catch (e) {
        return respond(body.id, {
          content: [{ type: 'text', text: `Error: ${e}` }],
          isError: true,
        });
      }
    }

    default:
      return respondError(body.id, -32601, `Method not found: ${body.method}`);
  }
}
