import { afterEach, describe, expect, it } from "vitest";
import { ScannerError, analyzeBaseToken, scanBaseToken, tokenSecurityUrl } from "../src/scanner.js";

const ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE = "https://api.gopluslabs.io";

function options(fetchImpl: typeof fetch, extra: { accessToken?: string; timeoutMs?: number } = {}) {
  return {
    fetchImpl,
    baseUrl: BASE,
    accessToken: extra.accessToken ?? "",
    timeoutMs: extra.timeoutMs ?? 1000,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function cleanBody() {
  return {
    code: 1,
    message: "OK",
    result: {
      [ADDRESS.toLowerCase()]: {
        token_name: "Clean",
        token_symbol: "CLN",
        buy_tax: "0",
        sell_tax: "0",
        transfer_tax: "0",
        is_open_source: "1",
        is_proxy: "0",
        is_mintable: "0",
        is_honeypot: "0",
        cannot_buy: "0",
        cannot_sell_all: "0",
        hidden_owner: "0",
        owner_change_balance: "0",
        can_take_back_ownership: "0",
        selfdestruct: "0",
        external_call: "0",
        slippage_modifiable: "0",
        personal_slippage_modifiable: "0",
        trading_cooldown: "0",
        transfer_pausable: "0",
        is_blacklisted: "0",
        is_whitelisted: "0",
        is_anti_whale: "0",
        anti_whale_modifiable: "0",
        is_in_dex: "1",
        honeypot_with_same_creator: "0",
        owner_address: "",
      },
    },
  };
}

afterEach(() => {
  delete process.env.GOPLUS_ACCESS_TOKEN;
  delete process.env.GOPLUS_TIMEOUT_MS;
});

describe("scanBaseToken", () => {
  it("rejects an invalid address before any request", async () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      return jsonResponse(cleanBody());
    };
    await expect(scanBaseToken("not-an-address", options(fetchImpl))).rejects.toMatchObject({
      code: "invalid_address",
    });
    await expect(scanBaseToken("0x1234", options(fetchImpl))).rejects.toMatchObject({ code: "invalid_address" });
    await expect(scanBaseToken(`0x${"0".repeat(40)}`, options(fetchImpl))).rejects.toMatchObject({
      code: "invalid_address",
    });
    expect(called).toBe(false);
  });

  it("requests the Base token_security endpoint and returns PASS", async () => {
    let seen = "";
    const fetchImpl: typeof fetch = async (input) => {
      seen = String(input);
      return jsonResponse(cleanBody());
    };
    const result = await scanBaseToken(ADDRESS.toLowerCase(), options(fetchImpl));
    expect(result.judgment).toBe("PASS");
    expect(result.address).toBe(ADDRESS);
    expect(seen).toBe(tokenSecurityUrl(BASE, ADDRESS).toString());
    expect(seen).toContain("/api/v1/token_security/8453");
    expect(seen).toContain(`contract_addresses=${ADDRESS.toLowerCase()}`);
  });

  it("sends an optional bearer token without putting it in the URL or the error", async () => {
    const secret = "super-secret-token";
    let authorization = "";
    let seen = "";
    const fetchImpl: typeof fetch = async (input, init) => {
      seen = String(input);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return jsonResponse({ message: "no" }, 401);
    };
    await expect(scanBaseToken(ADDRESS, options(fetchImpl, { accessToken: secret }))).rejects.toMatchObject({
      code: "http_error",
      status: 401,
    });
    expect(authorization).toBe(`Bearer ${secret}`);
    expect(seen).not.toContain(secret);
    try {
      await scanBaseToken(ADDRESS, options(fetchImpl, { accessToken: `Bearer ${secret}` }));
    } catch (error) {
      expect(error).toBeInstanceOf(ScannerError);
      expect((error as ScannerError).message).not.toContain(secret);
      expect((error as ScannerError).message).toMatch(/HTTP 401/);
    }
    expect(authorization).toBe(`Bearer ${secret}`);
  });

  it("reads GOPLUS_ACCESS_TOKEN from the environment when no override is passed", async () => {
    process.env.GOPLUS_ACCESS_TOKEN = "env-token";
    let authorization = "";
    const fetchImpl: typeof fetch = async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return jsonResponse(cleanBody());
    };
    await scanBaseToken(ADDRESS, { fetchImpl, baseUrl: BASE, timeoutMs: 1000 });
    expect(authorization).toBe("Bearer env-token");
  });

  it("maps HTTP errors, empty results, and non-JSON bodies", async () => {
    await expect(
      scanBaseToken(ADDRESS, options(async () => jsonResponse({ message: "down" }, 503))),
    ).rejects.toMatchObject({ code: "http_error", status: 503 });

    await expect(
      scanBaseToken(ADDRESS, options(async () => jsonResponse({ code: 1, message: "OK", result: {} }))),
    ).rejects.toMatchObject({ code: "empty_result" });

    await expect(
      scanBaseToken(ADDRESS, options(async () => new Response("nope", { status: 200 }))),
    ).rejects.toMatchObject({ code: "invalid_response" });

    await expect(
      scanBaseToken(ADDRESS, options(async () => new Response("", { status: 200 }))),
    ).rejects.toMatchObject({ code: "invalid_response" });

    await expect(
      scanBaseToken(ADDRESS, options(async () => jsonResponse({ code: 4029, message: "limited", result: {} }))),
    ).rejects.toMatchObject({ code: "api_error" });
  });

  it("reports a timeout separately from a network failure", async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new TypeError("missing signal"));
          return;
        }
        const abort = () => reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    await expect(scanBaseToken(ADDRESS, options(hanging, { timeoutMs: 20 }))).rejects.toMatchObject({
      code: "timeout",
    });

    const broken: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(scanBaseToken(ADDRESS, options(broken))).rejects.toMatchObject({ code: "network" });
  });

  it("aliases the judgment as status without inventing metrics", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse(cleanBody());
    const report = await analyzeBaseToken(ADDRESS, options(fetchImpl));
    expect(report.status).toBe("PASS");
    expect(report.judgment).toBe("PASS");
    expect(report.reasons).toEqual([]);
    expect(report.metrics.buyTaxPct).toBe(0);
    expect(report.metrics.isHoneypot).toBe(false);
  });

  it("rejects a timeout setting below 100ms", async () => {
    process.env.GOPLUS_TIMEOUT_MS = "1";
    const fetchImpl: typeof fetch = async () => jsonResponse(cleanBody());
    await expect(scanBaseToken(ADDRESS, { fetchImpl, baseUrl: BASE, accessToken: "" })).rejects.toMatchObject({
      code: "config",
    });
  });
});
