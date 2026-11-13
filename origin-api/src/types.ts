import type { Address } from "viem";

export type Verdict = "safe" | "caution" | "danger";
export type DexId =
  | "aerodrome"
  | "aerodrome-slipstream"
  | "uniswap-v3"
  | "pancakeswap-v3"
  | "baseswap"
  | "sushiswap";
export type PoolKind = "v2" | "aero" | "cl";

export interface PoolSummary {
  address: Address;
  dex: DexId;
  kind: PoolKind;
  quote: Address;
  quoteSymbol: string;
  feeBps: number | null;
  stable: boolean | null;
  tickSpacing: number | null;
}

export interface SimulationSummary {
  status: "ok" | "buy_failed" | "timeout" | "not_run";
  path: "router" | "direct" | "cl" | "none";
  amountIn: string;
  quotedBuy: string;
  tokensBought: string;
  quotedSell: string;
  quoteOut: string;
}

export interface TokenSafetyResponse {
  schemaVersion: 1;
  chain: "base";
  chainId: 8453;
  address: Address;
  verdict: Verdict;
  honeypot: boolean;
  buyTax: number;
  sellTax: number;
  ownerCanMint: boolean;
  /** -1 when LP lock cannot be measured (no pool, unreadable, or CL with no burned / known-locker position found). For CL pools a value is a lower bound (see the lp_lock_floor note). */
  lpLockedPct: number;
  /** -1 when USD liquidity could not be priced. 0 means no supported pool. */
  liquidityUsd: number;
  /** -1 when the holder list is unavailable. */
  holdersTop10Pct: number;
  reasons: string[];
  notes: string[];
  token: {
    name: string;
    symbol: string;
    decimals: number;
    proxy: boolean;
    implementation: Address | null;
    owner: Address | null;
    ownershipRenounced: boolean;
  };
  pool: PoolSummary | null;
  flags: {
    honeypot: boolean;
    highTax: boolean;
    ownerCanMint: boolean;
    blacklist: boolean;
    pause: boolean;
    paused: boolean;
    taxSetter: boolean;
    thinLiquidity: boolean;
    holderConcentration: boolean;
    unlockedLp: boolean;
  };
  simulation: SimulationSummary;
  sources: {
    bytecode: boolean;
    verifiedAbi: boolean;
    holders: "etherscan" | "blockscout" | "goplus" | "unavailable";
  };
  checkedAt: string;
  latencyMs: number;
  cache: "hit" | "miss";
  priceUsd: number;
}
