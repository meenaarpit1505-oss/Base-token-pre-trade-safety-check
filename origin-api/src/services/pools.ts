import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import {
  AERO,
  DAI,
  QUOTE_TOKENS,
  USDC,
  WETH_USDC_POOL,
  BURN_ADDRESSES,
  LP_LOCKERS,
  sameAddress,
  type QuoteToken,
} from "../domain/addresses.js";
import { humanAmount, priceToken0InToken1, roundPct, roundUsd } from "../domain/math.js";
import type { DexId, PoolKind } from "../types.js";
import { aggregate, decodeString, decodeWord, type BaseClient } from "./rpc.js";
import { clLockFloors, PANCAKE_V3_NPM, UNI_V3_NPM, type ClPoolLockInput } from "./lpLocks.js";

const clPoolExtraAbi = [
  { type: "function", name: "liquidity", stateMutability: "view", inputs: [], outputs: [{ type: "uint128" }] },
  { type: "function", name: "nft", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

const AERO_FACTORY = getAddress("0x420DD381b31aEf6683db6B902084cB0FFECe40Da");
const AERO_ROUTER = getAddress("0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43");
const UNI_V3_FACTORY = getAddress("0x33128a8fC17869897dcE68Ed026d694621f6FDfD");
const PANCAKE_V3_FACTORY = getAddress("0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865");
const SLIPSTREAM_FACTORIES = [
  getAddress("0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A"),
  getAddress("0xaDe65c38CD4849aDBA595a4323a8C7DdfE89716a"),
  getAddress("0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef"),
] as const;
const BASESWAP_FACTORY = getAddress("0xFDa619b6d20975be80A10332cD39b9a4b0FAa8BB");
const BASESWAP_ROUTER = getAddress("0x327Df1E6de05895d2ab08513aaDD9313Fe505d86");
const SUSHI_FACTORY = getAddress("0x71524B4f93c58fcbF659783284E38825f0622859");
const SUSHI_ROUTER = getAddress("0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891");

const ZERO = "0x0000000000000000000000000000000000000000";
const UNI_FEES = [100, 500, 3000, 10_000] as const;
const PANCAKE_FEES = [100, 500, 2500, 10_000] as const;
const TICK_SPACINGS = [1, 50, 100, 200, 2000] as const;

const pairAbi = [
  {
    type: "function",
    name: "getPair",
    stateMutability: "view",
    inputs: [
      { name: "a", type: "address" },
      { name: "b", type: "address" },
    ],
    outputs: [{ type: "address" }],
  },
] as const;

const v3FactoryAbi = [
  {
    type: "function",
    name: "getPool",
    stateMutability: "view",
    inputs: [
      { name: "a", type: "address" },
      { name: "b", type: "address" },
      { name: "fee", type: "uint24" },
    ],
    outputs: [{ type: "address" }],
  },
] as const;

const aeroFactoryAbi = [
  {
    type: "function",
    name: "getPool",
    stateMutability: "view",
    inputs: [
      { name: "a", type: "address" },
      { name: "b", type: "address" },
      { name: "stable", type: "bool" },
    ],
    outputs: [{ type: "address" }],
  },
] as const;

const clFactoryAbi = [
  {
    type: "function",
    name: "getPool",
    stateMutability: "view",
    inputs: [
      { name: "a", type: "address" },
      { name: "b", type: "address" },
      { name: "tickSpacing", type: "int24" },
    ],
    outputs: [{ type: "address" }],
  },
] as const;

const erc20Abi = [
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const reservesAbi = [
  {
    type: "function",
    name: "getReserves",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
    ],
  },
] as const;

const slot0Abi = [
  {
    type: "function",
    name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "sqrtPriceX96", type: "uint160" }],
  },
] as const;

export interface PricedPool {
  address: Address;
  dex: DexId;
  kind: PoolKind;
  quote: QuoteToken;
  router: Address;
  factory: Address;
  stable: boolean | null;
  feeBps: number | null;
  tickSpacing: number | null;
  quoteBalance: bigint;
  liquidityUsd: number | null;
  lpLockedPct: number | null;
  /** True when lpLockedPct is a lower bound (CL position NFTs: burned or known-locker positions only). */
  lpLockFloor: boolean;
}

export interface Market {
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  ethUsd: number | null;
  pools: PricedPool[];
  best: PricedPool | null;
}

interface Candidate {
  dex: DexId;
  kind: PoolKind;
  quote: QuoteToken;
  router: Address;
  factory: Address;
  stable: boolean | null;
  feeBps: number | null;
  tickSpacing: number | null;
  oracle: boolean;
  /** Set on oracle candidates: the asset whose USD price this pool measures. */
  priced?: Address;
}

interface FoundPool extends Candidate {
  address: Address;
}

function call(target: Address, data: Hex): { target: Address; data: Hex } {
  return { target, data };
}

function addressResult(data: Hex): Address | null {
  const value = decodeWord(data, "address");
  if (typeof value !== "string" || sameAddress(value, ZERO)) return null;
  return getAddress(value);
}

function buildCandidates(token: Address): Candidate[] {
  const quotes = QUOTE_TOKENS.filter((quote) => !sameAddress(quote.address, token));
  const candidates: Candidate[] = [];
  for (const quote of quotes) {
    for (const stable of [false, true]) {
      candidates.push({
        dex: "aerodrome",
        kind: "aero",
        quote,
        router: AERO_ROUTER,
        factory: AERO_FACTORY,
        stable,
        feeBps: null,
        tickSpacing: null,
        oracle: false,
      });
    }
    for (const fee of UNI_FEES) {
      candidates.push({
        dex: "uniswap-v3",
        kind: "cl",
        quote,
        router: ZERO as Address,
        factory: UNI_V3_FACTORY,
        stable: null,
        feeBps: fee / 100,
        tickSpacing: null,
        oracle: false,
      });
    }
    for (const fee of PANCAKE_FEES) {
      candidates.push({
        dex: "pancakeswap-v3",
        kind: "cl",
        quote,
        router: ZERO as Address,
        factory: PANCAKE_V3_FACTORY,
        stable: null,
        feeBps: fee === 2500 ? 25 : fee / 100,
        tickSpacing: null,
        oracle: false,
      });
    }
    for (const factory of SLIPSTREAM_FACTORIES) {
      for (const tickSpacing of TICK_SPACINGS) {
        candidates.push({
          dex: "aerodrome-slipstream",
          kind: "cl",
          quote,
          router: ZERO as Address,
          factory,
          stable: null,
          feeBps: null,
          tickSpacing,
          oracle: false,
        });
      }
    }
    candidates.push({
      dex: "baseswap",
      kind: "v2",
      quote,
      router: BASESWAP_ROUTER,
      factory: BASESWAP_FACTORY,
      stable: null,
      feeBps: 25,
      tickSpacing: null,
      oracle: false,
    });
    candidates.push({
      dex: "sushiswap",
      kind: "v2",
      quote,
      router: SUSHI_ROUTER,
      factory: SUSHI_FACTORY,
      stable: null,
      feeBps: 30,
      tickSpacing: null,
      oracle: false,
    });
  }
  return candidates;
}

function discoveryCall(token: Address, candidate: Candidate): Hex {
  if (candidate.kind === "v2") {
    return encodeFunctionData({ abi: pairAbi, functionName: "getPair", args: [token, candidate.quote.address] });
  }
  if (candidate.kind === "aero") {
    return encodeFunctionData({
      abi: aeroFactoryAbi,
      functionName: "getPool",
      args: [token, candidate.quote.address, candidate.stable ?? false],
    });
  }
  if (candidate.dex === "aerodrome-slipstream") {
    return encodeFunctionData({
      abi: clFactoryAbi,
      functionName: "getPool",
      args: [token, candidate.quote.address, candidate.tickSpacing ?? 100],
    });
  }
  const fee = candidate.dex === "pancakeswap-v3"
    ? candidate.feeBps === 25
      ? 2500
      : (candidate.feeBps ?? 0) * 100
    : (candidate.feeBps ?? 0) * 100;
  return encodeFunctionData({
    abi: v3FactoryAbi,
    functionName: "getPool",
    args: [token, candidate.quote.address, fee],
  });
}

function oracleCandidates(token: Address): Candidate[] {
  const usdc = QUOTE_TOKENS.find((quote) => sameAddress(quote.address, USDC));
  if (!usdc) return [];
  const specs: Candidate[] = [
    {
      dex: "uniswap-v3",
      kind: "cl",
      quote: usdc,
      router: ZERO as Address,
      factory: UNI_V3_FACTORY,
      stable: null,
      feeBps: 30,
      tickSpacing: null,
      oracle: true,
      priced: AERO,
    },
    {
      dex: "aerodrome",
      kind: "aero",
      quote: usdc,
      router: AERO_ROUTER,
      factory: AERO_FACTORY,
      stable: false,
      feeBps: null,
      tickSpacing: null,
      oracle: true,
      priced: AERO,
    },
    {
      dex: "uniswap-v3",
      kind: "cl",
      quote: usdc,
      router: ZERO as Address,
      factory: UNI_V3_FACTORY,
      stable: null,
      feeBps: 1,
      tickSpacing: null,
      oracle: true,
      priced: DAI,
    },
    {
      dex: "uniswap-v3",
      kind: "cl",
      quote: usdc,
      router: ZERO as Address,
      factory: UNI_V3_FACTORY,
      stable: null,
      feeBps: 5,
      tickSpacing: null,
      oracle: true,
      priced: DAI,
    },
    {
      dex: "aerodrome",
      kind: "aero",
      quote: usdc,
      router: AERO_ROUTER,
      factory: AERO_FACTORY,
      stable: true,
      feeBps: null,
      tickSpacing: null,
      oracle: true,
      priced: DAI,
    },
  ];
  return specs.filter((candidate) => candidate.priced && !sameAddress(candidate.priced, token));
}

export async function discoverMarket(client: BaseClient, token: Address): Promise<Market> {
  const candidates = buildCandidates(token);
  const oracles = oracleCandidates(token);
  const calls = [
    call(token, encodeFunctionData({ abi: erc20Abi, functionName: "name" })),
    call(token, encodeFunctionData({ abi: erc20Abi, functionName: "symbol" })),
    call(token, encodeFunctionData({ abi: erc20Abi, functionName: "decimals" })),
    call(token, encodeFunctionData({ abi: erc20Abi, functionName: "totalSupply" })),
    call(WETH_USDC_POOL, encodeFunctionData({ abi: slot0Abi, functionName: "slot0" })),
    ...candidates.map((candidate) => call(candidate.factory, discoveryCall(token, candidate))),
    ...oracles.map((candidate) => call(candidate.factory, discoveryCall(candidate.priced ?? AERO, candidate))),
  ];
  const first = await aggregate(client, calls);
  const name = first[0]?.success ? decodeString(first[0].returnData) ?? "Unknown" : "Unknown";
  const symbol = first[1]?.success ? decodeString(first[1].returnData) ?? "UNKNOWN" : "UNKNOWN";
  const decimalsWord = first[2]?.success ? decodeWord(first[2].returnData, "uint8") : null;
  const decimals =
    typeof decimalsWord === "bigint" || typeof decimalsWord === "number" ? Number(decimalsWord) : 18;
  const supplyWord = first[3]?.success ? decodeWord(first[3].returnData, "uint256") : null;
  const totalSupply = typeof supplyWord === "bigint" ? supplyWord : 0n;
  const sqrtWord = first[4]?.success ? decodeWord(first[4].returnData, "uint160") : null;
  const ethUsd = typeof sqrtWord === "bigint" && sqrtWord > 0n ? priceToken0InToken1(sqrtWord, 18, 6) : null;

  const found: FoundPool[] = [];
  const seen = new Set<string>();
  function pushFound(list: Candidate[], offset: number) {
    list.forEach((candidate, index) => {
      const row = first[offset + index];
      if (!row?.success) return;
      const pool = addressResult(row.returnData);
      if (!pool || seen.has(pool.toLowerCase())) return;
      seen.add(pool.toLowerCase());
      found.push({ ...candidate, address: pool });
    });
  }
  pushFound(candidates, 5);
  pushFound(oracles, 5 + candidates.length);

  const state = await readPoolState(client, token, decimals, found);
  const aeroUsd = priceFromUsdcPools(state, AERO, 18);
  const daiUsd = priceFromUsdcPools(state, DAI, 18);
  const quoteUsd = (quote: QuoteToken): number | null => {
    if (quote.usd === "stable") return 1;
    if (quote.usd === "eth") return ethUsd && ethUsd > 0 ? ethUsd : null;
    if (quote.usd === "dai") return daiUsd && daiUsd > 0 ? daiUsd : null;
    return aeroUsd && aeroUsd > 0 ? aeroUsd : null;
  };

  const pools = state
    .filter((pool) => !pool.candidate.oracle)
    .map((pool) => toPriced(pool, token, decimals, quoteUsd(pool.candidate.quote)))
    .filter((pool) => pool.quoteBalance > 0n || (pool.liquidityUsd ?? 0) > 0);

  return {
    name,
    symbol,
    decimals,
    totalSupply,
    ethUsd: ethUsd && ethUsd > 0 ? ethUsd : null,
    pools,
    best: selectMain(pools),
  };
}

interface PoolState {
  candidate: FoundPool;
  reserve0: bigint;
  reserve1: bigint;
  sqrtPriceX96: bigint;
  quoteBalance: bigint;
  tokenBalance: bigint;
  totalSupply: bigint;
  locked: bigint;
  tick: number | null;
  activeLiquidity: bigint;
  npm: Address | null;
  clLockedPct: number | null;
}

function signedWord(data: Hex, wordIndex: number): number | null {
  const start = 2 + wordIndex * 64;
  if (!data || data.length < start + 64) return null;
  let value = BigInt(`0x${data.slice(start, start + 64)}`);
  if (value >= 1n << 255n) value -= 1n << 256n;
  return Number(value);
}

async function readPoolState(client: BaseClient, token: Address, _decimals: number, pools: FoundPool[]): Promise<PoolState[]> {
  if (pools.length === 0) return [];
  const calls: { target: Address; data: Hex }[] = [];
  const layout: { pool: number; field: "reserves" | "slot0" | "quote" | "token" | "supply" | "lock" | "liquidity" | "nft" }[] = [];
  pools.forEach((pool, poolIndex) => {
    if (pool.kind === "cl") {
      calls.push(call(pool.address, encodeFunctionData({ abi: slot0Abi, functionName: "slot0" })));
      layout.push({ pool: poolIndex, field: "slot0" });
      if (!pool.oracle) {
        calls.push(call(pool.address, encodeFunctionData({ abi: clPoolExtraAbi, functionName: "liquidity" })));
        layout.push({ pool: poolIndex, field: "liquidity" });
        if (pool.dex === "aerodrome-slipstream") {
          calls.push(call(pool.address, encodeFunctionData({ abi: clPoolExtraAbi, functionName: "nft" })));
          layout.push({ pool: poolIndex, field: "nft" });
        }
      }
    } else {
      calls.push(call(pool.address, encodeFunctionData({ abi: reservesAbi, functionName: "getReserves" })));
      layout.push({ pool: poolIndex, field: "reserves" });
      calls.push(call(pool.address, encodeFunctionData({ abi: erc20Abi, functionName: "totalSupply" })));
      layout.push({ pool: poolIndex, field: "supply" });
      for (const holder of [...BURN_ADDRESSES, ...LP_LOCKERS]) {
        calls.push(
          call(pool.address, encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [holder] })),
        );
        layout.push({ pool: poolIndex, field: "lock" });
      }
    }
    calls.push(
      call(pool.quote.address, encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [pool.address] })),
    );
    layout.push({ pool: poolIndex, field: "quote" });
    calls.push(call(token, encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [pool.address] })));
    layout.push({ pool: poolIndex, field: "token" });
  });

  const rows = await aggregate(client, calls);
  const states: PoolState[] = pools.map((candidate) => ({
    candidate,
    reserve0: 0n,
    reserve1: 0n,
    sqrtPriceX96: 0n,
    quoteBalance: 0n,
    tokenBalance: 0n,
    totalSupply: 0n,
    locked: 0n,
    tick: null,
    activeLiquidity: 0n,
    npm: candidate.dex === "uniswap-v3" ? UNI_V3_NPM : candidate.dex === "pancakeswap-v3" ? PANCAKE_V3_NPM : null,
    clLockedPct: null,
  }));
  rows.forEach((row, index) => {
    const meta = layout[index];
    if (!meta || !row?.success) return;
    const state = states[meta.pool];
    if (!state) return;
    if (meta.field === "reserves") {
      try {
        const [r0, r1] = decodeReserves(row.returnData);
        state.reserve0 = r0;
        state.reserve1 = r1;
      } catch {
        /* ignore malformed reserves */
      }
    } else if (meta.field === "slot0") {
      const sqrt = decodeWord(row.returnData, "uint160");
      if (typeof sqrt === "bigint") state.sqrtPriceX96 = sqrt;
      state.tick = signedWord(row.returnData, 1);
    } else if (meta.field === "liquidity") {
      const liquidity = decodeWord(row.returnData, "uint256");
      if (typeof liquidity === "bigint") state.activeLiquidity = liquidity;
    } else if (meta.field === "nft") {
      const npm = decodeWord(row.returnData, "address");
      if (typeof npm === "string" && !sameAddress(npm, ZERO)) state.npm = getAddress(npm);
    } else if (meta.field === "quote" || meta.field === "token" || meta.field === "supply" || meta.field === "lock") {
      const amount = decodeWord(row.returnData, "uint256");
      if (typeof amount !== "bigint") return;
      if (meta.field === "quote") state.quoteBalance = amount;
      if (meta.field === "token") state.tokenBalance = amount;
      if (meta.field === "supply") state.totalSupply = amount;
      if (meta.field === "lock") state.locked += amount;
    }
  });
  await attachClLockFloors(client, token, states);
  return states;
}

async function attachClLockFloors(client: BaseClient, token: Address, states: PoolState[]): Promise<void> {
  const targets: { state: PoolState; input: ClPoolLockInput }[] = [];
  for (const state of states) {
    const candidate = state.candidate;
    if (candidate.kind !== "cl" || candidate.oracle || !state.npm || state.tick === null || state.activeLiquidity <= 0n) continue;
    const feeOrSpacing =
      candidate.dex === "aerodrome-slipstream" ? candidate.tickSpacing : candidate.feeBps !== null ? Math.round(candidate.feeBps * 100) : null;
    if (feeOrSpacing === null) continue;
    const quoteFirst = candidate.quote.address.toLowerCase() < token.toLowerCase();
    targets.push({
      state,
      input: {
        npm: state.npm,
        token0: quoteFirst ? candidate.quote.address : token,
        token1: quoteFirst ? token : candidate.quote.address,
        feeOrSpacing,
        tick: state.tick,
        liquidity: state.activeLiquidity,
      },
    });
  }
  if (targets.length === 0) return;
  try {
    const floors = await clLockFloors(client, targets.map((target) => target.input));
    floors.forEach((pct, index) => {
      const target = targets[index];
      if (target) target.state.clLockedPct = pct;
    });
  } catch {
    /* unknown stays null */
  }
}

function decodeReserves(data: Hex): [bigint, bigint] {
  if (!data || data.length < 2 + 64 * 2) return [0n, 0n];
  const r0 = BigInt(`0x${data.slice(2, 66)}`);
  const r1 = BigInt(`0x${data.slice(66, 130)}`);
  return [r0, r1];
}

const MIN_ORACLE_USDC = 100_000_000n;

function priceFromUsdcPools(states: PoolState[], token: Address, decimals: number): number | null {
  let best: { price: number; depth: bigint } | null = null;
  for (const state of states) {
    if (!state.candidate.oracle || !state.candidate.priced || !sameAddress(state.candidate.priced, token)) continue;
    if (state.quoteBalance < MIN_ORACLE_USDC) continue;
    const usd = usdFromUsdcPool(state, token, decimals);
    if (!usd || usd <= 0) continue;
    if (!best || state.quoteBalance > best.depth) best = { price: usd, depth: state.quoteBalance };
  }
  return best?.price ?? null;
}

function usdFromUsdcPool(state: PoolState, token: Address, tokenDecimals: number): number | null {
  const usdc = state.candidate.quote;
  if (!sameAddress(usdc.address, USDC)) return null;
  const token0IsQuote = usdc.address.toLowerCase() < token.toLowerCase();
  if (state.candidate.kind === "cl" && state.sqrtPriceX96 > 0n) {
    const dec0 = token0IsQuote ? usdc.decimals : tokenDecimals;
    const dec1 = token0IsQuote ? tokenDecimals : usdc.decimals;
    const token1PerToken0 = priceToken0InToken1(state.sqrtPriceX96, dec0, dec1);
    if (token1PerToken0 <= 0) return null;
    return token0IsQuote ? 1 / token1PerToken0 : token1PerToken0;
  }
  if (state.reserve0 > 0n && state.reserve1 > 0n) {
    const reserveToken = token0IsQuote ? state.reserve1 : state.reserve0;
    const reserveUsdc = token0IsQuote ? state.reserve0 : state.reserve1;
    const tokenHuman = humanAmount(reserveToken, tokenDecimals);
    const usdcHuman = humanAmount(reserveUsdc, usdc.decimals);
    if (tokenHuman <= 0) return null;
    return usdcHuman / tokenHuman;
  }
  return null;
}

function toPriced(state: PoolState, token: Address, tokenDecimals: number, quoteUsd: number | null): PricedPool {
  const quote = state.candidate.quote;
  const token0IsQuote = quote.address.toLowerCase() < token.toLowerCase();
  let liquidityUsd: number | null = null;
  let quoteBalance = state.quoteBalance;
  if (quoteUsd && quoteUsd > 0) {
    if (state.candidate.kind === "cl" && state.sqrtPriceX96 > 0n) {
      const dec0 = token0IsQuote ? quote.decimals : tokenDecimals;
      const dec1 = token0IsQuote ? tokenDecimals : quote.decimals;
      const token1PerToken0 = priceToken0InToken1(state.sqrtPriceX96, dec0, dec1);
      const price0 = token0IsQuote ? quoteUsd : token1PerToken0 * quoteUsd;
      const price1 = token0IsQuote ? (token1PerToken0 > 0 ? quoteUsd / token1PerToken0 : 0) : quoteUsd;
      const bal0 = token0IsQuote ? state.quoteBalance : state.tokenBalance;
      const bal1 = token0IsQuote ? state.tokenBalance : state.quoteBalance;
      liquidityUsd = roundUsd(humanAmount(bal0, dec0) * price0 + humanAmount(bal1, dec1) * price1);
    } else if (state.reserve0 > 0n || state.reserve1 > 0n) {
      const reserveQuote = token0IsQuote ? state.reserve0 : state.reserve1;
      quoteBalance = reserveQuote > 0n ? reserveQuote : quoteBalance;
      liquidityUsd = roundUsd(humanAmount(reserveQuote, quote.decimals) * quoteUsd * 2);
    } else if (quoteBalance > 0n) {
      liquidityUsd = roundUsd(humanAmount(quoteBalance, quote.decimals) * quoteUsd * 2);
    }
  }
  const lpLockedPct =
    state.candidate.kind === "cl"
      ? state.clLockedPct
      : state.totalSupply <= 0n
        ? null
        : roundPct(Number((state.locked * 10_000n) / state.totalSupply) / 100);

  return {
    address: state.candidate.address,
    dex: state.candidate.dex,
    kind: state.candidate.kind,
    quote,
    router: state.candidate.router,
    factory: state.candidate.factory,
    stable: state.candidate.stable,
    feeBps: state.candidate.feeBps,
    tickSpacing: state.candidate.tickSpacing,
    quoteBalance,
    liquidityUsd,
    lpLockedPct,
    lpLockFloor: state.candidate.kind === "cl" && lpLockedPct !== null,
  };
}

export function selectMain(pools: PricedPool[]): PricedPool | null {
  const priced = pools.filter((pool) => (pool.liquidityUsd ?? 0) > 0);
  if (priced.length > 0) {
    return [...priced].sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))[0] ?? null;
  }
  const funded = pools.filter((pool) => pool.quoteBalance > 0n);
  if (funded.length === 0) return null;
  return [...funded].sort((a, b) => (a.quoteBalance > b.quoteBalance ? -1 : 1))[0] ?? null;
}
