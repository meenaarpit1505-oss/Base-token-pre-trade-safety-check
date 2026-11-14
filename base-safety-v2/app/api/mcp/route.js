// Minimal stateless MCP server (Streamable HTTP transport, JSON responses) exposing analyze_base_token_safety.
// Methods: initialize, ping, tools/list, tools/call, notifications/* (accepted, 202).
// Optional payment gate on tools/call only: BILLING_MODE=open (default) | api_key (X-Api-Key) | x402
// (PAYMENT-SIGNATURE / X-Payment HTTP headers). An unpaid single call answers with the gate's HTTP status
// (402 + PAYMENT-REQUIRED for x402) and a JSON-RPC error whose data carries the payment details.
import { waitUntil } from '@vercel/functions';
import manifest from '../../../ai-plugin.json';
import { getTokenSafety } from '../../../lib/cacheLayer.js';
import { normalizeTokenAddress, ENGINE_VERSION } from '../../../lib/safetyEngine.js';
import { authorizeCall, getBillingConfig, BILLING_CORS_HEADERS } from '../../../lib/billing.js';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

const TOOL = manifest.tools[0];
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const HEADERS = { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-expose-headers': BILLING_CORS_HEADERS['access-control-expose-headers'] };
// JSON-RPC server-error codes used for billing denials (implementation-defined range).
const BILLING_ERROR_CODE = { 401: -32001, 402: -32002, 503: -32003 };

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message, data) => ({ jsonrpc: '2.0', id: id ?? null, error: data === undefined ? { code, message } : { code, message, data } });

const isPaidCall = (msg) => msg && msg.method === 'tools/call' && msg.params?.name === TOOL.name && normalizeTokenAddress(msg.params?.arguments?.token_address) != null;

async function dispatch(msg, http) {
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
        return ok(id, { isError: true, content: [{ type: 'text', text: 'token_address must match ^0x[a-fA-F0-9]{40}$' }] }); // never charged
      }
      const gate = await authorizeCall(http.request);
      if (!gate.ok) return http.deny(id, gate);
      let result;
      try {
        result = await getTokenSafety(token, { waitUntil });
      } catch (err) {
        await gate.finalize({ success: false });
        throw err;
      }
      const fin = await gate.finalize({ success: true });
      if (!fin.ok) return http.deny(id, fin);
      Object.assign(http.headers, gate.headers, fin.headers);
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
  const messages = batch ? body : [body];
  const billing = getBillingConfig();
  // One x402 payment authorizes exactly one call: paid batches must carry a single tools/call.
  if (billing.mode === 'x402' && messages.filter(isPaidCall).length > 1) {
    return new Response(JSON.stringify(fail(null, -32600, 'BILLING_MODE=x402: send one paid tools/call per HTTP request (one payment each).')), { status: 400, headers: HEADERS });
  }
  const http = {
    request,
    headers: {},
    status: 200,
    deny(id, d) {
      Object.assign(this.headers, d.headers);
      if (!batch) this.status = d.status;
      return fail(id, BILLING_ERROR_CODE[d.status] ?? -32002, d.body?.message ?? 'Payment required', d.body);
    },
  };
  let responses;
  if (billing.mode === 'open') responses = await Promise.all(messages.map((m) => dispatch(m, http)));
  else {
    responses = [];
    for (const msg of messages) responses.push(await dispatch(msg, http)); // sequential: each paid call is charged in order
  }
  const out = responses.filter(Boolean);
  if (!out.length) return new Response(null, { status: 202, headers: HEADERS });
  return new Response(JSON.stringify(batch ? out : out[0]), { status: http.status, headers: { ...HEADERS, ...(billing.mode === 'open' ? {} : { 'cache-control': 'no-store' }), ...http.headers } });
}

export async function GET() {
  // No server-initiated SSE stream in this stateless server.
  return new Response(JSON.stringify(fail(null, -32000, 'Use POST for MCP requests')), { status: 405, headers: { ...HEADERS, allow: 'POST' } });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: { ...HEADERS, 'access-control-allow-methods': 'POST, OPTIONS', ...BILLING_CORS_HEADERS } });
}
