# Prime Radiant

A lifelong, agent-accessible personal knowledge base built on Obsidian.

> *"The Prime Radiant held the Seldon Plan — the entire future of civilization encoded in a single device, accessible only to those entrusted with its care."*
> — Foundation, Isaac Asimov

## Modules

| Module | What | Required? |
|--------|------|-----------|
| **Core** (this README) | Obsidian vault + plugins + CLI + skills + templates | Yes |
| **[Worker](worker/)** | Cloudflare Worker — read-only MCP server + REST API for search/embeddings. Cron-synced from local vault. | Optional |
| **Graph** *(planned)* | Interactive knowledge graph visualization via Quartz + Cloudflare Pages | Optional |

Start with Core. Add modules when you need them.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    You (Human)                       │
│   Phone quick note · Voice memo · Long-form write   │
└───────────┬──────────────────────────┬──────────────┘
            │ raw input                │ browse/edit
            ▼                          ▼
┌──────────────────┐       ┌──────────────────────────┐
│   00-inbox/      │       │   Obsidian App           │
│   (drop zone)    │       │   (read/write/link)      │
└────────┬─────────┘       └──────────────────────────┘
         │                           ▲
         ▼                           │
┌──────────────────┐       ┌─────────┴────────────────┐
│  AI Agent        │       │   Obsidian Vault         │
│  (LLM +         │──────▶│   ~/prime-radiant/       │
│   Obsidian CLI)  │ write │   = Source of Truth      │
└──────────────────┘       └─────────┬────────────────┘
         ▲                           │
         │ read (MCP)                │ cron sync (every 5 min)
         │                           ▼
         │                 ┌──────────────────────────┐
         │                 │   Cloudflare Worker      │
         │                 │   REST API + MCP server  │
         │                 ├──────────────────────────┤
         │                 │ D1  — metadata + FTS5    │
         └─────────────────│ R2  — markdown storage   │
                           │ Vectorize — embeddings   │
                           │ Workers AI — embed model │
                           └──────────────────────────┘
```

**Source of truth:** Markdown files in the local Obsidian vault. Everything else is derived.

**Data flow:**
1. **Writes** go through the **Obsidian CLI** → local vault files
2. **Cron** syncs local vault → Cloudflare Worker every 5 minutes
3. **Reads/search** go through the **Worker MCP** (semantic, keyword, hybrid search)

**Cloudflare ecosystem:**

| Service | Role |
|---------|------|
| **Worker** | Hono app — REST API + MCP server, auth, routing |
| **D1** | SQLite — note metadata, tags, links, FTS5 full-text search |
| **R2** | Object storage — raw markdown files |
| **Vectorize** | Vector database — 384-dim embeddings for semantic search |
| **Workers AI** | Embedding model — generates vectors on write/sync |

**Local tools:**
- **Obsidian CLI** — all writes: create, append, move, delete, property management, search
- **Obsidian Git plugin** — auto-commit every 10 min, version history
- **Smart Connections** — local embeddings for in-Obsidian semantic search
- **Dataview** — structured queries over frontmatter

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
| **Smart Connections** | Semantic search via local embeddings (powers "find similar" in Obsidian) | Enable, let it build initial index. Check `.smart-env/` exists after. |
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

### 6. Obsidian CLI Reference

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

Agents **write locally** via Obsidian CLI, **read remotely** via the Worker MCP:

| Operation | Method | Why |
|-----------|--------|-----|
| Create/update/append/delete notes | Obsidian CLI | Keeps local vault as source of truth |
| Search (semantic, keyword, hybrid) | Worker MCP (`vault_search`) | Cloudflare has embeddings + FTS5 |
| Read note content | Worker MCP (`vault_read`) or Obsidian CLI | Either works; MCP if Obsidian isn't running |
| Graph/backlinks/tags/stats | Worker MCP | Pre-indexed in D1 |
| Frontmatter properties | Obsidian CLI (`property:set`) | Direct local edit |

See the skill files for complete agent instructions:

- **`skills/ingest.md`** — How to structure, classify, and file incoming data (writes via Obsidian CLI)
- **`skills/retrieve.md`** — How to search, query, and extract data (reads via MCP + CLI)

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
