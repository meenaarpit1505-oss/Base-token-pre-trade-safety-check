import { getAddress } from "viem";
import { app } from "../src/app.js";
import { clearSafetyCache, checkBaseToken } from "../src/services/safety.js";

const USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const chain = await app.request(
  "http://localhost/v1/token-safety?chain=solana&address=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
);
assert(chain.status === 400, `expected 400 for solana, got ${chain.status}`);

const samples: number[] = [];
let last: Awaited<ReturnType<typeof checkBaseToken>> | null = null;
for (let i = 0; i < 3; i++) {
  clearSafetyCache();
  const started = Date.now();
  last = await checkBaseToken(USDC);
  samples.push(Date.now() - started);
}

assert(last, "missing USDC report");
console.log(JSON.stringify({ samplesMs: samples, report: last }, null, 2));

assert(last.token.symbol === "USDC", `symbol ${last.token.symbol}`);
assert(last.token.decimals === 6, `decimals ${last.token.decimals}`);
assert(last.honeypot === false, "USDC was flagged as a honeypot");
assert(last.buyTax < 1, `buyTax ${last.buyTax}`);
assert(last.sellTax < 1, `sellTax ${last.sellTax}`);
assert(last.liquidityUsd > 1_000_000, `liquidityUsd ${last.liquidityUsd}`);
assert(last.ownerCanMint === true, "USDC mint authority was not detected");
assert(last.verdict === "caution", `verdict ${last.verdict}`);
assert(last.pool, "missing pool");
assert(last.simulation.status === "ok", `simulation ${last.simulation.status}`);
assert(Math.max(...samples) < 5_000, `latency ${samples.join(",")}`);

console.log(`integration ok. fresh latencies ms: ${samples.join(", ")}`);
