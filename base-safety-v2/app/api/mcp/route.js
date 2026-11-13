// Minimal stateless MCP server (Streamable HTTP transport, JSON responses) exposing analyze_base_token_safety.
// Methods: initialize, ping, tools/list, tools/call, notifications/* (accepted, 202).
import { waitUntil } from '@vercel/functions';
import manifest from '../../../ai-plugin.json';
import { getTokenSafety } from '../../../lib/cacheLayer.js';
import { normalizeTokenAddress, ENGINE_VERSION } from '../../../lib/safetyEngine.js';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

const TOOL = manifest.tools[0];
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const HEADERS = { 'content-type': 'application/json', 'access-control-allow-origin': '*' };

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function dispatch(msg) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(msg?.id, -32600, 'Invalid Request');
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      return ok(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'base-token-safety', title: manifest.name_for_human, version: ENGINE_VERSION },
        instructions: manifest.description_for_model,
      });
    }
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: [{ name: TOOL.name, title: TOOL.title, description: TOOL.description, inputSchema: TOOL.inputSchema, outputSchema: TOOL.outputSchema, annotations: TOOL.annotations }] });
    case 'tools/call': {
      if (params?.name !== TOOL.name) return fail(id, -32602, `Unknown tool: ${params?.name}`);
      const token = normalizeTokenAddress(params?.arguments?.token_address);
      if (!token) {
        return ok(id, { isError: true, content: [{ type: 'text', text: 'token_address must match ^0x[a-fA-F0-9]{40}$' }] });
      }
      const result = await getTokenSafety(token, { waitUntil });
      return ok(id, { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }], isError: false });
    }
    default:
      if (isNotification && method.startsWith('notifications/')) return null;
      return fail(id, -32601, `Method not found: ${method}`);
  }
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify(fail(null, -32700, 'Parse error')), { status: 400, headers: HEADERS });
  }
  const batch = Array.isArray(body);
  const responses = (await Promise.all((batch ? body : [body]).map(dispatch))).filter(Boolean);
  if (!responses.length) return new Response(null, { status: 202, headers: HEADERS });
  return new Response(JSON.stringify(batch ? responses : responses[0]), { status: 200, headers: HEADERS });
}

export async function GET() {
  // No server-initiated SSE stream in this stateless server.
  return new Response(JSON.stringify(fail(null, -32000, 'Use POST for MCP requests')), { status: 405, headers: { ...HEADERS, allow: 'POST' } });
}
