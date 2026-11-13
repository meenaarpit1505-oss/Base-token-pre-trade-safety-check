import { isIP } from "node:net";

export class OutboundUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundUrlError";
  }
}

export interface OutboundPolicy {
  /** Allow http:// to a private or loopback host. Public hosts still require https. */
  allowHttp?: boolean;
  /** Allow loopback, RFC1918, and link-local hosts. Cloud metadata addresses stay blocked. */
  allowPrivate?: boolean;
}

const METADATA_HOSTS = new Set(["169.254.169.254", "metadata.google.internal", "fd00:ec2::254"]);

export function assertOutboundUrl(raw: string, policy: OutboundPolicy = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OutboundUrlError("outbound URL is not absolute");
  }
  if (url.username || url.password) {
    throw new OutboundUrlError("outbound URL must not include credentials");
  }
  const host = hostname(url);
  if (!host) throw new OutboundUrlError("outbound URL is missing a host");
  if (METADATA_HOSTS.has(host) || isMetadataAddress(host)) {
    throw new OutboundUrlError("outbound URL points at a metadata address");
  }
  const privateHost = isPrivateHost(host);
  if (url.protocol === "https:") {
    if (privateHost && !policy.allowPrivate) throw new OutboundUrlError("outbound URL must be a public host");
    return url;
  }
  if (url.protocol === "http:" && policy.allowHttp && privateHost) return url;
  throw new OutboundUrlError("outbound URL must use https");
}

export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length > 0) {
      const last = parts[parts.length - 1] ?? "";
      if (last.length >= 12) parts[parts.length - 1] = `${last.slice(0, 4)}…`;
      url.pathname = `/${parts.join("/")}`;
    }
    return url.toString();
  } catch {
    return "invalid-url";
  }
}

export interface OutboundResult {
  ok: boolean;
  status: number;
  body: unknown | null;
}

export async function fetchOutbound(
  rawUrl: string,
  options: {
    timeoutMs: number;
    policy?: OutboundPolicy;
    headers?: Record<string, string>;
    method?: "GET" | "POST";
    body?: string;
    maxBytes?: number;
  },
): Promise<OutboundResult | null> {
  let url: URL;
  try {
    url = assertOutboundUrl(rawUrl, options.policy);
  } catch {
    return null;
  }
  const maxBytes = options.maxBytes ?? 1_000_000;
  try {
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: options.headers,
      body: options.body,
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    const advertised = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(advertised) && advertised > maxBytes) return { ok: false, status: response.status, body: null };
    const text = await readLimited(response, maxBytes);
    if (text === null) return { ok: false, status: response.status, body: null };
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = null;
      }
    }
    return { ok: response.ok, status: response.status, body };
  } catch {
    return null;
  }
}

export async function fetchJson(
  rawUrl: string,
  options: {
    timeoutMs: number;
    policy?: OutboundPolicy;
    headers?: Record<string, string>;
    maxBytes?: number;
  },
): Promise<unknown | null> {
  const result = await fetchOutbound(rawUrl, options);
  if (!result?.ok) return null;
  return result.body;
}

function hostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

function isMetadataAddress(host: string): boolean {
  return host.startsWith("169.254.169.");
}

function isPrivateHost(host: string): boolean {
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }
  const version = isIP(host);
  if (version === 4) return isPrivateV4(host);
  if (version === 6) return isPrivateV6(host);
  return false;
}

function isPrivateV4(host: string): boolean {
  const parts = host.split(".").map((part) => Number(part));
  const a = parts[0] ?? -1;
  const b = parts[1] ?? -1;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateV6(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === "::1" || normalized === "::") return true;
  if (normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("::ffff:")) {
    const v4 = normalized.slice("::ffff:".length);
    if (isIP(v4) === 4) return isPrivateV4(v4);
  }
  return false;
}

async function readLimited(response: Response, maxBytes: number): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    return Buffer.byteLength(text) > maxBytes ? null : text;
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
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
