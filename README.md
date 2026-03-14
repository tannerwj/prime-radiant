# Prime Radiant

A lifelong, agent-accessible personal knowledge base built on Obsidian.

> *"The Prime Radiant held the Seldon Plan — the entire future of civilization encoded in a single device, accessible only to those entrusted with its care."*
> — Foundation, Isaac Asimov

## Modules

| Module | What | Required? |
|--------|------|-----------|
| **Core** (this README) | Obsidian vault + plugins + CLI + skills + templates | Yes |
| **[Worker](worker/)** | Cloudflare Worker — remote REST API + MCP server, works without Obsidian running | Optional |
| **Graph** *(planned)* | Interactive knowledge graph visualization via Quartz + Cloudflare Pages | Optional |

Start with Core. Add modules when you need them.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  You (Human)                     │
│  Phone quick note · Voice memo · Long-form write │
└──────────┬──────────────────────────┬────────────┘
           │ raw input                │ browse/edit
           ▼                          ▼
┌─────────────────┐       ┌────────────────────────┐
│   00-inbox/     │       │   Obsidian App         │
│   (drop zone)   │       │   (read/write/link)    │
└────────┬────────┘       └────────────────────────┘
         │                          ▲
         ▼                          │
┌─────────────────┐       ┌────────┴───────────────┐
│  Inbox Agent    │       │   Obsidian Vault       │
│  (LLM + CLI)   │──────▶│   (Markdown files)     │
│  classifies,    │       │   = Source of Truth     │
│  tags, files    │       └────────┬───────────────┘
└─────────────────┘                │
                                   │ watches / indexes
                    ┌──────────────┼──────────────┐
                    ▼              ▼              ▼
              ┌──────────┐  ┌──────────┐  ┌──────────┐
              │ Smart    │  │ Local    │  │ Obsidian │
              │ Connect. │  │ REST API │  │ CLI      │
              │ (search) │  │ (CRUD)   │  │ (script) │
              └────┬─────┘  └────┬─────┘  └────┬─────┘
                   │             │              │
                   ▼             ▼              ▼
              ┌────────────────────────────────────┐
              │        AI Agents (any)             │
              │  OpenClaw · Claude · future agents │
              └────────────────────────────────────┘
```

**Source of truth:** Markdown files in the Obsidian vault. Everything else is derived.

**Access layers** (all local, no cloud):
- **Obsidian CLI** — scriptable note creation, search, property management
- **Local REST API plugin** — HTTPS API on localhost for full CRUD
- **Smart Connections MCP** — semantic search over pre-computed embeddings
- **Git** — version history and backup

## Setup

### 1. Obsidian Vault

Create a new vault or designate an existing one as your Prime Radiant.

```bash
# Create vault directory
mkdir -p ~/prime-radiant

# Open in Obsidian (creates .obsidian config)
open "obsidian://new-vault?path=$HOME/prime-radiant&name=Prime Radiant"
```

Copy the vault structure and templates:

```bash
# Create folder structure
mkdir -p ~/prime-radiant/{00-inbox,01-daily,02-notes,03-projects,04-areas,05-resources,06-people,07-archive,templates,assets}

# Copy templates from this repo
cp templates/*.md ~/prime-radiant/templates/
```

### 2. Obsidian Sync (cross-device)

**Option A — Obsidian Sync** ($4/mo, E2E encrypted):
Settings → Sync → enable. Works on all platforms including mobile.

**Option B — Syncthing** (free, self-hosted):
```bash
brew install syncthing
# Configure to sync ~/prime-radiant between devices
# Exclude: .obsidian/workspace.json, .obsidian/workspace-mobile.json
```

### 3. Community Plugins

Install from Settings → Community Plugins → Browse:

| Plugin | Purpose | Config |
|--------|---------|--------|
| **Smart Connections** | Semantic search via local embeddings | Enable, let it build initial index. Check `.smart-env/` exists after. |
| **Local REST API** | HTTPS API for external agent access | Default port 27124. Copy API key from settings. |
| **Obsidian Git** | Auto-commit version history | See git setup below. |
| **Dataview** | Structured queries over frontmatter | Enable. Used by search/retrieval. |
| **Templater** | Template engine for note creation | Point to `templates/` folder. |

### 4. Git Version History

```bash
cd ~/prime-radiant

git init
```

Create `.gitignore`:
```
.obsidian/workspace.json
.obsidian/workspace-mobile.json
.obsidian/cache
.trash/
.smart-env/
```

```bash
git add .
git commit -m "initial vault"

# Optional: push to private remote for backup
git remote add origin git@github.com:YOUR_USER/prime-radiant.git
git push -u origin main
```

**Obsidian Git plugin config:**
- Auto commit-and-sync interval: `10` minutes
- Pull updates on startup: `enabled`
- Commit message: `vault backup: {{date}}`

### 5. Ollama (local embeddings)

Only needed if building Path B (custom indexing). Smart Connections handles its own embeddings for Path A.

```bash
brew install ollama
ollama serve  # runs on http://localhost:11434
ollama pull nomic-embed-text:v1.5
```

Verify:
```bash
curl http://localhost:11434/api/embed -d '{
  "model": "nomic-embed-text:v1.5",
  "input": "test embedding"
}'
```

### 6. Smart Connections MCP Server

This gives any MCP-compatible agent semantic search over your vault.

```bash
git clone https://github.com/msdanyg/smart-connections-mcp.git ~/smart-connections-mcp
cd ~/smart-connections-mcp
npm install && npm run build
```

Add to your MCP config (e.g. `~/.claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "smart-connections": {
      "command": "node",
      "args": ["<path-to>/smart-connections-mcp/dist/index.js"],
      "env": {
        "SMART_VAULT_PATH": "<path-to-your-vault>"
      }
    }
  }
}
```

**MCP tools exposed:**

| Tool | Description |
|------|-------------|
| `get_similar_notes` | Semantic search by meaning (query, limit, threshold) |
| `get_connection_graph` | Multi-level graph of related notes from a starting note |
| `search_notes` | Keyword-ranked search |
| `get_note_content` | Read full note or specific section |
| `get_stats` | Vault metrics (total notes, embedding dimensions, model) |

### 7. Local REST API Reference

Base URL: `https://127.0.0.1:27124`
Auth: `Authorization: Bearer <api-key>` (find in plugin settings)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/vault/{path}` | Read file |
| PUT | `/vault/{path}` | Create/overwrite file |
| POST | `/vault/{path}` | Append to file |
| PATCH | `/vault/{path}` | Insert at heading/block/frontmatter |
| DELETE | `/vault/{path}` | Delete file |
| GET | `/vault/` | List vault root |
| POST | `/search/simple/?query=term` | Full-text search |
| GET | `/periodic/daily/` | Today's daily note |
| POST | `/periodic/daily/` | Append to daily note |
| GET | `/commands/` | List all commands |
| POST | `/commands/{id}/` | Execute command |

Self-signed cert — use `-k` with curl or disable cert verification in agents.

### 8. Obsidian CLI Reference

Requires Obsidian to be running. Communicates via IPC.

```bash
# Target a specific vault (must be first arg)
obsidian vault="Prime Radiant" <command>

# File operations
obsidian create name="00-inbox/quick thought" content="raw text here"
obsidian read file="My Note"
obsidian read path="02-notes/some-note.md"
obsidian append file="My Note" content="\n\nNew paragraph"
obsidian prepend file="My Note" content="Inserted after frontmatter"
obsidian move file="My Note" to="07-archive/My Note"
obsidian delete file="My Note"

# Search
obsidian search query="meeting notes" limit=10 format=json
obsidian search:context query="decision" limit=5

# Daily notes
obsidian daily                          # open today's note
obsidian daily:read                     # print content
obsidian daily:append content="- 3pm: called dentist"

# Properties
obsidian properties file="My Note"
obsidian property:set file="My Note" name="status" value="evergreen"
obsidian property:remove file="My Note" name="draft"

# Tags & links
obsidian tags sort=count counts         # all tags with frequency
obsidian tag tag="#topic/health"        # notes with this tag
obsidian tags:rename old=oldtag new=newtag
obsidian backlinks file="My Note"       # what links to this note
obsidian links file="My Note"           # what this note links to
obsidian orphans                        # notes with no backlinks

# Tasks
obsidian tasks todo                     # all incomplete tasks
obsidian tasks daily todo               # incomplete tasks from today

# Vault info
obsidian files total                    # count all notes
obsidian folders                        # folder tree

# Flags
#   silent         — don't open in GUI
#   format=json    — JSON output
#   --copy         — copy output to clipboard
#   -e / --editor  — open in default text editor
```

## Vault Structure

```
~/prime-radiant/
├── 00-inbox/          # Raw captures. LLM triages from here.
├── 01-daily/          # Daily notes (YYYY-MM-DD.md)
├── 02-notes/          # Permanent notes (flat, organized by metadata)
├── 03-projects/       # Active projects with outcomes
├── 04-areas/          # Ongoing life areas (health, career, finance)
├── 05-resources/      # Reference material (books, articles, courses)
├── 06-people/         # One note per person
├── 07-archive/        # Completed/inactive items
├── templates/         # Note templates
├── assets/            # Images, PDFs, attachments
├── .obsidian/         # Obsidian config (git-tracked minus workspace)
├── .smart-env/        # Smart Connections embeddings (gitignored)
└── .git/              # Version history
```

Notes in `02-notes/` are kept flat. Organization is via frontmatter metadata, tags, and links — not subfolders. This is intentional: folders force a single taxonomy, metadata allows many.

## Frontmatter Standard

Every note has YAML frontmatter:

```yaml
---
type: concept                  # daily|person|project|concept|experience|reflection|preference|habit|resource|capture
title: "Descriptive Title"
created: 2026-03-14
modified: 2026-03-14
status: seed                   # seed|sprout|evergreen|archived
tags:
  - topic/psychology
  - area/career
aliases:
  - "alternate name"
related:
  - "[[Other Note]]"
source: ""                     # URL, book, person
---
```

See `skills/ingest.md` for the full schema per note type.

## Tagging Convention

Hierarchical tags with controlled top-level namespaces:

```
topic/          # Subject domains: topic/psychology, topic/finance, topic/cooking
area/           # Life areas: area/health, area/career, area/relationships
source/         # Provenance: source/book, source/article, source/conversation
```

Max 2 levels deep. Maintain a `Tags Index.md` note in the vault root as the canonical tag registry.

## Agent Access Patterns

See the skill files for complete instructions:

- **`skills/ingest.md`** — How an LLM should structure, classify, and file incoming data
- **`skills/retrieve.md`** — How an LLM should search, query, and extract data

These are agent-agnostic. Use them as system prompts, Claude Code skills, or reference docs for any LLM.

## Roadmap

**Phase 1 — Core** (Obsidian + plugins + CLI)
- [ ] Set up vault with folder structure and templates
- [ ] Install and configure plugins
- [ ] Set up git versioning
- [ ] Configure Smart Connections MCP server for agent access

**Phase 2 — Remote Access** (optional, `worker/`)
- [x] Cloudflare Worker with REST API + MCP endpoint
- [x] R2 file storage + D1 FTS5 + Vectorize semantic search
- [x] Hybrid search with Reciprocal Rank Fusion
- [x] Vault sync script
- [x] Graph traversal and backlink queries

**Phase 3 — Visualization** (optional, planned)
- [ ] Quartz static site with interactive graph view
- [ ] Deploy to Cloudflare Pages
- [ ] Auto-rebuild on vault changes

**Phase 4 — Processing Pipeline** (planned)
- [ ] Session rhythm (Orient → Work → Persist)
- [ ] Write-time schema validation hooks
- [ ] Reflect + Reweave phases (deep connection-finding beyond initial filing)
- [ ] Weekly review automation
- [ ] Quick capture templates (Decision, Person, Insight, Meeting, AI Save)
