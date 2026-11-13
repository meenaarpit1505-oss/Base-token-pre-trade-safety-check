// Live smoke test against Base mainnet. Runs without Supabase (memory-only cache).
// Usage: node scripts/smoke.mjs [tokenAddress ...]
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { getTokenSafety, cacheStats } from '../lib/cacheLayer.js';

const manifest = JSON.parse(readFileSync(new URL('../ai-plugin.json', import.meta.url), 'utf8'));
const ajv = new Ajv({ strict: true, allErrors: true, strictTypes: false });
addFormats(ajv);
const validateOutput = ajv.compile(manifest.tools[0].outputSchema);

const tokens = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
      '0x940181a94A35A4569E4529A3CDfB74e38FD98631', // AERO
      '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', // DEGEN
      '0x532f27101965dd16442E59d40670FaF5eBB142E4', // BRETT
      '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', // cbBTC (intermediate quote asset itself)
      '0x000000000000000000000000000000000000dEaD', // no bytecode
      'not-an-address',
    ];

let failures = 0;
const summary = (r) => ({
  token: r.token?.symbol ?? r.token_address,
  status: r.status,
  risk_score: r.risk_score,
  confidence: r.confidence,
  cached: r.cached,
  cache_source: r.cache_source,
  latency_ms: r.latency_ms,
  mempool: `${r.risk_matrix.mempool_front_running.score} (${r.risk_matrix.mempool_front_running.data_source}, toxicity ${r.risk_matrix.mempool_front_running.metrics.execution_toxicity_pct ?? '-'}%)`,
  swaps: r.risk_matrix.mempool_front_running.metrics.swaps_analyzed ?? 0,
  jit: `${r.risk_matrix.jit_liquidity_vampire.score} (cycles ${r.risk_matrix.jit_liquidity_vampire.metrics.jit_cycles ?? '-'})`,
  cascade: `${r.risk_matrix.cross_pair_cascade.score} (depth $${Math.round(r.risk_matrix.cross_pair_cascade.metrics.total_depth_usd ?? 0)}, ref impact ${r.risk_matrix.cross_pair_cascade.metrics.reference_trade_impact_pct ?? '-'}%, drop ${r.risk_matrix.cross_pair_cascade.metrics.projected_price_drop_pct ?? '-'}%, ticks ${r.risk_matrix.cross_pair_cascade.metrics.post_shock_max_ticks_crossed ?? '-'}, unfilled ${r.risk_matrix.cross_pair_cascade.metrics.post_shock_unfilled_pct ?? '-'}%, hop ${r.risk_matrix.cross_pair_cascade.metrics.multi_hop_depth_share_pct ?? '-'}%)`,
  venues: [...new Set(r.pools.map((p) => `${p.dex}:${p.quote}`))].slice(0, 8),
  v4: r.risk_matrix.cross_pair_cascade.metrics.coverage ? `${r.risk_matrix.cross_pair_cascade.metrics.coverage.v4_pools_live}/${r.risk_matrix.cross_pair_cascade.metrics.coverage.v4_candidates_checked}` : '-',
  signals: [...new Set(Object.values(r.risk_matrix).flatMap((m) => m.signals.map((s) => s.code)))],
  errors: r.errors.map((e) => e.code),
});

for (const t of tokens) {
  const t0 = Date.now();
  const r = await getTokenSafety(t);
  const wall = Date.now() - t0;
  const valid = validateOutput(r);
  if (!valid) {
    failures++;
    console.error('SCHEMA FAIL', t, ajv.errorsText(validateOutput.errors));
  }
  console.log(JSON.stringify({ input: t, wall_ms: wall, schema_valid: valid, ...summary(r) }));
}

// Cache behaviour: second call must be a memory hit; concurrent calls must share one engine run.
const first = tokens.find((t) => /^0x[a-fA-F0-9]{40}$/.test(t));
const t1 = Date.now();
const again = await getTokenSafety(first);
console.log(JSON.stringify({ check: 'memory_hit', cached: again.cached, cache_source: again.cache_source, wall_ms: Date.now() - t1 }));
if (!again.cached) failures++;

const fresh = '0x4200000000000000000000000000000000000006'; // WETH, not yet cached
const t2 = Date.now();
const [a, b, c] = await Promise.all([getTokenSafety(fresh), getTokenSafety(fresh), getTokenSafety(fresh)]);
console.log(JSON.stringify({ check: 'single_flight', same_object: a === b && b === c, status: a.status, risk_score: a.risk_score, wall_ms: Date.now() - t2 }));
if (!(a === b && b === c)) failures++;

console.log(JSON.stringify({ cache: cacheStats() }));
if (process.env.SMOKE_FULL_OUTPUT) console.log(JSON.stringify(a, null, 2));
console.log(failures ? `SMOKE FAILED (${failures})` : 'SMOKE PASSED');
process.exit(failures ? 1 : 0);
