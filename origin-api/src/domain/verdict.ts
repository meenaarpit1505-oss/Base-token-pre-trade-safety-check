import { usdLabel } from "./math.js";

export type Verdict = "safe" | "caution" | "danger";
export type Severity = "danger" | "caution" | "info";

export const THRESHOLDS = {
  taxDangerPct: 10,
  taxCautionPct: 3,
  honeypotTaxPct: 50,
  liquidityDangerUsd: 1_000,
  liquidityCautionUsd: 10_000,
  lpUnlockCautionPct: 50,
  lpUnlockLiquidityMaxUsd: 100_000,
  holdersCautionPct: 70,
  roundTripHoneypotBps: 5_000,
} as const;

export interface Signals {
  honeypot: boolean;
  sellReverted: boolean;
  simulationFailed: boolean;
  buyTaxPct: number;
  sellTaxPct: number;
  ownerCanMint: boolean;
  /** True when a mint call succeeds after ownership was renounced. */
  publicMint: boolean;
  hasBlacklist: boolean;
  hasPause: boolean;
  isPaused: boolean;
  hasTaxSetter: boolean;
  /** null when the pool is concentrated liquidity or lock balances could not be read. */
  lpLockedPct: number | null;
  /** null when the quote asset could not be priced. */
  liquidityUsd: number | null;
  noPool: boolean;
  /** null when the holder API is unavailable. */
  holdersTop10Pct: number | null;
  proxyImplUnreadable: boolean;
}

export interface Flag {
  severity: Severity;
  code: string;
  message: string;
}

function taxFlag(side: "Buy" | "Sell", percent: number): Flag | null {
  if (percent >= THRESHOLDS.taxDangerPct) {
    return {
      severity: "danger",
      code: side === "Buy" ? "buy_tax" : "sell_tax",
      message: `${side} tax measured at ${percent}% (danger at ${THRESHOLDS.taxDangerPct}% or more).`,
    };
  }
  if (percent >= THRESHOLDS.taxCautionPct) {
    return {
      severity: "caution",
      code: side === "Buy" ? "buy_tax" : "sell_tax",
      message: `${side} tax measured at ${percent}% (caution at ${THRESHOLDS.taxCautionPct}% or more).`,
    };
  }
  return null;
}

export function flagsFromSignals(signals: Signals): Flag[] {
  const flags: Flag[] = [];

  if (signals.isPaused) {
    flags.push({
      severity: "danger",
      code: "paused",
      message: "The token is paused. Transfers are likely to fail.",
    });
  }

  if (signals.honeypot) {
    flags.push({
      severity: "danger",
      code: "honeypot",
      message: signals.sellReverted
        ? "Sell simulation reverted after a successful buy on the main pool. The token behaves like a honeypot."
        : "Round-trip simulation kept under half the quote spent, or the tax is extreme. Treat the token as a honeypot.",
    });
  }

  const buy = taxFlag("Buy", signals.buyTaxPct);
  const sell = taxFlag("Sell", signals.sellTaxPct);
  if (buy) flags.push(buy);
  if (sell) flags.push(sell);

  if (signals.noPool) {
    flags.push({
      severity: "danger",
      code: "no_pool",
      message: "No WETH, USDC, USDbC, DAI, or AERO pool with liquidity was found on the supported DEXes.",
    });
  } else if (signals.liquidityUsd !== null && signals.liquidityUsd < THRESHOLDS.liquidityDangerUsd) {
    flags.push({
      severity: "danger",
      code: "thin_liquidity",
      message: `Main-pool liquidity is ${usdLabel(signals.liquidityUsd)}, under the ${usdLabel(THRESHOLDS.liquidityDangerUsd)} danger line.`,
    });
  } else if (signals.liquidityUsd !== null && signals.liquidityUsd < THRESHOLDS.liquidityCautionUsd) {
    flags.push({
      severity: "caution",
      code: "thin_liquidity",
      message: `Main-pool liquidity is ${usdLabel(signals.liquidityUsd)}, under the ${usdLabel(THRESHOLDS.liquidityCautionUsd)} caution line.`,
    });
  }

  if (signals.proxyImplUnreadable) {
    flags.push({
      severity: "caution",
      code: "proxy_unreadable",
      message:
        "The token is a proxy and its implementation bytecode could not be read, so mint and admin controls may be missed.",
    });
  }

  if (signals.simulationFailed) {
    flags.push({
      severity: "caution",
      code: "simulation_failed",
      message: "Buy simulation failed or timed out, so the sell path was not verified.",
    });
  }

  if (signals.ownerCanMint) {
    flags.push({
      severity: "caution",
      code: "owner_can_mint",
      message: signals.publicMint
        ? "Ownership is renounced, but a public mint from an unrelated caller still succeeds, so supply can increase."
        : "A mint-like function is present and ownership is not renounced, so an admin can increase supply.",
    });
  }
  if (signals.hasBlacklist) {
    flags.push({
      severity: "caution",
      code: "blacklist",
      message: "The contract exposes blacklist or bot-blocking controls.",
    });
  }
  if (signals.hasPause && !signals.isPaused) {
    flags.push({
      severity: "caution",
      code: "pause",
      message: "The contract exposes a pause control.",
    });
  }
  if (signals.hasTaxSetter) {
    flags.push({
      severity: "caution",
      code: "tax_setter",
      message: "The contract exposes a function that can change buy or sell tax.",
    });
  }

  if (
    signals.holdersTop10Pct !== null &&
    signals.holdersTop10Pct >= THRESHOLDS.holdersCautionPct
  ) {
    flags.push({
      severity: "caution",
      code: "holder_concentration",
      message: `Top 10 holders control ${signals.holdersTop10Pct}% of supply after excluding the pool, burn, and known locker addresses.`,
    });
  }

  if (
    signals.lpLockedPct !== null &&
    signals.liquidityUsd !== null &&
    signals.lpLockedPct < THRESHOLDS.lpUnlockCautionPct &&
    signals.liquidityUsd < THRESHOLDS.lpUnlockLiquidityMaxUsd
  ) {
    flags.push({
      severity: "caution",
      code: "unlocked_lp",
      message: `Only ${signals.lpLockedPct}% of LP tokens are locked or burned, and pool liquidity is under ${usdLabel(THRESHOLDS.lpUnlockLiquidityMaxUsd)}.`,
    });
  }

  if (signals.holdersTop10Pct === null) {
    flags.push({
      severity: "info",
      code: "holders_unavailable",
      message:
        "Top-10 holder concentration is unavailable. The holder index did not return a usable list in time, so holdersTop10Pct is -1.",
    });
  }
  if (!signals.noPool && signals.lpLockedPct === null) {
    flags.push({
      severity: "info",
      code: "lp_lock_unmeasured",
      message:
        "LP locked percent was not measured. Concentrated-liquidity positions are NFTs, and Aerodrome gauge stakes are not treated as locked. lpLockedPct is -1.",
    });
  }
  if (!signals.noPool && signals.liquidityUsd === null) {
    flags.push({
      severity: "info",
      code: "liquidity_unpriced",
      message: "The main pool's quote asset could not be priced in USD. liquidityUsd is -1.",
    });
  }

  return flags;
}

export function decideVerdict(flags: Flag[]): { verdict: Verdict; reasons: string[]; notes: string[] } {
  const verdict: Verdict = flags.some((flag) => flag.severity === "danger")
    ? "danger"
    : flags.some((flag) => flag.severity === "caution")
      ? "caution"
      : "safe";
  return {
    verdict,
    reasons: flags.filter((flag) => flag.severity !== "info").map((flag) => flag.message),
    notes: flags.filter((flag) => flag.severity === "info").map((flag) => flag.message),
  };
}

export function isHoneypot(input: {
  buyOk: boolean;
  sellOk: boolean;
  amountIn: bigint;
  quoteOut: bigint;
  buyTaxPct: number | null;
  sellTaxPct: number | null;
}): boolean {
  if (!input.buyOk) return false;
  if (!input.sellOk) return true;
  if ((input.sellTaxPct ?? 0) >= THRESHOLDS.honeypotTaxPct) return true;
  if ((input.buyTaxPct ?? 0) >= 80) return true;
  if (input.amountIn > 0n) {
    const returnedBps = Number((input.quoteOut * 10_000n) / input.amountIn);
    if (returnedBps < THRESHOLDS.roundTripHoneypotBps) return true;
  }
  return false;
}
