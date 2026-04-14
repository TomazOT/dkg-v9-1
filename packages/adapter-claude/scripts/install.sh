#!/bin/bash
# ============================================================================
# DKG Claude Adapter — Install Script
#
# Sets up MCP server config + hooks for Claude Code.
# Run from anywhere — detects Claude config location automatically.
# ============================================================================

set -e

CLAUDE_DIR="$HOME/.claude"
SETTINGS_FILE="$CLAUDE_DIR/settings.json"

echo "DKG Claude Adapter Installer"
echo "============================"
echo ""

# Ensure .claude directory exists
mkdir -p "$CLAUDE_DIR"

# ── MCP Server Config ────────────────────────────────────────────────────────

if [ -f "$SETTINGS_FILE" ]; then
  # Check if dkg-memory MCP server already configured
  if grep -q "dkg-memory\|dkg-adapter-claude" "$SETTINGS_FILE" 2>/dev/null; then
    echo "  MCP server already configured in settings.json"
  else
    echo "  Adding DKG MCP server to settings.json..."
    echo "  (Manual step — add this to your mcpServers in $SETTINGS_FILE):"
    echo ""
    echo '    "dkg-memory": {'
    echo '      "command": "npx",'
    echo '      "args": ["--yes", "@origintrail-official/dkg-adapter-claude"]'
    echo '    }'
    echo ""
  fi
else
  echo "  Creating $SETTINGS_FILE with DKG MCP server..."
  cat > "$SETTINGS_FILE" << 'SETTINGSEOF'
{
  "mcpServers": {
    "dkg-memory": {
      "command": "npx",
      "args": ["--yes", "@origintrail-official/dkg-adapter-claude"]
    }
  }
}
SETTINGSEOF
  echo "  Created."
fi

# ── Hooks ─────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOOKS_SRC="$SCRIPT_DIR/hooks.json"

if [ -f "$HOOKS_SRC" ]; then
  echo ""
  echo "  Hooks file available at: $HOOKS_SRC"
  echo "  To enable lifecycle hooks (auto-sync CLAUDE.md with DKG),"
  echo "  add this to your project's .claude/settings.json:"
  echo ""
  echo '    "hooks": {'
  echo '      "SessionStart": [{"type": "command", "command": "npx --yes @origintrail-official/dkg-adapter-claude dkg-claude-sync", "timeout": 10}],'
  echo '      "PostToolUse": [{"matcher": "Write|Edit|Bash", "type": "command", "command": "npx --yes @origintrail-official/dkg-adapter-claude dkg-claude-sync --observation \"$CLAUDE_TOOL_RESULT\"", "timeout": 5}],'
  echo '      "Stop": [{"type": "command", "command": "npx --yes @origintrail-official/dkg-adapter-claude dkg-claude-sync", "timeout": 10}]'
  echo '    }'
fi

echo ""
echo "Done! Next steps:"
echo "  1. Start the DKG daemon: dkg start"
echo "  2. Open Claude Code — 12 DKG tools will be available"
echo "  3. Try: 'Use dkg_status to check the node'"
echo ""
