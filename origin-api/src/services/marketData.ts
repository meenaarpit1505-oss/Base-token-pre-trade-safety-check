import type { Address } from "viem";
import { getConfig } from "../config.js";
import type { HolderBalance } from "../domain/holders.js";
import type { AbiItem } from "../domain/selectors.js";
import { fetchJson } from "./outbound.js";

export type HolderSource = "etherscan" | "blockscout" | "goplus" | "unavailable";

export interface HolderRead {
  holders: HolderBalance[] | null;
  source: HolderSource;
  /** True when a later holder might exist beyond this page. */
  truncated: boolean;
}

export interface AbiRead {
  abi: AbiItem[] | null;
  verified: boolean;
}

const UNAVAILABLE: HolderRead = { holders: null, source: "unavailable", truncated: false };
const HOLDER_PAGE = 40;
const BACKGROUND_MS = 4_000;
const NEGATIVE_MS = 15_000;
const INDEX_HEADERS = {
  accept: "application/json",
  "user-agent": "Mozilla/5.0 (compatible; BaseTokenSafety/1.0)",
};

interface CacheEntry {
  read: HolderRead;
  expires: number;
  rank: number;
}

let generation = 0;
const cache = new Map<string, CacheEntry>();
const negative = new Map<string, number>();
const inflight = new Map<string, Promise<HolderRead>>();

export function clearHolderCache(): void {
  generation += 1;
  cache.clear();
  negative.clear();
  inflight.clear();
}

export async function fetchVerifiedAbi(token: Address, timeoutMs: number): Promise<AbiRead> {
  const config = getConfig();
  const jobs: Promise<unknown | null>[] = [
    fetchJson(`${config.sourcifyBaseUrl}/v2/contract/8453/${token}?fields=abi`, {
      timeoutMs,
      headers: INDEX_HEADERS,
    }),
  ];
  if (config.etherscanApiKey) {
    jobs.push(fetchJson(etherscanUrl(token, "contract", "getsourcecode", config.etherscanApiKey), {
      timeoutMs,
      headers: INDEX_HEADERS,
    }));
  }
  const payloads = await Promise.all(jobs);
  for (const payload of payloads) {
    const abi = parseAbi(payload);
    if (abi && abi.length > 0) return { abi, verified: true };
  }
  return { abi: null, verified: false };
}

export async function fetchHolders(token: Address, timeoutMs: number): Promise<HolderRead> {
  const key = token.toLowerCase();
  const fresh = readCache(key);
  if (fresh) return fresh;
  const deniedUntil = negative.get(key) ?? 0;
  if (deniedUntil > Date.now() && !inflight.has(key)) return UNAVAILABLE;

  const gen = generation;
  let pending = inflight.get(key);
  if (!pending) {
    pending = loadHolders(token, gen).finally(() => {
      if (inflight.get(key) === pending) inflight.delete(key);
    });
    inflight.set(key, pending);
    void pending.then((read) => {
      if (gen !== generation) return;
      if (!read.holders) negative.set(key, Date.now() + NEGATIVE_MS);
    });
  }

  let timer: NodeJS.Timeout | undefined;
  const timed = new Promise<HolderRead>((resolve) => {
    timer = setTimeout(() => resolve(readCache(key) ?? UNAVAILABLE), Math.max(1, timeoutMs));
  });
  const result = await Promise.race([pending, timed]);
  if (timer) clearTimeout(timer);
  return result.holders ? result : readCache(key) ?? result;
}

async function loadHolders(token: Address, gen: number): Promise<HolderRead> {
  const jobs = holderJobs(token);
  if (jobs.length === 0) return UNAVAILABLE;
  return new Promise((resolve) => {
    let remaining = jobs.length;
    let settled = false;
    const finish = (read: HolderRead) => {
      if (gen === generation && read.holders && read.holders.length > 0) remember(token.toLowerCase(), read);
      if (!settled && read.holders && read.holders.length > 0) {
        settled = true;
        resolve(read);
      }
      remaining -= 1;
      if (remaining === 0 && !settled) {
        settled = true;
        resolve(UNAVAILABLE);
      }
    };
    for (const job of jobs) {
      job.then(finish, () => finish(UNAVAILABLE));
    }
  });
}

function holderJobs(token: Address): Promise<HolderRead>[] {
  const config = getConfig();
  const jobs: Promise<HolderRead>[] = [];
  if (config.holderSources.has("blockscout")) jobs.push(fetchBlockscout(token));
  if (config.holderSources.has("goplus")) jobs.push(fetchGoPlus(token));
  if (config.holderSources.has("etherscan") && config.etherscanApiKey) jobs.push(fetchEtherscan(token));
  return jobs;
}

async function fetchBlockscout(token: Address): Promise<HolderRead> {
  const config = getConfig();
  const url = new URL("/api", `${config.blockscoutBaseUrl}/`);
  url.searchParams.set("module", "token");
  url.searchParams.set("action", "getTokenHolders");
  url.searchParams.set("contractaddress", token);
  url.searchParams.set("page", "1");
  url.searchParams.set("offset", String(HOLDER_PAGE));
  const payload = await fetchJson(url.toString(), { timeoutMs: BACKGROUND_MS, headers: INDEX_HEADERS });
  const parsed = parseBlockscoutHolders(payload, HOLDER_PAGE);
  if (!parsed) return UNAVAILABLE;
  return { holders: parsed.holders, source: "blockscout", truncated: parsed.truncated };
}

async function fetchGoPlus(token: Address): Promise<HolderRead> {
  const config = getConfig();
  const url = new URL(`/api/v1/token_security/8453`, `${config.goplusBaseUrl}/`);
  url.searchParams.set("contract_addresses", token);
  const payload = await fetchJson(url.toString(), { timeoutMs: BACKGROUND_MS, headers: INDEX_HEADERS });
  const holders = parseGoPlusHolders(payload, token);
  if (!holders) return UNAVAILABLE;
  return { holders, source: "goplus", truncated: holders.length >= 10 };
}

async function fetchEtherscan(token: Address): Promise<HolderRead> {
  const key = getConfig().etherscanApiKey;
  const payload = await fetchJson(etherscanUrl(token, "token", "tokenholderlist", key, { page: "1", offset: String(HOLDER_PAGE) }), {
    timeoutMs: BACKGROUND_MS,
    headers: INDEX_HEADERS,
  });
  const parsed = parseEtherscanHolders(payload, HOLDER_PAGE);
  if (!parsed) return UNAVAILABLE;
  return { holders: parsed.holders, source: "etherscan", truncated: parsed.truncated };
}

export function parseBlockscoutHolders(
  payload: unknown,
  requested: number,
): { holders: HolderBalance[]; truncated: boolean } | null {
  const rows = blockscoutRows(payload);
  if (!rows) return null;
  const holders = rows
    .map(rowFromUnknown)
    .filter((row): row is HolderBalance => row !== null);
  if (holders.length === 0) return null;
  return { holders, truncated: holders.length >= requested };
}

export function parseEtherscanHolders(
  payload: unknown,
  requested: number,
): { holders: HolderBalance[]; truncated: boolean } | null {
  if (!payload || typeof payload !== "object") return null;
  const result = (payload as { result?: unknown }).result;
  if (!Array.isArray(result)) return null;
  const holders: HolderBalance[] = [];
  for (const row of result) {
    if (!row || typeof row !== "object") continue;
    const address = (row as { TokenHolderAddress?: unknown }).TokenHolderAddress;
    const quantity = (row as { TokenHolderQuantity?: unknown }).TokenHolderQuantity;
    if (typeof address !== "string" || typeof quantity !== "string" || !/^\d+$/.test(quantity)) continue;
    holders.push({ address, quantity: BigInt(quantity) });
  }
  if (holders.length === 0) return null;
  return { holders, truncated: holders.length >= requested };
}

export function parseGoPlusHolders(payload: unknown, token: Address): HolderBalance[] | null {
  if (!payload || typeof payload !== "object") return null;
  const result = (payload as { result?: unknown }).result;
  if (!result || typeof result !== "object") return null;
  const row = (result as Record<string, unknown>)[token.toLowerCase()];
  if (!row || typeof row !== "object") return null;
  const list = (row as { holders?: unknown }).holders;
  if (!Array.isArray(list)) return null;
  const holders: HolderBalance[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const address = (item as { address?: unknown }).address;
    const percent = (item as { percent?: unknown }).percent;
    if (typeof address !== "string" || typeof percent !== "string") continue;
    const parsed = Number(percent);
    if (!Number.isFinite(parsed) || parsed < 0) continue;
    const share = parsed > 1 ? parsed / 100 : parsed;
    if (share > 1) continue;
    holders.push({ address, quantity: null, share });
  }
  return holders.length > 0 ? holders : null;
}

function blockscoutRows(payload: unknown): unknown[] | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as { status?: unknown; result?: unknown; items?: unknown };
  if (Array.isArray(record.items)) return record.items;
  if (record.status === "1" && Array.isArray(record.result)) return record.result;
  return null;
}

function rowFromUnknown(row: unknown): HolderBalance | null {
  if (!row || typeof row !== "object") return null;
  const record = row as { address?: unknown; value?: unknown };
  const address =
    typeof record.address === "string"
      ? record.address
      : record.address && typeof record.address === "object" && typeof (record.address as { hash?: unknown }).hash === "string"
        ? (record.address as { hash: string }).hash
        : null;
  const value = record.value;
  if (!address || typeof value !== "string" || !/^\d+$/.test(value)) return null;
  return { address, quantity: BigInt(value) };
}

function etherscanUrl(
  token: Address,
  module: string,
  action: string,
  apiKey: string,
  extra?: Record<string, string>,
): string {
  const url = new URL("https://api.etherscan.io/v2/api");
  url.searchParams.set("chainid", "8453");
  url.searchParams.set("module", module);
  url.searchParams.set("action", action);
  url.searchParams.set(module === "token" ? "contractaddress" : "address", token);
  url.searchParams.set("apikey", apiKey);
  for (const [key, value] of Object.entries(extra ?? {})) url.searchParams.set(key, value);
  return url.toString();
}

function remember(key: string, read: HolderRead): void {
  const rank = sourceRank(read.source);
  const current = cache.get(key);
  if (current && current.expires > Date.now() && current.rank > rank) return;
  const ttl = getConfig().holderCacheTtlMs;
  if (ttl <= 0) return;
  cache.set(key, { read, rank, expires: Date.now() + ttl });
  negative.delete(key);
}

function readCache(key: string): HolderRead | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expires <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.read;
}

function sourceRank(source: HolderSource): number {
  if (source === "etherscan") return 3;
  if (source === "blockscout") return 2;
  if (source === "goplus") return 1;
  return 0;
}

function parseAbi(payload: unknown): AbiItem[] | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.abi)) return record.abi as AbiItem[];
  if (typeof record.abi === "string" && record.abi.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(record.abi) as unknown;
      return Array.isArray(parsed) ? (parsed as AbiItem[]) : null;
    } catch {
      return null;
    }
  }
  if (Array.isArray(record.result) && record.result[0] && typeof record.result[0] === "object") {
    const abi = (record.result[0] as { ABI?: unknown }).ABI;
    if (typeof abi === "string" && abi.trim().startsWith("[")) {
      try {
        const parsed = JSON.parse(abi) as unknown;
        return Array.isArray(parsed) ? (parsed as AbiItem[]) : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}
