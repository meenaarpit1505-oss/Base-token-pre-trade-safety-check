import { getAddress, type Address } from "viem";
import { sameAddress } from "./addresses.js";
import { roundPct } from "./math.js";

export interface HolderBalance {
  address: string;
  /** Raw balance. Null when the source only reports a fraction of supply. */
  quantity: bigint | null;
  /** Fraction of total supply in the range [0, 1]. */
  share?: number;
}

/**
 * Share of total supply held by the largest 10 addresses after exclusions.
 * Excludes the zero address, the dead address, the token itself, pools,
 * and known locker contracts. Returns null when the filtered list or supply
 * cannot support a top-10 figure. A truncated source that does not contain
 * 10 non-excluded holders also returns null, so a short page is not reported
 * as a lower concentration than the chain.
 */
export function topHolderPercent(input: {
  holders: HolderBalance[];
  totalSupply: bigint;
  exclude: readonly string[];
  truncated?: boolean;
}): { pct: number | null; counted: number } {
  const excluded = new Set(input.exclude.map((address) => normalize(address)));
  const filtered = input.holders.filter((holder) => {
    if (excluded.has(normalize(holder.address))) return false;
    if (holder.quantity !== null) return holder.quantity > 0n;
    return (holder.share ?? 0) > 0;
  });
  if (filtered.length === 0) return { pct: null, counted: 0 };
  if (input.truncated && filtered.length < 10) return { pct: null, counted: filtered.length };

  const useQuantity = filtered.every((holder) => holder.quantity !== null);
  if (useQuantity) {
    if (input.totalSupply <= 0n) return { pct: null, counted: 0 };
    const top = [...filtered]
      .sort((a, b) => ((a.quantity ?? 0n) > (b.quantity ?? 0n) ? -1 : (a.quantity ?? 0n) < (b.quantity ?? 0n) ? 1 : 0))
      .slice(0, 10);
    const sum = top.reduce((total, holder) => total + (holder.quantity ?? 0n), 0n);
    const pct = roundPct(Number((sum * 10_000n) / input.totalSupply) / 100);
    return { pct, counted: top.length };
  }

  const top = [...filtered].sort((a, b) => (b.share ?? 0) - (a.share ?? 0)).slice(0, 10);
  const pct = roundPct(top.reduce((total, holder) => total + (holder.share ?? 0), 0) * 100);
  return { pct, counted: top.length };
}

export function excludeSet(addresses: readonly Address[]): string[] {
  const unique = new Map<string, Address>();
  for (const address of addresses) {
    if (!sameAddress(address, "0x")) unique.set(address.toLowerCase(), address);
  }
  return [...unique.values()];
}

function normalize(address: string): string {
  try {
    return getAddress(address).toLowerCase();
  } catch {
    return address.toLowerCase();
  }
}
