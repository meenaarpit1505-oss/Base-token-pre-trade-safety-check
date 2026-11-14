import { describe, expect, it } from "vitest";
import { encodeAbiParameters, getAddress } from "viem";
import { decodePosition, lockedSharePct, lpLockHoldersFromEnv, type LockedPosition } from "../src/services/lpLocks.js";
import { DEAD } from "../src/domain/addresses.js";
import { decideVerdict, flagsFromSignals } from "../src/domain/verdict.js";

const T0 = "0x1111111111111111111111111111111111111111";
const T1 = "0x2222222222222222222222222222222222222222";
const NPM = getAddress("0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1");

const pos = (over: Partial<LockedPosition> = {}): LockedPosition => ({
  token0: T0,
  token1: T1,
  feeOrSpacing: 3000,
  tickLower: -887220,
  tickUpper: 887220,
  liquidity: 400n,
  ...over,
});

describe("CL LP lock floor", () => {
  it("decodes positions() return data (V3 / Slipstream word layout)", () => {
    const data = encodeAbiParameters(
      [
        { type: "uint96" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "int24" },
        { type: "int24" }, { type: "int24" }, { type: "uint128" }, { type: "uint256" }, { type: "uint256" },
        { type: "uint128" }, { type: "uint128" },
      ],
      [0n, "0x0000000000000000000000000000000000000000", T0, T1, 200, -1000, 2000, 12345n, 0n, 0n, 0n, 0n],
    );
    expect(decodePosition(data)).toEqual({ token0: T0, token1: T1, feeOrSpacing: 200, tickLower: -1000, tickUpper: 2000, liquidity: 12345n });
    expect(decodePosition("0x1234")).toBeNull();
  });

  it("counts only matching, in-range burned positions against active liquidity", () => {
    const pool = { npm: NPM, token0: getAddress(T0), token1: getAddress(T1), feeOrSpacing: 3000, tick: 10, liquidity: 1000n };
    const positions = [
      pos(),
      pos({ liquidity: 100n, tickLower: 20, tickUpper: 40 }), // out of range
      pos({ liquidity: 500n, feeOrSpacing: 500 }), // other fee tier = other pool
      pos({ liquidity: 500n, token1: "0x3333333333333333333333333333333333333333" }), // other pair
    ];
    expect(lockedSharePct(pool, positions)).toBe(40);
    expect(lockedSharePct(pool, [pos({ liquidity: 5000n })])).toBe(100);
  });

  it("reports unknown (null), not 0%, when nothing burned or locked is found", () => {
    const pool = { npm: NPM, token0: getAddress(T0), token1: getAddress(T1), feeOrSpacing: 3000, tick: 10, liquidity: 1000n };
    expect(lockedSharePct(pool, [])).toBeNull();
    expect(lockedSharePct({ ...pool, liquidity: 0n }, [pos()])).toBeNull();
    expect(lockedSharePct({ ...pool, liquidity: 10n ** 9n }, [pos({ liquidity: 1n })])).toBeNull(); // dust
  });

  it("holders default to the burn address plus valid LP_NFT_LOCKERS entries", () => {
    expect(lpLockHoldersFromEnv("")).toEqual([DEAD]);
    expect(lpLockHoldersFromEnv("0x4444444444444444444444444444444444444444, nope, 0x000000000000000000000000000000000000dEaD")).toEqual([
      DEAD,
      getAddress("0x4444444444444444444444444444444444444444"),
    ]);
  });

  it("a CL floor never raises unlocked_lp, and is surfaced as an info note", () => {
    const base = {
      honeypot: false, sellReverted: false, simulationFailed: false, buyTaxPct: 0, sellTaxPct: 0, ownerCanMint: false,
      publicMint: false, hasBlacklist: false, hasPause: false, isPaused: false, hasTaxSetter: false,
      liquidityUsd: 20_000, noPool: false, holdersTop10Pct: 10, proxyImplUnreadable: false,
    };
    const floor = flagsFromSignals({ ...base, lpLockedPct: 12, lpLockFloor: true }).map((f) => f.code);
    expect(floor).toContain("lp_lock_floor");
    expect(floor).not.toContain("unlocked_lp");
    expect(flagsFromSignals({ ...base, lpLockedPct: 12 }).map((f) => f.code)).toContain("unlocked_lp");
    expect(decideVerdict(flagsFromSignals({ ...base, lpLockedPct: 12, lpLockFloor: true })).verdict).toBe("safe");
  });
});
