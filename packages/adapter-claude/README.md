# DKG Adapter for Claude Code

Connects Claude Code (and Claude Desktop) to a DKG V10 node for verifiable, shared agent memory.

Three integration layers:
1. **MCP tools** — 12 DKG operations as native Claude tools
2. **Lifecycle hooks** — auto-sync CLAUDE.md with DKG on session start/end
3. **Context injection** — DKG facts injected into `<dkg-context>` tags in CLAUDE.md

## Quick Start

### 1. Install and initialize DKG node (first time only)

```bash
npm install -g @origintrail-official/dkg
dkg init    # Interactive: choose chain, create wallet, set node name
```

### 2. Add MCP server to Claude Code

In `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "dkg-memory": {
      "command": "npx",
      "args": ["--yes", "@origintrail-official/dkg-adapter-claude"]
    }
  }
}
```

### 3. Start DKG daemon

```bash
dkg start
```

### 4. Open Claude Code

12 DKG tools appear automatically. Try: "Use dkg_status to check the node"

## Optional: Lifecycle Hooks

Add hooks to auto-sync CLAUDE.md with DKG memory. In your project's `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{
      "type": "command",
      "command": "npx --yes @origintrail-official/dkg-adapter-claude dkg-claude-sync",
      "timeout": 10
    }],
    "Stop": [{
      "type": "command",
      "command": "npx --yes @origintrail-official/dkg-adapter-claude dkg-claude-sync",
      "timeout": 10
    }]
  }
}
```

With hooks enabled, CLAUDE.md automatically contains your DKG facts at session start — no need to call `dkg_query` explicitly.

## How It Works

### Without hooks (MCP only)

Claude has 12 DKG tools. It must explicitly call `dkg_query` or `dkg_memory` to interact with the knowledge graph. Simple, pull-based.

### With hooks (full integration)

```
Session start → hook queries DKG → injects facts into CLAUDE.md
                                    ↓
Claude reads CLAUDE.md naturally → has full context
                                    ↓
Claude calls dkg_memory → writes to DKG
                                    ↓
Session end → hook syncs CLAUDE.md → facts persist for next session
```

CLAUDE.md uses `<dkg-context>` tags so your own instructions are preserved:

```markdown
# My Project Instructions       ← your content (preserved)

Some custom instructions here.

<dkg-context>                    ← auto-managed by DKG
## DKG Node
- Status: connected
- Peers: 4

## Memory [DKG Working Memory]
Project uses Python 3.11
User prefers concise responses

## DKG Tools
MEMORY: dkg_memory, dkg_query
COLLABORATE: dkg_share, dkg_publish, dkg_wallet_balances
...
</dkg-context>
```

## Tools

| Tool | Category | Description |
|------|----------|-------------|
| `dkg_memory` | Memory | Store/update/remove persistent facts |
| `dkg_query` | Memory | SPARQL queries on the knowledge graph |
| `dkg_share` | Collaboration | Share to Shared Working Memory (free) |
| `dkg_publish` | Collaboration | Publish to Verified Memory (costs TRAC) |
| `dkg_wallet_balances` | Collaboration | Check TRAC/ETH before publishing |
| `dkg_find_agents` | Network | Discover agents on the network |
| `dkg_send_message` | Network | Encrypted P2P messaging |
| `dkg_read_messages` | Network | Read agent conversations |
| `dkg_invoke_skill` | Network | Call remote agent capabilities |
| `dkg_context_graph_create` | Projects | Create new knowledge spaces |
| `dkg_subscribe` | Projects | Join existing projects |
| `dkg_status` | Projects | Node health and status |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DKG_DAEMON_URL` | `http://127.0.0.1:9200` | DKG daemon URL |
| `DKG_CONTEXT_GRAPH` | (empty) | Default Context Graph |
| `DKG_AGENT_NAME` | `claude` | Agent identity for scoping |

## License

Apache-2.0
