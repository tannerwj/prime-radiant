# Prime Radiant Worker — Remote API + MCP Server

Optional Cloudflare Worker that provides remote access to your vault without requiring Obsidian to be running. Exposes a REST API and MCP endpoint backed by R2 (file storage), D1 (SQLite with FTS5), Vectorize (semantic search), and Workers AI (embeddings).

**This is optional.** The core prime-radiant setup works without it.

## What You Get

- **REST API** — Full CRUD, keyword search, semantic search, hybrid search (RRF), graph queries
- **MCP endpoint** — 10 tools for any MCP-compatible AI agent (Claude, OpenClaw, Cursor, etc.)
- **Hybrid search** — Keyword (FTS5) + semantic (Vectorize) fused via Reciprocal Rank Fusion
- **Graph queries** — Wikilink traversal, backlinks, full vault graph (for visualization)
- **Globally available** — Edge-deployed, sub-100ms latency, works from any device
- **Free tier sufficient** — R2 10GB, D1 5M reads/day, Vectorize 10M dimensions, Workers 100K req/day

## Setup

### Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up) (free)
- Node.js 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)

### 1. Install dependencies

```bash
cd worker
npm install
```

### 2. Create Cloudflare resources

```bash
# Login to Cloudflare
wrangler login

# Create D1 database
wrangler d1 create prime-radiant-db
# Copy the database_id from the output

# Create R2 bucket
wrangler r2 bucket create prime-radiant-vault

# Create Vectorize index
wrangler vectorize create prime-radiant-embeddings --dimensions=384 --metric=cosine
```

### 3. Configure

Edit `wrangler.toml` and paste your `database_id`.

Set your API token:
```bash
wrangler secret put API_TOKEN
# Enter a strong random string (e.g. openssl rand -hex 32)
```

### 4. Initialize database

```bash
# Local (for dev)
wrangler d1 execute prime-radiant-db --file=schema.sql

# Remote (for production)
wrangler d1 execute prime-radiant-db --file=schema.sql --remote
```

### 5. Deploy

```bash
wrangler deploy
```

Your worker is now live at `https://prime-radiant.<your-subdomain>.workers.dev`.

### 6. Sync your vault

```bash
export PRIME_RADIANT_URL="https://prime-radiant.<your-subdomain>.workers.dev"
export PRIME_RADIANT_TOKEN="<your-token>"

# Full sync (first time)
FULL_SYNC=1 ../scripts/sync.sh /path/to/vault

# Incremental sync (subsequent)
../scripts/sync.sh /path/to/vault
```

Add to crontab for automatic sync:
```bash
# Every 5 minutes
*/5 * * * * PRIME_RADIANT_URL="..." PRIME_RADIANT_TOKEN="..." /path/to/scripts/sync.sh /path/to/vault
```

Or trigger from the Obsidian Git plugin's post-commit hook.

## API Reference

All endpoints require `Authorization: Bearer <token>` header (or `?key=<token>` query param).

### Notes

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/notes?type=&status=&tag=&limit=&offset=` | List notes (with filters) |
| GET | `/api/notes/{path}` | Read note |
| PUT | `/api/notes/{path}` | Create/update note (body: markdown) |
| POST | `/api/notes/{path}` | Append to note (body: content to append) |
| DELETE | `/api/notes/{path}` | Delete note |

### Search

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/search?q=&mode=&limit=` | Search (mode: hybrid/keyword/semantic) |

### Graph

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/graph` | Full vault graph (all nodes + edges) |
| GET | `/api/graph?path=&depth=` | Local graph from a note |
| GET | `/api/backlinks/{path}` | Notes that link to this note |

### Tags & Stats

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/tags` | All tags with counts |
| GET | `/api/stats` | Vault statistics |

### Sync

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/manifest` | Path→checksum map for all notes |
| POST | `/api/sync` | Bulk sync (body: `{files: [{path, content}], prune?: bool}`) |

## MCP Server

Connect any MCP-compatible client to `https://prime-radiant.<subdomain>.workers.dev/mcp`.

### Claude Desktop / ChatGPT

Add as a custom connector with URL:
```
https://prime-radiant.<subdomain>.workers.dev/mcp?key=<your-token>
```

### Claude Code

Add to your project's `.mcp.json`:
```json
{
  "mcpServers": {
    "prime-radiant": {
      "type": "http",
      "url": "https://prime-radiant.<subdomain>.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer <your-token>"
      }
    }
  }
}
```

### Tools

| Tool | Description |
|------|-------------|
| `vault_search` | Hybrid/keyword/semantic search |
| `vault_read` | Read a note |
| `vault_write` | Create/update a note |
| `vault_append` | Append to a note |
| `vault_delete` | Delete a note |
| `vault_list` | List notes with filters |
| `vault_graph` | Connection graph (local or full) |
| `vault_tags` | All tags with counts |
| `vault_backlinks` | Notes linking to a given note |
| `vault_stats` | Vault statistics |

## Development

```bash
# Run locally
wrangler dev

# Run with remote D1/R2/Vectorize (for testing against prod data)
wrangler dev --remote
```
