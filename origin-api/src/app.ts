import { Hono } from "hono";
import { cors } from "hono/cors";
import { getConfig } from "./config.js";
import { parseTokenQuery } from "./domain/query.js";
import { billing, usageFor } from "./http/billing.js";
import { getUsageStore } from "./http/usageStore.js";
import { HttpError } from "./http/errors.js";
import { rateLimit } from "./http/rateLimit.js";
import { checkBaseToken } from "./services/safety.js";

type AppEnv = { Variables: { billingIdentity: string } };

export const app = new Hono<AppEnv>();

/** Default export is what Vercel’s Hono detector loads from `src/app.ts`. */
export default app;

app.use(
  "*",
  cors({
    exposeHeaders: [
      "X-Price-Usd",
      "X-Billing-Mode",
      "X-Usage-Calls",
      "X-Usage-Usd",
      "PAYMENT-REQUIRED",
      "PAYMENT-RESPONSE",
    ],
  }),
);
app.use("*", async (c, next) => {
  const started = Date.now();
  await next();
  console.log(JSON.stringify({ method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - started }));
});

app.get("/", (c) => {
  const config = getConfig();
  return c.json({
    service: "base-token-safety",
    description: "Pre-trade honeypot, tax, mint, and liquidity check for Base tokens.",
    endpoint: "/v1/token-safety?chain=base&address=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    priceUsd: config.priceUsd,
    chainId: 8453,
    billingMode: config.billingMode,
  });
});

app.get("/health", (c) => {
  const store = getUsageStore();
  return c.json({ ok: true, chainId: 8453, usageStore: store.kind, usageDegraded: store.degraded });
});

app.get("/v1/usage", billing({ meter: false }), async (c) => {
  const identity = c.get("billingIdentity") as string;
  const usage = await usageFor(identity);
  return c.json({ identity: identity.startsWith("key:") ? "api_key" : identity, ...usage });
});

// Solana and POST /v1/token-safety/batch are intentionally not registered.
// Add a chain module beside checkBaseToken, or map that function over a list.
app.get("/v1/token-safety", rateLimit(), billing({ meter: true }), async (c) => {
  const started = Date.now();
  try {
    const { address } = parseTokenQuery(new URL(c.req.url).searchParams);
    const report = await checkBaseToken(address);
    report.latencyMs = Date.now() - started;
    return c.json(report);
  } catch (error) {
    if (error instanceof HttpError) {
      return c.json({ error: error.code, message: error.message }, error.status as 400);
    }
    throw error;
  }
});

app.notFound((c) => c.json({ error: "not_found", message: "No route for that path." }, 404));

app.onError((error, c) => {
  if (error instanceof HttpError) {
    return c.json({ error: error.code, message: error.message }, error.status as 400);
  }
  console.error(error);
  return c.json({ error: "internal_error", message: "Token safety check failed." }, 500);
});
