import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { topHolderPercent } from "../src/domain/holders.js";
import { chooseAmountIn, humanAmount, priceToken0InToken1, rawAmount, taxPercent } from "../src/domain/math.js";
import { parseTokenQuery } from "../src/domain/query.js";
import { flagsFromAbi, readMinimalProxy, scanBytecode } from "../src/domain/selectors.js";
import { HttpError } from "../src/http/errors.js";
import { SIMULATOR_RUNTIME_BYTECODE } from "../src/generated/simulator.js";

function isqrt(value: bigint): bigint {
  if (value < 2n) return value;
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

describe("price and trade sizing", () => {
  it("converts a sqrt price into a human token0 price", () => {
    const sqrtPrice = isqrt((3000n * (1n << 192n)) / 10n ** 12n);
    const price = priceToken0InToken1(sqrtPrice, 18, 6);
    expect(price).toBeGreaterThan(2990);
    expect(price).toBeLessThan(3010);
  });

  it("keeps human amounts exact for whole tokens", () => {
    expect(humanAmount(1_500_000n, 6)).toBe(1.5);
    expect(rawAmount(1.5, 6)).toBe(1_500_000n);
  });

  it("caps probe size at about $25 and 1% of the quote balance", () => {
    const deep = chooseAmountIn(10_000n * 10n ** 18n, 18, 3000);
    expect(humanAmount(deep, 18) * 3000).toBeLessThanOrEqual(25.01);
    const thin = chooseAmountIn(10n ** 16n, 18, 3000);
    expect(thin).toBeLessThanOrEqual(10n ** 16n / 100n);
  });

  it("drops sub-noise tax and reports a real transfer tax", () => {
    expect(taxPercent(995n, 1000n)).toBe(0);
    expect(taxPercent(900n, 1000n)).toBe(10);
    expect(taxPercent(100n, 0n)).toBeNull();
  });
});

describe("holders and bytecode", () => {
  it("excludes the pool, burn, and locker addresses from the top 10", () => {
    const pool = getAddress("0x00000000000000000000000000000000000000a1");
    const dead = getAddress("0x000000000000000000000000000000000000dead");
    const whale = getAddress("0x00000000000000000000000000000000000000b1");
    const retail = getAddress("0x00000000000000000000000000000000000000b2");
    const result = topHolderPercent({
      totalSupply: 1000n,
      exclude: [pool, dead],
      holders: [
        { address: pool, quantity: 700n },
        { address: dead, quantity: 200n },
        { address: whale, quantity: 80n },
        { address: retail, quantity: 20n },
      ],
    });
    expect(result.counted).toBe(2);
    expect(result.pct).toBe(10);
  });

  it("does not treat a short truncated holder page as the top 10", () => {
    const whale = getAddress("0x00000000000000000000000000000000000000b1");
    const pool = getAddress("0x00000000000000000000000000000000000000a1");
    const result = topHolderPercent({
      totalSupply: 1000n,
      truncated: true,
      exclude: [pool],
      holders: [
        { address: pool, quantity: 500n },
        { address: whale, quantity: 100n },
      ],
    });
    expect(result.pct).toBeNull();
  });

  it("sums share-based holders when raw balances are absent", () => {
    const result = topHolderPercent({
      totalSupply: 0n,
      exclude: [],
      holders: [
        { address: "0x00000000000000000000000000000000000000c1", quantity: null, share: 0.2 },
        { address: "0x00000000000000000000000000000000000000c2", quantity: null, share: 0.05 },
      ],
    });
    expect(result.pct).toBe(25);
    expect(result.counted).toBe(2);
  });

  it("reads a minimal proxy target and mint selector", () => {
    const impl = "11223344556677889900aabbccddeeff00112233";
    const code = `0x363d3d373d3d3d363d73${impl}5af43d82803e903d91602b57fd5bf3` as const;
    expect(readMinimalProxy(code)?.toLowerCase()).toBe(`0x${impl}`);
    const mintPush = "63" + "40c10f19";
    expect(scanBytecode(`0x${mintPush}`).hasMint).toBe(true);
    expect(scanBytecode("0x00").hasMint).toBe(false);
  });

  it("reads mint and blacklist from a verified ABI", () => {
    const flags = flagsFromAbi([
      { type: "function", name: "mint", stateMutability: "nonpayable" },
      { type: "function", name: "blacklist", stateMutability: "nonpayable" },
      { type: "function", name: "isBlacklisted", stateMutability: "view" },
      { type: "function", name: "symbol", stateMutability: "view" },
    ]);
    expect(flags.hasMint).toBe(true);
    expect(flags.hasBlacklist).toBe(true);
    expect(flags.hasPause).toBe(false);
  });
});

describe("parseTokenQuery", () => {
  it("accepts base and checksums the address", () => {
    const parsed = parseTokenQuery(
      new URLSearchParams({ chain: "BASE", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" }),
    );
    expect(parsed.chain).toBe("base");
    expect(parsed.address).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  });

  it("rejects unknown chains and bad addresses", () => {
    expect(() => parseTokenQuery(new URLSearchParams({ chain: "solana", address: "0x" + "11".repeat(20) }))).toThrow(
      HttpError,
    );
    try {
      parseTokenQuery(new URLSearchParams({ chain: "solana", address: "0x" + "ab".repeat(20) }));
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(400);
      expect((error as HttpError).code).toBe("unsupported_chain");
    }
    expect(() => parseTokenQuery(new URLSearchParams({ chain: "base", address: "0x1234" }))).toThrow(HttpError);
    expect(() => parseTokenQuery(new URLSearchParams({ chain: "8453" }))).toThrow(HttpError);
  });
});

describe("simulator bytecode", () => {
  it("is a compiled runtime contract", () => {
    expect(SIMULATOR_RUNTIME_BYTECODE.startsWith("0x")).toBe(true);
    expect(SIMULATOR_RUNTIME_BYTECODE.length).toBeGreaterThan(1000);
  });
});
