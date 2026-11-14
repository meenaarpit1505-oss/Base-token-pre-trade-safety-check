import { getAddress, isAddress } from "viem";
import { getConfig, type AppConfig } from "../config.js";
import { fetchOutbound } from "../services/outbound.js";

export const X402_VERSION = 2;

export interface PaymentRequirements {
  scheme: "exact";
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: {
    assetTransferMethod: "eip3009";
    name: string;
    version: string;
  };
}

export interface ParsedPayment {
  raw: Record<string, unknown>;
  payer: string;
  nonce: string;
  value: string;
  validBefore: number;
}

export interface FacilitatorOutcome {
  ok: boolean;
  reason: string;
  payer?: string;
  transaction?: string;
  network?: string;
}

const nonces = new Map<string, number>();

export function usdcAtomicUnits(priceUsd: number): string {
  const atomic = Math.round(priceUsd * 1_000_000);
  if (!Number.isSafeInteger(atomic) || atomic < 1) {
    throw new Error("PRICE_USD must convert to a positive USDC amount with 6 decimals");
  }
  return String(atomic);
}

export function paymentRequirements(config: AppConfig): PaymentRequirements {
  return {
    scheme: "exact",
    network: config.x402Network,
    amount: usdcAtomicUnits(config.priceUsd),
    asset: config.x402Asset,
    payTo: config.x402PayTo,
    maxTimeoutSeconds: config.x402MaxTimeoutSeconds,
    extra: {
      assetTransferMethod: "eip3009",
      name: config.x402AssetName,
      version: config.x402AssetVersion,
    },
  };
}

export const EXAMPLE_TOKEN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const BAZAAR_SERVICE_NAME = "Base Token Safety";
export const BAZAAR_TAGS = ["base", "token-safety", "defi", "pre-trade", "x402"] as const;

export interface PaymentRequiredOptions {
  /** HTTP method of the unpaid request. Defaults to GET. */
  method?: string;
  /** Override discovery type. Inferred from the resource path when omitted. */
  kind?: "http" | "mcp";
}

/** Strip query/hash so Bazaar catalogs one resource per path, not per token. */
export function canonicalResourceUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function inferKind(url: string): "http" | "mcp" {
  try {
    return new URL(url).pathname.toLowerCase().includes("/mcp") ? "mcp" : "http";
  } catch {
    return url.toLowerCase().includes("/mcp") ? "mcp" : "http";
  }
}

function httpMethod(method?: string): "GET" | "POST" {
  const upper = (method ?? "GET").toUpperCase();
  return upper === "POST" || upper === "PUT" || upper === "PATCH" ? "POST" : "GET";
}

const ORIGIN_OUTPUT_EXAMPLE = {
  schemaVersion: 1,
  chain: "base",
  chainId: 8453,
  address: EXAMPLE_TOKEN,
  verdict: "caution",
  honeypot: false,
  buyTax: 0,
  sellTax: 0,
  lpLockedPct: -1,
  liquidityUsd: 0,
  holdersTop10Pct: -1,
  reasons: [],
  notes: [],
};

/** x402 Bazaar discovery extension (info + validating schema). See https://docs.x402.org/extensions/bazaar */
export function bazaarExtension(resourceUrl: string, options: PaymentRequiredOptions = {}): Record<string, unknown> {
  const kind = options.kind ?? inferKind(resourceUrl);
  if (kind === "mcp") {
    const info = {
      input: {
        type: "mcp",
        toolName: "check_base_token_safety",
        description: "Pre-trade safety check for an ERC-20 on Base (chain 8453).",
        transport: "streamable-http",
        inputSchema: {
          type: "object",
          properties: {
            token_address: { type: "string", description: "ERC-20 contract address on Base mainnet (0x + 40 hex characters)." },
          },
          required: ["token_address"],
        },
        example: { token_address: EXAMPLE_TOKEN },
      },
      output: { type: "json", example: ORIGIN_OUTPUT_EXAMPLE },
    };
    return {
      info,
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          input: {
            type: "object",
            properties: {
              type: { type: "string", const: "mcp" },
              toolName: { type: "string" },
              description: { type: "string" },
              transport: { type: "string", enum: ["streamable-http", "sse"] },
              inputSchema: { type: "object" },
              example: { type: "object" },
            },
            required: ["type", "toolName", "inputSchema"],
            additionalProperties: false,
          },
          output: {
            type: "object",
            properties: { type: { type: "string" }, example: { type: "object" } },
            required: ["type"],
          },
        },
        required: ["input"],
      },
    };
  }

  const method = httpMethod(options.method);
  const isOriginPath = (() => {
    try {
      return new URL(canonicalResourceUrl(resourceUrl)).pathname.includes("/v1/token-safety");
    } catch {
      return resourceUrl.includes("/v1/token-safety");
    }
  })();
  const input =
    method === "POST"
      ? { type: "http", method: "POST", bodyType: "json", body: isOriginPath ? { chain: "base", address: EXAMPLE_TOKEN } : { token_address: EXAMPLE_TOKEN } }
      : {
          type: "http",
          method: "GET",
          queryParams: isOriginPath ? { chain: "base", address: EXAMPLE_TOKEN } : { token_address: EXAMPLE_TOKEN },
        };
  const inputProperties: Record<string, unknown> =
    method === "POST"
      ? {
          type: { type: "string", const: "http" },
          method: { type: "string", enum: ["POST", "PUT", "PATCH"] },
          bodyType: { type: "string", enum: ["json", "form-data", "text"] },
          body: { type: "object" },
          queryParams: { type: "object", additionalProperties: { type: "string" } },
          headers: { type: "object", additionalProperties: { type: "string" } },
        }
      : {
          type: { type: "string", const: "http" },
          method: { type: "string", enum: ["GET", "HEAD", "DELETE"] },
          queryParams: { type: "object", properties: isOriginPath ? { chain: { type: "string" }, address: { type: "string" } } : { token_address: { type: "string" } } },
          headers: { type: "object", additionalProperties: { type: "string" } },
        };
  const inputRequired = method === "POST" ? ["type", "method", "bodyType", "body"] : ["type", "method"];
  return {
    info: { input, output: { type: "json", example: ORIGIN_OUTPUT_EXAMPLE } },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        input: { type: "object", properties: inputProperties, required: inputRequired, additionalProperties: false },
        output: { type: "object", properties: { type: { type: "string" }, example: { type: "object" } }, required: ["type"] },
      },
      required: ["input"],
    },
  };
}

export function paymentRequiredDocument(
  config: AppConfig,
  resourceUrl: string,
  error: string,
  options: PaymentRequiredOptions = {},
): Record<string, unknown> {
  const accepts = config.x402PayTo ? [paymentRequirements(config)] : [];
  const url = canonicalResourceUrl(resourceUrl);
  const kind = options.kind ?? inferKind(resourceUrl);
  return {
    x402Version: X402_VERSION,
    error,
    resource: {
      url,
      description: "Base token safety check",
      mimeType: "application/json",
      serviceName: BAZAAR_SERVICE_NAME,
      tags: [...BAZAAR_TAGS],
    },
    accepts,
    extensions: { bazaar: bazaarExtension(resourceUrl, { ...options, kind }) },
  };
}

export function encodePaymentHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

export function parsePaymentHeader(header: string): { ok: true; payment: ParsedPayment } | { ok: false; reason: string } {
  const decoded = decodeHeader(header);
  if (!decoded.ok) return decoded;
  const raw = decoded.value;
  if (raw.x402Version !== X402_VERSION) return { ok: false, reason: "Only x402 version 2 payments are accepted." };
  const payload = raw.payload;
  if (!payload || typeof payload !== "object") return { ok: false, reason: "Payment payload is missing." };
  const authorization = (payload as { authorization?: unknown }).authorization;
  const signature = (payload as { signature?: unknown }).signature;
  if (!authorization || typeof authorization !== "object" || typeof signature !== "string") {
    return { ok: false, reason: "Payment payload must include an EIP-3009 authorization and signature." };
  }
  const auth = authorization as Record<string, unknown>;
  const from = stringField(auth, "from");
  const to = stringField(auth, "to");
  const value = stringField(auth, "value");
  const validAfter = stringField(auth, "validAfter");
  const validBefore = stringField(auth, "validBefore");
  const nonce = stringField(auth, "nonce");
  if (!from || !to || !value || !validAfter || !validBefore || !nonce) {
    return { ok: false, reason: "EIP-3009 authorization is incomplete." };
  }
  if (!isAddress(from) || !isAddress(to)) return { ok: false, reason: "Payment authorization addresses are invalid." };
  if (!/^\d+$/.test(value) || !/^\d+$/.test(validAfter) || !/^\d+$/.test(validBefore)) {
    return { ok: false, reason: "Payment authorization amounts must be decimal integers." };
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(nonce)) return { ok: false, reason: "Payment nonce must be a 32-byte hex value." };
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return { ok: false, reason: "Payment signature must be a 65-byte hex value." };
  }
  const accepted = raw.accepted;
  if (!accepted || typeof accepted !== "object") return { ok: false, reason: "Payment payload is missing accepted requirements." };
  return {
    ok: true,
    payment: {
      raw,
      payer: getAddress(from),
      nonce: nonce.toLowerCase(),
      value,
      validBefore: Number(validBefore),
    },
  };
}

export function rejectionReason(payment: ParsedPayment, requirements: PaymentRequirements, nowSec: number): string | null {
  const accepted = payment.raw.accepted as Record<string, unknown>;
  if (accepted.scheme !== requirements.scheme) return "Payment scheme must be exact.";
  if (accepted.network !== requirements.network) return `Payment network must be ${requirements.network}.`;
  if (typeof accepted.asset !== "string" || !same(accepted.asset, requirements.asset)) {
    return "Payment asset must be the configured USDC contract.";
  }
  if (typeof accepted.payTo !== "string" || !same(accepted.payTo, requirements.payTo)) {
    return "Payment recipient does not match X402_PAY_TO.";
  }
  if (accepted.amount !== requirements.amount) return `Payment amount must be ${requirements.amount} atomic units.`;
  const authorization = (payment.raw.payload as { authorization: Record<string, unknown> }).authorization;
  if (!same(String(authorization.to), requirements.payTo)) return "Authorization recipient does not match X402_PAY_TO.";
  if (String(authorization.value) !== requirements.amount) return `Authorization value must be ${requirements.amount}.`;
  const validAfter = Number(authorization.validAfter);
  const validBefore = Number(authorization.validBefore);
  if (!Number.isSafeInteger(validAfter) || !Number.isSafeInteger(validBefore) || validBefore <= validAfter) {
    return "Payment validity window is invalid.";
  }
  if (nowSec < validAfter || nowSec >= validBefore) return "Payment authorization is outside its validity window.";
  if (validBefore - nowSec > requirements.maxTimeoutSeconds) {
    return "Payment validity window is longer than maxTimeoutSeconds.";
  }
  const extra = accepted.extra;
  if (extra && typeof extra === "object") {
    const method = (extra as { assetTransferMethod?: unknown }).assetTransferMethod;
    if (method !== undefined && method !== "eip3009") {
      return "Only EIP-3009 transferWithAuthorization payments are accepted.";
    }
  }
  return null;
}

export function reserveNonce(nonce: string, holdMs: number): boolean {
  const now = Date.now();
  for (const [key, expiry] of nonces) {
    if (expiry <= now) nonces.delete(key);
  }
  const key = nonce.toLowerCase();
  const expiry = nonces.get(key);
  if (expiry && expiry > now) return false;
  nonces.set(key, now + holdMs);
  return true;
}

export function releaseNonce(nonce: string): void {
  nonces.delete(nonce.toLowerCase());
}

export function holdNonce(nonce: string, untilSec: number): void {
  nonces.set(nonce.toLowerCase(), Math.max(Date.now() + 60_000, untilSec * 1000));
}

export function resetNoncesForTests(): void {
  nonces.clear();
}

export async function facilitatorCall(
  kind: "verify" | "settle",
  payment: Record<string, unknown>,
  requirements: PaymentRequirements,
): Promise<FacilitatorOutcome> {
  const config = getConfig();
  if (!config.x402FacilitatorUrl) return { ok: false, reason: "x402 facilitator is not configured." };
  const endpoint = new URL(kind, config.x402FacilitatorUrl.endsWith("/") ? config.x402FacilitatorUrl : `${config.x402FacilitatorUrl}/`);
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (config.x402FacilitatorAuth) headers.authorization = authorizationHeader(config.x402FacilitatorAuth);
  const timeoutMs = kind === "verify" ? config.x402VerifyTimeoutMs : config.x402SettleTimeoutMs;
  const local = isLocal(endpoint.hostname);
  const result = await fetchOutbound(endpoint.toString(), {
    method: "POST",
    timeoutMs,
    policy: { allowHttp: local, allowPrivate: true },
    headers,
    body: JSON.stringify({ x402Version: X402_VERSION, paymentPayload: payment, paymentRequirements: requirements }),
    maxBytes: 100_000,
  });
  if (!result) return { ok: false, reason: "x402 facilitator did not respond." };
  const body = result.body && typeof result.body === "object" ? (result.body as Record<string, unknown>) : {};
  if (kind === "verify") {
    if (result.ok && body.isValid === true) {
      const payer = typeof body.payer === "string" && isAddress(body.payer) ? getAddress(body.payer) : undefined;
      return { ok: true, reason: "", payer };
    }
    return { ok: false, reason: reasonText(body.invalidReason) };
  }
  if (result.ok && body.success === true) {
    return {
      ok: true,
      reason: "",
      payer: typeof body.payer === "string" && isAddress(body.payer) ? getAddress(body.payer) : undefined,
      transaction: typeof body.transaction === "string" ? body.transaction : undefined,
      network: typeof body.network === "string" ? body.network : undefined,
    };
  }
  return { ok: false, reason: reasonText(body.errorReason ?? body.invalidReason) };
}

function decodeHeader(header: string): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  const trimmed = header.trim();
  if (!trimmed || trimmed.length > 12_000) return { ok: false, reason: "Payment header is empty or too large." };
  try {
    const json = trimmed.startsWith("{") ? trimmed : Buffer.from(trimmed, "base64").toString("utf8");
    const value = JSON.parse(json) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, reason: "Payment header is not a JSON object." };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, reason: "Payment header is not valid base64 JSON." };
  }
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 && value.length < 200 ? value : null;
}

function same(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function reasonText(value: unknown): string {
  if (typeof value === "string" && /^[a-z0-9_]{1,64}$/i.test(value)) return `Payment was rejected (${value}).`;
  return "Payment was rejected by the facilitator.";
}

function authorizationHeader(value: string): string {
  return /^[A-Za-z][A-Za-z0-9._-]*\s+\S+$/.test(value) ? value : `Bearer ${value}`;
}

function isLocal(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function settlementGap(config: AppConfig): string | null {
  if (config.x402PayTo && config.x402FacilitatorUrl) return null;
  const missing = [
    config.x402PayTo ? null : "X402_PAY_TO",
    config.x402FacilitatorUrl ? null : "X402_FACILITATOR_URL",
  ].filter(Boolean);
  return `Real x402 settlement is not live yet. Set ${missing.join(" and ")}.`;
}
