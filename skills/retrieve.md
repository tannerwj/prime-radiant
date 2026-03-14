# Skill: Prime Radiant Retrieve

You are an agent with access to a personal knowledge vault (Obsidian). Your job is to search, query, and extract relevant information to answer questions or provide context.

## Architecture

```
  Obsidian CLI (local reads)          Worker MCP (search/embeddings)
       │                                     │
       ▼                                     ▼
  Local Vault (~/prime-radiant/)     Cloudflare Worker
  = source of truth                    ├─ D1  — metadata + FTS5 search
                                       ├─ R2  — markdown storage
                                       ├─ Vectorize — semantic search
                                       └─ Workers AI — embedding model
```

The local vault is the source of truth. The Cloudflare Worker mirrors it (synced every 5 min) and provides search capabilities that don't exist locally: hybrid search (keyword + semantic), graph traversal over indexed links, and filtering by metadata.

## Access Methods

Two access paths: **Worker MCP** for search/embeddings, **Obsidian CLI** for local reads and structured queries.

### Search (Prime Radiant MCP)

Best for: semantic/keyword/hybrid search, graph traversal, filtering by type/tag/status.

| MCP Tool | Use |
|----------|-----|
| `vault_search(query, mode?, limit?)` | Search notes — mode: `hybrid` (default), `keyword`, `semantic` |
| `vault_read(path)` | Read full note content from the worker |
| `vault_list(type?, status?, tag?, limit?)` | List/filter notes by metadata |
| `vault_graph(path?, depth?)` | Connection graph for a note (or full vault if no path) |
| `vault_backlinks(path)` | Notes that link to the given note |
| `vault_tags()` | All tags with usage counts |
| `vault_stats()` | Vault metrics: counts, type distribution |

### Local Reads & Structured Queries (Obsidian CLI)

Best for: reading specific notes, exact-phrase search, tags, backlinks, tasks.

```bash
# Read a note
obsidian vault="Prime Radiant" read file="Note Title"
obsidian vault="Prime Radiant" read path="06-people/Jane Smith.md"
obsidian vault="Prime Radiant" properties file="Note Title"     # frontmatter only

# Keyword search
obsidian vault="Prime Radiant" search query="exact phrase" limit=10 format=json
obsidian vault="Prime Radiant" search:context query="term" limit=5

# By tag
obsidian vault="Prime Radiant" tag tag="#topic/health"

# Backlinks & outgoing links
obsidian vault="Prime Radiant" backlinks file="Morning Routine"
obsidian vault="Prime Radiant" links file="Morning Routine"

# Tasks
obsidian vault="Prime Radiant" tasks todo              # all incomplete
obsidian vault="Prime Radiant" tasks daily todo         # today's incomplete

# Tags overview
obsidian vault="Prime Radiant" tags sort=count counts

# Orphans (unlinked notes)
obsidian vault="Prime Radiant" orphans
```

## Query Strategy

### Step 1: Understand the intent

| Intent | Approach |
|--------|----------|
| "What do I know about X?" | Semantic search → read top results → follow links |
| "What are my preferences for X?" | Search `type: preference` + keyword X |
| "Who is X?" | Search `06-people/` for name |
| "What happened on/around date X?" | Read daily note + search by date |
| "How does X relate to Y?" | Get connection graph from X, search for Y, find intersection |
| "What are my active projects?" | Dataview query: `WHERE type = "project" AND status = "active"` |
| "What links mention X?" | Backlinks for note X |
| "Give me everything relevant to scenario X" | Multi-step: semantic search → read results → follow links → expand |

### Step 2: Search broad, then narrow

1. **Semantic search first** — cast a wide net with `vault_search(query, mode="hybrid", limit=20)`
2. **Read the top results** — `vault_read(path)` to check frontmatter and content
3. **Follow the graph** — `vault_graph(path, depth=2)` or `vault_backlinks(path)` to find connections
4. **Filter by metadata** — `vault_list(type, status, tag)` to narrow
5. **Synthesize** — combine information across notes into a coherent answer

### Step 3: Handle missing information

If you can't find what's being asked about:
- Say so explicitly. Don't fabricate.
- Suggest what *is* available that's close.
- Note whether this is a gap worth capturing (suggest creating a note).

## Retrieval Patterns

### Pattern: Context Dump (for another AI agent)

When an external agent asks "give me everything relevant to X":

```
1. vault_search(query="X", mode="hybrid", limit=20)
2. For top 5 results: vault_read(path=result.path)
3. For most relevant result: vault_graph(path=result.path, depth=2)
4. Read any highly connected neighbors
5. Return: structured summary + raw note contents + relationship map
```

### Pattern: Person Lookup

```
1. vault_search(query="Person Name", limit=5)
2. vault_read(path="06-people/Person Name.md")
3. vault_backlinks(path="06-people/Person Name.md")
4. Read recent interactions from backlinked notes
5. Return: profile + recent interactions + context
```

### Pattern: Decision Support

When asked "should I do X?" or "what do I think about X?":

```
1. Semantic search for the topic and related concepts
2. Find relevant preferences, experiences, reflections
3. Check for related projects or areas
4. Return: relevant past experiences + stated preferences + any patterns
```

### Pattern: Timeline Reconstruction

When asked "what was happening around [date]?":

```
1. Read daily note(s) for that date range
2. Search for notes modified in that period (Dataview: WHERE modified >= date AND modified <= date)
3. Check project logs for that period
4. Return: chronological summary of activities, thoughts, events
```

### Pattern: Relationship Mapping

When asked "how does X relate to Y?":

```
1. Get connection graph from X (depth 2-3)
2. Get connection graph from Y (depth 2-3)
3. Find shared connections (notes that appear in both graphs)
4. Read the connecting notes
5. Return: the path between X and Y through the knowledge graph
```

## Output Guidelines

When returning information from the vault:

1. **Cite your sources.** Reference note titles and paths so the user can verify: `(from [[Morning Routine]])`
2. **Distinguish stored facts from inference.** "Your notes say X" vs "Based on your notes, it seems like Y"
3. **Respect note maturity.** A `status: seed` note is a rough capture — don't treat it as authoritative. `status: evergreen` notes are vetted.
4. **Surface connections.** If you notice relationships the user might not have — mention them. "Your preference for minimalism (from [[Design Preferences]]) might be relevant to this project decision."
5. **Flag staleness.** If a note's `modified` date is old and the content might be outdated, say so.
