import { describe, expect, it } from "vitest";
import { decideVerdict, flagsFromSignals, isHoneypot, type Signals } from "../src/domain/verdict.js";

function signals(overrides: Partial<Signals> = {}): Signals {
  return {
    honeypot: false,
    sellReverted: false,
    simulationFailed: false,
    buyTaxPct: 0,
    sellTaxPct: 0,
    ownerCanMint: false,
    publicMint: false,
    hasBlacklist: false,
    hasPause: false,
    isPaused: false,
    hasTaxSetter: false,
    lpLockedPct: 100,
    liquidityUsd: 250_000,
    noPool: false,
    holdersTop10Pct: 20,
    proxyImplUnreadable: false,
    ...overrides,
  };
}

function codes(overrides: Partial<Signals> = {}): string[] {
  return flagsFromSignals(signals(overrides))
    .filter((flag) => flag.severity !== "info")
    .map((flag) => flag.code);
}

describe("flagsFromSignals", () => {
  it("marks a clean deep pool safe", () => {
    const decision = decideVerdict(flagsFromSignals(signals()));
    expect(decision.verdict).toBe("safe");
    expect(decision.reasons).toEqual([]);
  });

  it("treats a reverted sell as a honeypot danger", () => {
    const decision = decideVerdict(flagsFromSignals(signals({ honeypot: true, sellReverted: true })));
    expect(decision.verdict).toBe("danger");
    expect(decision.reasons[0]).toMatch(/honeypot/i);
    expect(codes({ honeypot: true, sellReverted: true })).toContain("honeypot");
  });

  it("puts 10% sell tax in danger and 3% buy tax in caution", () => {
    expect(decideVerdict(flagsFromSignals(signals({ sellTaxPct: 10 }))).verdict).toBe("danger");
    expect(decideVerdict(flagsFromSignals(signals({ buyTaxPct: 9.99 }))).verdict).toBe("caution");
    expect(decideVerdict(flagsFromSignals(signals({ buyTaxPct: 3 }))).verdict).toBe("caution");
    expect(decideVerdict(flagsFromSignals(signals({ buyTaxPct: 2.99 }))).verdict).toBe("safe");
  });

  it("keeps mint, blacklist, pause, and tax setters at caution", () => {
    expect(codes({ ownerCanMint: true })).toContain("owner_can_mint");
    expect(flagsFromSignals(signals({ ownerCanMint: true, publicMint: true }))[0]?.message).toMatch(/renounced/i);
    expect(codes({ hasBlacklist: true })).toContain("blacklist");
    expect(codes({ hasPause: true })).toContain("pause");
    expect(codes({ hasTaxSetter: true })).toContain("tax_setter");
    expect(decideVerdict(flagsFromSignals(signals({ ownerCanMint: true, hasBlacklist: true }))).verdict).toBe(
      "caution",
    );
  });

  it("escalates a live pause and dust liquidity to danger", () => {
    expect(decideVerdict(flagsFromSignals(signals({ isPaused: true }))).verdict).toBe("danger");
    expect(decideVerdict(flagsFromSignals(signals({ liquidityUsd: 999 }))).verdict).toBe("danger");
    expect(decideVerdict(flagsFromSignals(signals({ liquidityUsd: 5_000 }))).verdict).toBe("caution");
    expect(decideVerdict(flagsFromSignals(signals({ noPool: true, liquidityUsd: 0 }))).verdict).toBe("danger");
    expect(codes({ noPool: true, liquidityUsd: 0 })).toEqual(["no_pool"]);
  });

  it("warns on holder concentration and unlocked LP only for smaller pools", () => {
    expect(codes({ holdersTop10Pct: 70 })).toContain("holder_concentration");
    expect(codes({ holdersTop10Pct: 69.9 })).not.toContain("holder_concentration");
    expect(codes({ lpLockedPct: 49, liquidityUsd: 50_000 })).toContain("unlocked_lp");
    expect(codes({ lpLockedPct: 0, liquidityUsd: 5_000_000 })).not.toContain("unlocked_lp");
    expect(codes({ lpLockedPct: null, liquidityUsd: 10_000 })).not.toContain("unlocked_lp");
  });

  it("does not let missing holder data change a safe verdict", () => {
    const decision = decideVerdict(flagsFromSignals(signals({ holdersTop10Pct: null, lpLockedPct: null })));
    expect(decision.verdict).toBe("safe");
    expect(decision.notes.length).toBeGreaterThan(0);
    expect(decision.reasons).toEqual([]);
  });

  it("keeps danger when a honeypot also has a mint function", () => {
    const decision = decideVerdict(flagsFromSignals(signals({ honeypot: true, sellReverted: true, ownerCanMint: true })));
    expect(decision.verdict).toBe("danger");
    expect(decision.reasons).toHaveLength(2);
  });
});

describe("isHoneypot", () => {
  it("requires a successful buy before accusing a honeypot", () => {
    expect(isHoneypot({ buyOk: false, sellOk: false, amountIn: 0n, quoteOut: 0n, buyTaxPct: 0, sellTaxPct: 0 })).toBe(
      false,
    );
  });

  it("flags a reverted sell and a round trip that keeps under half", () => {
    expect(isHoneypot({ buyOk: true, sellOk: false, amountIn: 100n, quoteOut: 0n, buyTaxPct: 0, sellTaxPct: 0 })).toBe(
      true,
    );
    expect(
      isHoneypot({ buyOk: true, sellOk: true, amountIn: 1000n, quoteOut: 499n, buyTaxPct: 0, sellTaxPct: 0 }),
    ).toBe(true);
    expect(
      isHoneypot({ buyOk: true, sellOk: true, amountIn: 1000n, quoteOut: 990n, buyTaxPct: 0, sellTaxPct: 0 }),
    ).toBe(false);
  });
});
