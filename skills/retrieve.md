# Skill: Brain Retrieve

You are an agent with access to a personal knowledge vault (Obsidian). Your job is to search, query, and extract relevant information to answer questions or provide context.

## Access Methods

You have three search/read paths. Use the best one for the query type:

### Semantic Search (Smart Connections MCP)

Best for: fuzzy/conceptual queries, "find notes about X", "what do I know about Y"

| Tool | Use |
|------|-----|
| `get_similar_notes(query, limit, threshold)` | Find notes by meaning. Threshold 0-1 (default 0.5). |
| `get_connection_graph(note_path, depth)` | Explore related notes radiating from a starting point. |
| `search_notes(query, limit)` | Keyword-ranked search across vault. |
| `get_note_content(path, section)` | Read a specific note or section. |
| `get_stats()` | Vault overview: total notes, embedding info. |

### Keyword Search (CLI or REST API)

Best for: exact terms, names, specific phrases, property values

**CLI:**
```bash
obsidian vault="Brain" search query="exact phrase" limit=10 format=json
obsidian vault="Brain" search:context query="term" limit=5
```

**REST API:**
```bash
curl -X POST "https://127.0.0.1:27124/search/simple/?query=term&contextLength=200" \
  -H "Authorization: Bearer <key>" -k
```

### Structured Queries (CLI or REST API)

Best for: filtering by type, tag, status, date ranges, relationships

**By tag:**
```bash
obsidian vault="Brain" tag tag="#topic/health"
obsidian vault="Brain" tag tag="#person"
```

**By backlinks (what references a note):**
```bash
obsidian vault="Brain" backlinks file="Morning Routine"
```

**By outgoing links:**
```bash
obsidian vault="Brain" links file="Morning Routine"
```

**Tasks:**
```bash
obsidian vault="Brain" tasks todo              # all incomplete
obsidian vault="Brain" tasks daily todo         # today's incomplete
```

**Tag overview:**
```bash
obsidian vault="Brain" tags sort=count counts   # all tags with frequency
```

**Orphans (unlinked notes):**
```bash
obsidian vault="Brain" orphans
```

**Dataview via REST API** (requires Dataview plugin):
```bash
curl -X POST "https://127.0.0.1:27124/search/" \
  -H "Authorization: Bearer <key>" \
  -H "Content-Type: text/vnd.dataview.dql" \
  -d 'TABLE title, status, modified FROM "02-notes" WHERE type = "preference" SORT modified DESC' -k
```

### Read Specific Notes

**CLI:**
```bash
obsidian vault="Brain" read file="Note Title"
obsidian vault="Brain" read path="06-people/Jane Smith.md"
obsidian vault="Brain" properties file="Note Title"     # frontmatter only
```

**REST API:**
```bash
# Raw markdown
curl -H "Authorization: Bearer <key>" \
  "https://127.0.0.1:27124/vault/06-people/Jane%20Smith.md" -k

# Structured (with parsed frontmatter)
curl -H "Authorization: Bearer <key>" \
  -H "Accept: application/vnd.olrapi.note+json" \
  "https://127.0.0.1:27124/vault/06-people/Jane%20Smith.md" -k
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

1. **Semantic search first** — cast a wide net with `get_similar_notes`
2. **Read the top results** — check frontmatter and content for relevance
3. **Follow the graph** — use `get_connection_graph` or `backlinks` to find connected notes
4. **Filter by metadata** — use tags, type, status, dates to narrow
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
1. Semantic search: get_similar_notes(query="X", limit=20, threshold=0.3)
2. For top 5 results: get_note_content(path=result.path)
3. For most relevant result: get_connection_graph(note_path=result.path, depth=2)
4. Read any highly connected neighbors
5. Return: structured summary + raw note contents + relationship map
```

### Pattern: Person Lookup

```
1. Search: obsidian search query="Person Name" format=json
2. Read person note: obsidian read path="06-people/Person Name.md"
3. Get backlinks: obsidian backlinks file="Person Name"
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
