import type { Context, MiddlewareHandler } from "hono";
import { getConfig, type BillingMode } from "../config.js";
import { getUsageStore } from "./usageStore.js";
import {
  encodePaymentHeader,
  facilitatorCall,
  holdNonce,
  parsePaymentHeader,
  paymentRequiredDocument,
  paymentRequirements,
  rejectionReason,
  releaseNonce,
  reserveNonce,
  settlementGap,
  usdcAtomicUnits,
} from "./x402.js";

export { resetUsageForTests, usageKey } from "./usageStore.js";

export async function usageFor(identity: string): Promise<{ calls: number; usd: number }> {
  return getUsageStore().get(identity);
}

function unauthorized(c: Context, mode: BillingMode, message?: string): Response {
  if (mode === "x402") return paymentRequired(c, message ?? unpaidMessage());
  return Response.json(
    { error: "unauthorized", message: "Send a valid X-Api-Key. Configure API_KEYS when BILLING_MODE=api_key." },
    { status: 401 },
  );
}

function unpaidMessage(): string {
  const config = getConfig();
  const gap = settlementGap(config);
  if (config.x402AcceptStub) {
    return gap
      ? `Send PAYMENT-SIGNATURE as base64 x402 v2 JSON, or X-Payment: stub:<client-id>. ${gap}`
      : "Send PAYMENT-SIGNATURE as base64 x402 v2 JSON, or X-Payment: stub:<client-id>.";
  }
  return gap ?? "Send PAYMENT-SIGNATURE as a base64 x402 version 2 payment payload.";
}

function paymentRequired(c: Context, message: string): Response {
  const config = getConfig();
  const document = paymentRequiredDocument(config, c.req.url, message);
  let amount = "0";
  try {
    amount = usdcAtomicUnits(config.priceUsd);
  } catch {
    amount = "0";
  }
  const response = Response.json(
    {
      error: "payment_required",
      message,
      priceUsd: config.priceUsd,
      payTo: config.x402PayTo,
      network: config.x402Network,
      scheme: "x402",
      x402Version: 2,
      amount,
      asset: config.x402Asset,
      accepts: document.accepts,
    },
    { status: 402 },
  );
  response.headers.set("PAYMENT-REQUIRED", encodePaymentHeader(document));
  response.headers.set("X-Price-Usd", config.priceUsd.toFixed(2));
  response.headers.set("X-Billing-Mode", config.billingMode);
  return response;
}

export async function identify(c: Context): Promise<{ identity: string; nonce?: string; raw?: Record<string, unknown> } | Response> {
  const config = getConfig();
  c.header("X-Price-Usd", config.priceUsd.toFixed(2));
  c.header("X-Billing-Mode", config.billingMode);
  if (config.billingMode === "open") return { identity: "anonymous" };
  if (config.billingMode === "api_key") {
    const key = c.req.header("x-api-key")?.trim() ?? "";
    if (!key || key.length > 256 || !config.apiKeys.has(key)) return unauthorized(c, "api_key");
    return { identity: `key:${key}` };
  }
  const payment = c.req.header("payment-signature")?.trim() || c.req.header("x-payment")?.trim() || "";
  if (!payment || payment.length > 12_000) return unauthorized(c, "x402");
  if (config.x402AcceptStub && payment.startsWith("stub:")) {
    if (!/^stub:[A-Za-z0-9._:-]{1,64}$/.test(payment)) return unauthorized(c, "x402", "X-Payment stub must look like stub:<client-id>.");
    return { identity: `x402:${payment.slice(0, 64)}` };
  }
  const gap = settlementGap(config);
  if (gap) return unauthorized(c, "x402", `${gap} No payment was submitted.`);
  const parsed = parsePaymentHeader(payment);
  if (!parsed.ok) return unauthorized(c, "x402", parsed.reason);
  const requirements = paymentRequirements(config);
  const reason = rejectionReason(parsed.payment, requirements, Math.floor(Date.now() / 1000));
  if (reason) return unauthorized(c, "x402", reason);
  if (!reserveNonce(parsed.payment.nonce, 120_000)) {
    return unauthorized(c, "x402", "This payment nonce is already in use.");
  }
  const verified = await facilitatorCall("verify", parsed.payment.raw, requirements);
  if (!verified.ok) {
    releaseNonce(parsed.payment.nonce);
    return unauthorized(c, "x402", verified.reason);
  }
  return {
    identity: `x402:${(verified.payer ?? parsed.payment.payer).toLowerCase()}`,
    nonce: parsed.payment.nonce,
    raw: parsed.payment.raw,
  };
}

export function billing(options: { meter: boolean }): MiddlewareHandler {
  return async (c, next) => {
    const identified = await identify(c);
    if (identified instanceof Response) return identified;
    c.set("billingIdentity", identified.identity);
    await next();
    if (identified.nonce && c.res.status !== 200) releaseNonce(identified.nonce);
    if (!options.meter || c.res.status !== 200) return;
    if (identified.nonce && identified.raw) {
      const config = getConfig();
      const settled = await facilitatorCall("settle", identified.raw, paymentRequirements(config));
      if (!settled.ok) {
        releaseNonce(identified.nonce);
        return paymentRequired(c, settled.reason);
      }
      const validBefore = Number(
        ((identified.raw.payload as { authorization?: { validBefore?: string } } | undefined)?.authorization?.validBefore) ?? 0,
      );
      holdNonce(identified.nonce, Number.isFinite(validBefore) ? validBefore : 0);
      c.res.headers.set(
        "PAYMENT-RESPONSE",
        encodePaymentHeader({
          success: true,
          payer: settled.payer ?? identified.identity.replace(/^x402:/, ""),
          transaction: settled.transaction ?? "",
          network: settled.network ?? config.x402Network,
        }),
      );
    }
    const usageRow = await getUsageStore().increment(identified.identity, getConfig().priceUsd);
    c.res.headers.set("X-Usage-Calls", String(usageRow.calls));
    c.res.headers.set("X-Usage-Usd", usageRow.usd.toFixed(2));
  };
}
