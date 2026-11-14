import type { Address } from "viem";
import { getConfig } from "../config.js";
import {
  AERO,
  BURN_ADDRESSES,
  DAI,
  LP_LOCKERS,
  USDC,
  USDBC,
  WETH,
  sameAddress,
} from "../domain/addresses.js";
import { topHolderPercent } from "../domain/holders.js";
import { chooseAmountIn, humanAmount, taxPercent } from "../domain/math.js";
import { decideVerdict, flagsFromSignals, isHoneypot, type Flag } from "../domain/verdict.js";
import { DeadlineError, HttpError, withDeadline, withFallback } from "../http/errors.js";
import type { TokenSafetyResponse } from "../types.js";
import { TtlCache } from "./cache.js";
import { applyAbi, loadIntel, probePublicMint, type ContractIntel } from "./intel.js";
import { fetchHolders, fetchVerifiedAbi } from "./marketData.js";
import { discoverMarket, type PricedPool } from "./pools.js";
import { getBaseClient, isTransportError } from "./rpc.js";
import { simulatePool, type SimulationRaw } from "./simulate.js";

const PATHS = ["none", "router", "direct", "cl"] as const;

let cache: TtlCache<TokenSafetyResponse> | null = null;
const inflight = new Map<string, Promise<TokenSafetyResponse>>();

function responseCache(): TtlCache<TokenSafetyResponse> {
  if (!cache) cache = new TtlCache(getConfig().cacheTtlMs);
  return cache;
}

export function clearSafetyCache(): void {
  responseCache().clear();
  inflight.clear();
}

export async function checkBaseToken(address: Address): Promise<TokenSafetyResponse> {
  const started = Date.now();
  const key = address.toLowerCase();
  const cached = responseCache().get(key);
  if (cached) return { ...cached, cache: "hit", latencyMs: Date.now() - started };
  const pending = inflight.get(key);
  if (pending) {
    const shared = await pending;
    return { ...structuredClone(shared), cache: "hit" };
  }
  const run = runCheck(address).finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run.then((body) => structuredClone(body));
}

async function runCheck(address: Address): Promise<TokenSafetyResponse> {
  const started = Date.now();
  if (sameAddress(address, WETH)) {
    return finish(canonicalWrapped("WETH", "Wrapped Ether", address), started, true);
  }
  try {
    const report = await inspect(address, started);
    return report;
  } catch (error) {
    if (error instanceof HttpError || error instanceof DeadlineError) {
      if (error instanceof DeadlineError) {
        throw new HttpError(503, "rpc_unavailable", "Base RPC timed out. Set BASE_RPC_URL to a faster full node.");
      }
      throw error;
    }
    if (isTransportError(error)) {
      console.error(
        JSON.stringify({
          event: "rpc_error",
          name: error instanceof Error ? error.name : "unknown",
          message: error instanceof Error ? error.message.slice(0, 500) : "unknown",
        }),
      );
      throw new HttpError(503, "rpc_unavailable", "Base RPC request failed. Set BASE_RPC_URL to a reachable full node.");
    }
    throw error;
  }
}

async function inspect(address: Address, started: number): Promise<TokenSafetyResponse> {
  const config = getConfig();
  const client = await getBaseClient();
  const [abiRead, market, holders, intelBase] = await Promise.all([
    withFallback(fetchVerifiedAbi(address, config.sourceTimeoutMs), config.sourceTimeoutMs, {
      abi: null,
      verified: false,
    }),
    withDeadline(discoverMarket(client, address), config.discoveryTimeoutMs, "pool discovery"),
    withFallback(fetchHolders(address, config.holdersTimeoutMs), config.holdersTimeoutMs + 50, {
      holders: null,
      source: "unavailable" as const,
      truncated: false,
    }),
    withDeadline(loadIntel(client, address, null), config.discoveryTimeoutMs, "contract intel"),
  ]);
  const intel = applyAbi(intelBase, abiRead.abi);
  if (!intel.hasCode) {
    throw new HttpError(404, "not_a_contract", "address has no contract code on Base.");
  }

  const pool = market.best;
  const publicMintPromise =
    intel.hasMint && intel.ownershipRenounced
      ? withFallback(probePublicMint(client, address), 800, false)
      : Promise.resolve(false);
  const [simulation, publicMint] = await Promise.all([
    runSimulation(client, address, market.ethUsd, pool, market.pools),
    publicMintPromise,
  ]);
  const ownerCanMint = (intel.hasMint && !intel.ownershipRenounced) || publicMint;
  const buyTax = simulation.raw?.buyOk ? (taxPercent(simulation.raw.tokensBought, simulation.raw.quotedBuy) ?? 0) : 0;
  const sellTax = simulation.raw?.sellOk ? (taxPercent(simulation.raw.quoteOut, simulation.raw.quotedSell) ?? 0) : 0;
  const honeypot = simulation.raw
    ? isHoneypot({
        buyOk: simulation.raw.buyOk,
        sellOk: simulation.raw.sellOk,
        amountIn: simulation.raw.amountIn,
        quoteOut: simulation.raw.quoteOut,
        buyTaxPct: buyTax,
        sellTaxPct: sellTax,
      })
    : false;

  const holderPct = holders.holders
    ? topHolderPercent({
        holders: holders.holders,
        totalSupply: market.totalSupply,
        truncated: holders.truncated,
        exclude: [
          address,
          ...market.pools.map((item) => item.address),
          ...BURN_ADDRESSES,
          ...LP_LOCKERS,
          USDC,
          USDBC,
          DAI,
          AERO,
          WETH,
        ],
      }).pct
    : null;

  const flags = flagsFromSignals({
    honeypot,
    sellReverted: Boolean(simulation.raw?.buyOk && !simulation.raw.sellOk),
    simulationFailed: simulation.status === "buy_failed" || simulation.status === "timeout",
    buyTaxPct: buyTax,
    sellTaxPct: sellTax,
    ownerCanMint,
    publicMint,
    hasBlacklist: intel.hasBlacklist,
    hasPause: intel.hasPause,
    isPaused: intel.isPaused,
    hasTaxSetter: intel.hasTaxSetter,
    lpLockedPct: pool ? pool.lpLockedPct : null,
    lpLockFloor: pool ? pool.lpLockFloor : false,
    liquidityUsd: pool ? pool.liquidityUsd : market.pools.length === 0 ? 0 : null,
    noPool: !pool,
    holdersTop10Pct: holderPct,
    proxyImplUnreadable: intel.implUnreadable,
  });
  const decision = decideVerdict(flags);
  const response = buildResponse({
    address,
    market,
    pool,
    intel,
    abiVerified: abiRead.verified,
    holdersSource: holders.source,
    buyTax,
    sellTax,
    honeypot,
    holderPct,
    ownerCanMint,
    flags,
    reasons: decision.reasons,
    notes: decision.notes,
    verdict: decision.verdict,
    simulation,
    started,
  });
  if (simulation.status !== "timeout") responseCache().set(address.toLowerCase(), response);
  return response;
}

interface SimRun {
  status: TokenSafetyResponse["simulation"]["status"];
  path: TokenSafetyResponse["simulation"]["path"];
  raw: SimulationRaw | null;
  amountIn: bigint;
}

async function runSimulation(
  client: Awaited<ReturnType<typeof getBaseClient>>,
  token: Address,
  ethUsd: number | null,
  best: PricedPool | null,
  pools: PricedPool[],
): Promise<SimRun> {
  if (!best) return { status: "not_run", path: "none", raw: null, amountIn: 0n };
  const ordered = [...pools].sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));
  const unique = new Map<string, PricedPool>();
  for (const pool of [best, ...ordered]) unique.set(pool.address.toLowerCase(), pool);
  const config = getConfig();
  let last: SimRun = { status: "buy_failed", path: "none", raw: null, amountIn: 0n };
  let attempts = 0;
  for (const pool of unique.values()) {
    if (attempts >= 2) break;
    const amountIn = amountFor(pool, ethUsd);
    if (amountIn <= 0n) continue;
    attempts += 1;
    try {
      const raw = await withDeadline(
        simulatePool(client, pool, token, amountIn),
        config.simTimeoutMs,
        "swap simulation",
      );
      if (!raw) {
        last = { status: "buy_failed", path: "none", raw: null, amountIn };
        continue;
      }
      const path = PATHS[raw.path] ?? "none";
      if (!raw.buyOk) {
        last = { status: "buy_failed", path, raw, amountIn: raw.amountIn || amountIn };
        continue;
      }
      return { status: "ok", path, raw, amountIn: raw.amountIn || amountIn };
    } catch (error) {
      if (error instanceof DeadlineError) {
        return { status: "timeout", path: "none", raw: null, amountIn };
      }
      last = { status: "buy_failed", path: "none", raw: null, amountIn };
    }
  }
  return last;
}

function amountFor(pool: PricedPool, ethUsd: number | null): bigint {
  const quoteUsd =
    pool.quote.usd === "stable"
      ? 1
      : pool.quote.usd === "eth"
        ? ethUsd
        : impliedQuoteUsd(pool);
  if (quoteUsd && quoteUsd > 0 && pool.quoteBalance > 0n) {
    const sized = chooseAmountIn(pool.quoteBalance, pool.quote.decimals, quoteUsd);
    if (sized > 0n) return sized;
  }
  if (sameAddress(pool.quote.address, WETH)) return 2_000_000_000_000_000n;
  if (pool.quote.usd === "stable") return 5n * 10n ** BigInt(pool.quote.decimals);
  return pool.quoteBalance / 1000n;
}

function impliedQuoteUsd(pool: PricedPool): number | null {
  if (!pool.liquidityUsd || pool.quoteBalance <= 0n) return null;
  const human = humanAmount(pool.quoteBalance, pool.quote.decimals);
  if (human <= 0) return null;
  return pool.liquidityUsd / 2 / human;
}

function buildResponse(input: {
  address: Address;
  market: Awaited<ReturnType<typeof discoverMarket>>;
  pool: PricedPool | null;
  intel: ContractIntel;
  abiVerified: boolean;
  holdersSource: TokenSafetyResponse["sources"]["holders"];
  buyTax: number;
  sellTax: number;
  honeypot: boolean;
  holderPct: number | null;
  ownerCanMint: boolean;
  flags: Flag[];
  reasons: string[];
  notes: string[];
  verdict: TokenSafetyResponse["verdict"];
  simulation: SimRun;
  started: number;
}): TokenSafetyResponse {
  const codes = new Set(input.flags.map((flag) => flag.code));
  const liquidity = !input.pool
    ? input.market.pools.length === 0
      ? 0
      : -1
    : input.pool.liquidityUsd === null
      ? -1
      : input.pool.liquidityUsd;
  return {
    schemaVersion: 1,
    chain: "base",
    chainId: 8453,
    address: input.address,
    verdict: input.verdict,
    honeypot: input.honeypot,
    buyTax: input.buyTax,
    sellTax: input.sellTax,
    ownerCanMint: input.ownerCanMint,
    lpLockedPct: input.pool?.lpLockedPct ?? -1,
    liquidityUsd: liquidity,
    holdersTop10Pct: input.holderPct ?? -1,
    reasons: input.reasons,
    notes: input.notes,
    token: {
      name: input.market.name,
      symbol: input.market.symbol,
      decimals: input.market.decimals,
      proxy: input.intel.proxy,
      implementation: input.intel.implementation,
      owner: input.intel.owner,
      ownershipRenounced: input.intel.ownershipRenounced,
    },
    pool: input.pool
      ? {
          address: input.pool.address,
          dex: input.pool.dex,
          kind: input.pool.kind,
          quote: input.pool.quote.address,
          quoteSymbol: input.pool.quote.symbol,
          feeBps: input.pool.feeBps,
          stable: input.pool.stable,
          tickSpacing: input.pool.tickSpacing,
        }
      : null,
    flags: {
      honeypot: codes.has("honeypot"),
      highTax: codes.has("buy_tax") || codes.has("sell_tax"),
      ownerCanMint: codes.has("owner_can_mint"),
      blacklist: codes.has("blacklist"),
      pause: codes.has("pause") || codes.has("paused"),
      paused: codes.has("paused"),
      taxSetter: codes.has("tax_setter"),
      thinLiquidity: codes.has("thin_liquidity") || codes.has("no_pool"),
      holderConcentration: codes.has("holder_concentration"),
      unlockedLp: codes.has("unlocked_lp"),
    },
    simulation: {
      status: input.simulation.status === "ok" && input.simulation.raw ? "ok" : input.simulation.status,
      path: input.simulation.path,
      amountIn: (input.simulation.raw?.amountIn ?? input.simulation.amountIn).toString(),
      quotedBuy: (input.simulation.raw?.quotedBuy ?? 0n).toString(),
      tokensBought: (input.simulation.raw?.tokensBought ?? 0n).toString(),
      quotedSell: (input.simulation.raw?.quotedSell ?? 0n).toString(),
      quoteOut: (input.simulation.raw?.quoteOut ?? 0n).toString(),
    },
    sources: {
      bytecode: true,
      verifiedAbi: input.abiVerified,
      holders: input.holdersSource,
    },
    checkedAt: new Date().toISOString(),
    latencyMs: Date.now() - input.started,
    cache: "miss",
    priceUsd: getConfig().priceUsd,
  };
}

function canonicalWrapped(symbol: string, name: string, address: Address): TokenSafetyResponse {
  return {
    schemaVersion: 1,
    chain: "base",
    chainId: 8453,
    address,
    verdict: "safe",
    honeypot: false,
    buyTax: 0,
    sellTax: 0,
    ownerCanMint: false,
    lpLockedPct: -1,
    liquidityUsd: -1,
    holdersTop10Pct: -1,
    reasons: [],
    notes: [
      `${symbol} is canonical Base wrapped ETH, not an arbitrary swap target. Pool, holder, and mint checks are not applied.`,
    ],
    token: {
      name,
      symbol,
      decimals: 18,
      proxy: false,
      implementation: null,
      owner: null,
      ownershipRenounced: false,
    },
    pool: null,
    flags: {
      honeypot: false,
      highTax: false,
      ownerCanMint: false,
      blacklist: false,
      pause: false,
      paused: false,
      taxSetter: false,
      thinLiquidity: false,
      holderConcentration: false,
      unlockedLp: false,
    },
    simulation: {
      status: "not_run",
      path: "none",
      amountIn: "0",
      quotedBuy: "0",
      tokensBought: "0",
      quotedSell: "0",
      quoteOut: "0",
    },
    sources: { bytecode: false, verifiedAbi: false, holders: "unavailable" },
    checkedAt: new Date().toISOString(),
    latencyMs: 0,
    cache: "miss",
    priceUsd: getConfig().priceUsd,
  };
}

function finish(response: TokenSafetyResponse, started: number, store: boolean): TokenSafetyResponse {
  const body = { ...response, latencyMs: Date.now() - started };
  if (store) responseCache().set(response.address.toLowerCase(), body);
  return body;
}
