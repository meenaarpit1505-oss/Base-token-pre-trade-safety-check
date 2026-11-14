// Validates ai-plugin.json: parses, compiles inputSchema/outputSchema with Ajv (strict), runs input fixtures.
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const manifest = JSON.parse(readFileSync(new URL('../ai-plugin.json', import.meta.url), 'utf8'));
const tool = manifest.tools.find((t) => t.name === 'analyze_base_token_safety');
if (!tool) throw new Error('tool analyze_base_token_safety missing');

const ajv = new Ajv({ strict: true, allErrors: true, strictTypes: false });
addFormats(ajv);
const validateInput = ajv.compile(tool.inputSchema);
ajv.compile(tool.outputSchema);

const cases = [
  [{ token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }, true],
  [{ token_address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' }, true],
  [{ token_address: '833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }, false],
  [{ token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA0291' }, false],
  [{ token_address: '0xZZ3589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }, false],
  [{}, false],
  [{ token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', extra: 1 }, false],
];
for (const [input, expected] of cases) {
  if (validateInput(input) !== expected) throw new Error(`input fixture failed: ${JSON.stringify(input)} expected ${expected}`);
}
// Output fixtures for fields added in v2.1 (V4 pool ids, new quote assets, hooks/hops, recommendation.reasons).
const validateOutput = ajv.compile(tool.outputSchema);
const model = (data_source) => ({ score: 10, status: 'SAFE', confidence: 0.6, data_available: true, data_source, latency_ms: 5, metrics: {}, signals: [] });
const sample = (overrides = {}) => ({
  tool: 'analyze_base_token_safety', version: '2.2.0', chain_id: 8453, token_address: '0x4ed4e862860bed51a9570b96d89af5e1b0efefed',
  status: 'SAFE', risk_score: 10, confidence: 0.6,
  risk_matrix: { mempool_front_running: model('recent_blocks_fallback'), jit_liquidity_vampire: model('onchain_logs'), cross_pair_cascade: model('onchain_state') },
  recommendation: { action: 'PROCEED', max_slippage_bps: 50, split_order: false, use_private_order_flow: false, avoid_pools: ['0x' + 'ab'.repeat(32)], reasons: ['SAFE: no material signals across the three models.'] },
  cached: false, cache_source: 'none', cache_age_seconds: 0, checked_at: '2026-11-11T00:00:00.000Z', ttl_seconds: 300, latency_ms: 10, block_number: 1,
  token: { symbol: 'T', name: 'T', decimals: 18, price_usd: 1, is_contract: true },
  pools: [
    { address: '0x' + 'ab'.repeat(32), dex: 'uniswap_v4', quote: 'ETH', fee: 3000, tick_spacing: 60, depth_usd: 1, hooks: '0x0000000000000000000000000000000000000000', hops: 1 },
    { address: '0x' + 'cd'.repeat(20), dex: 'aerodrome_slipstream', quote: 'cbBTC', fee: null, tick_spacing: 100, depth_usd: 1, hooks: null, hops: 2 },
    { address: '0x' + 'ef'.repeat(20), dex: 'uniswap_v2', quote: 'USDbC', fee: 3000, tick_spacing: null, depth_usd: 1 },
  ],
  errors: [],
  ...overrides,
});
const outCases = [
  [sample(), true],
  [sample({ pools: [{ address: '0x' + 'ab'.repeat(31), dex: 'uniswap_v4', quote: 'ETH', fee: 3000, tick_spacing: 60, depth_usd: 1 }] }), false], // 62-hex id
  [sample({ pools: [{ address: '0x' + 'cd'.repeat(20), dex: 'sushiswap', quote: 'WETH', fee: 3000, tick_spacing: null, depth_usd: 1 }] }), false],
  [sample({ pools: [{ address: '0x' + 'cd'.repeat(20), dex: 'uniswap_v3', quote: 'DAI', fee: 3000, tick_spacing: null, depth_usd: 1 }] }), false],
  [sample({ pools: [{ address: '0x' + 'cd'.repeat(20), dex: 'uniswap_v3', quote: 'WETH', fee: 3000, tick_spacing: null, depth_usd: 1, hops: 3 }] }), false],
];
for (const [out, expected] of outCases) {
  if (validateOutput(out) !== expected) throw new Error(`output fixture failed (expected ${expected}): ${ajv.errorsText(validateOutput.errors)}`);
}
console.log(`ai-plugin.json OK: valid JSON, inputSchema + outputSchema compile (Ajv strict), ${cases.length} input + ${outCases.length} output fixtures pass.`);
