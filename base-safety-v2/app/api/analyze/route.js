// POST /api/analyze {"token_address":"0x..."}   or   GET /api/analyze?token_address=0x...
import { waitUntil } from '@vercel/functions';
import { getTokenSafety } from '../../../lib/cacheLayer.js';
import { normalizeTokenAddress } from '../../../lib/safetyEngine.js';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';
export const preferredRegion = ['iad1']; // keep close to Base RPC providers + Supabase; adjust to your Supabase region

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' };

function badRequest(message) {
  return new Response(JSON.stringify({ error: { code: 'INVALID_TOKEN_ADDRESS', message } }), { status: 400, headers: JSON_HEADERS });
}

async function handle(tokenAddress) {
  const token = normalizeTokenAddress(tokenAddress);
  if (!token) return badRequest('token_address must match ^0x[a-fA-F0-9]{40}$');
  const t0 = Date.now();
  const result = await getTokenSafety(token, { waitUntil });
  // CDN layer: identical GETs inside the remaining TTL are served from Vercel's edge cache (max 60 s).
  const sMaxAge = Math.max(0, Math.min(60, result.ttl_seconds));
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: {
      ...JSON_HEADERS,
      'cache-control': 'no-store',
      'cdn-cache-control': sMaxAge > 0 ? `public, s-maxage=${sMaxAge}, stale-while-revalidate=30` : 'no-store',
      'x-cache': result.cached ? `HIT-${result.cache_source}` : 'MISS',
      'x-risk-status': result.status,
      'server-timing': `total;dur=${Date.now() - t0}, engine;dur=${result.cached ? 0 : result.latency_ms}`,
    },
  });
}

export async function GET(request) {
  return handle(new URL(request.url).searchParams.get('token_address'));
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest('Body must be JSON: {"token_address":"0x..."}');
  }
  return handle(body?.token_address);
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: { ...JSON_HEADERS, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' },
  });
}
