import { createHash } from "node:crypto";
import { getConfig } from "../config.js";
import { RedisClient, RedisError, type RedisValue } from "./redisClient.js";

export interface UsageSnapshot {
  calls: number;
  usd: number;
}

export interface UsageStore {
  readonly kind: "memory" | "redis" | "postgres";
  readonly degraded: boolean;
  increment(identity: string, priceUsd: number): Promise<UsageSnapshot>;
  get(identity: string): Promise<UsageSnapshot>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

const USAGE_SCRIPT = `
local calls = redis.call('HINCRBY', KEYS[1], 'calls', ARGV[2])
local cents = redis.call('HINCRBY', KEYS[1], 'cents', ARGV[1])
return {calls, cents}
`;

export function usageKey(identity: string): string {
  return `token-safety:usage:${createHash("sha256").update(identity).digest("hex")}`;
}

export class MemoryUsageStore implements UsageStore {
  readonly kind = "memory" as const;
  readonly degraded = false;
  private readonly rows = new Map<string, { calls: number; cents: number }>();

  async increment(identity: string, priceUsd: number): Promise<UsageSnapshot> {
    return this.add(identity, centsOf(priceUsd), 1);
  }

  async get(identity: string): Promise<UsageSnapshot> {
    const row = this.rows.get(usageKey(identity)) ?? { calls: 0, cents: 0 };
    return snapshot(row.calls, row.cents);
  }

  peek(identity: string): { calls: number; cents: number } {
    return this.rows.get(usageKey(identity)) ?? { calls: 0, cents: 0 };
  }

  clear(identity?: string): void {
    if (identity === undefined) this.rows.clear();
    else this.rows.delete(usageKey(identity));
  }

  async ping(): Promise<void> {}

  async close(): Promise<void> {}

  add(identity: string, cents: number, calls: number): UsageSnapshot {
    const key = usageKey(identity);
    const row = this.rows.get(key) ?? { calls: 0, cents: 0 };
    row.calls += calls;
    row.cents += cents;
    this.rows.set(key, row);
    return snapshot(row.calls, row.cents);
  }
}

class RedisUsageStore implements UsageStore {
  readonly kind = "redis" as const;
  readonly degraded = false;
  private client: RedisClient | null = null;
  private rest: { url: string; token: string } | null = null;

  constructor(private readonly redisUrl: string, private readonly upstashUrl: string, private readonly upstashToken: string) {}

  async increment(identity: string, priceUsd: number, calls = 1, cents = centsOf(priceUsd)): Promise<UsageSnapshot> {
    const key = usageKey(identity);
    const result = this.redisUrl
      ? await (await this.protocol()).command(["EVAL", USAGE_SCRIPT, "1", key, String(cents), String(calls)])
      : await this.restCommand(["EVAL", USAGE_SCRIPT, "1", key, String(cents), String(calls)]);
    return pair(result);
  }

  async get(identity: string): Promise<UsageSnapshot> {
    const key = usageKey(identity);
    const result = this.redisUrl
      ? await (await this.protocol()).command(["HMGET", key, "calls", "cents"])
      : await this.restCommand(["HMGET", key, "calls", "cents"]);
    if (!Array.isArray(result)) return snapshot(0, 0);
    return snapshot(countOf(result[0] ?? 0), countOf(result[1] ?? 0));
  }

  async ping(): Promise<void> {
    const result = this.redisUrl ? await (await this.protocol()).command(["PING"]) : await this.restCommand(["PING"]);
    if (result !== "PONG") throw new RedisError("redis PING failed");
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }

  private async protocol(): Promise<RedisClient> {
    if (!this.client) this.client = new RedisClient(this.redisUrl);
    return this.client;
  }

  private async restCommand(args: string[]): Promise<RedisValue> {
    if (!this.rest) {
      const url = assertUpstash(this.upstashUrl);
      if (!this.upstashToken) throw new RedisError("UPSTASH_REDIS_REST_TOKEN is empty");
      this.rest = { url, token: this.upstashToken };
    }
    const response = await fetch(this.rest.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.rest.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(args),
      redirect: "error",
      signal: AbortSignal.timeout(2_000),
    });
    const payload = (await response.json().catch(() => null)) as { result?: RedisValue; error?: string } | null;
    if (!response.ok || !payload || payload.error) {
      throw new RedisError(payload?.error || `upstash HTTP ${response.status}`);
    }
    return payload.result ?? null;
  }
}

class PostgresUsageStore implements UsageStore {
  readonly kind = "postgres" as const;
  readonly degraded = false;
  private pool: PgPool | null = null;
  private ready: Promise<void> | null = null;

  constructor(private readonly databaseUrl: string) {}

  async increment(identity: string, priceUsd: number, calls = 1, cents = centsOf(priceUsd)): Promise<UsageSnapshot> {
    await this.ensure();
    const result = await this.pool!.query(
      `INSERT INTO token_safety_usage (identity_hash, calls, cents)
       VALUES ($1, $2, $3)
       ON CONFLICT (identity_hash) DO UPDATE
       SET calls = token_safety_usage.calls + EXCLUDED.calls,
           cents = token_safety_usage.cents + EXCLUDED.cents,
           updated_at = now()
       RETURNING calls, cents`,
      [usageKey(identity), calls, cents],
    );
    const row = result.rows[0];
    if (!row) throw new Error("postgres usage upsert returned no row");
    return snapshot(countOf(row.calls), countOf(row.cents));
  }

  async get(identity: string): Promise<UsageSnapshot> {
    await this.ensure();
    const result = await this.pool!.query(
      "SELECT calls, cents FROM token_safety_usage WHERE identity_hash = $1",
      [usageKey(identity)],
    );
    const row = result.rows[0];
    if (!row) return snapshot(0, 0);
    return snapshot(countOf(row.calls), countOf(row.cents));
  }

  async ping(): Promise<void> {
    await this.ensure();
    await this.pool!.query("SELECT 1");
  }

  async close(): Promise<void> {
    await this.pool?.end();
    this.pool = null;
    this.ready = null;
  }

  private async ensure(): Promise<void> {
    if (!this.ready) this.ready = this.open();
    try {
      await this.ready;
    } catch (error) {
      this.ready = null;
      throw error;
    }
  }

  private async open(): Promise<void> {
    assertDatabaseUrl(this.databaseUrl);
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({
      connectionString: this.databaseUrl,
      max: 4,
      connectionTimeoutMillis: 2_000,
      statement_timeout: 2_000,
      application_name: "base-token-safety",
    });
    this.pool = pool;
    await pool.query(`CREATE TABLE IF NOT EXISTS token_safety_usage (
      identity_hash text PRIMARY KEY,
      calls bigint NOT NULL,
      cents bigint NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  }
}

class ResilientUsageStore implements UsageStore {
  readonly kind: UsageStore["kind"];
  degraded = false;
  private primary: UsageStore | null = null;
  private readonly memory = new MemoryUsageStore();
  private failedUntil = 0;

  constructor(kind: UsageStore["kind"], private readonly connect: () => Promise<UsageStore>) {
    this.kind = kind;
  }

  async increment(identity: string, priceUsd: number): Promise<UsageSnapshot> {
    const store = await this.connected();
    const pending = this.memory.peek(identity);
    if (!store) return this.memory.increment(identity, priceUsd);
    try {
      const row = await add(store, identity, centsOf(priceUsd) + pending.cents, 1 + pending.calls);
      this.memory.clear(identity);
      this.degraded = false;
      return row;
    } catch (error) {
      this.noteFailure(error);
      return this.memory.increment(identity, priceUsd);
    }
  }

  async get(identity: string): Promise<UsageSnapshot> {
    const store = await this.connected();
    const local = this.memory.peek(identity);
    if (!store) return snapshot(local.calls, local.cents);
    try {
      const remote = await store.get(identity);
      this.degraded = false;
      return snapshot(remote.calls + local.calls, Math.round(remote.usd * 100) + local.cents);
    } catch (error) {
      this.noteFailure(error);
      return snapshot(local.calls, local.cents);
    }
  }

  async ping(): Promise<void> {
    try {
      const store = await this.connected();
      if (!store) return;
      await store.ping();
      this.degraded = false;
    } catch (error) {
      this.noteFailure(error);
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.primary?.close();
    this.primary = null;
  }

  private async connected(): Promise<UsageStore | null> {
    if (this.kind === "memory") return null;
    if (this.failedUntil > Date.now()) return this.primary;
    try {
      if (!this.primary) this.primary = await this.connect();
      return this.primary;
    } catch (error) {
      this.noteFailure(error);
      return null;
    }
  }

  private noteFailure(error: unknown): void {
    this.degraded = true;
    this.failedUntil = Date.now() + 5_000;
    console.error(
      JSON.stringify({
        event: "usage_store_error",
        store: this.kind,
        message: error instanceof Error ? error.message.slice(0, 300) : "unknown",
      }),
    );
  }
}

let singleton: UsageStore | null = null;

export function getUsageStore(): UsageStore {
  if (singleton) return singleton;
  const config = getConfig();
  if (config.usageBackend === "memory") {
    singleton = new MemoryUsageStore();
    return singleton;
  }
  singleton = new ResilientUsageStore(config.usageBackend, async () => {
    if (config.usageBackend === "redis") {
      return new RedisUsageStore(config.redisUrl, config.upstashRedisRestUrl, config.upstashRedisRestToken);
    }
    return new PostgresUsageStore(config.databaseUrl);
  });
  return singleton;
}

export async function resetUsageForTests(): Promise<void> {
  await singleton?.close();
  singleton = null;
}

function centsOf(priceUsd: number): number {
  const cents = Math.round(priceUsd * 100);
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error("PRICE_USD cannot be metered");
  return cents;
}

function snapshot(calls: number, cents: number): UsageSnapshot {
  return { calls, usd: cents / 100 };
}

function countOf(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("usage counter is out of range");
  return parsed;
}

function pair(value: RedisValue): UsageSnapshot {
  if (!Array.isArray(value) || value.length < 2) throw new RedisError("redis usage script returned an unexpected value");
  return snapshot(countOf(value[0]), countOf(value[1]));
}

async function add(store: UsageStore, identity: string, cents: number, calls: number): Promise<UsageSnapshot> {
  if (store instanceof RedisUsageStore || store instanceof PostgresUsageStore) {
    return store.increment(identity, 0, calls, cents);
  }
  throw new Error("usage store cannot accept a delta");
}

function assertUpstash(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".upstash.io")) {
    throw new RedisError("UPSTASH_REDIS_REST_URL must be an https://*.upstash.io endpoint");
  }
  if (url.username || url.password) throw new RedisError("UPSTASH_REDIS_REST_URL must not include credentials");
  return raw.replace(/\/$/, "");
}

function assertDatabaseUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use postgres:// or postgresql://");
  }
  const host = url.hostname.toLowerCase();
  if (!host || host === "169.254.169.254" || host === "metadata.google.internal") {
    throw new Error("DATABASE_URL host is not allowed");
  }
}

interface PgPool {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<{ calls?: unknown; cents?: unknown }> }>;
  end: () => Promise<void>;
}
