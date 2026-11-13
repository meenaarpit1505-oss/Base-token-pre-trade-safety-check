import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { resetConfigForTests, resolveUsageBackend } from "../src/config.js";
import { MemoryUsageStore, usageKey } from "../src/http/usageStore.js";
import { RedisClient } from "../src/http/redisClient.js";
import { parsePaymentHeader, paymentRequirements, rejectionReason, usdcAtomicUnits } from "../src/http/x402.js";
import { getConfig } from "../src/config.js";
import { parseBlockscoutHolders, parseEtherscanHolders, parseGoPlusHolders } from "../src/services/marketData.js";
import { assertOutboundUrl, OutboundUrlError } from "../src/services/outbound.js";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

afterEach(() => {
  delete process.env.USAGE_STORE;
  delete process.env.REDIS_URL;
  delete process.env.DATABASE_URL;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.BILLING_MODE;
  delete process.env.X402_PAY_TO;
  resetConfigForTests();
});

describe("outbound URL policy", () => {
  it("allows public https and private http, and blocks metadata", () => {
    expect(assertOutboundUrl("https://base.blockscout.com/api").hostname).toBe("base.blockscout.com");
    expect(assertOutboundUrl("http://10.0.0.8:8545", { allowHttp: true, allowPrivate: true }).hostname).toBe("10.0.0.8");
    expect(() => assertOutboundUrl("http://example.com")).toThrow(OutboundUrlError);
    expect(() => assertOutboundUrl("https://169.254.169.254/latest")).toThrow(/metadata/);
    expect(() => assertOutboundUrl("https://user:pass@example.com")).toThrow(/credentials/);
    expect(() => assertOutboundUrl("https://127.0.0.1/secret")).toThrow(/public host/);
  });
});

describe("holder parsers", () => {
  it("reads blockscout and etherscan integer balances", () => {
    const blockscout = parseBlockscoutHolders(
      { status: "1", result: [{ address: "0x1111111111111111111111111111111111111111", value: "5" }] },
      40,
    );
    expect(blockscout?.holders[0]?.quantity).toBe(5n);
    expect(blockscout?.truncated).toBe(false);
    const etherscan = parseEtherscanHolders(
      { result: [{ TokenHolderAddress: "0x2222222222222222222222222222222222222222", TokenHolderQuantity: "9" }] },
      1,
    );
    expect(etherscan?.truncated).toBe(true);
    expect(parseEtherscanHolders({ result: "Max rate limit reached" }, 40)).toBeNull();
  });

  it("reads goplus shares as fractions of supply", () => {
    const token = getAddress(USDC);
    const holders = parseGoPlusHolders(
      { result: { [token.toLowerCase()]: { holders: [{ address: token, percent: "0.25" }] } } },
      token,
    );
    expect(holders?.[0]?.share).toBe(0.25);
    expect(holders?.[0]?.quantity).toBeNull();
  });
});

describe("usage store selection", () => {
  it("keeps memory as the fallback and refuses an ambiguous backend", async () => {
    expect(resolveUsageBackend({})).toBe("memory");
    const memory = new MemoryUsageStore();
    expect((await memory.increment("key:agent", 0.01)).usd).toBe(0.01);
    expect((await memory.increment("key:agent", 0.01)).calls).toBe(2);
    expect(usageKey("key:agent")).not.toContain("agent");
    expect(() =>
      resolveUsageBackend({ REDIS_URL: "redis://127.0.0.1:6379", DATABASE_URL: "postgres://localhost/db" }),
    ).toThrow(/USAGE_STORE/);
  });

  it("round-trips a counter through a local redis protocol server", async () => {
    const server = net.createServer((socket) => {
      socket.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        if (text.includes("PING")) socket.write("+PONG\r\n");
        else if (text.includes("EVAL")) socket.write("*2\r\n:4\r\n:7\r\n");
        else if (text.includes("HMGET")) socket.write("*2\r\n$1\r\n4\r\n$1\r\n7\r\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing port");
    const client = new RedisClient(`redis://127.0.0.1:${address.port}`);
    try {
      expect(await client.command(["PING"])).toBe("PONG");
      expect(await client.command(["EVAL", "return 1", "1", "k", "1", "1"])).toEqual([4, 7]);
      expect(await client.command(["HMGET", "k", "calls", "cents"])).toEqual(["4", "7"]);
    } finally {
      await client.close();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

describe("x402 requirements", () => {
  it("prices one cent as 10000 USDC atomic units", () => {
    expect(usdcAtomicUnits(0.01)).toBe("10000");
    process.env.BILLING_MODE = "x402";
    process.env.X402_PAY_TO = "0x000000000000000000000000000000000000dEaD";
    resetConfigForTests();
    const requirements = paymentRequirements(getConfig());
    expect(requirements.amount).toBe("10000");
    expect(requirements.scheme).toBe("exact");
    expect(requirements.extra.name).toBe("USD Coin");
    const header = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        accepted: requirements,
        payload: {
          signature: `0x${"ab".repeat(65)}`,
          authorization: {
            from: "0x0000000000000000000000000000000000000001",
            to: requirements.payTo,
            value: "10000",
            validAfter: "0",
            validBefore: "1700000030",
            nonce: `0x${"11".repeat(32)}`,
          },
        },
      }),
    ).toString("base64");
    const parsed = parsePaymentHeader(header);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const now = 1_700_000_000;
    expect(rejectionReason(parsed.payment, requirements, now)).toBeNull();
    const authorization = (parsed.payment.raw.payload as { authorization: { value: string; validBefore: string } }).authorization;
    authorization.value = "1";
    expect(rejectionReason(parsed.payment, requirements, now)).toMatch(/10000/);
    authorization.value = "10000";
    authorization.validBefore = "9999999999";
    expect(rejectionReason(parsed.payment, requirements, now)).toMatch(/maxTimeoutSeconds/);
  });
});
