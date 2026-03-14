import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import api from './api';
import { handleMcp } from './mcp';

const app = new Hono<{ Bindings: Env }>();

// CORS for browser access (graph viz, etc.)
app.use('*', cors());

// Auth middleware — skip for health check and MCP discovery
app.use('/api/*', async (c, next) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '') || c.req.query('key');
  if (!token || token !== c.env.API_TOKEN) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
});

app.use('/mcp', async (c, next) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
    || c.req.header('x-brain-key')
    || c.req.query('key');
  if (!token || token !== c.env.API_TOKEN) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
});

// Health check
app.get('/', (c) => c.json({
  name: 'prime-radiant',
  version: '1.0.0',
  endpoints: { api: '/api', mcp: '/mcp' },
}));

// REST API
app.route('/api', api);

// MCP Streamable HTTP endpoint
app.post('/mcp', async (c) => {
  return handleMcp(c.req.raw, c.env);
});

export default app;
