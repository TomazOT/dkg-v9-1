#!/usr/bin/env node
/**
 * DKG MCP Server for Claude Code / Claude Desktop.
 *
 * Exposes 12 DKG tools via Model Context Protocol so Claude can:
 * - Store/recall persistent memory in DKG Working Memory
 * - Query the knowledge graph via SPARQL
 * - Share knowledge with team agents (Shared Working Memory)
 * - Publish to Verified Memory (chain-anchored, costs TRAC)
 * - Discover and message other agents on the network
 * - Create and join Context Graphs (projects)
 *
 * Combined with hooks.json for Claude Code lifecycle integration
 * and CLAUDE.md context injection, this gives Claude feature parity
 * with the Hermes Agent DKG adapter.
 *
 * Usage:
 *   npx @origintrail-official/dkg-adapter-claude
 *   # or in .claude/settings.json mcpServers config
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DkgDaemonClient } from './dkg-client.js';

const DEFAULT_URL = process.env.DKG_DAEMON_URL ?? 'http://127.0.0.1:9200';
const DEFAULT_CG = process.env.DKG_CONTEXT_GRAPH ?? '';

let _client: DkgDaemonClient | null = null;

function getClient(): DkgDaemonClient {
  if (!_client) {
    _client = new DkgDaemonClient(DEFAULT_URL);
  }
  return _client;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

function isUri(value: string): boolean {
  return /^(?:https?:\/\/|urn:|did:)/i.test(value);
}

// ─── Server ──────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'dkg-memory',
  version: '0.0.1',
});

// ─── MEMORY WORKFLOW ─────────────────────────────────────────────────────────

server.tool(
  'dkg_memory',
  'Store, update, or remove persistent facts in your DKG knowledge graph. ' +
  'These persist across sessions and can be shared with other agents. ' +
  'Actions: add (new fact), replace (update), remove (delete). ' +
  'Targets: memory (agent notes) or user (user profile).',
  {
    action: z.enum(['add', 'replace', 'remove']).describe('What to do'),
    target: z.enum(['memory', 'user']).default('memory').describe('Which store'),
    content: z.string().describe('The fact to store or identify'),
    old_text: z.string().optional().describe('For replace/remove: substring to match'),
  },
  async (args) => {
    try {
      const client = getClient();
      const result = await client.post('/api/hermes/memory-write', {
        action: args.action,
        target: args.target,
        content: args.content,
        oldText: args.old_text ?? '',
        agentName: 'claude',
      });
      return ok(JSON.stringify(result, null, 2));
    } catch (e) { return err(String(e)); }
  },
);

server.tool(
  'dkg_query',
  'Query the DKG knowledge graph using SPARQL. Returns structured results ' +
  'from Working Memory, Shared Memory, or the full Context Graph. ' +
  'Queries are local and fast — no network round-trip.',
  {
    sparql: z.string().describe('SPARQL query string'),
    context_graph: z.string().optional().describe('Context Graph scope (optional)'),
    include_shared_memory: z.boolean().optional().describe('Also search Shared Memory'),
  },
  async (args) => {
    try {
      const client = getClient();
      const result = await client.post('/api/query', {
        sparql: args.sparql,
        contextGraphId: args.context_graph ?? DEFAULT_CG || undefined,
        includeSharedMemory: args.include_shared_memory,
      });
      return ok(JSON.stringify(result, null, 2));
    } catch (e) { return err(String(e)); }
  },
);

// ─── COLLABORATION WORKFLOW ──────────────────────────────────────────────────

server.tool(
  'dkg_share',
  'Share knowledge to Shared Working Memory — visible to all team members ' +
  'and agents in the Context Graph. Free, gossip-replicated across peers.',
  {
    content: z.string().describe('Knowledge to share with the team'),
    context_graph: z.string().optional().describe('Target Context Graph'),
  },
  async (args) => {
    try {
      const client = getClient();
      const result = await client.post('/api/shared-memory/write', {
        contextGraphId: args.context_graph ?? DEFAULT_CG,
        content: args.content,
      });
      return ok(JSON.stringify(result, null, 2));
    } catch (e) { return err(String(e)); }
  },
);

server.tool(
  'dkg_publish',
  'Publish knowledge to Verified Memory — chain-anchored, permanent, costs TRAC. ' +
  'Two modes: with quads (structured RDF triples) or without (publishes entire SWM). ' +
  'Always call dkg_wallet_balances first to verify sufficient TRAC.',
  {
    context_graph: z.string().optional().describe('Context Graph to publish to'),
    quads: z.array(z.object({
      subject: z.string().describe('Subject URI'),
      predicate: z.string().describe('Predicate URI'),
      object: z.string().describe('Object — URI or literal'),
    })).optional().describe('Structured triples to publish (optional)'),
  },
  async (args) => {
    try {
      const client = getClient();
      const cg = args.context_graph ?? DEFAULT_CG;

      if (args.quads && args.quads.length > 0) {
        const quads = args.quads.map(q => ({
          subject: q.subject,
          predicate: q.predicate,
          object: isUri(q.object) ? q.object : `"${q.object.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
          graph: '',
        }));
        await client.post('/api/shared-memory/write', { contextGraphId: cg, quads });
        const result = await client.post('/api/shared-memory/publish', { contextGraphId: cg });
        return ok(JSON.stringify({ ...result, quadsPublished: quads.length }, null, 2));
      } else {
        const result = await client.post('/api/shared-memory/publish', { contextGraphId: cg });
        return ok(JSON.stringify(result, null, 2));
      }
    } catch (e) { return err(String(e)); }
  },
);

server.tool(
  'dkg_wallet_balances',
  'Check TRAC and ETH balances for the node\'s operational wallets. ' +
  'Call this BEFORE using dkg_publish to verify sufficient funds.',
  {},
  async () => {
    try {
      const result = await getClient().get('/api/wallet/balances');
      return ok(JSON.stringify(result, null, 2));
    } catch (e) { return err(String(e)); }
  },
);

// ─── NETWORK & DISCOVERY ────────────────────────────────────────────────────

server.tool(
  'dkg_find_agents',
  'Discover other DKG agents on the network. Returns agent names, peer IDs, ' +
  'frameworks, and available skills. Use to find collaborators or agents ' +
  'with specific capabilities.',
  {
    framework: z.string().optional().describe('Filter by framework (e.g. "OpenClaw", "hermes-agent")'),
    skill_type: z.string().optional().describe('Filter by skill URI'),
  },
  async (args) => {
    try {
      const params = new URLSearchParams();
      if (args.framework) params.set('framework', args.framework);
      if (args.skill_type) params.set('skill_type', args.skill_type);
      const qs = params.toString();
      const result = await getClient().get(`/api/agents${qs ? '?' + qs : ''}`);
      return ok(JSON.stringify(result, null, 2));
    } catch (e) { return err(String(e)); }
  },
);

server.tool(
  'dkg_send_message',
  'Send an encrypted P2P message to another DKG agent. Both agents must be online. ' +
  'Use dkg_find_agents first to discover peer IDs.',
  {
    peer_id: z.string().describe('Recipient peer ID or agent name'),
    text: z.string().describe('Message text'),
  },
  async (args) => {
    try {
      const result = await getClient().post('/api/chat', {
        peerId: args.peer_id,
        text: args.text,
      });
      return ok(JSON.stringify(result, null, 2));
    } catch (e) { return err(String(e)); }
  },
);

server.tool(
  'dkg_read_messages',
  'Read P2P messages from other DKG agents. Filter by peer to see a specific conversation.',
  {
    peer: z.string().optional().describe('Filter by peer ID or agent name'),
    limit: z.number().optional().describe('Max messages (default: 50)'),
  },
  async (args) => {
    try {
      const params = new URLSearchParams();
      if (args.peer) params.set('peer', args.peer);
      if (args.limit) params.set('limit', String(args.limit));
      const qs = params.toString();
      const result = await getClient().get(`/api/messages${qs ? '?' + qs : ''}`);
      return ok(JSON.stringify(result, null, 2));
    } catch (e) { return err(String(e)); }
  },
);

server.tool(
  'dkg_invoke_skill',
  'Invoke a skill on a remote DKG agent. Use dkg_find_agents with skill_type ' +
  'first to discover which agents offer the capability you need.',
  {
    peer_id: z.string().describe('Target agent peer ID or name'),
    skill_uri: z.string().describe('Skill URI to invoke'),
    input: z.string().describe('Input data as text'),
  },
  async (args) => {
    try {
      const result = await getClient().post('/api/invoke-skill', {
        peerId: args.peer_id,
        skillUri: args.skill_uri,
        input: args.input,
      });
      return ok(JSON.stringify(result, null, 2));
    } catch (e) { return err(String(e)); }
  },
);

// ─── PROJECT MANAGEMENT ─────────────────────────────────────────────────────

server.tool(
  'dkg_context_graph_create',
  'Create a new Context Graph — a bounded knowledge space for a project or team. ' +
  'Check dkg_status first to see if it already exists.',
  {
    name: z.string().describe('Human-readable name (e.g. "Pharma Research")'),
    description: z.string().optional().describe('What this Context Graph is for'),
  },
  async (args) => {
    try {
      const id = args.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const result = await getClient().post('/api/context-graph/create', {
        id,
        name: args.name,
        description: args.description,
      });
      return ok(JSON.stringify(result, null, 2));
    } catch (e) { return err(String(e)); }
  },
);

server.tool(
  'dkg_subscribe',
  'Subscribe to a Context Graph to receive its data and updates from the network.',
  {
    context_graph_id: z.string().describe('Context Graph ID to subscribe to'),
  },
  async (args) => {
    try {
      const result = await getClient().post('/api/context-graph/subscribe', {
        contextGraphId: args.context_graph_id,
      });
      return ok(JSON.stringify(result, null, 2));
    } catch (e) { return err(String(e)); }
  },
);

server.tool(
  'dkg_status',
  'Check DKG node health, connected peers, context graphs, and sync status.',
  {},
  async () => {
    try {
      const [status, cgs] = await Promise.all([
        getClient().get('/api/status'),
        getClient().get('/api/context-graph/list').catch(() => ({ contextGraphs: [] })),
      ]);
      return ok(JSON.stringify({ ...status, contextGraphs: cgs }, null, 2));
    } catch (e) { return err(String(e)); }
  },
);

// ─── Start ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
