import { getAddress, isAddress, type Address } from "viem";
import { ZERO } from "./domain/addresses.js";
import { getConfig } from "./config.js";
import { ParseError, judgeGoPlusPayload, type Judgment, type TokenSafetyJudgment } from "./parser.js";
import { assertOutboundUrl } from "./services/outbound.js";

/**
 * Live GoPlus token-security fetch for Base (chain id 8453).
 *
 * Endpoint (public, no key required):
 * `GET {GOPLUS_BASE_URL}/api/v1/token_security/8453?contract_addresses={lowercase}`
 * Default base URL is `https://api.gopluslabs.io`.
 *
 * An access token is optional. When `GOPLUS_ACCESS_TOKEN` is set it is sent as
 * `Authorization: Bearer <token>` and is never written into the URL or logs.
 * `GOPLUS_TIMEOUT_MS` defaults to 8000 and must be at least 100.
 */
export const BASE_CHAIN_ID = 8453;
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 1_000_000;

export type ScannerErrorCode =
  | "invalid_address"
  | "timeout"
  | "http_error"
  | "empty_result"
  | "api_error"
  | "invalid_response"
  | "network"
  | "config";

export class ScannerError extends Error {
  readonly code: ScannerErrorCode;
  readonly status?: number;

  constructor(code: ScannerErrorCode, message: string, status?: number) {
    super(message);
    this.name = "ScannerError";
    this.code = code;
    this.status = status;
  }
}

export interface ScannerOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  accessToken?: string;
  timeoutMs?: number;
}

export function parseBaseTokenAddress(raw: string): Address {
  const trimmed = raw.trim();
  if (!isAddress(trimmed, { strict: false })) {
    throw new ScannerError(
      "invalid_address",
      "address must be a 20-byte hex string (0x plus 40 hex characters).",
    );
  }
  const address = getAddress(trimmed);
  if (address === ZERO) {
    throw new ScannerError("invalid_address", "address must not be the zero address.");
  }
  return address;
}

export async function scanBaseToken(address: string, options: ScannerOptions = {}): Promise<TokenSafetyJudgment> {
  const checksum = parseBaseTokenAddress(address);
  const payload = await fetchGoPlusTokenSecurity(checksum, options);
  try {
    return judgeGoPlusPayload(payload, checksum);
  } catch (error) {
    if (error instanceof ParseError) {
      throw new ScannerError(error.kind, error.message);
    }
    throw error;
  }
}

/** Agent-facing scan. `status` mirrors `judgment`. Extra GoPlus fields are included unchanged. */
export interface AgentSafetyReport extends TokenSafetyJudgment {
  status: Judgment;
}

export async function analyzeBaseToken(
  tokenAddress: string,
  options: ScannerOptions = {},
): Promise<AgentSafetyReport> {
  const judgment = await scanBaseToken(tokenAddress, options);
  return { ...judgment, status: judgment.judgment };
}

export async function fetchGoPlusTokenSecurity(address: string, options: ScannerOptions = {}): Promise<unknown> {
  const checksum = parseBaseTokenAddress(address);
  const settings = resolveSettings(options);
  const url = tokenSecurityUrl(settings.baseUrl, checksum);
  try {
    assertOutboundUrl(url.toString());
  } catch {
    throw new ScannerError("config", "GOPLUS_BASE_URL is not an allowed https URL.");
  }

  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": "BaseTokenSafety/1.0",
  };
  const authorization = authorizationHeader(settings.accessToken);
  if (authorization) headers.authorization = authorization;

  let response: Response;
  try {
    response = await settings.fetchImpl(url, {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(settings.timeoutMs),
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new ScannerError("timeout", `GoPlus token security request timed out after ${settings.timeoutMs}ms.`);
    }
    throw new ScannerError("network", "GoPlus token security request failed before a response arrived.");
  }

  if (!response.ok) {
    const hint =
      response.status === 401 || response.status === 403
        ? " Check GOPLUS_ACCESS_TOKEN."
        : "";
    throw new ScannerError(
      "http_error",
      `GoPlus token security request failed with HTTP ${response.status}.${hint}`,
      response.status,
    );
  }

  const text = await readLimited(response, MAX_RESPONSE_BYTES);
  if (!text.trim()) {
    throw new ScannerError("invalid_response", "GoPlus returned an empty body.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ScannerError("invalid_response", "GoPlus returned a body that was not JSON.");
  }
}

function resolveSettings(options: ScannerOptions): {
  fetchImpl: typeof fetch;
  baseUrl: string;
  accessToken: string;
  timeoutMs: number;
} {
  return {
    fetchImpl: options.fetchImpl ?? fetch,
    baseUrl: (options.baseUrl ?? getConfig().goplusBaseUrl).replace(/\/$/, ""),
    accessToken: options.accessToken ?? process.env.GOPLUS_ACCESS_TOKEN?.trim() ?? "",
    timeoutMs: options.timeoutMs ?? timeoutFromEnv(),
  };
}

function timeoutFromEnv(): number {
  const raw = process.env.GOPLUS_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 100) {
    throw new ScannerError("config", "GOPLUS_TIMEOUT_MS must be a number greater than or equal to 100.");
  }
  return value;
}

export function tokenSecurityUrl(baseUrl: string, address: Address): URL {
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/api/v1/token_security/${BASE_CHAIN_ID}`);
  url.searchParams.set("contract_addresses", address.toLowerCase());
  return url;
}

function authorizationHeader(accessToken: string): string | null {
  const token = accessToken.trim();
  if (!token) return null;
  return /^bearer\s+/i.test(token) ? token : `Bearer ${token}`;
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  return name === "TimeoutError" || name === "AbortError";
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const advertised = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(advertised) && advertised > maxBytes) {
    throw new ScannerError("invalid_response", "GoPlus response exceeded 1 MB.");
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) {
      throw new ScannerError("invalid_response", "GoPlus response exceeded 1 MB.");
    }
    return text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ScannerError("invalid_response", "GoPlus response exceeded 1 MB.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
