import { afterEach, describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { app } from "../src/app.js";
import { resetConfigForTests } from "../src/config.js";
import { resetUsageForTests, usageFor } from "../src/http/billing.js";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

afterEach(async () => {
  delete process.env.BILLING_MODE;
  delete process.env.API_KEYS;
  delete process.env.X402_ACCEPT_STUB;
  delete process.env.X402_PAY_TO;
  delete process.env.X402_FACILITATOR_URL;
  delete process.env.PRICE_USD;
  delete process.env.REDIS_URL;
  delete process.env.DATABASE_URL;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.USAGE_STORE;
  resetConfigForTests();
  await resetUsageForTests();
});

describe("HTTP surface", () => {
  it("describes the service and a health check", async () => {
    const root = await app.request("http://localhost/");
    expect(root.status).toBe(200);
    const body = (await root.json()) as { endpoint: string; priceUsd: number };
    expect(body.endpoint).toContain("/v1/token-safety");
    expect(body.priceUsd).toBe(0.01);
    const health = await app.request("http://localhost/health");
    expect(health.status).toBe(200);
  });

  it("returns 400 for a bad chain or address without calling a node", async () => {
    const chain = await app.request(`http://localhost/v1/token-safety?chain=solana&address=${USDC}`);
    expect(chain.status).toBe(400);
    expect(((await chain.json()) as { error: string }).error).toBe("unsupported_chain");

    const address = await app.request("http://localhost/v1/token-safety?chain=base&address=0xnope");
    expect(address.status).toBe(400);
    expect(((await address.json()) as { error: string }).error).toBe("invalid_address");
    expect(chain.headers.get("x-price-usd")).toBe("0.01");
  });

  it("requires an API key when billing mode is api_key", async () => {
    process.env.BILLING_MODE = "api_key";
    process.env.API_KEYS = "agent-key";
    resetConfigForTests();
    const denied = await app.request(`http://localhost/v1/token-safety?chain=base&address=${USDC}`);
    expect(denied.status).toBe(401);

    const accepted = await app.request(`http://localhost/v1/token-safety?chain=base&address=0x1234`, {
      headers: { "x-api-key": "agent-key" },
    });
    expect(accepted.status).toBe(400);
    expect((await usageFor("key:agent-key")).calls).toBe(0);
  });

  it("returns 402 until the x402 stub header is present", async () => {
    process.env.BILLING_MODE = "x402";
    process.env.X402_ACCEPT_STUB = "true";
    resetConfigForTests();
    const unpaid = await app.request(`http://localhost/v1/token-safety?chain=base&address=${USDC}`);
    expect(unpaid.status).toBe(402);
    const body = (await unpaid.json()) as { priceUsd: number; scheme: string };
    expect(body.priceUsd).toBe(0.01);
    expect(body.scheme).toBe("x402");

    const paid = await app.request("http://localhost/v1/token-safety?chain=base&address=0x1234", {
      headers: { "x-payment": "stub:agent-1" },
    });
    expect(paid.status).toBe(400);
  });

  it("advertises an exact USDC price when a pay-to address is configured", async () => {
    process.env.BILLING_MODE = "x402";
    process.env.PRICE_USD = "0.01";
    const payTo = getAddress("0x000000000000000000000000000000000000dEaD");
    process.env.X402_PAY_TO = payTo;
    resetConfigForTests();
    const unpaid = await app.request(`http://localhost/v1/token-safety?chain=base&address=${USDC}`);
    expect(unpaid.status).toBe(402);
    const body = (await unpaid.json()) as {
      scheme: string;
      amount: string;
      accepts: Array<{ scheme: string; amount: string; network: string; asset: string; payTo: string }>;
    };
    expect(body.scheme).toBe("x402");
    expect(body.amount).toBe("10000");
    expect(body.accepts[0]?.scheme).toBe("exact");
    expect(body.accepts[0]?.network).toBe("eip155:8453");
    expect(body.accepts[0]?.asset.toLowerCase()).toBe(USDC.toLowerCase());
    expect(body.accepts[0]?.payTo).toBe(payTo);
    const encoded = unpaid.headers.get("payment-required");
    expect(encoded).toBeTruthy();
    const required = JSON.parse(Buffer.from(encoded ?? "", "base64").toString("utf8")) as { x402Version: number };
    expect(required.x402Version).toBe(2);
  });
});
