import { getAddress, isAddress } from "viem";
import { USDC } from "./domain/addresses.js";
import { assertOutboundUrl } from "./services/outbound.js";

export type BillingMode = "open" | "api_key" | "x402";
export type UsageBackend = "memory" | "redis" | "postgres";
export type HolderSourceName = "blockscout" | "goplus" | "etherscan";

export interface AppConfig {
  port: number;
  rpcUrls: string[];
  etherscanApiKey: string;
  sourcifyBaseUrl: string;
  blockscoutBaseUrl: string;
  goplusBaseUrl: string;
  holderSources: Set<HolderSourceName>;
  holderCacheTtlMs: number;
  cacheTtlMs: number;
  priceUsd: number;
  billingMode: BillingMode;
  apiKeys: Set<string>;
  usageBackend: UsageBackend;
  redisUrl: string;
  upstashRedisRestUrl: string;
  upstashRedisRestToken: string;
  databaseUrl: string;
  x402PayTo: string;
  x402AcceptStub: boolean;
  x402FacilitatorUrl: string;
  x402FacilitatorAuth: string;
  x402Network: string;
  x402Asset: string;
  x402AssetName: string;
  x402AssetVersion: string;
  x402MaxTimeoutSeconds: number;
  x402VerifyTimeoutMs: number;
  x402SettleTimeoutMs: number;
  simTimeoutMs: number;
  holdersTimeoutMs: number;
  sourceTimeoutMs: number;
  discoveryTimeoutMs: number;
  rateLimitPerMin: number;
}

let cached: AppConfig | null = null;

const HOLDER_SOURCE_NAMES = new Set<HolderSourceName>(["blockscout", "goplus", "etherscan"]);

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return value;
}

function billingMode(raw: string | undefined): BillingMode {
  const mode = (raw ?? "open").trim().toLowerCase();
  if (mode === "open" || mode === "api_key" || mode === "x402") return mode;
  throw new Error("BILLING_MODE must be open, api_key, or x402");
}

export function resolveUsageBackend(env: NodeJS.ProcessEnv = process.env): UsageBackend {
  const choice = (env.USAGE_STORE ?? "").trim().toLowerCase();
  const redis = Boolean(env.REDIS_URL?.trim() || (env.UPSTASH_REDIS_REST_URL?.trim() && env.UPSTASH_REDIS_REST_TOKEN?.trim()));
  const postgres = Boolean(env.DATABASE_URL?.trim());
  if (choice === "memory") return "memory";
  if (choice === "redis") {
    if (!redis) {
      throw new Error("USAGE_STORE=redis requires REDIS_URL or both UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN");
    }
    return "redis";
  }
  if (choice === "postgres") {
    if (!postgres) throw new Error("USAGE_STORE=postgres requires DATABASE_URL");
    return "postgres";
  }
  if (choice) throw new Error("USAGE_STORE must be memory, redis, or postgres");
  if (redis && postgres) {
    throw new Error("Set USAGE_STORE=redis or USAGE_STORE=postgres when both a Redis URL and DATABASE_URL are set");
  }
  if (postgres) return "postgres";
  if (redis) return "redis";
  return "memory";
}

export function getConfig(): AppConfig {
  if (cached) return cached;
  const primary = process.env.BASE_RPC_URL?.trim() || "https://mainnet.base.org";
  const fallbacks = (process.env.BASE_RPC_FALLBACKS ?? "https://base.publicnode.com,https://1rpc.io/base")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const rpcUrls = [...new Set([primary, ...fallbacks])].map((url) => publicOrPrivateRpc(url));
  const keys = (process.env.API_KEYS ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const mode = billingMode(process.env.BILLING_MODE);
  const priceUsd = num("PRICE_USD", 0.01);
  if (mode === "x402") {
    const atomic = Math.round(priceUsd * 1_000_000);
    if (!Number.isSafeInteger(atomic) || atomic < 1) {
      throw new Error("PRICE_USD must convert to a positive USDC amount with 6 decimals when BILLING_MODE=x402");
    }
  }
  const asset = tokenAddress("X402_ASSET", process.env.X402_ASSET, USDC);
  const defaultUsdc = asset.toLowerCase() === USDC.toLowerCase();
  const assetName = process.env.X402_ASSET_NAME?.trim() || (defaultUsdc ? "USD Coin" : "");
  const assetVersion = process.env.X402_ASSET_VERSION?.trim() || (defaultUsdc ? "2" : "");
  const payTo = payToAddress(process.env.X402_PAY_TO);
  if (mode === "x402" && payTo && (!assetName || !assetVersion)) {
    throw new Error("X402_ASSET_NAME and X402_ASSET_VERSION are required when X402_ASSET is not Base USDC");
  }
  cached = {
    port: num("PORT", 8787),
    rpcUrls,
    etherscanApiKey: process.env.ETHERSCAN_API_KEY?.trim() ?? "",
    sourcifyBaseUrl: publicBase("SOURCIFY_BASE_URL", process.env.SOURCIFY_BASE_URL, "https://sourcify.dev/server"),
    blockscoutBaseUrl: publicBase("BLOCKSCOUT_BASE_URL", process.env.BLOCKSCOUT_BASE_URL, "https://base.blockscout.com"),
    goplusBaseUrl: publicBase("GOPLUS_BASE_URL", process.env.GOPLUS_BASE_URL, "https://api.gopluslabs.io"),
    holderSources: holderSources(process.env.HOLDER_SOURCES),
    holderCacheTtlMs: num("HOLDER_CACHE_TTL_MS", 600_000),
    cacheTtlMs: num("CACHE_TTL_MS", 20_000),
    priceUsd,
    billingMode: mode,
    apiKeys: new Set(keys),
    usageBackend: resolveUsageBackend(),
    redisUrl: redisUrl(process.env.REDIS_URL),
    upstashRedisRestUrl: process.env.UPSTASH_REDIS_REST_URL?.trim() ?? "",
    upstashRedisRestToken: process.env.UPSTASH_REDIS_REST_TOKEN?.trim() ?? "",
    databaseUrl: process.env.DATABASE_URL?.trim() ?? "",
    x402PayTo: payTo,
    x402AcceptStub: (process.env.X402_ACCEPT_STUB ?? "true").toLowerCase() !== "false",
    x402FacilitatorUrl: facilitatorUrl(process.env.X402_FACILITATOR_URL),
    x402FacilitatorAuth: process.env.X402_FACILITATOR_AUTH?.trim() ?? "",
    x402Network: caipNetwork(process.env.X402_NETWORK),
    x402Asset: asset,
    x402AssetName: assetName,
    x402AssetVersion: assetVersion,
    x402MaxTimeoutSeconds: Math.min(3600, Math.max(1, num("X402_MAX_TIMEOUT_SECONDS", 60) || 60)),
    x402VerifyTimeoutMs: Math.max(100, num("X402_VERIFY_TIMEOUT_MS", 2_500) || 2_500),
    x402SettleTimeoutMs: Math.max(100, num("X402_SETTLE_TIMEOUT_MS", 8_000) || 8_000),
    simTimeoutMs: num("SIM_TIMEOUT_MS", 1200),
    holdersTimeoutMs: num("HOLDERS_TIMEOUT_MS", 900),
    sourceTimeoutMs: num("SOURCE_TIMEOUT_MS", 500),
    discoveryTimeoutMs: num("DISCOVERY_TIMEOUT_MS", 1500),
    rateLimitPerMin: num("RATE_LIMIT_PER_MIN", 120),
  };
  return cached;
}

export function resetConfigForTests(): void {
  cached = null;
}

function publicBase(name: string, raw: string | undefined, fallback: string): string {
  const value = (raw?.trim() || fallback).replace(/\/$/, "");
  try {
    const url = assertOutboundUrl(value);
    const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
    return `${url.origin}${path}`;
  } catch (error) {
    throw new Error(`${name} is not allowed: ${error instanceof Error ? error.message : "invalid URL"}`);
  }
}

function publicOrPrivateRpc(raw: string): string {
  try {
    assertOutboundUrl(raw, { allowHttp: true, allowPrivate: true });
    return raw;
  } catch (error) {
    throw new Error(`RPC URL is not allowed: ${error instanceof Error ? error.message : "invalid URL"}`);
  }
}

function facilitatorUrl(raw: string | undefined): string {
  const value = raw?.trim() ?? "";
  if (!value) return "";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("X402_FACILITATOR_URL is not a valid URL");
  }
  const host = url.hostname.toLowerCase();
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1";
  try {
    assertOutboundUrl(value, { allowHttp: local, allowPrivate: true });
  } catch (error) {
    throw new Error(`X402_FACILITATOR_URL is not allowed: ${error instanceof Error ? error.message : "invalid URL"}`);
  }
  return value.replace(/\/$/, "");
}

function payToAddress(raw: string | undefined): string {
  const value = raw?.trim() ?? "";
  if (!value) return "";
  if (!isAddress(value)) throw new Error("X402_PAY_TO must be an EVM address");
  const address = getAddress(value);
  if (address === "0x0000000000000000000000000000000000000000") {
    throw new Error("X402_PAY_TO must not be the zero address");
  }
  return address;
}

function tokenAddress(name: string, raw: string | undefined, fallback: string): string {
  const value = raw?.trim() || fallback;
  if (!isAddress(value)) throw new Error(`${name} must be an EVM address`);
  return getAddress(value);
}

function caipNetwork(raw: string | undefined): string {
  const value = (raw ?? "eip155:8453").trim();
  if (!/^eip155:[1-9]\d*$/.test(value)) throw new Error("X402_NETWORK must be a CAIP-2 eip155 identifier");
  return value;
}

function holderSources(raw: string | undefined): Set<HolderSourceName> {
  const parts = (raw ?? "blockscout,goplus,etherscan")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) throw new Error("HOLDER_SOURCES must list at least one of blockscout, goplus, etherscan");
  const names = new Set<HolderSourceName>();
  for (const part of parts) {
    if (!HOLDER_SOURCE_NAMES.has(part as HolderSourceName)) {
      throw new Error("HOLDER_SOURCES must list blockscout, goplus, or etherscan");
    }
    names.add(part as HolderSourceName);
  }
  return names;
}

function redisUrl(raw: string | undefined): string {
  const value = raw?.trim() ?? "";
  if (!value) return "";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("REDIS_URL is not a valid URL");
  }
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error("REDIS_URL must use redis:// or rediss://");
  }
  return value;
}
