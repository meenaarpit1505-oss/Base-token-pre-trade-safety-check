/** Reported taxes at or below this are treated as AMM rounding and slippage noise. */
export const TAX_NOISE_FLOOR_PCT = 0.5;

export function humanAmount(amount: bigint, decimals: number): number {
  if (amount <= 0n) return 0;
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  const fraction = amount % scale;
  return Number(whole) + Number(fraction) / 10 ** decimals;
}

export function rawAmount(human: number, decimals: number): bigint {
  if (!Number.isFinite(human) || human <= 0) return 0n;
  const places = Math.min(decimals, 8);
  const [whole = "0", frac = ""] = human.toFixed(places).split(".");
  const digits = `${frac}${"0".repeat(decimals)}`.slice(0, decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(digits || "0");
}

/**
 * Size a probe swap off the quote tokens sitting in the pool.
 * Target about 0.1% of that balance, clamped to roughly $2–$25 and never above 1%.
 */
export function chooseAmountIn(quoteBalance: bigint, decimals: number, quoteUsd: number): bigint {
  if (quoteBalance <= 0n || !(quoteUsd > 0)) return 0n;
  const onePercent = quoteBalance / 100n;
  let amount = quoteBalance / 1000n;
  const maxRaw = rawAmount(25 / quoteUsd, decimals);
  const minRaw = rawAmount(2 / quoteUsd, decimals);
  if (maxRaw > 0n && amount > maxRaw) amount = maxRaw;
  if (minRaw > 0n && amount < minRaw) amount = minRaw;
  if (onePercent > 0n && amount > onePercent) amount = onePercent;
  const half = quoteBalance / 2n;
  if (half > 0n && amount > half) amount = half;
  return amount > 0n ? amount : 0n;
}

/** Human price of one token0, denominated in token1. */
export function priceToken0InToken1(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  if (sqrtPriceX96 <= 0n) return 0;
  const numerator = sqrtPriceX96 * sqrtPriceX96;
  const scale = 10n ** 18n;
  const scaledRaw = (numerator * scale) / (1n << 192n);
  const raw = Number(scaledRaw) / 1e18;
  return raw * 10 ** (decimals0 - decimals1);
}

/**
 * Transfer-tax percent implied by quoted output vs tokens/quote actually received.
 * Returns null when there is no quote to compare against.
 */
export function taxPercent(actual: bigint, quoted: bigint): number | null {
  if (quoted <= 0n) return null;
  if (actual >= quoted) return 0;
  const bps = ((quoted - actual) * 10_000n) / quoted;
  const percent = Number(bps) / 100;
  if (percent <= TAX_NOISE_FLOOR_PCT) return 0;
  return Math.round(percent * 100) / 100;
}

export function roundUsd(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value >= 1000) return Math.round(value);
  return Math.round(value * 100) / 100;
}

export function roundPct(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(100, Math.round(value * 100) / 100);
}

export function usdLabel(value: number): string {
  const rounded = value >= 100 ? Math.round(value).toString() : value.toFixed(2);
  return `$${rounded}`;
}
