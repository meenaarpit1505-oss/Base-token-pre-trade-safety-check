// Offline unit tests: detectors (sandwich / JIT / pending), CL math, multi-hop + V4 cascade routing, V4 log decoding,
// status combination rules, and output-schema validity. No network access.
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { encodeAbiParameters, encodeEventTopics, keccak256, toHex } from 'viem';
import { _models, loadConfig, parseV4PoolKeys, v4PoolId, analyzeTokenSafety, THRESHOLDS, ADDRESSES, decodeV4InitializeLogs, v4LogDiscoveryUrls } from '../lib/safetyEngine.js';
import * as cl from '../lib/clMath.js';

let passed = 0;
const assert = (c, m) => {
  if (!c) {
    console.error('FAIL', m);
    process.exit(1);
  }
  passed++;
};
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const cfg = loadConfig();
const { ASSET } = _models;

// ---------------------------------------------------------------------------
// 1. Sandwich / JIT / pending detectors (synthetic)
// ---------------------------------------------------------------------------
const P = '0x' + '1'.repeat(40), BOT = '0x' + 'b'.repeat(40), U1 = '0x' + 'c'.repeat(40), U2 = '0x' + 'd'.repeat(40);
const pool = { address: P, kind: 'v3', quote: ASSET.USDC, liquidity: 1000n, depthUsd: 100000, tokenAmount: 1, quoteSideUsd: 50000 };
const sw = (block, logIndex, tx, dir, actor) => ({ pool: P, block, logIndex, tx, dir, sender: actor, recipient: actor, quoteAbs: 1000 });
const logs = {
  swaps: [sw(10, 1, '0xa1', 'buy', BOT), sw(10, 2, '0xa2', 'buy', U1), sw(10, 3, '0xa3', 'sell', BOT), sw(11, 1, '0xa4', 'buy', U2), sw(12, 5, '0xa6', 'sell', U1)],
  v3Mints: [{ pool: P, block: 20, logIndex: 1, tx: '0xm1', owner: BOT, salt: null, tickLower: -10, tickUpper: 10, amount: 500n }],
  v3Burns: [{ pool: P, block: 20, logIndex: 3, tx: '0xb1', owner: BOT, salt: null, tickLower: -10, tickUpper: 10, amount: 500n }],
  v2Mints: [], v2Burns: [], lpMints: [], coverage: 1, failures: [], fromBlock: 1, toBlock: 30,
};
logs.swaps.push({ pool: P, block: 20, logIndex: 2, tx: '0xv', dir: 'buy', sender: U2, recipient: U2, quoteAbs: 5000 });
const ctx = { cfg, pools: [pool], poolByAddr: new Map([[P, pool]]), getLogs: async () => logs, ethUsd: 3000, quoteUsd: (q) => (q.stable ? 1 : 3000), client: null, logsClient: null };
const r = await _models.analyzeRecentSwaps(ctx, logs);
assert(r.sandwiches === 1 && r.victimSwaps === 1, 'sandwich detection');
assert(near(r.victimVolumeUsd, 1000), 'sandwich victim USD uses quoteUsd');
const j = await _models.checkJit(ctx);
assert(j.metrics.jit_cycles === 1 && j.metrics.same_block_cycles === 1 && j.metrics.swaps_bracketed_by_jit === 1, 'jit detection');
assert(j.score > 0 && j.signals.some((s) => s.code === 'SAME_BLOCK_JIT'), 'jit scored');
const pend = _models.analyzePending({ token: '0x' + 'e'.repeat(40), poolByAddr: ctx.poolByAddr, cfg }, [
  { from: BOT, to: P, maxPriorityFeePerGas: '0x64', input: '0x' },
  { from: U1, to: '0x' + '9'.repeat(40), maxPriorityFeePerGas: '0x1', input: '0xabc' + 'e'.repeat(40) },
  { from: U2, to: '0x' + '9'.repeat(40), maxPriorityFeePerGas: '0x1', input: '0x' },
]);
assert(pend.relevant === 2 && pend.flagged >= 1, 'pending analysis');

// ---------------------------------------------------------------------------
// 2. Concentrated-liquidity math
// ---------------------------------------------------------------------------
{
  const bp = cl.bitmapPosition(-1, 10);
  assert(bp.compressed === -1 && bp.wordPos === -1 && bp.bitPos === 255, 'TickBitmap position for negative ticks');
  const bp2 = cl.bitmapPosition(-200005, 60);
  assert(bp2.compressed === Math.floor(-200005 / 60) && bp2.wordPos === bp2.compressed >> 8, 'TickBitmap position large negative');

  // Inverse pair.
  for (const [d, a] of [[1e6, 1e4], [5e4, 1e4], [1e9, 10]]) assert(near(cl.cpDepthFromImpact(cl.cpImpact(d, a), a), d, 1e-6), 'cpDepthFromImpact inverts cpImpact');

  // Single range == constant product on virtual reserves.
  const wide = { down: [], up: [], downEdge: cl.MIN_TICK, upEdge: cl.MAX_TICK, source: 'tick_bitmap' };
  const prof = cl.buildProfile({ sqrtP: 1, L: 1e6, ticks: wide });
  const dx = 1e4;
  const sim = cl.simulateSwap(prof, dx, true);
  const expected = 1 - (1 / (1 + dx / 1e6)) ** 2;
  assert(near(sim.impact, expected, 1e-9) && !sim.exhausted && sim.crossed === 0, 'in-range CL swap equals CP on virtual reserves');
  const simUp = cl.simulateSwap(prof, dx, false);
  assert(near(simUp.impact, 1 - (1 / (1 + dx / 1e6)) ** 2, 1e-9), 'token1-in symmetric case');

  // Crossing an initialized tick that removes most liquidity increases impact; running past the window => exhausted.
  const t = { down: [-100, -400], up: [], downEdge: -1000, upEdge: cl.MAX_TICK, source: 'tick_bitmap' };
  const nets = new Map([[-100, 9e5], [-400, 5e4]]); // crossing down subtracts liquidityNet
  const p2 = cl.buildProfile({ sqrtP: 1, L: 1e6, ticks: t, netByTick: nets });
  const small = cl.simulateSwap(p2, 1000, true);
  assert(small.crossed === 0 && !small.exhausted, 'small swap stays in range');
  const big = cl.simulateSwap(p2, 2e4, true);
  const sameNoTicks = cl.simulateSwap(prof, 2e4, true);
  assert(big.crossed >= 1 && big.impact > sameNoTicks.impact, 'tick walk into thinner liquidity raises impact');
  const huge = cl.simulateSwap(p2, 1e9, true);
  assert(huge.exhausted && huge.filledFraction < 1, 'swap beyond known window reports exhaustion');
  // Unknown liquidityNet terminates the profile at that tick.
  const p3 = cl.buildProfile({ sqrtP: 1, L: 1e6, ticks: t, netByTick: new Map() });
  assert(p3.downEdge === -100 && p3.down.length === 0, 'unresolved tick ends the known profile');

  // Bitmap decoding: bits set at compressed -2 (word -1, bit 254) and +3 (word 0, bit 3); current tick 0, spacing 10.
  const words = new Map([[-1, 1n << 254n], [0, 1n << 3n], [1, 0n]]);
  const it = cl.initializedTicks(words, 5, 10);
  assert(it.source === 'tick_bitmap' && it.down[0] === -20 && it.up[0] === 30, 'initialized ticks from bitmap words');
  const fb = cl.initializedTicks(null, 5, 10);
  assert(fb.source === 'tick_spacing_bound' && fb.downEdge === 0 && fb.upEdge === 10, 'tick-spacing fallback bound');

  // Window amounts for a full-range-ish profile are positive on both sides.
  const wa = cl.windowAmounts(cl.buildProfile({ sqrtP: 1, L: 1e6, ticks: { down: [], up: [], downEdge: -1000, upEdge: 1000, source: 'tick_bitmap' } }));
  assert(wa.token0Above > 0 && wa.token1Below > 0, 'window amounts');
}

// ---------------------------------------------------------------------------
// 3. Cascade: CL vs constant product, multi-hop, V4, hooks, exhaustion
// ---------------------------------------------------------------------------
const TOKEN = '0x' + 'a'.repeat(40);
const ethUsd = 3000;
const mkCtx = (pools, extra = {}) => ({
  token: TOKEN,
  cfg,
  tokenMeta: { symbol: 'TKN', decimals: 18 },
  tokenUsd: 1,
  ethUsd,
  isReferenceAsset: false,
  secondaryDepthUsd: { WETH: 5e7, ETH: 5e7, USDC: null, USDbC: 2e6, cbBTC: 3e7 },
  intermediateUsd: { USDbC: 1, cbBTC: 70000 },
  quoteUsd: (q) => (q.symbol === 'USDC' || q.symbol === 'USDbC' ? 1 : q.symbol === 'cbBTC' ? 70000 : ethUsd),
  dustIgnored: 0,
  tickScan: 'ok',
  coverage: { venues: [], quote_assets: [] },
  pools,
  poolByAddr: new Map(pools.map((p) => [p.address, p])),
  ...extra,
});
// CL pool: token is token1 (quote USDC = token0 when quote < token); give it in-range L worth ~$400k of virtual depth
// while its balances are only $200k (most of the TVL sits near price). CP on balances overstates impact.
function clPool({ address, quote, depthUsd, Lusd, kind = 'v3', dex = 'uniswap_v3', hooked = false, ticks }) {
  // Price 1 token = $1; for quote at $q per unit, raw price token1/token0 handled as tokenIs0=true with sqrtP=sqrt(1/q*10^(dq-18)).
  const q = quote.symbol === 'USDC' || quote.symbol === 'USDbC' ? 1 : quote.symbol === 'cbBTC' ? 70000 : ethUsd;
  const sqrtP = Math.sqrt((1 / q) * 10 ** (quote.decimals - 18));
  // Virtual quote reserve (raw) = L * sqrtP ; USD = L*sqrtP/10^dq * q ; CP depth = 2x that.
  const L = (Lusd / 2) / ((sqrtP / 10 ** quote.decimals) * q);
  const t = ticks ?? { down: [], up: [], downEdge: cl.MIN_TICK, upEdge: cl.MAX_TICK, source: 'tick_bitmap' };
  return { address, kind, dex, quote, fee: 3000, tick_spacing: 60, hooks: hooked ? '0x' + '4'.repeat(40) : kind === 'v4' ? '0x0000000000000000000000000000000000000000' : null, hooked, tokenIs0: true, hasBalances: kind !== 'v4', depthUsd, windowDepthUsd: kind === 'v4' ? depthUsd : depthUsd / 2, profile: cl.buildProfile({ sqrtP, L, ticks: t }), liquidity: BigInt(Math.round(L)) };
}
const cpPool = ({ address, quote, depthUsd, dex = 'uniswap_v2' }) => ({ address, kind: 'v2', dex, quote, fee: 3000, tick_spacing: null, hooks: null, hooked: false, tokenIs0: true, hasBalances: true, depthUsd });
{
  const A1 = '0x' + '2'.repeat(40);
  const clCtx = mkCtx([clPool({ address: A1, quote: ASSET.USDC, depthUsd: 2e5, Lusd: 4e5 })]);
  const cpCtx = mkCtx([cpPool({ address: A1, quote: ASSET.USDC, depthUsd: 2e5 })]);
  const iCl = _models.routeTrade(clCtx, 1e4, null).impact;
  const iCp = _models.routeTrade(cpCtx, 1e4, null).impact;
  assert(iCl < iCp, `CL in-range depth lowers impact vs CP on balances (${iCl.toFixed(4)} < ${iCp.toFixed(4)})`);
  assert(near(iCl, cl.cpImpact(4e5, 1e4), 1e-6), 'single in-range CL pool matches CP on its virtual depth');

  // Multi-hop: same first-leg depth quoted in cbBTC must have higher impact than a direct USDC quote.
  const hopCtx = mkCtx([cpPool({ address: A1, quote: ASSET.cbBTC, depthUsd: 2e5 })], { secondaryDepthUsd: { cbBTC: 1e6 } });
  const iHop = _models.routeTrade(hopCtx, 1e4, null).impact;
  assert(iHop > iCp, 'second hop adds impact');
  assert(near(iHop, 1 - (1 - cl.cpImpact(2e5, 1e4)) * (1 - cl.cpImpact(1e6, 1e4)), 1e-9), 'two-leg composition');
  const casHop = await _models.checkCascade(hopCtx);
  assert(casHop.signals.some((s) => s.code === 'MULTI_HOP_ROUTE'), 'MULTI_HOP_ROUTE signal when depth is behind an intermediate');
  assert(casHop.metrics.routes[0].hops === 2 && casHop.metrics.routes[0].path[1] === 'cbBTC', 'routes metric explains hops');
  assert(casHop.metrics.multi_hop_depth_share_pct === 100, 'multi-hop share');
  // Unknown second-leg depth => conservative + flagged.
  const hopUnknown = await _models.checkCascade(mkCtx([cpPool({ address: A1, quote: ASSET.USDbC, depthUsd: 2e5 })], { secondaryDepthUsd: {} }));
  assert(hopUnknown.signals.some((s) => s.code === 'HOP_LEG_UNPRICED'), 'unpriced hop leg flagged');

  // V4 pool with a tiny known tick window: the post-shock sell exhausts it => CL_LIQUIDITY_EXHAUSTED + split_order.
  const V4 = '0x' + 'f'.repeat(64);
  const narrow = { down: [], up: [], downEdge: -200, upEdge: 200, source: 'tick_bitmap' };
  const v4Base = clPool({ address: V4, quote: ASSET.ETH, depthUsd: 3e5, Lusd: 3e5, kind: 'v4', dex: 'uniswap_v4' });
  // Re-center the narrow window on the pool's actual tick.
  const tick0 = Math.floor(Math.log(v4Base.profile.sqrtP ** 2) / Math.log(1.0001));
  const v4Pool = clPool({ address: V4, quote: ASSET.ETH, depthUsd: 3e5, Lusd: 3e5, kind: 'v4', dex: 'uniswap_v4', ticks: { ...narrow, downEdge: tick0 - 20, upEdge: tick0 + 20 } });
  const v4Ctx = mkCtx([v4Pool]);
  const casV4 = await _models.checkCascade(v4Ctx);
  assert(casV4.metrics.post_shock_unfilled_pct > 0 && casV4.signals.some((s) => s.code === 'CL_LIQUIDITY_EXHAUSTED'), 'V4 window exhaustion flagged');
  assert(casV4.metrics.impact_breakdown[0].dex === 'uniswap_v4' && casV4.metrics.impact_breakdown[0].window_exhausted, 'V4 breakdown');
  const rec = _models.recommendation('WARN', { cross_pair_cascade: casV4, mempool_front_running: { score: 0, signals: [] }, jit_liquidity_vampire: { score: 0, metrics: { affected_pools: [] }, signals: [] } }, {});
  assert(rec.split_order === true && rec.reasons.some((x) => x.includes('CL_LIQUIDITY_EXHAUSTED')), 'recommendation reasons surface new signals');
  // V3 pool with balances beyond the window falls back to CP on residual balances instead of reporting unfilled.
  const v3Narrow = { ...v4Pool, address: '0x' + '3'.repeat(40), kind: 'v3', dex: 'uniswap_v3', hasBalances: true, depthUsd: 3e5, windowDepthUsd: 1e4, hooks: null };
  const casV3 = await _models.checkCascade(mkCtx([v3Narrow]));
  assert(casV3.metrics.post_shock_unfilled_pct === 0 && casV3.metrics.impact_breakdown[0].residual_balance_fallback, 'V3 residual-balance fallback');

  // Hooked V4 pool (configured key) is flagged and lowers confidence.
  const hookedPool = clPool({ address: '0x' + 'e'.repeat(64), quote: ASSET.USDC, depthUsd: 5e5, Lusd: 5e5, kind: 'v4', dex: 'uniswap_v4', hooked: true });
  const casHook = await _models.checkCascade(mkCtx([hookedPool]));
  assert(casHook.signals.some((s) => s.code === 'V4_HOOKED_POOL') && casHook.confidence < 0.75, 'hooked V4 pool flagged');

  // Thin WETH-only token: cascade must be able to WARN (>= 35) on its own.
  const thin = await _models.checkCascade(mkCtx([cpPool({ address: A1, quote: ASSET.WETH, depthUsd: 1.5e5 })]));
  assert(thin.score >= THRESHOLDS.WARN, `thin WETH-paired token warns inside cascade (score ${thin.score})`);
  // Deep stable-paired token stays low.
  const deep = await _models.checkCascade(mkCtx([clPool({ address: A1, quote: ASSET.USDC, depthUsd: 2e7, Lusd: 4e7 })]));
  assert(deep.score < THRESHOLDS.WARN, `deep USDC-paired token stays SAFE-range in cascade (score ${deep.score})`);
}

// ---------------------------------------------------------------------------
// 4. Uniswap V4 log decoding + JIT on V4 positions
// ---------------------------------------------------------------------------
{
  const id = v4PoolId({ currency0: '0x0000000000000000000000000000000000000000', currency1: ADDRESSES.USDC, fee: 500, tickSpacing: 10, hooks: '0x0000000000000000000000000000000000000000' });
  assert(/^0x[a-f0-9]{64}$/.test(id), 'v4 pool id format');
  const raw = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], ['0x0000000000000000000000000000000000000000', ADDRESSES.USDC, 500, 10, '0x0000000000000000000000000000000000000000']));
  assert(raw.toLowerCase() === id, 'v4 pool id = keccak256(abi.encode(PoolKey))');
  const keys = parseV4PoolKeys(`${ADDRESSES.USDC},0x0000000000000000000000000000000000000000,500,10,0x${'4'.repeat(40)};bad,entry`);
  assert(keys.length === 1 && keys[0].currency0 === '0x0000000000000000000000000000000000000000' && keys[0].hooks === '0x' + '4'.repeat(40), 'UNISWAP_V4_POOL_KEYS parsing sorts currencies and drops invalid entries');

  const poolId = '0x' + '7'.repeat(64);
  const v4p = { address: poolId, poolId, kind: 'v4', quote: ASSET.ETH, tokenIs0: false, liquidity: 10000n, depthUsd: 1e5 };
  const vctx = { cfg, pools: [v4p], poolByAddr: new Map([[poolId, v4p]]), ethUsd, quoteUsd: () => ethUsd };
  const PM = ADDRESSES.UNISWAP_V4_POOL_MANAGER;
  const swapLog = (blk, li, a0, a1, sender) => ({
    address: PM,
    topics: encodeEventTopics({ abi: [_models.EV.V4_SWAP], eventName: 'Swap', args: { id: poolId, sender } }),
    data: encodeAbiParameters([{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }], [a0, a1, 2n ** 96n, 10000n, 0, 3000]),
    blockNumber: toHex(blk), logIndex: toHex(li), transactionHash: '0x' + String(blk * 100 + li).padStart(64, '0'),
  });
  const modLog = (blk, li, delta, salt) => ({
    address: PM,
    topics: encodeEventTopics({ abi: [_models.EV.V4_MODIFY], eventName: 'ModifyLiquidity', args: { id: poolId, sender: BOT } }),
    data: encodeAbiParameters([{ type: 'int24' }, { type: 'int24' }, { type: 'int256' }, { type: 'bytes32' }], [-60, 60, delta, salt]),
    blockNumber: toHex(blk), logIndex: toHex(li), transactionHash: '0x' + String(blk * 100 + li).padStart(64, '9'),
  });
  const salt = '0x' + '0'.repeat(62) + '2a';
  // Token is currency1. Swapper pays 1 ETH (amount0 = -1e18) and receives token (amount1 > 0) => buy.
  const decoded = _models.decodePoolLogs(vctx, [
    modLog(50, 1, 5000n, salt),
    swapLog(50, 2, -(10n ** 18n), 10n ** 21n, U1),
    modLog(50, 3, -5000n, salt),
    swapLog(51, 1, 10n ** 17n, -(10n ** 20n), U2),
    { ...swapLog(52, 1, 1n, -1n, U2), address: '0x' + '9'.repeat(40) }, // not from PoolManager => ignored
  ]);
  assert(decoded.swaps.length === 2, 'V4 swaps decoded only from PoolManager');
  assert(decoded.swaps[0].dir === 'buy' && near(decoded.swaps[0].quoteAbs, 1), 'V4 swapper-perspective sign => buy');
  assert(decoded.swaps[1].dir === 'sell', 'V4 sell');
  assert(decoded.v3Mints.length === 1 && decoded.v3Burns.length === 1 && decoded.v3Mints[0].salt === salt, 'V4 ModifyLiquidity => mint/burn with salt');
  const vj = await _models.checkJit({ ...vctx, getLogs: async () => ({ ...decoded, fromBlock: 1, toBlock: 60, coverage: 1, failures: [] }) });
  assert(vj.metrics.jit_cycles === 1 && vj.metrics.same_block_cycles === 1 && vj.metrics.swaps_bracketed_by_jit === 1, 'JIT detection on V4 positions');
  assert(vj.metrics.top_jit_providers[0].v4_position_salt_prefix, 'V4 JIT provider reports position salt');
}

// ---------------------------------------------------------------------------
// 5. Status combination rules
// ---------------------------------------------------------------------------
{
  const m = (score, confidence, signals = [], data_available = true) => ({ score, confidence, data_available, signals });
  const base_ = (a, b, c) => _models.combine({ mempool_front_running: a, jit_liquidity_vampire: b, cross_pair_cascade: c }, cfg);
  assert(base_(m(0, 0.6), m(0, 0.5), m(20, 0.75)).status === 'SAFE', 'quiet token SAFE');
  const low = base_(m(0, 0.1), m(0, 0.1), m(10, 0.2));
  assert(low.status === 'WARN' && low.lowConfidence, 'low confidence never SAFE');
  const lowRec = _models.recommendation(low.status, { cross_pair_cascade: { score: 10, metrics: {}, signals: [] }, mempool_front_running: { score: 0, signals: [] }, jit_liquidity_vampire: { score: 0, metrics: { affected_pools: [] }, signals: [] } }, low);
  assert(lowRec.reasons[0].startsWith('LOW_CONFIDENCE'), 'low-confidence reason surfaced');
  assert(base_(m(0, 0.6), m(0, 0.5), m(90, 0.6)).status === 'DANGER', 'single-model escalation');
  assert(base_(m(0, 0.6), m(0, 0.5), m(30, 0.75, [{ code: 'THIN_LIQUIDITY', severity: 'critical', message: 'x' }])).status === 'WARN', 'critical-signal floor');
  assert(base_(m(0, 0.6), m(0, 0.5), m(30, 0.3, [{ code: 'THIN_LIQUIDITY', severity: 'critical', message: 'x' }])).status === 'SAFE', 'floor needs confidence >= 0.5');
  const degraded = base_(m(50, 0, [], false), m(50, 0, [], false), m(50, 0, [], false));
  assert(degraded.status === 'WARN' && degraded.riskScore === 50, 'no data => WARN 50, never SAFE');
}

// ---------------------------------------------------------------------------
// 6. Output schema: invalid input (no network) and a synthetic assembled result
// ---------------------------------------------------------------------------
{
  const manifest = JSON.parse(readFileSync(new URL('../ai-plugin.json', import.meta.url), 'utf8'));
  const ajv = new Ajv({ strict: true, allErrors: true, strictTypes: false });
  addFormats(ajv);
  const validate = ajv.compile(manifest.tools[0].outputSchema);
  const bad = await analyzeTokenSafety('not-an-address');
  assert(validate(bad), 'invalid-address result is schema-valid: ' + ajv.errorsText(validate.errors));
  assert(bad.status === 'DANGER' && bad.recommendation.reasons.length === 1, 'invalid address => DANGER with reason');
}


// ---------------------------------------------------------------------------
// 7. Payment gate (lib/billing.js): open / api_key / x402, fail-closed config. No network.
// ---------------------------------------------------------------------------
{
  const B = await import('../lib/billing.js');
  const reqWith = (headers = {}) => new Request('https://svc.test/api/analyze', { method: 'POST', headers });
  const open = await B.authorizeCall(reqWith(), { cfg: B.loadBillingConfig({}) });
  assert(open.ok && open.identity === 'anonymous' && Object.keys(open.headers).length === 0, 'billing: default mode open, no headers');
  const bogus = await B.authorizeCall(reqWith(), { cfg: B.loadBillingConfig({ BILLING_MODE: 'free' }) });
  assert(!bogus.ok && bogus.status === 503, 'billing: unknown mode fails closed (503)');
  const noSb = await B.authorizeCall(reqWith({ 'x-api-key': 'k' }), { cfg: B.loadBillingConfig({ BILLING_MODE: 'api_key' }) });
  assert(!noSb.ok && noSb.status === 503 && noSb.body.error === 'billing_not_configured', 'billing: api_key without Supabase fails closed');

  const akCfg = B.loadBillingConfig({ BILLING_MODE: 'api_key', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test' });
  const calls = [];
  const rpcYes = async (fn, args) => (calls.push([fn, args]), { data: true, error: null });
  const rpcNo = async () => ({ data: false, error: null });
  const rpcErr = async () => ({ data: null, error: { message: 'boom' } });
  assert((await B.authorizeCall(reqWith(), { cfg: akCfg, rpc: rpcYes })).status === 401, 'billing: api_key missing header => 401');
  const akOk = await B.authorizeCall(reqWith({ 'x-api-key': 'secret-key-123' }), { cfg: akCfg, rpc: rpcYes });
  assert(akOk.ok && calls.length === 1 && calls[0][0] === 'deduct_api_key_balance' && calls[0][1].p_key === 'secret-key-123' && calls[0][1].p_cost === '0.01', 'billing: api_key deducts $0.01 via RPC');
  assert(!akOk.identity.includes('secret-key-123') && akOk.headers['x-price-usd'] === '0.01', 'billing: identity does not echo the key; price header');
  assert((await B.authorizeCall(reqWith({ 'x-api-key': 'k' }), { cfg: akCfg, rpc: rpcNo })).status === 402, 'billing: api_key empty balance => 402');
  assert((await B.authorizeCall(reqWith({ 'x-api-key': 'k' }), { cfg: akCfg, rpc: rpcErr })).status === 402, 'billing: api_key RPC error fails closed');
  assert((await B.authorizeCall(reqWith({ 'x-api-key': 'k' }), { cfg: akCfg, rpc: null })).status === 503, 'billing: api_key no client => 503');

  // x402 config validation
  assert(B.loadBillingConfig({ BILLING_MODE: 'x402' }).errors.length > 0, 'billing: x402 without pay-to/facilitator is misconfigured');
  assert(B.loadBillingConfig({ BILLING_MODE: 'x402', X402_PAY_TO: '0x0000000000000000000000000000000000000000', X402_FACILITATOR_URL: 'https://f.test' }).errors.some((e) => e.includes('zero')), 'billing: zero pay-to rejected');
  assert(B.loadBillingConfig({ BILLING_MODE: 'x402', X402_PAY_TO: '0x' + '1'.repeat(40), X402_FACILITATOR_URL: 'http://f.test' }).errors.some((e) => e.includes('https')), 'billing: non-https facilitator rejected');
  assert(B.loadBillingConfig({ BILLING_MODE: 'x402', PRICE_USD: '0', X402_ACCEPT_STUB: 'true' }).errors.length > 0, 'billing: zero price rejected');

  // x402 stub-only (testing)
  const stubCfg = B.loadBillingConfig({ BILLING_MODE: 'x402', X402_ACCEPT_STUB: 'true' });
  assert(stubCfg.errors.length === 0, 'billing: stub-only x402 config is valid');
  const unpaid = await B.authorizeCall(reqWith(), { cfg: stubCfg });
  assert(!unpaid.ok && unpaid.status === 402 && unpaid.headers['payment-required'], 'billing: x402 unpaid => 402 + PAYMENT-REQUIRED');
  const doc = JSON.parse(atob(unpaid.headers['payment-required']));
  assert(doc.x402Version === 2 && Array.isArray(doc.accepts) && doc.accepts.length === 0, 'billing: no pay-to => no invented accepts');
  assert((await B.authorizeCall(reqWith({ 'x-payment': 'stub:agent-1' }), { cfg: stubCfg })).ok, 'billing: stub accepted when X402_ACCEPT_STUB=true');
  const stubOff = B.loadBillingConfig({ BILLING_MODE: 'x402', X402_PAY_TO: '0x' + '1'.repeat(40), X402_FACILITATOR_URL: 'https://f.test' });
  assert(!(await B.authorizeCall(reqWith({ 'x-payment': 'stub:agent-1' }), { cfg: stubOff })).ok, 'billing: stub rejected by default');

  // x402 full path with a fake facilitator (test-only addresses)
  const PAY_TO = '0x' + '1'.repeat(40);
  const PAYER = '0x' + '2'.repeat(40);
  const xCfg = B.loadBillingConfig({ BILLING_MODE: 'x402', X402_PAY_TO: PAY_TO, X402_FACILITATOR_URL: 'https://facilitator.test/x402' });
  assert(xCfg.errors.length === 0 && xCfg.amount === '10000', 'billing: x402 config, $0.01 = 10000 atomic USDC');
  const reqs = B.paymentRequirements(xCfg);
  assert(reqs.asset === B.BASE_USDC && reqs.network === 'eip155:8453' && reqs.extra.name === 'USD Coin' && reqs.extra.version === '2', 'billing: USDC-on-Base requirements');
  const now = 1_800_000_000;
  const mkPay = (over = {}, nonce = '0x' + 'a'.repeat(64)) => B.encodePaymentHeader({
    x402Version: 2,
    accepted: { ...reqs, ...over },
    payload: { signature: '0x' + 'b'.repeat(130), authorization: { from: PAYER, to: PAY_TO, value: over.amount ?? '10000', validAfter: String(now - 10), validBefore: String(now + 50), nonce } },
  });
  const hits = [];
  const fac = (settleOk = true) => async (url, init) => {
    hits.push(url);
    const isVerify = url.endsWith('/verify');
    const body = isVerify ? { isValid: true, payer: PAYER } : settleOk ? { success: true, payer: PAYER, transaction: '0x' + 'c'.repeat(64), network: 'eip155:8453' } : { success: false, errorReason: 'insufficient_funds' };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  B.resetNoncesForTests();
  const g = await B.authorizeCall(reqWith({ 'payment-signature': mkPay() }), { cfg: xCfg, fetch: fac(), now });
  assert(g.ok && g.identity === 'x402:' + PAYER.toLowerCase() && hits[0] === 'https://facilitator.test/x402/verify', 'billing: x402 verify via facilitator');
  const fin = await g.finalize({ success: true });
  assert(fin.ok && hits[1] === 'https://facilitator.test/x402/settle' && JSON.parse(atob(fin.headers['payment-response'])).success === true, 'billing: x402 settle + PAYMENT-RESPONSE');
  const replay = await B.authorizeCall(reqWith({ 'payment-signature': mkPay() }), { cfg: xCfg, fetch: fac(), now });
  assert(!replay.ok && replay.status === 402 && replay.body.message.includes('nonce'), 'billing: nonce replay rejected');
  const wrongAmt = await B.authorizeCall(reqWith({ 'payment-signature': mkPay({ amount: '1' }, '0x' + 'd'.repeat(64)) }), { cfg: xCfg, fetch: fac(), now });
  assert(!wrongAmt.ok && wrongAmt.status === 402, 'billing: wrong amount rejected');
  const wrongTo = await B.authorizeCall(reqWith({ 'payment-signature': mkPay({ payTo: PAYER }, '0x' + 'e'.repeat(64)) }), { cfg: xCfg, fetch: fac(), now });
  assert(!wrongTo.ok && wrongTo.body.message.includes('X402_PAY_TO'), 'billing: wrong recipient rejected');
  const g2 = await B.authorizeCall(reqWith({ 'payment-signature': mkPay({}, '0x' + 'f'.repeat(64)) }), { cfg: xCfg, fetch: fac(false), now });
  const fin2 = await g2.finalize({ success: true });
  assert(g2.ok && !fin2.ok && fin2.status === 402, 'billing: failed settlement withholds the result');
  const g3 = await B.authorizeCall(reqWith({ 'payment-signature': mkPay({}, '0x' + 'f'.repeat(64)) }), { cfg: xCfg, fetch: fac(), now });
  assert(g3.ok, 'billing: nonce released after failed settlement');
  const garbage = await B.authorizeCall(reqWith({ 'payment-signature': 'not-base64!!' }), { cfg: xCfg, fetch: fac(), now });
  assert(!garbage.ok && garbage.status === 402, 'billing: malformed payment => 402');
}

// ---------------------------------------------------------------------------
// 8. Uniswap V4 Initialize-log discovery (gating + decoding). No network.
// ---------------------------------------------------------------------------
{
  assert(v4LogDiscoveryUrls('auto', 'https://mainnet.base.org', [], ['https://base-rpc.publicnode.com']) === null, 'v4 logs: auto + default RPCs => disabled');
  assert(v4LogDiscoveryUrls('auto', 'https://base-mainnet.g.alchemy.com/v2/x', [], [])?.[0]?.includes('alchemy'), 'v4 logs: auto + custom BASE_RPC_URL => enabled');
  assert(v4LogDiscoveryUrls('auto', 'https://mainnet.base.org', ['https://logs.example'], [])?.length === 1, 'v4 logs: auto + BASE_LOGS_RPC_URL => enabled');
  assert(v4LogDiscoveryUrls('on', 'https://mainnet.base.org', [], ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'])?.join() === 'https://base-rpc.publicnode.com', 'v4 logs: on uses fallbacks, never mainnet.base.org');
  assert(v4LogDiscoveryUrls('off', 'https://x.example', ['https://y.example'], []) === null, 'v4 logs: off');

  const TOKEN = '0x' + '7'.repeat(40);
  const HOOK = '0x' + '8'.repeat(39) + 'c';
  const mk = (c0, c1, fee, ts, hooks, idOverride) => {
    const key = { currency0: c0, currency1: c1, fee, tickSpacing: ts, hooks };
    const ev = _models.EV.V4_INITIALIZE;
    const topics = encodeEventTopics({ abi: [ev], eventName: 'Initialize', args: { id: idOverride ?? v4PoolId(key), currency0: c0, currency1: c1 } });
    const data = encodeAbiParameters([{ type: 'uint24' }, { type: 'int24' }, { type: 'address' }, { type: 'uint160' }, { type: 'int24' }], [fee, ts, hooks, 2n ** 96n, 0]);
    return { topics, data, blockNumber: '0x10' };
  };
  const ETH = '0x0000000000000000000000000000000000000000';
  const USDC = ASSET.USDC.address;
  const found = decodeV4InitializeLogs([
    mk(ETH, TOKEN, 12345, 77, HOOK), // hooked ETH pool, custom tier
    mk(TOKEN, USDC, 3000, 60, ETH), // hookless USDC
    mk(TOKEN, '0x' + '9'.repeat(40), 3000, 60, ETH), // unsupported quote => ignored
    mk(ETH, TOKEN, 500, 10, HOOK, '0x' + '0'.repeat(63) + '1'), // id does not match key => ignored
    { topics: ['0x' + '1'.repeat(64)], data: '0x' }, // garbage
  ], TOKEN);
  assert(found.length === 2 && found[0].hooks === HOOK && found[0].fee === 12345 && found[0].tickSpacing === 77 && found[0].block === 16, 'v4 logs: decode hooked Initialize, drop unknown quotes / bad ids');
}

console.log(`UNIT PASSED (${passed} assertions)`);
