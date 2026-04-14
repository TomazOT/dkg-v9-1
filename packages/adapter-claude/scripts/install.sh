#!/bin/bash
# ============================================================================
# DKG Claude Adapter — Install Script
#
# Automatically adds the dkg-memory MCP server to ~/.claude/settings.json
# so Claude Code picks up the 12 DKG tools on next startup.
#
# Preserves all existing settings (other MCP servers, hooks, plugins, etc.).
#
# Usage:
#   cd packages/adapter-claude
#   ./scripts/install.sh
# ============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ADAPTER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_ENTRY="$ADAPTER_DIR/dist/index.js"
CLAUDE_DIR="$HOME/.claude"
SETTINGS_FILE="$CLAUDE_DIR/settings.json"

echo "DKG Claude Adapter Installer"
echo "============================"
echo ""
echo "  Adapter dir: $ADAPTER_DIR"
echo "  Entry:       $DIST_ENTRY"
echo "  Settings:    $SETTINGS_FILE"
echo ""

# ── Check that the adapter is built ─────────────────────────────────────────

if [ ! -f "$DIST_ENTRY" ]; then
  echo "  Error: dist/index.js not found."
  echo "  Build the adapter first:"
  echo ""
  echo "    cd $ADAPTER_DIR"
  echo "    pnpm install && pnpm build"
  echo ""
  exit 1
fi

# ── Check that node is available ────────────────────────────────────────────

if ! command -v node >/dev/null 2>&1; then
  echo "  Error: node is required to merge settings.json."
  exit 1
fi

# ── Ensure Claude config directory exists ───────────────────────────────────

mkdir -p "$CLAUDE_DIR"

# ── Merge MCP server into settings.json ─────────────────────────────────────
# Uses Node so we don't add a jq dependency. Reads existing settings
# (if any), merges dkg-memory into mcpServers, writes back atomically.

node - "$SETTINGS_FILE" "$DIST_ENTRY" <<'NODE_EOF'
const fs = require('fs');
const path = require('path');

const settingsPath = process.argv[2];
const entryPath = process.argv[3];

let settings = {};
if (fs.existsSync(settingsPath)) {
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch (e) {
    console.error(`  Error: ${settingsPath} is not valid JSON.`);
    console.error(`  Please fix it manually and re-run install.`);
    process.exit(1);
  }
}

if (!settings.mcpServers || typeof settings.mcpServers !== 'object') {
  settings.mcpServers = {};
}

const existing = settings.mcpServers['dkg-memory'];
const newConfig = {
  command: 'node',
  args: [entryPath],
};

if (existing && JSON.stringify(existing) === JSON.stringify(newConfig)) {
  console.log('  dkg-memory already configured with matching entry — no change.');
  process.exit(0);
}

if (existing) {
  console.log('  Existing dkg-memory entry found — updating path.');
}

settings.mcpServers['dkg-memory'] = newConfig;

// Atomic write: temp file + rename
const tmpPath = settingsPath + '.tmp';
fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n');
fs.renameSync(tmpPath, settingsPath);

console.log('  Added dkg-memory to mcpServers in settings.json');
NODE_EOF

echo ""
echo "Done. Next steps:"
echo ""
echo "  1. Start the DKG daemon (in another terminal):"
echo "       dkg init    # first-time setup"
echo "       dkg start"
echo ""
echo "  2. Restart Claude Code to load the new MCP server."
echo ""
echo "  3. Verify 12 DKG tools appear in the tool list:"
echo "       dkg_memory, dkg_query, dkg_share, dkg_publish, dkg_wallet_balances,"
echo "       dkg_find_agents, dkg_send_message, dkg_read_messages,"
echo "       dkg_invoke_skill, dkg_context_graph_create, dkg_subscribe, dkg_status"
echo ""
echo "  If the daemon is on a different machine or port, set DKG_DAEMON_URL"
echo "  in the MCP server config's env block."
echo ""
