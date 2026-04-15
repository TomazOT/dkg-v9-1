#!/usr/bin/env node
/**
 * DKG Claude Adapter — End-to-end test harness.
 *
 * Spins up a mock DKG daemon on a local port, starts the MCP server
 * pointing at it, runs all 12 tools via MCP JSON-RPC, and verifies:
 *   1. All tools are registered
 *   2. Each tool call succeeds (no isError)
 *   3. Each tool sends the expected request shape to the daemon
 *
 * Run against the current mock (quick correctness check):
 *   node test/harness.mjs
 *
 * Run against a real DKG daemon (integration test when V10 RC drops):
 *   DKG_DAEMON_URL=http://127.0.0.1:9200 node test/harness.mjs --real
 *
 * In --real mode, the harness skips the request-shape assertions (since
 * it has no control over responses) and just verifies that each tool
 * doesn't error. Useful for catching API contract changes.
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import readline from 'node:readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADAPTER_ENTRY = resolve(__dirname, '..', 'dist', 'index.js');
const MOCK_PORT = 19200;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}`;

const REAL_MODE = process.argv.includes('--real');
const DAEMON_URL = REAL_MODE ? (process.env.DKG_DAEMON_URL ?? 'http://127.0.0.1:9200') : MOCK_URL;

// ─── Mock daemon ─────────────────────────────────────────────────────────────

const mockRequests = [];

const mockResponses = {
  '/api/status': { peerId: 'mock-peer-1', connectedPeers: 3, ok: true },
  '/api/query': {
    results: {
      bindings: [
        { s: { value: 'urn:test:1' }, p: { value: 'urn:test:p' }, o: { value: 'test value' } },
      ],
    },
  },
  '/api/wallet/balances': {
    wallets: [{ address: '0xmock', trac: '1000.00', eth: '0.5' }],
  },
  '/api/agents': { agents: [{ name: 'mock-agent', peerId: 'mock-peer-1' }] },
  '/api/messages': { messages: [{ from: 'peer-1', text: 'hi' }] },
  '/api/chat': { delivered: true },
  '/api/invoke-skill': { result: 'mock-skill-result' },
  '/api/context-graph/create': { id: 'cg:test-xyz', uri: 'did:dkg:cg:test-xyz' },
  '/api/context-graph/list': { contextGraphs: [{ id: 'cg:test-xyz', name: 'test' }] },
  '/api/context-graph/subscribe': { subscribed: true },
  '/api/shared-memory/write': { shareOperationId: 'op-1' },
  '/api/shared-memory/publish': { kcId: 'kc-1', kas: [], txHash: '0xmock' },
  '/api/hermes/memory-write': { success: true },
};

function startMockDaemon() {
  return new Promise((resolveServer) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const path = req.url.split('?')[0];
        let parsedBody = null;
        if (body) {
          try {
            parsedBody = JSON.parse(body);
          } catch {
            parsedBody = body;
          }
        }
        mockRequests.push({ method: req.method, path, url: req.url, body: parsedBody });
        const response = mockResponses[path] ?? { ok: true };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      });
    });
    server.listen(MOCK_PORT, '127.0.0.1', () => resolveServer(server));
  });
}

// ─── MCP client over stdio ───────────────────────────────────────────────────

async function runMcpTests() {
  const server = spawn('node', [ADAPTER_ENTRY], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, DKG_DAEMON_URL: DAEMON_URL },
  });

  const stderr = [];
  server.stderr.on('data', (chunk) => stderr.push(chunk.toString()));

  const rl = readline.createInterface({ input: server.stdout });
  const mcpResponses = new Map();
  let msgId = 0;

  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined) mcpResponses.set(msg.id, msg);
    } catch {
      /* non-JSON line — ignore */
    }
  });

  function send(method, params = {}) {
    msgId++;
    const id = msgId;
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return new Promise((resolveResp, rejectResp) => {
      const timeout = setTimeout(
        () => rejectResp(new Error(`Timeout waiting for ${method}`)),
        5000,
      );
      const check = () => {
        if (mcpResponses.has(id)) {
          clearTimeout(timeout);
          resolveResp(mcpResponses.get(id));
        } else {
          setTimeout(check, 20);
        }
      };
      check();
    });
  }

  function notify(method, params = {}) {
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  // Handshake
  await send('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'harness', version: '1.0' },
  });
  notify('notifications/initialized');

  // List tools
  const toolsResp = await send('tools/list');
  const tools = (toolsResp.result?.tools ?? []).map((t) => t.name);

  // Tool execution with request capture
  const call = async (name, args) => {
    mockRequests.length = 0;
    try {
      const resp = await send('tools/call', { name, arguments: args });
      return {
        name,
        ok: !resp.result?.isError,
        response: resp.result,
        requests: [...mockRequests],
      };
    } catch (e) {
      return { name, ok: false, error: String(e), requests: [...mockRequests] };
    }
  };

  const results = [];
  results.push(await call('dkg_status', {}));
  results.push(await call('dkg_memory', { action: 'add', content: 'test fact from harness' }));
  results.push(await call('dkg_query', { sparql: 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 1' }));
  results.push(await call('dkg_share', { content: 'team note from harness' }));
  results.push(await call('dkg_publish', {})); // no quads: publish entire SWM
  results.push(
    await call('dkg_publish', {
      quads: [
        { subject: 'urn:test:finding/1', predicate: 'urn:test:title', object: 'literal value' },
        { subject: 'urn:test:finding/1', predicate: 'urn:test:source', object: 'https://example.org/source' },
      ],
    }),
  );
  results.push(await call('dkg_wallet_balances', {}));
  results.push(await call('dkg_find_agents', { framework: 'hermes-agent' }));
  results.push(await call('dkg_send_message', { peer_id: 'peer-1', text: 'hi' }));
  results.push(await call('dkg_read_messages', { limit: 5 }));
  results.push(
    await call('dkg_invoke_skill', {
      peer_id: 'peer-1',
      skill_uri: 'urn:skill:ImageAnalysis',
      input: 'test',
    }),
  );
  results.push(await call('dkg_context_graph_create', { name: 'Test Graph' }));
  results.push(await call('dkg_subscribe', { context_graph_id: 'cg:test-xyz' }));

  server.stdin.end();
  await new Promise((r) => setTimeout(r, 100));
  server.kill('SIGTERM');

  return { tools, results, stderr: stderr.join('') };
}

// ─── Assertions ──────────────────────────────────────────────────────────────

function runAssertions({ tools, results }) {
  const checks = [];
  const expected = [
    'dkg_memory',
    'dkg_query',
    'dkg_share',
    'dkg_publish',
    'dkg_wallet_balances',
    'dkg_find_agents',
    'dkg_send_message',
    'dkg_read_messages',
    'dkg_invoke_skill',
    'dkg_context_graph_create',
    'dkg_subscribe',
    'dkg_status',
  ];

  // 1. Tool registration
  for (const name of expected) {
    checks.push({ name: `Tool registered: ${name}`, pass: tools.includes(name) });
  }
  checks.push({
    name: `Tool count is exactly 12`,
    pass: tools.length === 12,
    detail: `got ${tools.length}: ${tools.join(', ')}`,
  });

  // 2. Every call returns without isError
  for (const r of results) {
    checks.push({
      name: `${r.name} returned without error`,
      pass: r.ok,
      detail: r.error || (r.response?.isError ? JSON.stringify(r.response).slice(0, 200) : ''),
    });
  }

  if (REAL_MODE) return checks; // skip request-shape assertions in real mode

  // 3. Request-shape assertions against the mock
  const byTool = {};
  for (const r of results) (byTool[r.name] = byTool[r.name] || []).push(r);

  // dkg_memory → POST /api/hermes/memory-write with {action, target, content}
  const memReq = byTool['dkg_memory']?.[0]?.requests?.[0];
  checks.push({
    name: 'dkg_memory POSTs to /api/hermes/memory-write',
    pass:
      memReq?.method === 'POST' &&
      memReq?.path === '/api/hermes/memory-write' &&
      memReq?.body?.action === 'add' &&
      memReq?.body?.target === 'memory' &&
      memReq?.body?.content === 'test fact from harness',
    detail: memReq ? JSON.stringify(memReq.body) : 'no request captured',
  });

  // dkg_query → POST /api/query with sparql field
  const queryReq = byTool['dkg_query']?.[0]?.requests?.[0];
  checks.push({
    name: 'dkg_query POSTs to /api/query with sparql',
    pass:
      queryReq?.method === 'POST' &&
      queryReq?.path === '/api/query' &&
      typeof queryReq?.body?.sparql === 'string',
    detail: queryReq ? JSON.stringify(queryReq.body) : '',
  });

  // dkg_share → POST /api/shared-memory/write with quads array (not plain text)
  const shareReq = byTool['dkg_share']?.[0]?.requests?.[0];
  checks.push({
    name: 'dkg_share sends quads array (not plain content)',
    pass:
      shareReq?.method === 'POST' &&
      shareReq?.path === '/api/shared-memory/write' &&
      Array.isArray(shareReq?.body?.quads) &&
      shareReq.body.quads.length > 0 &&
      typeof shareReq.body.quads[0]?.subject === 'string',
    detail: shareReq ? JSON.stringify(shareReq.body).slice(0, 200) : '',
  });
  checks.push({
    name: 'dkg_share does NOT send plain content field',
    pass: shareReq && !('content' in (shareReq.body ?? {})),
    detail: shareReq?.body?.content ? `found content: ${shareReq.body.content}` : '',
  });

  // dkg_publish no-quads → just publish call
  const publishPlain = byTool['dkg_publish']?.[0];
  checks.push({
    name: 'dkg_publish (no quads) only calls /api/shared-memory/publish',
    pass:
      publishPlain?.requests?.length === 1 &&
      publishPlain.requests[0].path === '/api/shared-memory/publish',
    detail: publishPlain
      ? `paths: ${publishPlain.requests.map((r) => r.path).join(', ')}`
      : '',
  });

  // dkg_publish with quads → write + publish
  const publishQuads = byTool['dkg_publish']?.[1];
  checks.push({
    name: 'dkg_publish (with quads) writes to SWM then publishes',
    pass:
      publishQuads?.requests?.length === 2 &&
      publishQuads.requests[0].path === '/api/shared-memory/write' &&
      publishQuads.requests[1].path === '/api/shared-memory/publish',
    detail: publishQuads
      ? `paths: ${publishQuads.requests.map((r) => r.path).join(', ')}`
      : '',
  });

  // URI auto-detect: literal → quoted, URI → bare
  const publishWriteBody = publishQuads?.requests?.[0]?.body?.quads;
  checks.push({
    name: 'dkg_publish URI auto-detect: literal object is quoted',
    pass: publishWriteBody?.[0]?.object === '"literal value"',
    detail: publishWriteBody ? `object: ${publishWriteBody[0].object}` : '',
  });
  checks.push({
    name: 'dkg_publish URI auto-detect: https:// object is bare',
    pass: publishWriteBody?.[1]?.object === 'https://example.org/source',
    detail: publishWriteBody ? `object: ${publishWriteBody[1].object}` : '',
  });

  // dkg_wallet_balances → GET /api/wallet/balances
  const walletReq = byTool['dkg_wallet_balances']?.[0]?.requests?.[0];
  checks.push({
    name: 'dkg_wallet_balances GETs /api/wallet/balances',
    pass: walletReq?.method === 'GET' && walletReq?.path === '/api/wallet/balances',
    detail: walletReq ? `${walletReq.method} ${walletReq.path}` : '',
  });

  // dkg_find_agents → GET /api/agents with framework query param
  const findReq = byTool['dkg_find_agents']?.[0]?.requests?.[0];
  checks.push({
    name: 'dkg_find_agents GETs /api/agents with framework query',
    pass:
      findReq?.method === 'GET' &&
      findReq?.path === '/api/agents' &&
      findReq?.url?.includes('framework=hermes-agent'),
    detail: findReq?.url || '',
  });

  // dkg_send_message → POST /api/chat with peerId + text
  const chatReq = byTool['dkg_send_message']?.[0]?.requests?.[0];
  checks.push({
    name: 'dkg_send_message POSTs to /api/chat',
    pass:
      chatReq?.method === 'POST' &&
      chatReq?.path === '/api/chat' &&
      chatReq?.body?.peerId === 'peer-1' &&
      chatReq?.body?.text === 'hi',
    detail: chatReq ? JSON.stringify(chatReq.body) : '',
  });

  // dkg_read_messages → GET /api/messages with limit
  const readReq = byTool['dkg_read_messages']?.[0]?.requests?.[0];
  checks.push({
    name: 'dkg_read_messages GETs /api/messages with limit',
    pass:
      readReq?.method === 'GET' &&
      readReq?.path === '/api/messages' &&
      readReq?.url?.includes('limit=5'),
    detail: readReq?.url || '',
  });

  // dkg_invoke_skill → POST /api/invoke-skill with peerId/skillUri/input
  const skillReq = byTool['dkg_invoke_skill']?.[0]?.requests?.[0];
  checks.push({
    name: 'dkg_invoke_skill POSTs to /api/invoke-skill',
    pass:
      skillReq?.method === 'POST' &&
      skillReq?.path === '/api/invoke-skill' &&
      skillReq?.body?.peerId === 'peer-1' &&
      skillReq?.body?.skillUri === 'urn:skill:ImageAnalysis' &&
      skillReq?.body?.input === 'test',
    detail: skillReq ? JSON.stringify(skillReq.body) : '',
  });

  // dkg_context_graph_create → POST with cg:{slug}-{hex} ID
  const cgReq = byTool['dkg_context_graph_create']?.[0]?.requests?.[0];
  checks.push({
    name: 'dkg_context_graph_create POSTs to /api/context-graph/create',
    pass: cgReq?.method === 'POST' && cgReq?.path === '/api/context-graph/create',
    detail: cgReq ? `${cgReq.method} ${cgReq.path}` : '',
  });
  checks.push({
    name: 'dkg_context_graph_create generates cg:{slug}-{hex} ID',
    pass: /^cg:test-graph-[a-f0-9]+$/.test(cgReq?.body?.id ?? ''),
    detail: cgReq ? `id: ${cgReq.body.id}` : '',
  });

  // dkg_subscribe → POST /api/context-graph/subscribe with contextGraphId
  const subReq = byTool['dkg_subscribe']?.[0]?.requests?.[0];
  checks.push({
    name: 'dkg_subscribe POSTs to /api/context-graph/subscribe',
    pass:
      subReq?.method === 'POST' &&
      subReq?.path === '/api/context-graph/subscribe' &&
      subReq?.body?.contextGraphId === 'cg:test-xyz',
    detail: subReq ? JSON.stringify(subReq.body) : '',
  });

  // dkg_status → both /api/status and /api/context-graph/list
  const statusPaths = (byTool['dkg_status']?.[0]?.requests ?? []).map((r) => r.path);
  checks.push({
    name: 'dkg_status queries both /api/status and /api/context-graph/list',
    pass:
      statusPaths.includes('/api/status') && statusPaths.includes('/api/context-graph/list'),
    detail: statusPaths.join(', '),
  });

  return checks;
}

// ─── Main ────────────────────────────────────────────────────────────────────

(async () => {
  console.log('DKG Claude Adapter — Test Harness');
  console.log('=================================');
  console.log(`Mode:    ${REAL_MODE ? 'REAL (live daemon)' : 'MOCK (local daemon)'}`);
  console.log(`Daemon:  ${DAEMON_URL}`);
  console.log(`Adapter: ${ADAPTER_ENTRY}`);
  console.log('');

  let mockServer;
  if (!REAL_MODE) {
    mockServer = await startMockDaemon();
    console.log(`Mock daemon listening on ${MOCK_URL}\n`);
  }

  try {
    const { tools, results, stderr } = await runMcpTests();
    const checks = runAssertions({ tools, results });

    let passed = 0;
    let failed = 0;
    for (const c of checks) {
      const mark = c.pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
      console.log(`  ${mark} ${c.name}`);
      if (!c.pass && c.detail) console.log(`       └─ ${c.detail}`);
      c.pass ? passed++ : failed++;
    }

    console.log('');
    console.log(`${passed} passed, ${failed} failed, ${checks.length} total`);

    if (failed > 0 && stderr) {
      console.log('\n--- MCP server stderr ---');
      console.log(stderr);
    }

    process.exit(failed === 0 ? 0 : 1);
  } finally {
    if (mockServer) mockServer.close();
  }
})().catch((e) => {
  console.error('\nHarness crashed:', e);
  process.exit(1);
});
