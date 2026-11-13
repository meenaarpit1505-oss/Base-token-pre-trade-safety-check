/**
 * Base Token Pre-Trade Safety Engine (chain id 8453)
 *
 * Three threat models, run in parallel, each bounded by its own timeout and never throwing:
 *   1. mempool_front_running  - pending-queue probe, falling back to recent-block sandwich forensics
 *   2. jit_liquidity_vampire  - same-provider add->remove liquidity cycles around swaps
 *   3. cross_pair_cascade     - liquidity graph + secondary-asset shock simulation (CL tick-walk aware)
 *
 * Venues: Uniswap V2, Uniswap V3, Uniswap V4 (singleton PoolManager, hookless standard tiers + configured keys),
 * Aerodrome basic (volatile/stable) and Aerodrome Slipstream (CL). Quote assets: WETH, native ETH (V4), USDC,
 * USDbC and cbBTC; USDbC/cbBTC pairs are scored as two-hop routes into USDC/WETH.
 *
 * Runtime: Edge (Vercel / Next.js) or Node >= 18. Only depends on viem.
 */
import {
  createPublicClient,
  http,
  fallback,
  parseAbi,
  parseAbiItem,
  toEventSelector,
  decodeEventLog,
  erc20Abi,
  getAddress,
  toHex,
  zeroAddress,
  keccak256,
  encodeAbiParameters,
} from 'viem';
import { base } from 'viem/chains';
import * as cl from './clMath.js';

export const ENGINE_VERSION = '2.2.0';
export const TOOL_NAME = 'analyze_base_token_safety';
export const CHAIN_ID = 8453;
export const CACHE_TTL_SECONDS = 300;

// ---------------------------------------------------------------------------
// Verified Base mainnet addresses. Sources (checked 2026-11-11):
//  - Uniswap V2/V3/V4: https://docs.uniswap.org/contracts/v4/deployments (+ v3/v2 deployment pages)
//  - Aerodrome basic: Aerodrome docs / basescan verified PoolFactory
//  - Slipstream: https://github.com/aerodrome-finance/slipstream#deployments (3 PoolFactory generations)
//  - USDC / USDbC: https://docs.base.org/base-chain/network-information/ecosystem-bridges , circle.com blog
//  - cbBTC: https://www.coinbase.com/cbbtc , https://www.coinbase.com/blog/coinbase-wrapped-btc-cbbtc-is-now-live
//  - WETH9 predeploy: https://docs.base.org/base-chain/network-information/base-contracts
// ---------------------------------------------------------------------------
export const ADDRESSES = Object.freeze({
  UNISWAP_V3_FACTORY: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
  UNISWAP_V2_FACTORY: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6',
  UNISWAP_V4_POOL_MANAGER: '0x498581fF718922c3f8e6A244956aF099B2652b2b',
  UNISWAP_V4_STATE_VIEW: '0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71',
  AERODROME_POOL_FACTORY: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
  // Aerodrome Slipstream (concentrated liquidity) factories: initial, GaugeCaps, GaugesV3 generations.
  SLIPSTREAM_CL_FACTORIES: Object.freeze([
    '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A',
    '0xaDe65c38CD4849aDBA595a4323a8C7DdfE89716a',
    '0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef',
  ]),
  WETH: '0x4200000000000000000000000000000000000006',
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  USDBC: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA',
  CBBTC: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
  NATIVE_ETH: zeroAddress, // Uniswap V4 Currency.wrap(address(0))
});

// Routers/position managers: their address shows up as `sender` for every user, so it is never an actor identity.
const DEFAULT_ROUTERS = [
  '0x6fF5693b99212Da76ad316178A184AB56D299b43', // Uniswap UniversalRouter (v4)
  '0xFDf682F51FE81aA4898F0AE2163D8A55c127Fbc7', // Uniswap UniversalRouter 2.1.1
  '0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40', // Uniswap UniversalRouter 2.1.2
  '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD', // Uniswap UniversalRouter (legacy)
  '0x2626664c2603336E57B271c5C0b26F421741e481', // Uniswap SwapRouter02
  '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24', // Uniswap V2 Router02
  '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1', // Uniswap V3 NonfungiblePositionManager
  '0x7C5f5A4bBd8fD63184577525326123B519429bDc', // Uniswap V4 PositionManager
  '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43', // Aerodrome Router
  '0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5', // Slipstream SwapRouter (initial)
  '0xcbBb8035cAc7D4B3Ca7aBb74cF7BdF900215Ce0D', // Slipstream SwapRouter (GaugeCaps)
  '0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F', // Slipstream SwapRouter (GaugesV3)
  '0x827922686190790b37229fd06084350E74485b72', // Slipstream NonfungiblePositionManager (initial)
  '0xa990C6a764b73BF43cee5Bb40339c3322FB9D55F', // Slipstream NonfungiblePositionManager (GaugeCaps)
  '0xe1f8cd9AC4e4A65F54f38a5CdAfCA44f6dD68b53', // Slipstream NonfungiblePositionManager (GaugesV3)
];

// group: assets that share one shock (WETH and native ETH are the same economic asset).
// hop: pools quoted in this asset need a second swap to reach USDC/WETH; scored as a two-leg route.
const ASSET = Object.freeze({
  ETH: Object.freeze({ address: lcAddr(ADDRESSES.NATIVE_ETH), symbol: 'ETH', decimals: 18, stable: false, group: 'ETH', hop: false }),
  WETH: Object.freeze({ address: lcAddr(ADDRESSES.WETH), symbol: 'WETH', decimals: 18, stable: false, group: 'ETH', hop: false }),
  USDC: Object.freeze({ address: lcAddr(ADDRESSES.USDC), symbol: 'USDC', decimals: 6, stable: true, group: 'USDC', hop: false }),
  USDbC: Object.freeze({ address: lcAddr(ADDRESSES.USDBC), symbol: 'USDbC', decimals: 6, stable: true, group: 'USDbC', hop: true }),
  cbBTC: Object.freeze({ address: lcAddr(ADDRESSES.CBBTC), symbol: 'cbBTC', decimals: 8, stable: false, group: 'cbBTC', hop: true }),
});
function lcAddr(a) {
  return a.toLowerCase();
}
const PRIMARY_QUOTES = [ASSET.WETH, ASSET.USDC];
const EXTRA_QUOTES = [ASSET.USDbC, ASSET.cbBTC];
const V4_CURRENCIES = [ASSET.ETH, ASSET.WETH, ASSET.USDC, ASSET.USDbC, ASSET.cbBTC];
const ASSET_BY_ADDR = new Map(Object.values(ASSET).map((a) => [a.address, a]));

const V3_FEE_TIERS = [100, 500, 3000, 10000];
const SLIPSTREAM_TICK_SPACINGS = [1, 50, 100, 200, 2000];
// Uniswap V4 hookless pools are only discoverable by key; these are the interface's standard fee/tickSpacing pairs.
const V4_STANDARD_TIERS = [
  [100, 1],
  [500, 10],
  [3000, 60],
  [10000, 200],
];

// ---------------------------------------------------------------------------
// Configuration (env-driven, safe defaults, clamped)
// ---------------------------------------------------------------------------
function env(name, fallbackValue) {
  try {
    const v = globalThis.process?.env?.[name];
    return v === undefined || v === '' ? fallbackValue : v;
  } catch {
    return fallbackValue;
  }
}
function envNum(name, fallbackValue, min, max) {
  const n = Number(env(name, fallbackValue));
  if (!Number.isFinite(n)) return fallbackValue;
  return Math.min(max, Math.max(min, n));
}
function envBool(name, fallbackValue) {
  const v = String(env(name, fallbackValue ? 'true' : 'false')).trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(v);
}
function envList(name) {
  return String(env(name, ''))
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^0x[a-f0-9]{40}$/.test(s));
}
function envUrls(name, fallbackValue) {
  return String(env(name, fallbackValue))
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//.test(s));
}

/**
 * UNISWAP_V4_POOL_KEYS="currency0,currency1,fee,tickSpacing,hooks;..." (hooked pools cannot be discovered without
 * an Initialize-event index, so operators can list them explicitly). Invalid entries are ignored.
 */
export function parseV4PoolKeys(raw) {
  const out = [];
  for (const part of String(raw ?? '').split(';')) {
    const f = part.split(',').map((s) => s.trim());
    if (f.length !== 5) continue;
    const [c0, c1, feeS, tsS, hooks] = f;
    const fee = Number(feeS);
    const ts = Number(tsS);
    if (![c0, c1, hooks].every((a) => /^0x[a-fA-F0-9]{40}$/.test(a))) continue;
    if (!Number.isInteger(fee) || fee < 0 || fee > 0xffffff || !Number.isInteger(ts) || ts < 1 || ts > 32767) continue;
    const [a, b] = BigInt(c0) < BigInt(c1) ? [c0, c1] : [c1, c0];
    out.push({ currency0: a.toLowerCase(), currency1: b.toLowerCase(), fee, tickSpacing: ts, hooks: hooks.toLowerCase() });
  }
  return out.slice(0, 20);
}

const NO_LOGS_HOSTS = ['mainnet.base.org']; // rejects / rate-limits eth_getLogs
const logsCapable = (u) => {
  try {
    return !NO_LOGS_HOSTS.includes(new URL(u).hostname);
  } catch {
    return false;
  }
};
/**
 * UNISWAP_V4_LOG_DISCOVERY: auto (default) => on only when an operator-supplied endpoint can serve logs
 * (BASE_LOGS_RPC_URL, or a BASE_RPC_URL that is not mainnet.base.org); on => also try BASE_RPC_FALLBACK_URLS
 * (e.g. publicnode, 50k-block ranges); off => disabled. Returns the URL list to use, or null when disabled.
 */
export function v4LogDiscoveryUrls(mode, primary, logsUrls = [], fallbacks = []) {
  const m = String(mode ?? 'auto').toLowerCase();
  if (m === 'off' || m === 'false' || m === '0') return null;
  const explicit = dedupe([...logsUrls, ...(primary && primary !== 'https://mainnet.base.org' ? [primary] : [])]).filter(logsCapable);
  const urls = m === 'on' || m === 'true' || m === '1' ? dedupe([...explicit, ...fallbacks.filter(logsCapable)]) : explicit;
  return urls.length ? urls : null;
}

export function loadConfig(overrides = {}) {
  const primary = overrides.rpcUrl || env('BASE_RPC_URL', 'https://mainnet.base.org');
  const fallbacks = envUrls('BASE_RPC_FALLBACK_URLS', 'https://base-rpc.publicnode.com');
  const logsUrls = envUrls('BASE_LOGS_RPC_URL', '');
  return {
    rpcUrls: dedupe([primary, ...fallbacks]),
    // Many public endpoints (incl. mainnet.base.org) reject eth_getLogs; try dedicated/fallback URLs first for logs.
    logsRpcUrls: dedupe([...logsUrls, ...fallbacks, primary]),
    rpcTimeoutMs: envNum('RPC_TIMEOUT_MS', 4000, 500, 20000),
    checkTimeoutMs: overrides.checkTimeoutMs ?? envNum('CHECK_TIMEOUT_MS', 7000, 1000, 30000),
    engineTimeoutMs: overrides.timeoutMs ?? envNum('ENGINE_TIMEOUT_MS', 9500, 2000, 60000),
    logBlockRange: envNum('LOG_BLOCK_RANGE', 1800, 50, 20000), // ~1h of 2s Base blocks
    logChunkSize: envNum('LOG_CHUNK_SIZE', 1000, 25, 10000),
    logConcurrency: envNum('LOG_CONCURRENCY', 4, 1, 8),
    logAddressBatch: envNum('LOG_ADDRESS_BATCH', 10, 1, 1000), // publicnode caps eth_getLogs at 10 addresses
    logMaxPools: envNum('LOG_MAX_POOLS', 8, 1, 50), // deepest N pools carry ~all flow; dust pools are skipped
    headLagBlocks: envNum('HEAD_LAG_BLOCKS', 2, 0, 50), // load-balanced RPCs disagree on the head by a block or two
    pendingSampleMs: envNum('PENDING_SAMPLE_MS', 600, 100, 3000),
    maxTxLookups: envNum('MAX_TX_LOOKUPS', 60, 0, 500),
    jitWindowBlocks: envNum('JIT_WINDOW_BLOCKS', 5, 0, 100),
    jitMinShare: envNum('JIT_MIN_LIQUIDITY_SHARE', 0.05, 0.0001, 1),
    shockPct: envNum('CASCADE_SHOCK_PCT', 30, 1, 95),
    referenceTradeUsd: envNum('REFERENCE_TRADE_USD', 10000, 10, 1e9),
    dustPoolUsd: envNum('DUST_POOL_USD', 1000, 0, 1e9),
    clMaxPools: envNum('CL_TICK_SCAN_MAX_POOLS', 6, 0, 20),
    clMaxTicks: envNum('CL_TICK_WALK_MAX_TICKS', 8, 1, 32),
    contextTickBudgetMs: envNum('CL_TICK_SCAN_BUDGET_MS', 4500, 500, 30000),
    enableV4: overrides.enableV4 ?? envBool('ENABLE_UNISWAP_V4', true),
    enableExtraQuotes: overrides.enableExtraQuotes ?? envBool('ENABLE_EXTRA_QUOTES', true),
    v4ExtraKeys: parseV4PoolKeys(env('UNISWAP_V4_POOL_KEYS', '')),
    // Hooked / non-standard V4 pools via PoolManager Initialize logs (bounded, env-gated; never via mainnet.base.org).
    v4LogDiscovery: v4LogDiscoveryUrls(env('UNISWAP_V4_LOG_DISCOVERY', 'auto'), primary, logsUrls, fallbacks),
    v4DiscoveryLookback: envNum('V4_DISCOVERY_LOOKBACK_BLOCKS', 500000, 1000, 50000000),
    v4DiscoveryChunk: envNum('V4_DISCOVERY_CHUNK_BLOCKS', 50000, 1000, 10000000), // publicnode caps ranges at 50k
    v4DiscoveryBudgetMs: envNum('V4_DISCOVERY_BUDGET_MS', 2500, 200, 20000),
    v4DiscoveryCacheMs: envNum('V4_DISCOVERY_CACHE_SECONDS', 1800, 0, 86400) * 1000,
    v4DiscoveryMaxPools: envNum('V4_DISCOVERY_MAX_POOLS', 12, 1, 50),
    mevBots: new Set(envList('MEV_BOT_ADDRESSES')),
    routers: new Set([...DEFAULT_ROUTERS.map((a) => a.toLowerCase()), ...envList('KNOWN_ROUTER_ADDRESSES')]),
    weights: {
      mempool_front_running: envNum('WEIGHT_MEMPOOL', 0.35, 0, 1),
      jit_liquidity_vampire: envNum('WEIGHT_JIT', 0.3, 0, 1),
      cross_pair_cascade: envNum('WEIGHT_CASCADE', 0.35, 0, 1),
    },
  };
}

// ---------------------------------------------------------------------------
// Status thresholds (documented in README + manifest)
// ---------------------------------------------------------------------------
export const THRESHOLDS = Object.freeze({ WARN: 35, DANGER: 65, MODEL_ESCALATION: 85, LOW_CONFIDENCE: 0.35, CRITICAL_FLOOR_CONFIDENCE: 0.5 });

export function statusFromScore(score) {
  if (score >= THRESHOLDS.DANGER) return 'DANGER';
  if (score >= THRESHOLDS.WARN) return 'WARN';
  return 'SAFE';
}

// ---------------------------------------------------------------------------
// ABIs + event topics
// ---------------------------------------------------------------------------
const v3FactoryAbi = parseAbi(['function getPool(address,address,uint24) view returns (address)']);
const v2FactoryAbi = parseAbi(['function getPair(address,address) view returns (address)']);
const aeroFactoryAbi = parseAbi(['function getPool(address,address,bool) view returns (address)']);
const clFactoryAbi = parseAbi(['function getPool(address,address,int24) view returns (address)']);
// Only the first two words of ticks() are decoded (liquidityGross, liquidityNet): identical in V3 and Slipstream.
const v3PoolAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
  'function liquidity() view returns (uint128)',
  'function token0() view returns (address)',
  'function tickBitmap(int16) view returns (uint256)',
  'function ticks(int24) view returns (uint128 liquidityGross, int128 liquidityNet)',
]);
// Slipstream slot0 has 6 fields (no feeProtocol); everything else is V3-compatible, including event layouts.
const clPoolAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, bool)',
  'function liquidity() view returns (uint128)',
  'function token0() view returns (address)',
  'function tickBitmap(int16) view returns (uint256)',
  'function ticks(int24) view returns (uint128 liquidityGross, int128 liquidityNet)',
]);
const stateViewAbi = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128)',
  'function getTickBitmap(bytes32 poolId, int16 tick) view returns (uint256)',
  'function getTickLiquidity(bytes32 poolId, int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet)',
]);
// Aerodrome returns (uint256,uint256,uint256), UniV2 (uint112,uint112,uint32): identical ABI word layout.
const v2PoolAbi = parseAbi([
  'function getReserves() view returns (uint256, uint256, uint256)',
  'function token0() view returns (address)',
  'function totalSupply() view returns (uint256)',
]);

const EV = {
  V3_SWAP: parseAbiItem('event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)'),
  V3_MINT: parseAbiItem('event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)'),
  V3_BURN: parseAbiItem('event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)'),
  V2_SWAP: parseAbiItem('event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)'),
  V2_MINT: parseAbiItem('event Mint(address indexed sender, uint256 amount0, uint256 amount1)'),
  V2_BURN: parseAbiItem('event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)'),
  AERO_SWAP: parseAbiItem('event Swap(address indexed sender, address indexed to, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out)'),
  AERO_BURN: parseAbiItem('event Burn(address indexed sender, address indexed to, uint256 amount0, uint256 amount1)'),
  TRANSFER: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
  // Uniswap V4 PoolManager (v4-core IPoolManager). Swap amounts are the SWAPPER's deltas (sign opposite to V3).
  V4_SWAP: parseAbiItem('event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)'),
  V4_MODIFY: parseAbiItem('event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)'),
  V4_INITIALIZE: parseAbiItem('event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)'),
};
const TOPIC = Object.fromEntries(Object.entries(EV).map(([k, v]) => [k, toEventSelector(v)]));
const TOPIC_TO_EVENT = new Map(Object.entries(EV).map(([k, v]) => [TOPIC[k], { key: k, item: v }]));
const POOL_EVENT_TOPICS = ['V3_SWAP', 'V3_MINT', 'V3_BURN', 'V2_SWAP', 'V2_MINT', 'V2_BURN', 'AERO_SWAP', 'AERO_BURN'].map((k) => TOPIC[k]);
const V4_EVENT_TOPICS = [TOPIC.V4_SWAP, TOPIC.V4_MODIFY];
const ZERO_TOPIC = '0x' + '0'.repeat(64);

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function dedupe(arr) {
  return [...new Set(arr)];
}
const lc = (a) => (typeof a === 'string' ? a.toLowerCase() : a);
const clamp = (n, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, n));
const round = (n, d = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : 0);
const toFloat = (bi, decimals) => {
  if (typeof bi !== 'bigint') return 0;
  const neg = bi < 0n;
  const abs = neg ? -bi : bi;
  const scale = 10n ** BigInt(decimals);
  const v = Number(abs / scale) + Number(abs % scale) / Number(scale);
  return neg ? -v : v;
};
const signal = (code, severity, message) => ({ code, severity, message: String(message).slice(0, 300) });
const isCL = (p) => p.kind === 'v3' || p.kind === 'cl' || p.kind === 'v4';

export function normalizeTokenAddress(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  return /^0x[a-fA-F0-9]{40}$/.test(s) ? s.toLowerCase() : null;
}

/** keccak256(abi.encode(PoolKey)) exactly as v4-core PoolIdLibrary. */
export function v4PoolId({ currency0, currency1, fee, tickSpacing, hooks }) {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
      [getAddress(currency0), getAddress(currency1), fee, tickSpacing, getAddress(hooks)],
    ),
  ).toLowerCase();
}

class TimeoutError extends Error {
  constructor(label, ms) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/** Run fn(signal) with a hard deadline; aborts the controller so cooperative work stops early. */
async function withTimeout(fn, ms, label, parentSignal) {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parentSignal.reason);
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort(parentSignal.reason);
    else parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new TimeoutError(label, ms);
      controller.abort(err);
      reject(err);
    }, ms);
  });
  const aborted = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason ?? new Error(`${label} aborted`)), { once: true });
  });
  try {
    return await Promise.race([fn(controller.signal), timeout, aborted]);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener?.('abort', onParentAbort);
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

const sleep = (ms, sig) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    sig?.addEventListener?.('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

// ---------------------------------------------------------------------------
// RPC clients (module-scoped => reused across warm invocations)
// ---------------------------------------------------------------------------
const clientCache = new Map();
function getClient(urls, timeoutMs, { jsonRpcBatch = true } = {}) {
  const key = urls.join('|') + '#' + timeoutMs + '#' + jsonRpcBatch;
  let c = clientCache.get(key);
  if (!c) {
    // Small JSON-RPC batches: public endpoints count each batched call against per-second limits.
    const batch = jsonRpcBatch ? { batchSize: 10, wait: 8 } : false;
    const transports = urls.map((u) => http(u, { batch, timeout: timeoutMs, retryCount: 0 }));
    c = createPublicClient({
      chain: base,
      transport: transports.length > 1 ? fallback(transports, { rank: false, retryCount: 0 }) : transports[0],
      batch: { multicall: { batchSize: 8192, wait: 4 } },
    });
    clientCache.set(key, c);
  }
  return c;
}

// ---------------------------------------------------------------------------
// Pool discovery + state (generic over venues so token pools and reference pools share one code path)
// ---------------------------------------------------------------------------
/** Factory lookups for `baseAddr` against `quote`. Returns [{call, meta}] where meta describes the pool. */
function classicDiscovery(baseAddr, quote, { v3Fees = V3_FEE_TIERS, clSpacings = SLIPSTREAM_TICK_SPACINGS, v2 = true, aeroStable = true } = {}) {
  const out = [];
  const q = getAddress(quote.address);
  for (const fee of v3Fees) {
    out.push({ call: { address: ADDRESSES.UNISWAP_V3_FACTORY, abi: v3FactoryAbi, functionName: 'getPool', args: [baseAddr, q, fee] }, meta: { dex: 'uniswap_v3', kind: 'v3', quote, fee, tick_spacing: cl.tickSpacingForFee(fee) } });
  }
  if (v2) out.push({ call: { address: ADDRESSES.UNISWAP_V2_FACTORY, abi: v2FactoryAbi, functionName: 'getPair', args: [baseAddr, q] }, meta: { dex: 'uniswap_v2', kind: 'v2', quote, fee: 3000, tick_spacing: null } });
  for (const factory of ADDRESSES.SLIPSTREAM_CL_FACTORIES) {
    for (const ts of clSpacings) {
      out.push({ call: { address: factory, abi: clFactoryAbi, functionName: 'getPool', args: [baseAddr, q, ts] }, meta: { dex: 'aerodrome_slipstream', kind: 'cl', quote, fee: null, tick_spacing: ts } });
    }
  }
  for (const stable of aeroStable ? [false, true] : [false]) {
    out.push({ call: { address: ADDRESSES.AERODROME_POOL_FACTORY, abi: aeroFactoryAbi, functionName: 'getPool', args: [baseAddr, q, stable] }, meta: { dex: stable ? 'aerodrome_stable' : 'aerodrome_volatile', kind: stable ? 'aero_stable' : 'aero', quote, fee: null, tick_spacing: null } });
  }
  return out;
}

/** V4 candidate pools for `token` (hookless standard tiers + configured keys), ids computed off-chain. */
function v4Candidates(token, cfg) {
  if (!cfg.enableV4) return [];
  const out = [];
  const seen = new Set();
  const push = (key, quote, hooked) => {
    const id = v4PoolId(key);
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ address: id, poolId: id, dex: 'uniswap_v4', kind: 'v4', quote, fee: key.fee, tick_spacing: key.tickSpacing, hooks: key.hooks, hooked });
  };
  for (const quote of V4_CURRENCIES) {
    if (quote.address === token) continue;
    if (quote === ASSET.ETH && token === ASSET.WETH.address) continue;
    if (!cfg.enableExtraQuotes && EXTRA_QUOTES.includes(quote)) continue;
    const [c0, c1] = BigInt(token) < BigInt(quote.address) ? [token, quote.address] : [quote.address, token];
    for (const [fee, tickSpacing] of V4_STANDARD_TIERS) push({ currency0: c0, currency1: c1, fee, tickSpacing, hooks: zeroAddress }, quote, false);
  }
  for (const k of cfg.v4ExtraKeys) {
    const other = k.currency0 === token ? k.currency1 : k.currency1 === token ? k.currency0 : null;
    const quote = other ? ASSET_BY_ADDR.get(other) : null;
    if (quote) push(k, quote, k.hooks !== zeroAddress);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Uniswap V4 Initialize-log discovery (hooked + non-standard-tier pools). Bounded lookback, chunked ranges,
// time budget, per-token memory cache. Only uses logs-capable endpoints (see v4LogDiscoveryUrls).
// ---------------------------------------------------------------------------
const v4DiscoveryCache = new Map(); // token -> { at, promise }
const topicAddr = (a) => '0x' + a.toLowerCase().slice(2).padStart(64, '0');

/** Decode Initialize logs into PoolKeys whose other currency is a supported quote asset. */
export function decodeV4InitializeLogs(logs, token) {
  const out = [];
  const seen = new Set();
  for (const log of logs ?? []) {
    try {
      const { args } = decodeEventLog({ abi: [EV.V4_INITIALIZE], data: log.data, topics: log.topics });
      const key = { currency0: lc(args.currency0), currency1: lc(args.currency1), fee: Number(args.fee), tickSpacing: Number(args.tickSpacing), hooks: lc(args.hooks) };
      const other = key.currency0 === token ? key.currency1 : key.currency1 === token ? key.currency0 : null;
      if (!other || !ASSET_BY_ADDR.has(other)) continue;
      const id = lc(args.id);
      if (seen.has(id) || v4PoolId(key) !== id) continue; // id must match the key (guards against bogus logs)
      seen.add(id);
      out.push({ ...key, block: log.blockNumber != null ? Number(BigInt(log.blockNumber)) : null });
    } catch {
      /* not an Initialize log */
    }
  }
  return out;
}

async function scanV4Initialize(token, cfg, client) {
  const head = await client.getBlockNumber({ cacheTime: 1000 });
  const toBlock = head - BigInt(cfg.headLagBlocks);
  const span = BigInt(cfg.v4DiscoveryLookback);
  const fromBlock = toBlock > span ? toBlock - span + 1n : 0n;
  const t = topicAddr(token);
  const jobs = [
    [TOPIC.V4_INITIALIZE, null, t], // token is currency0
    [TOPIC.V4_INITIALIZE, null, null, t], // token is currency1
  ];
  const res = await Promise.all(
    jobs.map((topics) => getLogsChunked(client, { address: ADDRESSES.UNISWAP_V4_POOL_MANAGER, topics, fromBlock, toBlock, chunk: cfg.v4DiscoveryChunk, concurrency: cfg.logConcurrency })),
  );
  const keys = decodeV4InitializeLogs(res.flatMap((r) => r.logs), token).sort((a, b) => (b.block ?? 0) - (a.block ?? 0));
  return {
    keys: keys.slice(0, cfg.v4DiscoveryMaxPools),
    coverage: Math.min(...res.map((r) => r.coverage)),
    fromBlock: Number(fromBlock),
    toBlock: Number(toBlock),
    failures: res.flatMap((r) => r.failures).slice(0, 3),
  };
}

/** Returns { status, keys, ... } within cfg.v4DiscoveryBudgetMs; a slow scan keeps running and warms the cache. */
async function discoverV4Keys(token, cfg) {
  if (!cfg.enableV4 || !cfg.v4LogDiscovery) return { status: 'disabled', keys: [] };
  const now = Date.now();
  let entry = v4DiscoveryCache.get(token);
  if (!entry || now - entry.at > cfg.v4DiscoveryCacheMs) {
    const client = getClient(cfg.v4LogDiscovery, cfg.rpcTimeoutMs + 2000, { jsonRpcBatch: false });
    entry = { at: now, promise: scanV4Initialize(token, cfg, client).then((r) => ({ status: r.coverage >= 1 ? 'ok' : 'partial', ...r }), (e) => ({ status: 'error', keys: [], error: String(e?.shortMessage || e?.message || e).slice(0, 160) })) };
    v4DiscoveryCache.set(token, entry);
    if (v4DiscoveryCache.size > 2000) v4DiscoveryCache.delete(v4DiscoveryCache.keys().next().value);
    entry.promise.then((r) => {
      if (r.status === 'error') v4DiscoveryCache.delete(token); // retry next call
    });
  }
  let timer;
  const budget = new Promise((resolve) => (timer = setTimeout(() => resolve({ status: 'budget_exceeded', keys: [] }), cfg.v4DiscoveryBudgetMs)));
  try {
    return await Promise.race([entry.promise, budget]);
  } finally {
    clearTimeout(timer);
  }
}

function stateCallsFor(p, baseAddr) {
  if (p.kind === 'v4') return []; // V4 state is read in round 1 through StateView (pool id known up front)
  const concentrated = p.kind === 'v3' || p.kind === 'cl';
  const abi = p.kind === 'cl' ? clPoolAbi : concentrated ? v3PoolAbi : v2PoolAbi;
  return [
    { address: p.address, abi, functionName: 'token0' },
    { address: baseAddr, abi: erc20Abi, functionName: 'balanceOf', args: [p.address] },
    { address: getAddress(p.quote.address), abi: erc20Abi, functionName: 'balanceOf', args: [p.address] },
    concentrated ? { address: p.address, abi, functionName: 'slot0' } : { address: p.address, abi, functionName: 'getReserves' },
    concentrated ? { address: p.address, abi, functionName: 'liquidity' } : { address: p.address, abi, functionName: 'totalSupply' },
  ];
}

const val = (r) => (r && r.status === 'success' ? r.result : null);

/** Decode pool state; price is `base` priced in `quote` (human units). */
function parseState(p, res, baseAddr, baseDecimals) {
  const base_ = lc(baseAddr);
  if (p.kind === 'v4') {
    const s0 = p.v4Slot0;
    const L = p.v4Liquidity;
    const baseIs0 = BigInt(base_) < BigInt(p.quote.address);
    const sqrtPriceX96 = s0 ? s0[0] : 0n;
    let priceInQuote = null;
    if (sqrtPriceX96 > 0n) {
      const raw = cl.sqrtX96ToFloat(sqrtPriceX96) ** 2;
      priceInQuote = (baseIs0 ? raw : 1 / raw) * 10 ** (baseDecimals - p.quote.decimals);
    }
    return { token0: baseIs0 ? base_ : p.quote.address, tokenIs0: baseIs0, tokenAmount: 0, quoteAmount: 0, priceInQuote, liquidity: L ?? null, sqrtPriceX96, tick: s0 ? Number(s0[1]) : null, totalSupply: null, stateOk: sqrtPriceX96 > 0n && L != null, hasBalances: false };
  }
  const token0 = lc(val(res[0]) ?? '');
  const baseBal = val(res[1]);
  const quoteBal = val(res[2]);
  const tokenIs0 = token0 === base_;
  let priceInQuote = null;
  let liquidity = null;
  let totalSupply = null;
  let sqrtPriceX96 = null;
  let tick = null;
  if (p.kind === 'v3' || p.kind === 'cl') {
    const s0 = val(res[3]);
    liquidity = val(res[4]);
    if (s0 && s0[0] > 0n) {
      sqrtPriceX96 = s0[0];
      tick = Number(s0[1]);
      const raw = cl.sqrtX96ToFloat(s0[0]) ** 2; // token1 per token0 (raw units)
      priceInQuote = (tokenIs0 ? raw : 1 / raw) * 10 ** (baseDecimals - p.quote.decimals);
    }
  } else {
    const r = val(res[3]);
    totalSupply = val(res[4]);
    if (r && p.kind !== 'aero_stable') {
      const rT = toFloat(tokenIs0 ? r[0] : r[1], baseDecimals);
      const rQ = toFloat(tokenIs0 ? r[1] : r[0], p.quote.decimals);
      if (rT > 0) priceInQuote = rQ / rT;
    }
  }
  return {
    token0,
    tokenIs0,
    tokenAmount: baseBal != null ? toFloat(baseBal, baseDecimals) : 0,
    quoteAmount: quoteBal != null ? toFloat(quoteBal, p.quote.decimals) : 0,
    priceInQuote,
    liquidity,
    sqrtPriceX96,
    tick,
    totalSupply,
    stateOk: token0 !== '' && baseBal != null && quoteBal != null,
    hasBalances: true,
  };
}

/**
 * Rounds 3+4: tick bitmaps around the current tick, then liquidityNet of the nearest initialized ticks.
 * Never throws; pools without tick data keep the provable tick-spacing bound.
 */
async function loadTickProfiles(client, pools, cfg, sig) {
  const targets = pools.filter((p) => isCL(p) && p.tick != null && p.tick_spacing && p.liquidity != null).slice(0, cfg.clMaxPools);
  const bitmapCall = (p, word) =>
    p.kind === 'v4'
      ? { address: ADDRESSES.UNISWAP_V4_STATE_VIEW, abi: stateViewAbi, functionName: 'getTickBitmap', args: [p.poolId, word] }
      : { address: p.address, abi: p.kind === 'cl' ? clPoolAbi : v3PoolAbi, functionName: 'tickBitmap', args: [word] };
  const netCall = (p, tick) =>
    p.kind === 'v4'
      ? { address: ADDRESSES.UNISWAP_V4_STATE_VIEW, abi: stateViewAbi, functionName: 'getTickLiquidity', args: [p.poolId, tick] }
      : { address: p.address, abi: p.kind === 'cl' ? clPoolAbi : v3PoolAbi, functionName: 'ticks', args: [tick] };
  const wordMaps = new Map();
  if (targets.length) {
    try {
      const calls = [];
      const idx = [];
      for (const p of targets) for (const w of cl.bitmapWordsFor(p.tick, p.tick_spacing)) {
        if (w < -32768 || w > 32767) continue;
        calls.push(bitmapCall(p, w));
        idx.push([p, w]);
      }
      const r3 = await client.multicall({ contracts: calls, allowFailure: true });
      if (sig?.aborted) throw sig.reason;
      r3.forEach((r, i) => {
        const [p, w] = idx[i];
        if (r.status !== 'success') return;
        if (!wordMaps.has(p)) wordMaps.set(p, new Map());
        wordMaps.get(p).set(w, r.result);
      });
    } catch {
      /* fall through: tick-spacing bound */
    }
  }
  const tickSets = new Map();
  for (const p of pools.filter(isCL)) {
    if (p.tick == null || !p.tick_spacing) continue;
    tickSets.set(p, cl.initializedTicks(wordMaps.get(p) ?? null, p.tick, p.tick_spacing));
  }
  const nets = new Map();
  const netCalls = [];
  const netIdx = [];
  for (const [p, t] of tickSets) {
    if (t.source !== 'tick_bitmap') continue;
    for (const tick of [...t.down.slice(0, cfg.clMaxTicks), ...t.up.slice(0, cfg.clMaxTicks)]) {
      netCalls.push(netCall(p, tick));
      netIdx.push([p, tick]);
    }
  }
  if (netCalls.length && !sig?.aborted) {
    try {
      const r4 = await client.multicall({ contracts: netCalls, allowFailure: true });
      r4.forEach((r, i) => {
        const [p, tick] = netIdx[i];
        if (r.status !== 'success') return;
        if (!nets.has(p)) nets.set(p, new Map());
        nets.get(p).set(tick, Number(r.result[1]));
      });
    } catch {
      /* unknown nets => profile ends at the first unresolved tick */
    }
  }
  for (const [p, t] of tickSets) {
    p.profile = cl.buildProfile({ sqrtP: cl.sqrtX96ToFloat(p.sqrtPriceX96), L: Number(p.liquidity), ticks: t, netByTick: nets.get(p) ?? new Map(), maxTicks: cfg.clMaxTicks });
  }
}

// ---------------------------------------------------------------------------
// Context: token metadata + pool discovery + pool state (2 multicall round trips + up to 2 for CL tick data)
// ---------------------------------------------------------------------------
async function buildContext(token, cfg, sig) {
  const tStart = Date.now();
  const client = getClient(cfg.rpcUrls, cfg.rpcTimeoutMs);
  // eth_getLogs goes un-batched: several public providers reject batched/multi-range log queries.
  const logsClient = getClient(cfg.logsRpcUrls, cfg.rpcTimeoutMs + 2000, { jsonRpcBatch: false });
  const tokenAddr = getAddress(token);
  const quoteSet = [...PRIMARY_QUOTES, ...(cfg.enableExtraQuotes ? EXTRA_QUOTES : [])];
  const quotes = quoteSet.filter((q) => q.address !== token);
  const isReferenceAsset = ASSET_BY_ADDR.has(token);
  // Intermediate assets (USDbC, cbBTC) need their own USD price and market depth for two-hop routes.
  const intermediates = cfg.enableExtraQuotes ? EXTRA_QUOTES.filter((q) => q.address !== token) : [];

  // Round 1: block number, bytecode, token metadata, pool discovery, ETH/USD + intermediate reference discovery,
  // and Uniswap V4 state (pool ids are computed off-chain, so slot0/liquidity are read directly).
  const disc = quotes.flatMap((q) => classicDiscovery(tokenAddr, q));
  const refDisc = [];
  for (const q of intermediates) {
    for (const other of PRIMARY_QUOTES) {
      for (const d of classicDiscovery(getAddress(q.address), other, { v3Fees: [100, 500, 3000], clSpacings: [1, 100], v2: false, aeroStable: q.stable && other.stable })) {
        refDisc.push({ ...d, meta: { ...d.meta, refFor: q } });
      }
    }
  }
  const v4 = v4Candidates(token, cfg);
  const v4DiscoveryPromise = discoverV4Keys(token, cfg); // runs alongside round 1
  const v4Calls = v4.flatMap((p) => [
    { address: ADDRESSES.UNISWAP_V4_STATE_VIEW, abi: stateViewAbi, functionName: 'getSlot0', args: [p.poolId] },
    { address: ADDRESSES.UNISWAP_V4_STATE_VIEW, abi: stateViewAbi, functionName: 'getLiquidity', args: [p.poolId] },
  ]);
  const ethRefCalls = [
    { address: ADDRESSES.UNISWAP_V3_FACTORY, abi: v3FactoryAbi, functionName: 'getPool', args: [ADDRESSES.WETH, ADDRESSES.USDC, 500] },
    { address: ADDRESSES.AERODROME_POOL_FACTORY, abi: aeroFactoryAbi, functionName: 'getPool', args: [ADDRESSES.WETH, ADDRESSES.USDC, false] },
  ];
  const tokenCalls = [
    { address: tokenAddr, abi: erc20Abi, functionName: 'decimals' },
    { address: tokenAddr, abi: erc20Abi, functionName: 'symbol' },
    { address: tokenAddr, abi: erc20Abi, functionName: 'name' },
    { address: tokenAddr, abi: erc20Abi, functionName: 'totalSupply' },
  ];
  const r1Calls = [...tokenCalls, ...ethRefCalls, ...disc.map((d) => d.call), ...refDisc.map((d) => d.call), ...v4Calls];

  const [blockNumber, code, r1] = await Promise.all([
    client.getBlockNumber({ cacheTime: 1000 }),
    client.getCode({ address: tokenAddr }),
    client.multicall({ contracts: r1Calls, allowFailure: true }),
  ]);
  if (sig?.aborted) throw sig.reason;

  const isContract = typeof code === 'string' && code !== '0x' && code.length > 2;
  const decimalsRaw = Number(val(r1[0]) ?? 18);
  const decimals = Number.isFinite(decimalsRaw) && decimalsRaw >= 0 && decimalsRaw <= 255 ? decimalsRaw : 18;
  const tokenMeta = {
    symbol: typeof val(r1[1]) === 'string' ? val(r1[1]).slice(0, 32) : null,
    name: typeof val(r1[2]) === 'string' ? val(r1[2]).slice(0, 64) : null,
    decimals,
    total_supply: val(r1[3]) != null ? toFloat(val(r1[3]), decimals) : null,
    is_contract: isContract,
    is_erc20: val(r1[0]) != null && val(r1[3]) != null,
  };
  const refV3 = val(r1[4]);
  const refAero = val(r1[5]);
  let off = 6;
  const collect = (list) => {
    const found = [];
    list.forEach((d, i) => {
      const addr = val(r1[off + i]);
      if (addr && lc(addr) !== zeroAddress && !found.some((f) => f.address === lc(addr))) found.push({ address: lc(addr), ...d.meta });
    });
    off += list.length;
    return found;
  };
  const discovered = collect(disc);
  const refPools = collect(refDisc);
  v4.forEach((p, i) => {
    p.v4Slot0 = val(r1[off + i * 2]);
    p.v4Liquidity = val(r1[off + i * 2 + 1]);
  });
  const v4Live = v4.filter((p) => p.v4Slot0 && p.v4Slot0[0] > 0n && p.v4Liquidity != null && p.v4Liquidity > 0n);

  // Round 1b: V4 pools found in Initialize logs that key guessing did not cover (hooked / custom tiers).
  const v4Disc = await v4DiscoveryPromise;
  const known = new Set(v4.map((p) => p.poolId));
  const v4Found = [];
  for (const k of v4Disc.keys ?? []) {
    const id = v4PoolId(k);
    if (known.has(id)) continue;
    known.add(id);
    const other = k.currency0 === token ? k.currency1 : k.currency0;
    v4Found.push({ address: id, poolId: id, dex: 'uniswap_v4', kind: 'v4', quote: ASSET_BY_ADDR.get(other), fee: k.fee, tick_spacing: k.tickSpacing, hooks: k.hooks, hooked: k.hooks !== zeroAddress, discovered_via: 'initialize_log' });
  }
  if (v4Found.length) {
    const r1b = await client.multicall({
      contracts: v4Found.flatMap((p) => [
        { address: ADDRESSES.UNISWAP_V4_STATE_VIEW, abi: stateViewAbi, functionName: 'getSlot0', args: [p.poolId] },
        { address: ADDRESSES.UNISWAP_V4_STATE_VIEW, abi: stateViewAbi, functionName: 'getLiquidity', args: [p.poolId] },
      ]),
      allowFailure: true,
    });
    v4Found.forEach((p, i) => {
      p.v4Slot0 = val(r1b[i * 2]);
      p.v4Liquidity = val(r1b[i * 2 + 1]);
      if (p.v4Slot0 && p.v4Slot0[0] > 0n && p.v4Liquidity != null && p.v4Liquidity > 0n) v4Live.push(p);
    });
  }
  if (sig?.aborted) throw sig.reason;

  // Round 2: pool state for discovered token pools, intermediate reference pools, ETH/USD reference pools.
  const stateCalls = [];
  const tokenIdx = discovered.map((p) => {
    const s = stateCalls.length;
    stateCalls.push(...stateCallsFor(p, tokenAddr));
    return s;
  });
  const refIdx = refPools.map((p) => {
    const s = stateCalls.length;
    stateCalls.push(...stateCallsFor(p, getAddress(p.refFor.address)));
    return s;
  });
  const refStart = stateCalls.length;
  if (refV3 && lc(refV3) !== zeroAddress) {
    stateCalls.push({ address: refV3, abi: v3PoolAbi, functionName: 'slot0' });
    stateCalls.push({ address: ADDRESSES.WETH, abi: erc20Abi, functionName: 'balanceOf', args: [refV3] });
    stateCalls.push({ address: ADDRESSES.USDC, abi: erc20Abi, functionName: 'balanceOf', args: [refV3] });
  }
  const refAeroStart = stateCalls.length;
  if (refAero && lc(refAero) !== zeroAddress) stateCalls.push({ address: refAero, abi: v2PoolAbi, functionName: 'getReserves' });
  const r2 = stateCalls.length ? await client.multicall({ contracts: stateCalls, allowFailure: true }) : [];
  if (sig?.aborted) throw sig.reason;

  // ETH/USD from Uniswap V3 WETH/USDC 0.05% (token0 = WETH since 0x42.. < 0x83..), fallback Aerodrome vAMM reserves.
  let ethUsd = null;
  const secondaryDepthUsd = { WETH: null, ETH: null, USDC: null, USDbC: null, cbBTC: null };
  if (refV3 && lc(refV3) !== zeroAddress) {
    const s0 = val(r2[refStart]);
    if (s0) {
      const px = cl.sqrtX96ToFloat(s0[0]) ** 2 * 10 ** (18 - 6);
      if (px > 10 && px < 1e6) ethUsd = px;
    }
    const wBal = val(r2[refStart + 1]);
    const uBal = val(r2[refStart + 2]);
    if (ethUsd && wBal != null && uBal != null) secondaryDepthUsd.WETH = toFloat(wBal, 18) * ethUsd + toFloat(uBal, 6);
  }
  if (refAero && lc(refAero) !== zeroAddress) {
    const res = val(r2[refAeroStart]);
    if (res) {
      const w = toFloat(res[0], 18);
      const u = toFloat(res[1], 6);
      if (!ethUsd && w > 0) ethUsd = u / w;
      if (ethUsd) secondaryDepthUsd.WETH = (secondaryDepthUsd.WETH ?? 0) + w * ethUsd + u;
    }
  }
  secondaryDepthUsd.ETH = secondaryDepthUsd.WETH;
  const primaryUsd = (q) => (q.stable && q.symbol === 'USDC' ? 1 : q.group === 'ETH' ? ethUsd : null);

  // Intermediate USD prices + market depth from their own USDC/WETH pools (deepest priced pool sets the price).
  const intermediateUsd = {};
  for (const q of intermediates) {
    const rows = refPools
      .map((p, i) => ({ p, s: parseState(p, r2.slice(refIdx[i], refIdx[i] + 5), q.address, q.decimals) }))
      .filter(({ p, s }) => p.refFor === q && s.stateOk && primaryUsd(p.quote) != null);
    let best = null;
    let depth = 0;
    for (const { p, s } of rows) {
      const oUsd = primaryUsd(p.quote);
      const otherSide = s.quoteAmount * oUsd;
      if (s.priceInQuote != null && s.priceInQuote > 0 && (!best || otherSide > best.otherSide)) best = { px: s.priceInQuote * oUsd, otherSide };
      depth += otherSide;
    }
    let px = best?.px ?? null;
    if (px != null && q.stable && (px < 0.8 || px > 1.2)) px = null; // depegged/manipulated reference => unpriced
    intermediateUsd[q.symbol] = px;
    if (px != null) {
      for (const { s } of rows) depth += s.tokenAmount * px;
      secondaryDepthUsd[q.symbol] = depth;
    }
  }
  const quoteUsd = (q) => primaryUsd(q) ?? intermediateUsd[q.symbol] ?? null;

  const raw = [
    ...discovered.map((p, i) => ({ ...p, hooks: null, hooked: false, ...parseState(p, r2.slice(tokenIdx[i], tokenIdx[i] + 5), tokenAddr, decimals) })),
    ...v4Live.map((p) => ({ ...p, ...parseState(p, null, tokenAddr, decimals) })),
  ].filter((p) => p.stateOk);

  // Preliminary ranking for tick scans: real quote balance for classic pools, CP-equivalent virtual reserve for V4.
  for (const p of raw) {
    const qUsd = quoteUsd(p.quote);
    p.quoteUsd = qUsd;
    if (p.hasBalances) p.rankUsd = qUsd != null ? p.quoteAmount * qUsd : 0;
    else {
      const s = cl.sqrtX96ToFloat(p.sqrtPriceX96);
      const L = Number(p.liquidity);
      const vQuote = p.tokenIs0 ? L * s : L / s;
      p.rankUsd = qUsd != null ? (vQuote / 10 ** p.quote.decimals) * qUsd : 0;
    }
  }
  raw.sort((a, b) => b.rankUsd - a.rankUsd);
  let tickScan = 'skipped_budget';
  if (Date.now() - tStart < cfg.contextTickBudgetMs && raw.some(isCL)) {
    await loadTickProfiles(client, raw, cfg, sig);
    tickScan = 'ok';
  } else {
    // No budget left: every CL pool still gets the provable tick-spacing bound.
    for (const p of raw.filter((x) => isCL(x) && x.tick != null && x.tick_spacing)) {
      p.profile = cl.buildProfile({ sqrtP: cl.sqrtX96ToFloat(p.sqrtPriceX96), L: Number(p.liquidity), ticks: cl.initializedTicks(null, p.tick, p.tick_spacing), maxTicks: cfg.clMaxTicks });
    }
    if (!raw.some(isCL)) tickScan = 'no_cl_pools';
  }
  if (sig?.aborted) throw sig.reason;

  // Window amounts (tokens actually held by in-range liquidity inside the known tick window).
  for (const p of raw) {
    if (!p.profile) continue;
    const w = cl.windowAmounts(p.profile);
    const amt0 = w.token0Above;
    const amt1 = w.token1Below;
    const tokRaw = p.tokenIs0 ? amt0 : amt1;
    const qRaw = p.tokenIs0 ? amt1 : amt0;
    p.window = { tokenAmount: tokRaw / 10 ** decimals, quoteAmount: qRaw / 10 ** p.quote.decimals };
  }
  for (const p of raw) {
    const qUsd = p.quoteUsd;
    if (!p.hasBalances) {
      p.tokenAmount = p.window?.tokenAmount ?? 0;
      p.quoteAmount = p.window?.quoteAmount ?? 0;
    }
    p.quoteSideUsd = qUsd != null ? p.quoteAmount * qUsd : 0;
    p.priceUsd = p.priceInQuote != null && qUsd != null && Number.isFinite(p.priceInQuote) ? p.priceInQuote * qUsd : null;
  }

  // Reference USD price = price in the pool with the deepest quote side (manipulation-resistant vs thin pools).
  let tokenUsd = null;
  if (token === ASSET.USDC.address) tokenUsd = 1;
  else if (token === ASSET.WETH.address) tokenUsd = ethUsd;
  else {
    const priced = raw.filter((p) => p.priceUsd != null && p.priceUsd > 0 && p.kind !== 'aero_stable').sort((a, b) => b.quoteSideUsd - a.quoteSideUsd);
    tokenUsd = priced[0]?.priceUsd ?? null;
  }
  for (const p of raw) {
    p.depthUsd = p.quoteSideUsd + (tokenUsd != null ? p.tokenAmount * tokenUsd : p.quoteSideUsd);
    p.windowDepthUsd = p.window && p.quoteUsd != null ? p.window.quoteAmount * p.quoteUsd + (tokenUsd != null ? p.window.tokenAmount * tokenUsd : 0) : null;
  }
  raw.sort((a, b) => b.depthUsd - a.depthUsd);

  // Dust filter: drop pools below DUST_POOL_USD as long as at least one real pool remains.
  const nonDust = raw.filter((p) => p.depthUsd >= cfg.dustPoolUsd);
  const pools = nonDust.length ? nonDust : raw;
  const dustIgnored = raw.length - pools.length;

  // Shared, memoized log fetch (used by mempool fallback + JIT).
  let logsPromise = null;
  const ctx = {
    token,
    tokenAddr,
    cfg,
    client,
    logsClient,
    blockNumber,
    tokenMeta,
    isReferenceAsset,
    ethUsd,
    tokenUsd,
    quoteUsd,
    intermediateUsd,
    secondaryDepthUsd,
    pools,
    dustIgnored,
    tickScan,
    coverage: {
      venues: ['uniswap_v2', 'uniswap_v3', ...(cfg.enableV4 ? ['uniswap_v4'] : []), 'aerodrome_volatile', 'aerodrome_stable', 'aerodrome_slipstream'],
      quote_assets: dedupe([...quotes.map((q) => q.symbol), ...(cfg.enableV4 && token !== ASSET.WETH.address ? ['ETH'] : [])]),
      v4_discovery: cfg.enableV4
        ? ['hookless_standard_tiers', ...(cfg.v4ExtraKeys.length ? ['configured_keys'] : []), ...(cfg.v4LogDiscovery ? ['initialize_logs'] : [])].join('+').replace(/^hookless_standard_tiers$/, 'hookless_standard_tiers_only')
        : 'disabled',
      v4_candidates_checked: v4.length + v4Found.length,
      v4_pools_live: v4Live.length,
      v4_log_discovery: {
        status: v4Disc.status,
        pools_found: v4Disc.keys?.length ?? 0,
        new_pools_checked: v4Found.length,
        ...(v4Disc.fromBlock != null ? { from_block: v4Disc.fromBlock, to_block: v4Disc.toBlock, coverage: round(v4Disc.coverage, 3) } : {}),
      },
    },
    poolByAddr: new Map(pools.map((p) => [p.address, p])),
    getLogs: (s) => (logsPromise ??= fetchPoolLogs(ctx, s)),
  };
  return ctx;
}

// ---------------------------------------------------------------------------
// Bounded, chunked, adaptive eth_getLogs
// ---------------------------------------------------------------------------
async function getLogsChunked(client, { address, topics, fromBlock, toBlock, chunk, concurrency, sig }) {
  const ranges = [];
  for (let start = fromBlock; start <= toBlock; start += BigInt(chunk)) {
    const end = start + BigInt(chunk) - 1n > toBlock ? toBlock : start + BigInt(chunk) - 1n;
    ranges.push([start, end]);
  }
  let covered = 0n;
  const failures = [];
  const fetchRange = async ([a, b], depth = 0) => {
    if (sig?.aborted) return [];
    try {
      const logs = await client.request({
        method: 'eth_getLogs',
        params: [{ address, topics, fromBlock: toHex(a), toBlock: toHex(b) }],
      });
      covered += b - a + 1n;
      return Array.isArray(logs) ? logs : [];
    } catch (err) {
      // Too many results / range too large => split; give up after a few levels.
      if (depth < 3 && b > a) {
        const mid = a + (b - a) / 2n;
        const [l, r] = await Promise.all([fetchRange([a, mid], depth + 1), fetchRange([mid + 1n, b], depth + 1)]);
        return [...l, ...r];
      }
      failures.push(String(err?.details || err?.shortMessage || err?.message || err).slice(0, 160));
      return [];
    }
  };
  const parts = await mapLimit(ranges, concurrency, (r) => fetchRange(r));
  const total = toBlock - fromBlock + 1n;
  return { logs: parts.flat(), coverage: total > 0n ? Number(covered) / Number(total) : 0, failures };
}

const emptyLogs = () => ({ swaps: [], v3Mints: [], v3Burns: [], v2Mints: [], v2Burns: [], lpMints: [], coverage: 0, failures: [], fromBlock: null, toBlock: null, poolsScanned: 0 });

async function fetchPoolLogs(ctx, sig) {
  const { pools, cfg, blockNumber, logsClient } = ctx;
  if (!pools.length) return emptyLogs();
  const toBlock = blockNumber - BigInt(cfg.headLagBlocks);
  const fromBlock = toBlock - BigInt(cfg.logBlockRange) + 1n;
  const scanned = pools.slice(0, cfg.logMaxPools); // pools are sorted by depth
  const groups = (list) => {
    const out = [];
    for (let i = 0; i < list.length; i += cfg.logAddressBatch) out.push(list.slice(i, i + cfg.logAddressBatch));
    return out;
  };
  const classic = scanned.filter((p) => p.kind !== 'v4');
  const v4Ids = scanned.filter((p) => p.kind === 'v4').map((p) => p.poolId);
  const jobs = [
    ...groups(classic.map((p) => p.address)).map((address) => ({ address, topics: [POOL_EVENT_TOPICS] })),
    ...groups(classic.filter((p) => !isCL(p)).map((p) => p.address)).map((address) => ({ address, topics: [TOPIC.TRANSFER, ZERO_TOPIC] })),
    // V4: every pool lives in the PoolManager; filter by indexed pool id (topic1).
    ...groups(v4Ids).map((ids) => ({ address: ADDRESSES.UNISWAP_V4_POOL_MANAGER, topics: [V4_EVENT_TOPICS, ids] })),
  ];
  const results = await Promise.all(
    jobs.map((j) => getLogsChunked(logsClient, { ...j, fromBlock, toBlock, chunk: cfg.logChunkSize, concurrency: cfg.logConcurrency, sig })),
  );
  const out = decodePoolLogs(ctx, results.flatMap((r) => r.logs));
  out.fromBlock = Number(fromBlock);
  out.toBlock = Number(toBlock);
  out.poolsScanned = scanned.length;
  out.coverage = results.length ? Math.min(...results.map((r) => r.coverage)) : 0;
  out.failures = results.flatMap((r) => r.failures).slice(0, 5);
  return out;
}

/** Decode raw logs into normalized swap / liquidity events (exported for offline replay tests). */
function decodePoolLogs(ctx, rawLogs) {
  const out = emptyLogs();
  const pm = lc(ADDRESSES.UNISWAP_V4_POOL_MANAGER);
  for (const log of rawLogs) {
    const ev = TOPIC_TO_EVENT.get(log.topics?.[0]);
    if (!ev) continue;
    const isV4 = lc(log.address) === pm;
    if (isV4 !== ev.key.startsWith('V4_')) continue;
    const pool = ctx.poolByAddr.get(isV4 ? lc(log.topics?.[1] ?? '') : lc(log.address));
    if (!pool) continue;
    let args;
    try {
      args = decodeEventLog({ abi: [ev.item], data: log.data, topics: log.topics, strict: true }).args;
    } catch {
      continue;
    }
    const base_ = { pool: pool.address, block: Number(BigInt(log.blockNumber)), logIndex: Number(BigInt(log.logIndex)), tx: lc(log.transactionHash) };
    switch (ev.key) {
      case 'V3_SWAP': {
        const tAmt = pool.tokenIs0 ? args.amount0 : args.amount1;
        const qAmt = pool.tokenIs0 ? args.amount1 : args.amount0;
        out.swaps.push({ ...base_, dir: tAmt < 0n ? 'buy' : 'sell', sender: lc(args.sender), recipient: lc(args.recipient), quoteAbs: Math.abs(toFloat(qAmt, pool.quote.decimals)) });
        break;
      }
      case 'V4_SWAP': {
        // Swapper-perspective deltas: positive token delta => swapper received the token => buy.
        const tAmt = pool.tokenIs0 ? args.amount0 : args.amount1;
        const qAmt = pool.tokenIs0 ? args.amount1 : args.amount0;
        out.swaps.push({ ...base_, dir: tAmt > 0n ? 'buy' : 'sell', sender: lc(args.sender), recipient: lc(args.sender), quoteAbs: Math.abs(toFloat(qAmt, pool.quote.decimals)) });
        break;
      }
      case 'V2_SWAP':
      case 'AERO_SWAP': {
        const tOut = pool.tokenIs0 ? args.amount0Out : args.amount1Out;
        const qIn = pool.tokenIs0 ? args.amount1In : args.amount0In;
        const qOut = pool.tokenIs0 ? args.amount1Out : args.amount0Out;
        out.swaps.push({ ...base_, dir: tOut > 0n ? 'buy' : 'sell', sender: lc(args.sender), recipient: lc(args.to), quoteAbs: toFloat(qIn > 0n ? qIn : qOut, pool.quote.decimals) });
        break;
      }
      case 'V3_MINT':
        out.v3Mints.push({ ...base_, owner: lc(args.owner), salt: null, tickLower: args.tickLower, tickUpper: args.tickUpper, amount: args.amount });
        break;
      case 'V3_BURN':
        if (args.amount > 0n) out.v3Burns.push({ ...base_, owner: lc(args.owner), salt: null, tickLower: args.tickLower, tickUpper: args.tickUpper, amount: args.amount });
        break;
      case 'V4_MODIFY': {
        // Positions are keyed by (sender, ticks, salt); PositionManager uses salt = tokenId. delta == 0 is a fee poke.
        const d = args.liquidityDelta;
        const row = { ...base_, owner: lc(args.sender), salt: lc(args.salt), tickLower: args.tickLower, tickUpper: args.tickUpper };
        if (d > 0n) out.v3Mints.push({ ...row, amount: d });
        else if (d < 0n) out.v3Burns.push({ ...row, amount: -d });
        break;
      }
      case 'V2_MINT':
        out.v2Mints.push({ ...base_, sender: lc(args.sender) });
        break;
      case 'V2_BURN':
      case 'AERO_BURN':
        out.v2Burns.push({ ...base_, to: lc(args.to) });
        break;
      case 'TRANSFER':
        if (lc(args.to) !== zeroAddress && args.value > 0n) out.lpMints.push({ ...base_, provider: lc(args.to), value: args.value });
        break;
      default:
        break;
    }
  }
  const byPos = (a, b) => a.block - b.block || a.logIndex - b.logIndex;
  for (const k of ['swaps', 'v3Mints', 'v3Burns', 'v2Mints', 'v2Burns', 'lpMints']) out[k].sort(byPos);
  out.coverage = 1;
  return out;
}

// ---------------------------------------------------------------------------
// Model 1: Mempool front-running attack surface
// ---------------------------------------------------------------------------
async function probePendingQueue(ctx, sig) {
  const { client, cfg } = ctx;
  const attempts = [];
  // a) txpool_content (full pending pool on self-hosted nodes)
  try {
    const pool = await client.request({ method: 'txpool_content', params: [] });
    const txs = [];
    for (const byNonce of Object.values(pool?.pending ?? {})) for (const tx of Object.values(byNonce ?? {})) txs.push(tx);
    attempts.push({ method: 'txpool_content', ok: true, txs: txs.length });
    if (txs.length) return { method: 'txpool_content', txs: txs.slice(0, 5000), attempts };
  } catch (e) {
    attempts.push({ method: 'txpool_content', ok: false });
  }
  if (sig?.aborted) return { method: null, txs: [], attempts };
  // b) pending block (only meaningful if it is genuinely ahead of the head and unsealed)
  try {
    const blk = await client.request({ method: 'eth_getBlockByNumber', params: ['pending', true] });
    // Non-sequencer OP-stack nodes answer 'pending' with the sealed head block (hash set) => not a mempool view.
    const isRealPending = blk && Array.isArray(blk.transactions) && blk.hash == null;
    attempts.push({ method: 'eth_getBlockByNumber(pending)', ok: true, real_pending: Boolean(isRealPending) });
    if (isRealPending && blk.transactions.length) return { method: 'pending_block', txs: blk.transactions, attempts };
  } catch {
    attempts.push({ method: 'eth_getBlockByNumber(pending)', ok: false });
  }
  if (sig?.aborted) return { method: null, txs: [], attempts };
  // c) pending tx filter sampled for a short window
  let filterId = null;
  try {
    filterId = await client.request({ method: 'eth_newPendingTransactionFilter', params: [] });
    await sleep(cfg.pendingSampleMs, sig);
    const hashes = await client.request({ method: 'eth_getFilterChanges', params: [filterId] });
    attempts.push({ method: 'eth_newPendingTransactionFilter', ok: true, hashes: Array.isArray(hashes) ? hashes.length : 0 });
    if (Array.isArray(hashes) && hashes.length) {
      const sample = hashes.filter((h) => typeof h === 'string').slice(0, cfg.maxTxLookups);
      const txs = (await Promise.allSettled(sample.map((hash) => client.request({ method: 'eth_getTransactionByHash', params: [hash] }))))
        .map((r) => (r.status === 'fulfilled' ? r.value : null))
        .filter((t) => t && t.blockNumber == null);
      if (txs.length) return { method: 'pending_filter', txs, attempts };
    }
  } catch {
    attempts.push({ method: 'eth_newPendingTransactionFilter', ok: false });
  } finally {
    if (filterId) client.request({ method: 'eth_uninstallFilter', params: [filterId] }).catch(() => {});
  }
  return { method: null, txs: [], attempts };
}

function analyzePending(ctx, txs) {
  const { token, poolByAddr, cfg } = ctx;
  const tokenNeedle = token.slice(2);
  const fees = [];
  const relevant = [];
  for (const tx of txs) {
    const tip = tx.maxPriorityFeePerGas != null ? BigInt(tx.maxPriorityFeePerGas) : tx.gasPrice != null ? BigInt(tx.gasPrice) : 0n;
    fees.push(tip);
    const to = lc(tx.to ?? '');
    const input = lc(tx.input ?? '');
    if (poolByAddr.has(to) || to === token || input.includes(tokenNeedle)) relevant.push({ from: lc(tx.from), to, tip, direct: poolByAddr.has(to) });
  }
  fees.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const medianTip = fees.length ? fees[Math.floor(fees.length / 2)] : 0n;
  const senderCount = new Map();
  for (const r of relevant) senderCount.set(r.from, (senderCount.get(r.from) ?? 0) + 1);
  const bots = new Set();
  let flagged = 0;
  for (const r of relevant) {
    const isBot = cfg.mevBots.has(r.from) || cfg.mevBots.has(r.to) || r.direct || (medianTip > 0n && r.tip > medianTip * 5n) || (senderCount.get(r.from) ?? 0) >= 2;
    if (isBot) {
      flagged++;
      bots.add(r.from);
    }
  }
  return {
    sampled: txs.length,
    relevant: relevant.length,
    flagged,
    toxicity: relevant.length ? (flagged / relevant.length) * 100 : 0,
    bots: [...bots].slice(0, 10),
  };
}

async function analyzeRecentSwaps(ctx, logs, sig) {
  const { cfg } = ctx;
  const swaps = logs.swaps;
  const actorOf = (s) => (!cfg.routers.has(s.sender) ? s.sender : !cfg.routers.has(s.recipient) ? s.recipient : null);
  for (const s of swaps) s.actor = actorOf(s);

  const groups = new Map();
  for (const s of swaps) {
    const k = `${s.block}:${s.pool}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }

  const detect = (group) => {
    const hits = [];
    for (let i = 0; i < group.length; i++) {
      const a = group[i];
      if (!a.actor) continue;
      for (let k = i + 2; k < group.length; k++) {
        const c = group[k];
        if (c.actor !== a.actor || c.dir === a.dir || c.tx === a.tx) continue;
        const victims = group.slice(i + 1, k).filter((v) => v.dir === a.dir && v.actor !== a.actor && v.tx !== a.tx && v.tx !== c.tx);
        if (victims.length) hits.push({ front: a, back: c, victims });
        break;
      }
    }
    return hits;
  };

  let sandwiches = [];
  const unresolved = [];
  for (const g of groups.values()) {
    if (g.length < 3) continue;
    const found = detect(g);
    if (found.length) sandwiches.push(...found);
    else if (g.some((s) => !s.actor)) unresolved.push(g);
  }

  // Resolve router-mediated swaps to tx.from (bounded, batched) and re-scan those groups.
  let lookups = 0;
  if (unresolved.length && cfg.maxTxLookups > 0 && !sig?.aborted) {
    const hashes = dedupe(unresolved.flat().map((s) => s.tx)).slice(0, cfg.maxTxLookups);
    lookups = hashes.length;
    const res = await mapLimit(hashes, 8, (h) =>
      sig?.aborted ? null : ctx.logsClient.request({ method: 'eth_getTransactionByHash', params: [h] }).catch(() => null),
    );
    const fromByTx = new Map();
    res.forEach((tx, i) => tx?.from && fromByTx.set(hashes[i], lc(tx.from)));
    for (const g of unresolved) {
      for (const s of g) if (!s.actor && fromByTx.has(s.tx)) s.actor = fromByTx.get(s.tx);
      sandwiches.push(...detect(g));
    }
  }

  // High-frequency two-sided actors (heuristic searcher signature) + configured known bots.
  const perActor = new Map();
  for (const s of swaps) {
    if (!s.actor) continue;
    const e = perActor.get(s.actor) ?? { n: 0, buy: 0, sell: 0 };
    e.n++;
    e[s.dir]++;
    perActor.set(s.actor, e);
  }
  const hfMin = Math.max(6, Math.ceil(swaps.length * 0.15));
  const heuristicBots = [...perActor.entries()].filter(([, e]) => e.n >= hfMin && e.buy > 0 && e.sell > 0).map(([a]) => a);
  const knownBots = [...perActor.keys()].filter((a) => cfg.mevBots.has(a));
  // Weighted toxicity: confirmed sandwich legs/victims and configured bots count fully; heuristic searcher flow
  // (often arbitrage/backrunning that does not hurt takers) counts as 35% attack surface.
  const confirmed = new Set([...knownBots, ...sandwiches.map((s) => s.front.actor)]);
  const heur = new Set(heuristicBots);
  const toxic = new Set();
  for (const sw of sandwiches) {
    toxic.add(sw.front);
    toxic.add(sw.back);
    sw.victims.forEach((v) => toxic.add(v));
  }
  let heuristicFlow = 0;
  for (const s of swaps) {
    if (toxic.has(s)) continue;
    if (s.actor && confirmed.has(s.actor)) toxic.add(s);
    else if (s.actor && heur.has(s.actor)) heuristicFlow++;
  }

  const victimSwaps = sandwiches.reduce((n, s) => n + s.victims.length, 0);
  const victimVolumeUsd = sandwiches.reduce((n, s) => n + s.victims.reduce((m, v) => m + swapUsd(ctx, v), 0), 0);
  return {
    swaps: swaps.length,
    sandwiches: sandwiches.length,
    victimSwaps,
    victimVolumeUsd,
    toxicity: swaps.length ? ((toxic.size + heuristicFlow * 0.35) / swaps.length) * 100 : 0,
    searcherFlowPct: swaps.length ? (heuristicFlow / swaps.length) * 100 : 0,
    heuristicBots: heuristicBots.slice(0, 10),
    knownBots: knownBots.slice(0, 10),
    lookups,
  };
}

async function checkMempool(ctx, sig) {
  const signals = [];
  const [pending, logs] = await Promise.all([probePendingQueue(ctx, sig), ctx.getLogs(sig)]);
  const recent = await analyzeRecentSwaps(ctx, logs, sig);
  const pend = pending.txs.length ? analyzePending(ctx, pending.txs) : null;

  const usingPending = Boolean(pend && pend.sampled > 0);
  const toxicity = usingPending ? Math.max(pend.toxicity, recent.toxicity) : recent.toxicity;

  if (!usingPending) {
    signals.push(signal('PRIVATE_MEMPOOL', 'info', 'Base sequencer mempool is private; public RPC exposed no pending transactions. Scored from recent-block forensics (sandwiches, searcher activity) instead.'));
  }
  if (recent.sandwiches > 0) {
    signals.push(signal('SANDWICH_DETECTED', recent.sandwiches >= 3 ? 'critical' : 'warn', `${recent.sandwiches} sandwich pattern(s) hit ${recent.victimSwaps} victim swap(s) in the last ${ctx.cfg.logBlockRange} blocks.`));
  }
  if (recent.knownBots.length) signals.push(signal('KNOWN_MEV_BOT_ACTIVE', 'critical', `Configured MEV bot(s) trading this token: ${recent.knownBots.slice(0, 3).join(', ')}.`));
  if (recent.heuristicBots.length) signals.push(signal('SEARCHER_ACTIVITY', 'warn', `${recent.heuristicBots.length} high-frequency two-sided actor(s) dominate swap flow.`));
  if (pend && pend.flagged) signals.push(signal('PENDING_BOT_TARGETING', 'critical', `${pend.flagged}/${pend.relevant} pending tx(s) touching this token look like searcher flow.`));
  if (toxicity >= 40) signals.push(signal('HIGH_EXECUTION_TOXICITY', 'critical', `Execution toxicity ${round(toxicity, 1)}%.`));
  if (logs.coverage < 1) signals.push(signal('PARTIAL_LOG_COVERAGE', 'info', `Only ${round(logs.coverage * 100, 0)}% of the block window was readable from RPC.`));

  const score = clamp(Math.round(toxicity * 1.2 + Math.min(35, recent.sandwiches * 7) + (recent.knownBots.length ? 10 : 0) + (pend?.flagged ? 10 : 0)));
  const hasData = usingPending || (ctx.pools.length > 0 && logs.coverage > 0);
  let confidence = usingPending ? 0.85 : recent.swaps >= 25 ? 0.6 : recent.swaps >= 5 ? 0.45 : 0.25;
  if (!usingPending) confidence *= Math.max(0.2, logs.coverage);
  if (!hasData) {
    signals.push(signal('NO_FLOW_DATA', 'warn', ctx.pools.length ? 'Swap logs unavailable from RPC.' : 'No known DEX pools to analyze.'));
    confidence = 0.1;
  }
  return {
    score: hasData ? score : 50,
    confidence: round(confidence, 2),
    data_available: hasData,
    data_source: usingPending ? 'pending' : hasData ? 'recent_blocks_fallback' : 'unavailable',
    metrics: {
      execution_toxicity_pct: round(toxicity, 2),
      pending_probe: pending.attempts,
      pending_txs_sampled: pend?.sampled ?? 0,
      pending_relevant_txs: pend?.relevant ?? 0,
      pending_flagged_txs: pend?.flagged ?? 0,
      blocks_analyzed: logs.fromBlock != null ? logs.toBlock - logs.fromBlock + 1 : 0,
      log_coverage_pct: round(logs.coverage * 100, 1),
      log_errors: logs.failures,
      swaps_analyzed: recent.swaps,
      searcher_flow_share_pct: round(recent.searcherFlowPct, 2),
      sandwiches_detected: recent.sandwiches,
      sandwich_victim_swaps: recent.victimSwaps,
      sandwich_victim_volume_usd: round(recent.victimVolumeUsd, 2),
      suspected_mev_bots: dedupe([...recent.knownBots, ...recent.heuristicBots, ...(pend?.bots ?? [])]).slice(0, 10),
      tx_sender_lookups: recent.lookups,
    },
    signals,
  };
}

function swapUsd(ctx, swap) {
  const q = ctx.poolByAddr.get(swap.pool)?.quote;
  if (!q) return 0;
  const px = typeof ctx.quoteUsd === 'function' ? ctx.quoteUsd(q) : q.stable ? 1 : q.group === 'ETH' || q.symbol === 'WETH' ? ctx.ethUsd : null;
  return swap.quoteAbs * (px ?? 0);
}

// ---------------------------------------------------------------------------
// Model 2: JIT (just-in-time) vampire liquidity
// ---------------------------------------------------------------------------
async function checkJit(ctx, sig) {
  const signals = [];
  const { cfg, pools } = ctx;
  if (!pools.length) {
    return { score: 50, confidence: 0.1, data_available: false, data_source: 'unavailable', metrics: { pools_analyzed: 0 }, signals: [signal('NO_POOLS', 'warn', 'No Uniswap V2/V3/V4 or Aerodrome (basic/Slipstream) pools against WETH/ETH/USDC/USDbC/cbBTC found.')] };
  }
  const logs = await ctx.getLogs(sig);
  const K = cfg.jitWindowBlocks;
  const after = (a, b) => b.block > a.block || (b.block === a.block && b.logIndex > a.logIndex);
  const cycles = [];
  let totalMintShare = 0;

  // V3/Slipstream/V4: same owner (+ V4 salt) + identical tick range, burned (>=90% of minted liquidity) within K blocks.
  const posKey = (e) => `${e.pool}|${e.owner}|${e.salt ?? ''}|${e.tickLower}|${e.tickUpper}`;
  const burnsByKey = new Map();
  for (const b of logs.v3Burns) {
    const k = posKey(b);
    if (!burnsByKey.has(k)) burnsByKey.set(k, []);
    burnsByKey.get(k).push(b);
  }
  for (const m of logs.v3Mints) {
    const pool = ctx.poolByAddr.get(m.pool);
    const L = pool?.liquidity && pool.liquidity > 0n ? pool.liquidity : null;
    const share = L ? Number(m.amount) / (Number(L) + Number(m.amount)) : 0;
    totalMintShare += share;
    const cand = burnsByKey.get(posKey(m)) ?? [];
    const idx = cand.findIndex((b) => !b.used && after(m, b) && b.block - m.block <= K && b.amount * 10n >= m.amount * 9n);
    if (idx >= 0) {
      const b = cand[idx];
      b.used = true;
      cycles.push({ pool: m.pool, provider: m.salt ? `${m.owner}#${m.salt.slice(0, 18)}` : m.owner, mint: m, burn: b, share, sameBlock: b.block === m.block });
    }
  }

  // V2/Aerodrome: LP tokens minted to provider, then Burn(to = provider) within K blocks.
  const burnsByTo = new Map();
  for (const b of logs.v2Burns) {
    const k = `${b.pool}|${b.to}`;
    if (!burnsByTo.has(k)) burnsByTo.set(k, []);
    burnsByTo.get(k).push(b);
  }
  for (const m of logs.lpMints) {
    const pool = ctx.poolByAddr.get(m.pool);
    const ts = pool?.totalSupply && pool.totalSupply > 0n ? pool.totalSupply : null;
    const share = ts ? Number(m.value) / (Number(ts) + Number(m.value)) : 0;
    totalMintShare += share;
    const cand = burnsByTo.get(`${m.pool}|${m.provider}`) ?? [];
    const idx = cand.findIndex((b) => !b.used && after(m, b) && b.block - m.block <= K);
    if (idx >= 0) {
      const b = cand[idx];
      b.used = true;
      cycles.push({ pool: m.pool, provider: m.provider, mint: m, burn: b, share, sameBlock: b.block === m.block });
    }
  }

  // Swaps executed against the transient liquidity (bracketed by mint..burn in same pool).
  const swapsByPool = new Map();
  for (const s of logs.swaps) {
    if (!swapsByPool.has(s.pool)) swapsByPool.set(s.pool, []);
    swapsByPool.get(s.pool).push(s);
  }
  let bracketed = 0;
  for (const c of cycles) {
    const list = swapsByPool.get(c.pool) ?? [];
    c.bracketed = list.filter((s) => after(c.mint, s) && after(s, c.burn)).length;
    bracketed += c.bracketed;
  }

  const large = cycles.filter((c) => c.share >= cfg.jitMinShare);
  const sameBlock = cycles.filter((c) => c.sameBlock).length;
  const jitShare = totalMintShare > 0 ? (cycles.reduce((n, c) => n + c.share, 0) / totalMintShare) * 100 : 0;
  const providers = new Map();
  for (const c of large) providers.set(c.provider, (providers.get(c.provider) ?? 0) + 1);
  const prone = (large.length > 0 && bracketed > 0) || jitShare >= 25;
  const affectedPools = dedupe(large.map((c) => c.pool));

  if (large.length) signals.push(signal('JIT_CYCLES', large.length >= 3 ? 'critical' : 'warn', `${large.length} large add->remove liquidity cycle(s) within ${K} blocks (>= ${round(cfg.jitMinShare * 100, 1)}% of pool liquidity).`));
  if (sameBlock) signals.push(signal('SAME_BLOCK_JIT', 'warn', `${sameBlock} liquidity position(s) added and removed in the same block.`));
  if (prone) signals.push(signal('PHANTOM_DEPTH', 'critical', 'Quoted depth is partly transient: JIT liquidity appears around swaps and leaves immediately, so pre-trade quotes overstate resting depth.'));
  if (logs.coverage < 1) signals.push(signal('PARTIAL_LOG_COVERAGE', 'info', `Only ${round(logs.coverage * 100, 0)}% of the block window was readable from RPC.`));

  const events = logs.v3Mints.length + logs.v3Burns.length + logs.lpMints.length + logs.v2Burns.length;
  const hasData = logs.coverage > 0;
  const mintCount = logs.v3Mints.length + logs.lpMints.length;
  const sampleWeight = Math.min(1, mintCount / 5); // a single mint should not read as "100% JIT"
  const score = clamp(Math.round(large.length * 12 + sameBlock * 15 + (bracketed > 0 ? 15 : 0) + jitShare * 0.6 * sampleWeight));
  const confidence = hasData ? (events >= 10 ? 0.7 : 0.5) * Math.max(0.2, logs.coverage) : 0.1;
  return {
    score: hasData ? score : 50,
    confidence: round(confidence, 2),
    data_available: hasData,
    data_source: hasData ? 'onchain_logs' : 'unavailable',
    metrics: {
      pools_analyzed: pools.length,
      pools_log_scanned: logs.poolsScanned ?? 0,
      v4_pools_scanned: pools.slice(0, cfg.logMaxPools).filter((p) => p.kind === 'v4').length,
      blocks_analyzed: logs.fromBlock != null ? logs.toBlock - logs.fromBlock + 1 : 0,
      log_coverage_pct: round(logs.coverage * 100, 1),
      liquidity_events_analyzed: events,
      jit_window_blocks: K,
      jit_cycles: cycles.length,
      large_jit_cycles: large.length,
      same_block_cycles: sameBlock,
      swaps_bracketed_by_jit: bracketed,
      jit_liquidity_share_pct: round(jitShare, 2),
      prone_to_slippage_extraction: prone,
      top_jit_providers: [...providers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, cycles_]) => {
        const [address, v4Salt] = id.split('#');
        return v4Salt ? { address, v4_position_salt_prefix: v4Salt, cycles: cycles_ } : { address, cycles: cycles_ };
      }),
      affected_pools: affectedPools.slice(0, 10),
    },
    signals,
  };
}

// ---------------------------------------------------------------------------
// Model 3: Cross-pair liquidity cascade (CL tick-walk aware, multi-hop aware)
// ---------------------------------------------------------------------------
/**
 * Impact of selling `usd` worth of the token into one pool.
 *  - CL pools (V3 / Slipstream / V4): exact in-range swap simulation over the known tick window (clMath.simulateSwap).
 *    If the trade runs past the window, V3/Slipstream fall back to constant-product on the pool's remaining balances;
 *    V4 (no per-pool balances) reports the unfilled remainder.
 *  - Constant-product pools (V2 / Aerodrome basic): x*y=k on USD depth.
 *  - Two-hop routes (USDbC, cbBTC quotes): the proceeds are sold again into that asset's USDC/WETH market.
 * `scale` shrinks liquidity (shock / LP flight) for pools in the shocked asset group.
 */
function simulatePool(ctx, p, usd, scale, leg2Scale = scale) {
  let impact;
  let filled = 1;
  let crossed = 0;
  let exhausted = false;
  let fallbackUsed = false;
  if (p.profile && ctx.tokenUsd > 0) {
    const amountRaw = (usd / ctx.tokenUsd) * 10 ** ctx.tokenMeta.decimals;
    const r = cl.simulateSwap(p.profile, amountRaw, p.tokenIs0, scale);
    impact = r.impact;
    crossed = r.crossed;
    if (r.exhausted) {
      exhausted = true;
      const unfilledUsd = usd * (1 - r.filledFraction);
      const residual = p.hasBalances ? Math.max(0, p.depthUsd - (p.windowDepthUsd ?? 0)) * scale : 0;
      if (residual > 0) {
        fallbackUsed = true;
        impact = 1 - (1 - impact) * (1 - cl.cpImpact(residual, unfilledUsd));
      } else {
        filled = r.filledFraction;
      }
    }
  } else {
    impact = cl.cpImpact(p.depthUsd * scale, usd);
  }
  let leg2Depth = null;
  let leg2Unpriced = false;
  if (p.quote.hop) {
    leg2Depth = ctx.secondaryDepthUsd[p.quote.symbol];
    if (!(leg2Depth > 0)) {
      leg2Unpriced = true;
      leg2Depth = p.depthUsd; // unknown second leg: assume it is no deeper than the first (conservative)
    }
    impact = 1 - (1 - impact) * (1 - cl.cpImpact(leg2Depth * leg2Scale, usd * filled));
  }
  return { impact: Math.min(1, Math.max(0, impact)), filled, crossed, exhausted, fallbackUsed, leg2Depth, leg2Unpriced };
}

/**
 * Route a `sizeUsd` sell across all pools. Two-pass allocation: (1) proportional to each pool's small-probe
 * CP-equivalent depth, (2) re-weighted by the CP-equivalent depth implied by pass-1 impacts (so pools whose tick
 * window is exhausted receive less flow). Returns the allocation-weighted impact; unfillable flow counts as 100%.
 */
function routeTrade(ctx, sizeUsd, shock) {
  const pools = ctx.pools;
  const scaleOf = (p) => (shock && p.quote.group === shock.group ? 1 - shock.S : 1);
  const BIG = 1e15;
  const probe = Math.max(1, sizeUsd * 0.01);
  let weights = pools.map((p) => Math.min(BIG, cl.cpDepthFromImpact(simulatePool(ctx, p, probe, scaleOf(p)).impact, probe)));
  let results = null;
  let alloc = null;
  for (let pass = 0; pass < 2; pass++) {
    const wsum = weights.reduce((a, b) => a + b, 0);
    if (!(wsum > 0)) return { impact: 1, unfilledPct: 100, effectiveDepthUsd: 0, maxCrossed: 0, exhaustedPools: pools.map((p) => p.address), fallbackPools: [], perPool: [], leg2Unpriced: false };
    alloc = weights.map((w) => (sizeUsd * w) / wsum);
    results = pools.map((p, i) => simulatePool(ctx, p, alloc[i], scaleOf(p)));
    weights = results.map((r, i) => Math.min(BIG, cl.cpDepthFromImpact(r.impact, alloc[i]) * r.filled));
  }
  let impactAcc = 0;
  let unfilled = 0;
  results.forEach((r, i) => {
    impactAcc += alloc[i] * (r.filled * r.impact + (1 - r.filled));
    unfilled += alloc[i] * (1 - r.filled);
  });
  const perPool = pools
    .map((p, i) => ({ p, r: results[i], a: alloc[i] }))
    .sort((x, y) => y.a - x.a)
    .slice(0, 6)
    .map(({ p, r, a }) => ({
      pool: p.address,
      dex: p.dex,
      quote_symbol: p.quote.symbol,
      model: p.profile ? 'concentrated_liquidity' : 'constant_product',
      tick_data: p.profile ? p.profile.source : null,
      allocated_usd: round(a, 2),
      impact_pct: round(r.impact * 100, 3),
      ticks_crossed: r.crossed,
      window_exhausted: r.exhausted,
      residual_balance_fallback: r.fallbackUsed,
      filled_pct: round(r.filled * 100, 2),
      hops: p.quote.hop ? 2 : 1,
    }));
  return {
    impact: Math.min(1, impactAcc / sizeUsd),
    unfilledPct: (unfilled / sizeUsd) * 100,
    effectiveDepthUsd: weights.reduce((a, b) => a + (Number.isFinite(b) && b < BIG ? b : 0), 0),
    maxCrossed: Math.max(0, ...results.map((r) => r.crossed)),
    exhaustedPools: pools.filter((_, i) => results[i].exhausted && !results[i].fallbackUsed && alloc[i] > 0).map((p) => p.address),
    fallbackPools: pools.filter((_, i) => results[i].fallbackUsed).map((p) => p.address),
    perPool,
    leg2Unpriced: results.some((r, i) => r.leg2Unpriced && alloc[i] > sizeUsd * 0.05),
  };
}

async function checkCascade(ctx) {
  const { pools, cfg, tokenUsd, secondaryDepthUsd, isReferenceAsset } = ctx;
  const signals = [];
  if (!pools.length) {
    signals.push(signal('NO_LIQUIDITY_FOUND', 'critical', 'No Uniswap V2/V3/V4 or Aerodrome (basic/Slipstream) liquidity against WETH/ETH/USDC/USDbC/cbBTC; exits may be impossible or routed through unknown venues.'));
    return { score: 95, confidence: 0.6, data_available: true, data_source: 'onchain_state', metrics: { pools_found: 0, total_depth_usd: 0, coverage: ctx.coverage, graph: { nodes: [ctx.token], edges: [] } }, signals };
  }
  const total = pools.reduce((n, p) => n + p.depthUsd, 0);
  const shares = pools.map((p) => (total > 0 ? p.depthUsd / total : 0));
  const hhi = shares.reduce((n, s) => n + s * s, 0);
  const byQuote = {};
  pools.forEach((p) => (byQuote[p.quote.symbol] = (byQuote[p.quote.symbol] ?? 0) + p.depthUsd));
  const largest = pools[0];
  const shockedQuote = largest.quote;
  const groupDepth = pools.filter((p) => p.quote.group === shockedQuote.group).reduce((n, p) => n + p.depthUsd, 0);
  const groupShare = total > 0 ? groupDepth / total : 0;
  const S = cfg.shockPct / 100;
  const size = cfg.referenceTradeUsd;

  // Shock: the secondary asset (group) of the largest pair suffers an S% liquidation.
  //  - every pool quoted in that asset loses S% of its liquidity (CL: L scaled; CP: depth scaled; hop leg too);
  //  - if the asset is volatile (ETH, cbBTC), the token is re-marked by S% in those pools and arbitrage spreads the
  //    move depth-weighted across the graph (market beta, unavoidable but real for USD-denominated agents);
  //  - a reference-size sell then executes against the shrunken liquidity (CL tick walk / CP curve / two-hop route).
  const repricing = isReferenceAsset || shockedQuote.stable ? 0 : S * groupShare;
  const pre = routeTrade(ctx, size, null);
  const post = routeTrade(ctx, size, { group: shockedQuote.group, S });
  const impact = post.impact;
  const projectedDrop = 1 - (1 - repricing) * (1 - impact);
  const remaining = pools.reduce((n, p) => n + p.depthUsd * (p.quote.group === shockedQuote.group ? 1 - S : 1), 0);
  const collapse = projectedDrop >= 0.4 || impact >= 0.15 || remaining < size * 5 || post.unfilledPct >= 20;
  const secondary = shockedQuote.stable ? null : secondaryDepthUsd[shockedQuote.symbol];
  const backingRatio = secondary ? groupDepth / secondary : null;

  // Multi-hop exposure: depth that can only reach USDC/WETH through an intermediate asset.
  const hopDepth = pools.filter((p) => p.quote.hop).reduce((n, p) => n + p.depthUsd, 0);
  const hopShare = total > 0 ? hopDepth / total : 0;
  const hooked = pools.filter((p) => p.hooked);
  const hookedShare = total > 0 ? hooked.reduce((n, p) => n + p.depthUsd, 0) / total : 0;
  const clShare = total > 0 ? pools.filter(isCL).reduce((n, p) => n + p.depthUsd, 0) / total : 0;
  const largestTickData = largest.profile ? largest.profile.source : null;

  // Score rubric (documented in README): liquidity-driven impact weighted fully (x2.5), beta repricing at 0.6 so a
  // WETH pairing alone cannot reach DANGER, plus structural penalties.
  let score = impact * 100 * 2.5 + repricing * 100 * 0.6;
  if (hhi > 0.85) score += 8;
  if (total < 50_000) score += 20;
  else if (total < 250_000) score += 10;
  else if (total < 1_000_000) score += 4;
  if (!isReferenceAsset && backingRatio != null && backingRatio > 0.5) score += 10;
  if (hopShare >= 0.5) score += 8;
  else if (hopShare >= 0.2) score += 3;
  if (post.unfilledPct > 0) score += post.unfilledPct >= 20 ? 15 : 8;
  if (hookedShare >= 0.5) score += 5;
  score = clamp(Math.round(score));

  const sym = ctx.tokenMeta.symbol ?? 'TOKEN';
  if (collapse) signals.push(signal('SYSTEMIC_COLLAPSE_RISK', 'critical', `A ${cfg.shockPct}% liquidation in ${largest.dex} ${sym}/${shockedQuote.symbol} projects a ${round(projectedDrop * 100, 1)}% price collapse.`));
  else if (projectedDrop >= 0.15) signals.push(signal('CASCADE_SENSITIVE', 'warn', `Projected ${round(projectedDrop * 100, 1)}% drawdown under a ${cfg.shockPct}% secondary-pair shock.`));
  if (hhi > 0.85) signals.push(signal('LIQUIDITY_CONCENTRATED', 'warn', `${round(shares[0] * 100, 1)}% of depth sits in one pool (HHI ${round(hhi, 2)}).`));
  if (total < 250_000) signals.push(signal('THIN_LIQUIDITY', total < 50_000 ? 'critical' : 'warn', `Total on-chain depth ~$${Math.round(total).toLocaleString('en-US')}.`));
  if (post.unfilledPct > 0) {
    signals.push(signal('CL_LIQUIDITY_EXHAUSTED', post.unfilledPct >= 20 ? 'critical' : 'warn', `After the shock, ${round(post.unfilledPct, 1)}% of a $${size.toLocaleString('en-US')} sell runs past the known in-range liquidity of ${post.exhaustedPools.length} CL pool(s).`));
  } else if (post.maxCrossed > 0 || post.fallbackPools.length) {
    const parts = [];
    if (post.maxCrossed > 0) parts.push(`crosses up to ${post.maxCrossed} initialized tick(s) in one pool`);
    if (post.fallbackPools.length) parts.push(`runs past the scanned tick window in ${post.fallbackPools.length} pool(s), priced there from remaining balances`);
    signals.push(signal('CL_TICK_WALK', 'info', `Post-shock reference sell ${parts.join('; ')}.`));
  }
  if (hopShare > 0) {
    const via = dedupe(pools.filter((p) => p.quote.hop).map((p) => p.quote.symbol)).join('/');
    signals.push(signal(hopShare >= 0.5 ? 'MULTI_HOP_ROUTE' : 'ROUTED_VIA_INTERMEDIATE', hopShare >= 0.5 ? 'warn' : 'info', `${round(hopShare * 100, 1)}% of depth is quoted in ${via}; exits need a second hop into USDC/WETH.`));
  }
  if (post.leg2Unpriced) signals.push(signal('HOP_LEG_UNPRICED', 'warn', 'Second-hop market depth for an intermediate asset could not be read; assumed no deeper than the first leg.'));
  if (hooked.length) signals.push(signal('V4_HOOKED_POOL', 'warn', `${hooked.length} configured Uniswap V4 pool(s) use hooks (${round(hookedShare * 100, 1)}% of depth); hook logic can change fees/deltas and is not modeled.`));
  if (largest.profile && largestTickData !== 'tick_bitmap') signals.push(signal('CL_TICK_DATA_LIMITED', 'info', 'Tick bitmap for the deepest CL pool was not read; impact uses the provable current tick-spacing range (conservative).'));
  if (tokenUsd == null) signals.push(signal('PRICE_UNRESOLVED', 'warn', 'Could not derive a USD price; depth measured on the quote side only.'));
  if (isReferenceAsset) signals.push(signal('REFERENCE_ASSET', 'info', 'Token is a Base quote/reference asset (WETH/USDC/USDbC/cbBTC); price is anchored externally, repricing shock not applied.'));

  let confidence = tokenUsd != null ? 0.75 : 0.45;
  if (largest.profile && largestTickData !== 'tick_bitmap') confidence -= 0.1;
  if (post.leg2Unpriced) confidence -= 0.1;
  if (hookedShare >= 0.5) confidence -= 0.15;

  const routes = Object.values(
    pools.reduce((acc, p) => {
      const k = p.quote.symbol;
      acc[k] ??= {
        quote_symbol: k,
        hops: p.quote.hop ? 2 : 1,
        path: p.quote.hop ? [sym, k, 'USDC|WETH'] : [sym, k],
        depth_usd: 0,
        second_leg_depth_usd: p.quote.hop ? (secondaryDepthUsd[k] != null ? round(secondaryDepthUsd[k], 2) : null) : null,
        pools: 0,
      };
      acc[k].depth_usd = round(acc[k].depth_usd + p.depthUsd, 2);
      acc[k].pools++;
      return acc;
    }, {}),
  );
  const graph = {
    nodes: dedupe([ctx.token, ...pools.map((p) => p.quote.address), ...(hopShare > 0 ? [ASSET.USDC.address, ASSET.WETH.address] : [])]),
    edges: pools.slice(0, 12).map((p, i) => ({
      pool: p.address,
      dex: p.dex,
      fee: p.fee,
      tick_spacing: p.tick_spacing ?? null,
      hooks: p.hooks ?? null,
      from: ctx.token,
      to: p.quote.address,
      quote_symbol: p.quote.symbol,
      hops: p.quote.hop ? 2 : 1,
      depth_usd: round(p.depthUsd, 2),
      in_range_window_depth_usd: p.windowDepthUsd != null ? round(p.windowDepthUsd, 2) : null,
      share_pct: round(shares[i] * 100, 2),
    })),
  };
  return {
    score,
    confidence: round(Math.max(0.1, confidence), 2),
    data_available: true,
    data_source: 'onchain_state',
    metrics: {
      pools_found: pools.length,
      dust_pools_ignored: ctx.dustIgnored ?? 0,
      total_depth_usd: round(total, 2),
      depth_by_quote_usd: Object.fromEntries(Object.entries(byQuote).map(([k, v]) => [k, round(v, 2)])),
      concentration_hhi: round(hhi, 4),
      concentrated_liquidity_share_pct: round(clShare * 100, 2),
      largest_pool: largest.address,
      largest_pool_tick_data: largestTickData,
      tick_scan: ctx.tickScan,
      shock_pct: cfg.shockPct,
      shocked_secondary_asset: shockedQuote.symbol,
      secondary_asset_depth_usd: secondary != null ? round(secondary, 2) : null,
      backing_ratio: backingRatio != null ? round(backingRatio, 4) : null,
      repricing_pct: round(repricing * 100, 2),
      post_shock_trade_impact_pct: round(impact * 100, 3),
      post_shock_depth_usd: round(remaining, 2),
      post_shock_unfilled_pct: round(post.unfilledPct, 2),
      post_shock_max_ticks_crossed: post.maxCrossed,
      post_shock_exhausted_pools: post.exhaustedPools.slice(0, 10),
      projected_price_drop_pct: round(projectedDrop * 100, 2),
      reference_trade_usd: size,
      reference_trade_impact_pct: round(pre.impact * 100, 3),
      effective_cp_depth_usd: round(pre.effectiveDepthUsd, 2),
      multi_hop_depth_share_pct: round(hopShare * 100, 2),
      hooked_pool_depth_share_pct: round(hookedShare * 100, 2),
      intermediate_prices_usd: Object.fromEntries(Object.entries(ctx.intermediateUsd ?? {}).map(([k, v]) => [k, v != null ? Number(v.toPrecision(8)) : null])),
      systemic_collapse: collapse,
      routes,
      impact_breakdown: post.perPool,
      coverage: ctx.coverage,
      graph,
    },
    signals,
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
function unavailableModel(reason, ms) {
  return {
    score: 50,
    status: 'WARN',
    confidence: 0,
    data_available: false,
    data_source: 'unavailable',
    latency_ms: ms,
    metrics: {},
    signals: [signal(reason.code, 'warn', reason.message)],
  };
}

async function runModel(name, fn, ctx, cfg, parentSignal) {
  const t0 = Date.now();
  try {
    const r = await withTimeout((s) => fn(ctx, s), cfg.checkTimeoutMs, name, parentSignal);
    return { ...r, status: statusFromScore(r.score), latency_ms: Date.now() - t0 };
  } catch (err) {
    const isTimeout = err?.name === 'TimeoutError';
    return unavailableModel(
      { code: isTimeout ? 'CHECK_TIMEOUT' : 'CHECK_FAILED', message: isTimeout ? `${name} exceeded ${cfg.checkTimeoutMs}ms` : `${name} failed: ${String(err?.shortMessage || err?.message || err).slice(0, 200)}` },
      Date.now() - t0,
    );
  }
}

function combine(matrix, cfg) {
  let wsum = 0;
  let acc = 0;
  let csum = 0;
  for (const [k, m] of Object.entries(matrix)) {
    const w = (cfg.weights[k] ?? 0) * (m.data_available ? Math.max(0.2, m.confidence) : 0.05);
    acc += m.score * w;
    wsum += w;
    csum += (cfg.weights[k] ?? 0) * m.confidence;
  }
  const wTotal = Object.values(cfg.weights).reduce((a, b) => a + b, 0) || 1;
  const riskScore = wsum > 0 ? Math.round(acc / wsum) : 50;
  const confidence = round(csum / wTotal, 2);
  let status = statusFromScore(riskScore);
  const escalated = Object.values(matrix).some((m) => m.score >= THRESHOLDS.MODEL_ESCALATION && m.confidence >= 0.5);
  if (escalated) status = 'DANGER';
  const lowConfidence = status === 'SAFE' && confidence < THRESHOLDS.LOW_CONFIDENCE;
  if (lowConfidence) status = 'WARN';
  // Critical-signal floor: a well-evidenced critical finding (e.g. repeated sandwiches, phantom depth, thin
  // liquidity, CL exhaustion) can never be blended away into SAFE by two quiet models.
  const criticalFloor = Object.values(matrix).some((m) => m.data_available && m.confidence >= THRESHOLDS.CRITICAL_FLOOR_CONFIDENCE && (m.signals ?? []).some((s) => s.severity === 'critical'));
  if (status === 'SAFE' && criticalFloor) status = 'WARN';
  return { riskScore: clamp(riskScore), status, confidence, escalated, criticalFloor, lowConfidence };
}

const SEVERITY_RANK = { critical: 0, warn: 1, info: 2 };
const REASON_INFO_CODES = new Set(['PRIVATE_MEMPOOL', 'CL_TICK_WALK', 'ROUTED_VIA_INTERMEDIATE', 'CL_TICK_DATA_LIMITED']);

/** Human-readable reasons behind the status (critical first), capped at 8 entries. */
function reasons(status, matrix, combined = {}) {
  const out = [];
  if (combined.escalated) out.push('ESCALATED: a single model scored >= 85 with confidence >= 0.5.');
  if (combined.lowConfidence) out.push(`LOW_CONFIDENCE: overall confidence ${combined.confidence} < ${THRESHOLDS.LOW_CONFIDENCE}; a SAFE-range score is held at WARN.`);
  if (combined.criticalFloor && status === 'WARN') out.push('FLOOR: a critical signal with confidence >= 0.5 keeps this at least WARN.');
  const rows = [];
  for (const [model, m] of Object.entries(matrix)) {
    for (const s of m.signals ?? []) {
      if (s.severity === 'info' && !REASON_INFO_CODES.has(s.code)) continue;
      rows.push({ model, s });
    }
  }
  rows.sort((a, b) => SEVERITY_RANK[a.s.severity] - SEVERITY_RANK[b.s.severity]);
  for (const { model, s } of rows) out.push(`${s.severity.toUpperCase()} ${s.code} (${model}): ${s.message}`.slice(0, 300));
  if (!out.length) out.push(`${status}: no material signals across the three models.`);
  return dedupe(out).slice(0, 8);
}

function recommendation(status, matrix, combined) {
  const cm = matrix.cross_pair_cascade.metrics ?? {};
  return {
    action: status === 'SAFE' ? 'PROCEED' : status === 'WARN' ? 'PROCEED_WITH_LIMITS' : 'ABORT',
    max_slippage_bps: status === 'SAFE' ? 50 : status === 'WARN' ? 100 : 0,
    split_order: matrix.cross_pair_cascade.score >= 50 || matrix.mempool_front_running.score >= 50 || (cm.post_shock_unfilled_pct ?? 0) > 0 || (cm.multi_hop_depth_share_pct ?? 0) >= 50,
    use_private_order_flow: matrix.mempool_front_running.score >= 35,
    avoid_pools: matrix.jit_liquidity_vampire.metrics?.affected_pools ?? [],
    reasons: reasons(status, matrix, combined),
  };
}

function baseResult(token, t0) {
  return {
    tool: TOOL_NAME,
    version: ENGINE_VERSION,
    chain_id: CHAIN_ID,
    token_address: token,
    cached: false,
    cache_source: 'none',
    cache_age_seconds: 0,
    ttl_seconds: CACHE_TTL_SECONDS,
    checked_at: new Date().toISOString(),
    latency_ms: Date.now() - t0,
    errors: [],
  };
}

function fatalResult(token, t0, code, message, extra = {}) {
  const m = () => ({ ...unavailableModel({ code, message }, 0), score: 100, status: 'DANGER' });
  const risk_matrix = { mempool_front_running: m(), jit_liquidity_vampire: m(), cross_pair_cascade: m() };
  return {
    ...baseResult(lc(token ?? ''), t0),
    status: 'DANGER',
    risk_score: 100,
    confidence: 1,
    block_number: null,
    token: null,
    pools: [],
    risk_matrix,
    recommendation: { action: 'ABORT', max_slippage_bps: 0, split_order: false, use_private_order_flow: false, avoid_pools: [], reasons: [`CRITICAL ${code}: ${message}`.slice(0, 300)] },
    errors: [{ code, message }],
    ...extra,
  };
}

/**
 * Analyze a Base token. Never throws: every failure path returns a schema-valid result.
 * @param {string} tokenAddress 0x-prefixed 20-byte hex address
 * @param {{rpcUrl?: string, timeoutMs?: number, checkTimeoutMs?: number, signal?: AbortSignal}} [options]
 */
export async function analyzeTokenSafety(tokenAddress, options = {}) {
  const t0 = Date.now();
  const token = normalizeTokenAddress(tokenAddress);
  if (!token) return fatalResult(String(tokenAddress ?? ''), t0, 'INVALID_TOKEN_ADDRESS', 'token_address must match ^0x[a-fA-F0-9]{40}$');
  const cfg = loadConfig(options);

  let ctx;
  try {
    ctx = await withTimeout((s) => buildContext(token, cfg, s), Math.min(cfg.checkTimeoutMs, cfg.engineTimeoutMs), 'context', options.signal);
  } catch (err) {
    const r = fatalResult(token, t0, 'RPC_UNAVAILABLE', `Could not read Base state: ${String(err?.shortMessage || err?.message || err).slice(0, 200)}`);
    return { ...r, status: 'WARN', risk_score: 50, confidence: 0, risk_matrix: Object.fromEntries(Object.entries(r.risk_matrix).map(([k, v]) => [k, { ...v, score: 50, status: 'WARN' }])), recommendation: { ...r.recommendation, action: 'PROCEED_WITH_LIMITS', max_slippage_bps: 50, reasons: ['WARN RPC_UNAVAILABLE: Base state could not be read; degraded result (score 50, never SAFE). Retry shortly.'] } };
  }

  if (!ctx.tokenMeta.is_contract) {
    return fatalResult(token, t0, 'NOT_A_CONTRACT', 'No bytecode at token_address on Base; not a token.', { block_number: Number(ctx.blockNumber) });
  }

  const remaining = Math.max(500, cfg.engineTimeoutMs - (Date.now() - t0));
  const modelCfg = { ...cfg, checkTimeoutMs: Math.min(cfg.checkTimeoutMs, remaining) };
  const [mempool, jit, cascade] = await Promise.all([
    runModel('mempool_front_running', checkMempool, ctx, modelCfg, options.signal),
    runModel('jit_liquidity_vampire', checkJit, ctx, modelCfg, options.signal),
    runModel('cross_pair_cascade', checkCascade, ctx, modelCfg, options.signal),
  ]);
  const risk_matrix = { mempool_front_running: mempool, jit_liquidity_vampire: jit, cross_pair_cascade: cascade };
  const combined = combine(risk_matrix, cfg);
  const { riskScore, status, confidence } = combined;
  const errors = [];
  if (!ctx.tokenMeta.is_erc20) errors.push({ code: 'NON_STANDARD_ERC20', message: 'decimals()/totalSupply() did not respond like an ERC-20.' });

  return {
    ...baseResult(token, t0),
    status,
    risk_score: riskScore,
    confidence,
    block_number: Number(ctx.blockNumber),
    token: {
      symbol: ctx.tokenMeta.symbol,
      name: ctx.tokenMeta.name,
      decimals: ctx.tokenMeta.decimals,
      price_usd: ctx.tokenUsd != null ? Number(ctx.tokenUsd.toPrecision(8)) : null,
      is_contract: ctx.tokenMeta.is_contract,
    },
    pools: ctx.pools.slice(0, 12).map((p) => ({ address: p.address, dex: p.dex, quote: p.quote.symbol, fee: p.fee, tick_spacing: p.tick_spacing ?? null, depth_usd: round(p.depthUsd, 2), hooks: p.hooks ?? null, hops: p.quote.hop ? 2 : 1 })),
    risk_matrix,
    recommendation: recommendation(status, risk_matrix, combined),
    latency_ms: Date.now() - t0,
    errors,
  };
}

// Pure model functions, exported for unit tests and offline replay of captured logs.
export const _models = { analyzeRecentSwaps, checkJit, checkCascade, analyzePending, decodePoolLogs, routeTrade, simulatePool, combine, recommendation, EV, TOPIC, ASSET };
