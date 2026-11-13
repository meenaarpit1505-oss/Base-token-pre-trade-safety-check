import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEDUCT_API_KEY_RPC,
  formatUsd,
  resetSupabaseForTests,
  validateAndDeductKey,
  type DeductRpc,
} from "../src/db.js";

const KEY = "live-key-not-a-wallet-secret";

afterEach(() => {
  resetSupabaseForTests();
  vi.restoreAllMocks();
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

describe("validateAndDeductKey", () => {
  it("debits through one atomic RPC when the key can pay", async () => {
    const calls: Array<{ fn: string; args: { p_key: string; p_cost: string } }> = [];
    const rpc: DeductRpc = async (fn, args) => {
      calls.push({ fn, args });
      return { data: true, error: null };
    };
    await expect(validateAndDeductKey(KEY, 0.01, { rpc })).resolves.toBe(true);
    expect(calls).toEqual([{ fn: DEDUCT_API_KEY_RPC, args: { p_key: KEY, p_cost: "0.01" } }]);
  });

  it("returns false and does not throw when the key is missing, inactive, or underfunded", async () => {
    const rpc: DeductRpc = async () => ({ data: false, error: null });
    await expect(validateAndDeductKey(KEY, 0.01, { rpc })).resolves.toBe(false);
  });

  it("returns false without calling the database for an empty key or a non-positive cost", async () => {
    let called = false;
    const rpc: DeductRpc = async () => {
      called = true;
      return { data: true, error: null };
    };
    await expect(validateAndDeductKey("   ", 0.01, { rpc })).resolves.toBe(false);
    await expect(validateAndDeductKey(KEY, 0, { rpc })).resolves.toBe(false);
    await expect(validateAndDeductKey(KEY, -1, { rpc })).resolves.toBe(false);
    expect(called).toBe(false);
  });

  it("fails closed on a database error and does not echo the raw key", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const rpc: DeductRpc = async () => ({ data: null, error: { message: `rejected ${KEY}` } });
    await expect(validateAndDeductKey(KEY, 0.01, { rpc })).resolves.toBe(false);
    const logged = error.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(logged).not.toContain(KEY);
    expect(logged).toContain("[redacted]");
  });

  it("fails closed when Supabase is not configured", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(validateAndDeductKey(KEY, 0.01)).resolves.toBe(false);
  });

  it("formats 0.01 as a decimal string", () => {
    expect(formatUsd(0.01)).toBe("0.01");
    expect(formatUsd(1)).toBe("1");
  });
});
