// POST /api/analyze {"token_address":"0x..."}   or   GET /api/analyze?token_address=0x...
// Optional payment gate: BILLING_MODE=open (default) | api_key | x402 (see lib/billing.js, README "Billing").
import { waitUntil } from '@vercel/functions';
import { getTokenSafety } from '../../../lib/cacheLayer.js';
import { normalizeTokenAddress } from '../../../lib/safetyEngine.js';
import { authorizeCall, getBillingConfig, BILLING_CORS_HEADERS } from '../../../lib/billing.js';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';
export const preferredRegion = ['iad1']; // keep close to Base RPC providers + Supabase; adjust to your Supabase region

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-expose-headers': BILLING_CORS_HEADERS['access-control-expose-headers'] };

function badRequest(message) {
  return new Response(JSON.stringify({ error: { code: 'INVALID_TOKEN_ADDRESS', message } }), { status: 400, headers: JSON_HEADERS });
}

const denied = (d) => new Response(JSON.stringify(d.body), { status: d.status, headers: { ...JSON_HEADERS, 'cache-control': 'no-store', ...d.headers } });

async function handle(request, tokenAddress) {
  const token = normalizeTokenAddress(tokenAddress);
  if (!token) return badRequest('token_address must match ^0x[a-fA-F0-9]{40}$'); // never charged
  const billing = getBillingConfig();
  const gate = await authorizeCall(request);
  if (!gate.ok) return denied(gate);

  const t0 = Date.now();
  let result;
  try {
    result = await getTokenSafety(token, { waitUntil });
  } catch (err) {
    await gate.finalize({ success: false });
    throw err;
  }
  const fin = await gate.finalize({ success: true });
  if (!fin.ok) return denied(fin); // x402 settlement failed: do not hand out the paid result

  // CDN layer: identical GETs inside the remaining TTL are served from the edge cache (max 60 s) - open mode only,
  // so a shared cache can never serve a paid response for free.
  const sMaxAge = billing.mode === 'open' ? Math.max(0, Math.min(60, result.ttl_seconds)) : 0;
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: {
      ...JSON_HEADERS,
      ...gate.headers,
      ...fin.headers,
      'cache-control': 'no-store',
      'cdn-cache-control': sMaxAge > 0 ? `public, s-maxage=${sMaxAge}, stale-while-revalidate=30` : 'no-store',
      'x-cache': result.cached ? `HIT-${result.cache_source}` : 'MISS',
      'x-risk-status': result.status,
      'server-timing': `total;dur=${Date.now() - t0}, engine;dur=${result.cached ? 0 : result.latency_ms}`,
    },
  });
}

export async function GET(request) {
  return handle(request, new URL(request.url).searchParams.get('token_address'));
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest('Body must be JSON: {"token_address":"0x..."}');
  }
  return handle(request, body?.token_address);
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: { ...JSON_HEADERS, 'access-control-allow-methods': 'GET, POST, OPTIONS', ...BILLING_CORS_HEADERS },
  });
}
