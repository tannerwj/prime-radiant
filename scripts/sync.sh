#!/usr/bin/env bash
set -euo pipefail

# Sync local Obsidian vault to the remote Brain worker.
# Usage: ./scripts/sync.sh [vault_path]
#
# Environment variables:
#   BRAIN_API_URL   - Worker URL (e.g. https://prime-radiant.you.workers.dev)
#   BRAIN_API_TOKEN - API bearer token

VAULT="${1:-$HOME/Brain}"
API="${BRAIN_API_URL:?Set BRAIN_API_URL}"
TOKEN="${BRAIN_API_TOKEN:?Set BRAIN_API_TOKEN}"
SYNC_FILE="$VAULT/.brain-last-sync"
BATCH_SIZE=20

if [ ! -d "$VAULT" ]; then
  echo "Vault not found: $VAULT" >&2
  exit 1
fi

# Determine which files to sync
if [ "${FULL_SYNC:-}" = "1" ] || [ ! -f "$SYNC_FILE" ]; then
  echo "Full sync: $VAULT → $API"
  FIND_NEWER=""
else
  echo "Incremental sync (files changed since last sync)"
  FIND_NEWER="-newer $SYNC_FILE"
fi

cd "$VAULT"

# Collect files into batches and sync via the bulk endpoint
FILES='[]'
COUNT=0
TOTAL=0

flush_batch() {
  if [ "$COUNT" -eq 0 ]; then return; fi

  RESPONSE=$(curl -sf -X POST "$API/api/sync" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"files\": $FILES}" 2>&1) || {
    echo "  ✗ Batch failed: $RESPONSE" >&2
    FILES='[]'
    COUNT=0
    return
  }

  CREATED=$(echo "$RESPONSE" | grep -o '"created":[0-9]*' | cut -d: -f2)
  UPDATED=$(echo "$RESPONSE" | grep -o '"updated":[0-9]*' | cut -d: -f2)
  UNCHANGED=$(echo "$RESPONSE" | grep -o '"unchanged":[0-9]*' | cut -d: -f2)
  echo "  ✓ batch: ${CREATED:-0} created, ${UPDATED:-0} updated, ${UNCHANGED:-0} unchanged"

  FILES='[]'
  COUNT=0
}

while IFS= read -r file; do
  path="${file#./}"
  # Read file and JSON-escape the content
  content=$(python3 -c "
import json, sys
with open(sys.argv[1], 'r') as f:
    print(json.dumps(f.read()))
" "$file")

  # Append to batch
  if [ "$COUNT" -eq 0 ]; then
    FILES="[{\"path\":$(python3 -c "import json; print(json.dumps('$path'))"),\"content\":$content}]"
  else
    FILES=$(echo "$FILES" | python3 -c "
import json, sys
batch = json.load(sys.stdin)
batch.append({'path': '$path', 'content': $content})
print(json.dumps(batch))
")
  fi

  COUNT=$((COUNT + 1))
  TOTAL=$((TOTAL + 1))

  if [ "$COUNT" -ge "$BATCH_SIZE" ]; then
    flush_batch
  fi
done < <(find . -name '*.md' $FIND_NEWER \
  -not -path './.obsidian/*' \
  -not -path './.smart-env/*' \
  -not -path './.trash/*' \
  -not -path './.git/*' \
  -not -path './templates/*')

flush_batch

touch "$SYNC_FILE"
echo "Done. Processed $TOTAL files."
