/**
 * Cache + routing middleware for the Base token safety engine.
 *
 * Read path (fastest first):
 *   1. In-process LRU (per warm Edge/serverless instance)         ~0 ms
 *   2. Single-flight: concurrent misses for one token share one engine run
 *   3. Supabase row with updated_at newer than TTL (300 s)        ~20-80 ms, bounded by SUPABASE_READ_TIMEOUT_MS
 *   4. Full on-chain analysis (safetyEngine)                      ~1-3 s
 * Write path: fresh results are returned to the caller immediately; the Supabase upsert runs in the background
 * via the platform's waitUntil (Vercel / Next.js) or as a logged fire-and-forget promise.
 *
 * Degrades gracefully: with no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY it runs memory-only.
 */
import { createClient } from '@supabase/supabase-js';
import { analyzeTokenSafety, normalizeTokenAddress, CACHE_TTL_SECONDS } from './safetyEngine.js';

const env = (k, d) => {
  try {
    const v = globalThis.process?.env?.[k];
    return v === undefined || v === '' ? d : v;
  } catch {
    return d;
  }
};
const TABLE = env('SUPABASE_CACHE_TABLE', 'token_risk_cache');
const TTL_MS = Math.max(1, Math.min(CACHE_TTL_SECONDS, Number(env('CACHE_TTL_SECONDS', CACHE_TTL_SECONDS)) || CACHE_TTL_SECONDS)) * 1000;
const READ_TIMEOUT_MS = Number(env('SUPABASE_READ_TIMEOUT_MS', 250)) || 250;
const WRITE_TIMEOUT_MS = Number(env('SUPABASE_WRITE_TIMEOUT_MS', 3000)) || 3000;
const LRU_MAX = Number(env('MEMORY_CACHE_MAX_ENTRIES', 5000)) || 5000;
// Results whose models mostly failed (RPC outage) are cached briefly so an outage is not pinned for 5 minutes.
const DEGRADED_TTL_MS = 20_000;

// ---------------------------------------------------------------------------
// Supabase client (lazy, module-scoped, null when not configured)
// ---------------------------------------------------------------------------
let supabase;
let warned = false;
export function getSupabase() {
  if (supabase !== undefined) return supabase;
  const url = env('SUPABASE_URL', '');
  const key = env('SUPABASE_SERVICE_ROLE_KEY', '');
  if (!url || !key) {
    if (!warned) {
      console.warn('[cacheLayer] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set: running with in-memory cache only.');
      warned = true;
    }
    supabase = null;
    return supabase;
  }
  supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { 'x-client-info': 'base-token-safety/2.2' } },
  });
  return supabase;
}

// ---------------------------------------------------------------------------
// LRU with per-entry expiry (Map preserves insertion order => O(1) LRU)
// ---------------------------------------------------------------------------
class TtlLru {
  constructor(max) {
    this.max = max;
    this.map = new Map();
  }
  get(key) {
    const e = this.map.get(key);
    if (!e) return null;
    if (e.expiresAt <= Date.now()) {
      this.map.delete(key);
      return null;
    }
    this.map.delete(key);
    this.map.set(key, e);
    return e;
  }
  set(key, value, storedAt, ttlMs) {
    this.map.delete(key);
    this.map.set(key, { value, storedAt, expiresAt: storedAt + ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
  delete(key) {
    this.map.delete(key);
  }
  get size() {
    return this.map.size;
  }
}
const memory = new TtlLru(LRU_MAX);
const inflight = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function decorate(payload, source, storedAtMs) {
  const age = Math.max(0, Math.floor((Date.now() - storedAtMs) / 1000));
  return {
    ...payload,
    cached: source !== 'none',
    cache_source: source,
    cache_age_seconds: source === 'none' ? 0 : age,
    ttl_seconds: Math.max(0, Math.floor(TTL_MS / 1000) - (source === 'none' ? 0 : age)),
  };
}

function isDegraded(payload) {
  const models = Object.values(payload?.risk_matrix ?? {});
  return models.filter((m) => !m.data_available).length >= 2 || (payload?.errors ?? []).some((e) => e.code === 'RPC_UNAVAILABLE');
}

function isCacheable(payload) {
  return !(payload?.errors ?? []).some((e) => e.code === 'INVALID_TOKEN_ADDRESS');
}

async function readSupabase(token) {
  const db = getSupabase();
  if (!db) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
  try {
    const freshAfter = new Date(Date.now() - TTL_MS).toISOString();
    const { data, error } = await db
      .from(TABLE)
      .select('payload, updated_at')
      .eq('token_address', token)
      .gt('updated_at', freshAfter)
      .abortSignal(controller.signal)
      .maybeSingle();
    if (error) {
      if (!controller.signal.aborted) console.warn(`[cacheLayer] supabase read failed: ${error.message}`);
      return null;
    }
    if (!data?.payload) return null;
    return { payload: data.payload, storedAt: Date.parse(data.updated_at) };
  } catch (err) {
    if (!controller.signal.aborted) console.warn(`[cacheLayer] supabase read error: ${err?.message ?? err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function writeSupabase(token, payload) {
  const db = getSupabase();
  if (!db) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WRITE_TIMEOUT_MS);
  try {
    const row = {
      token_address: token,
      payload,
      risk_score: payload.risk_score,
      status: payload.status,
      confidence: payload.confidence,
      block_number: payload.block_number,
      engine_version: payload.version,
      updated_at: payload.checked_at,
    };
    const { error } = await db.from(TABLE).upsert(row, { onConflict: 'token_address' }).abortSignal(controller.signal);
    if (error) console.error(`[cacheLayer] supabase write failed for ${token}: ${error.message}`);
  } catch (err) {
    console.error(`[cacheLayer] supabase write error for ${token}: ${err?.message ?? err}`);
  } finally {
    clearTimeout(timer);
  }
}

function scheduleBackground(promise, waitUntil) {
  const safe = Promise.resolve(promise).catch((err) => console.error(`[cacheLayer] background task failed: ${err?.message ?? err}`));
  if (typeof waitUntil === 'function') {
    try {
      waitUntil(safe);
      return;
    } catch (err) {
      console.warn(`[cacheLayer] waitUntil unavailable, falling back to fire-and-forget: ${err?.message ?? err}`);
    }
  }
  void safe;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Resolve a token risk profile with cache routing. Never throws.
 * @param {string} tokenAddress
 * @param {{ waitUntil?: (p: Promise<unknown>) => void, forceRefresh?: boolean, engineOptions?: object }} [opts]
 * @returns {Promise<object>} schema-valid analyze_base_token_safety result
 */
export async function getTokenSafety(tokenAddress, opts = {}) {
  const token = normalizeTokenAddress(tokenAddress);
  if (!token) return analyzeTokenSafety(tokenAddress); // returns INVALID_TOKEN_ADDRESS result, never cached

  if (!opts.forceRefresh) {
    const hit = memory.get(token);
    if (hit) return decorate(hit.value, 'memory', hit.storedAt);
  }

  const pending = inflight.get(token);
  if (pending) return pending;

  const work = (async () => {
    try {
      if (!opts.forceRefresh) {
        const row = await readSupabase(token);
        if (row && Number.isFinite(row.storedAt) && Date.now() - row.storedAt < TTL_MS) {
          memory.set(token, row.payload, row.storedAt, TTL_MS - (Date.now() - row.storedAt));
          return decorate(row.payload, 'supabase', row.storedAt);
        }
      }
      const fresh = await analyzeTokenSafety(token, opts.engineOptions);
      if (isCacheable(fresh)) {
        const storedAt = Date.parse(fresh.checked_at) || Date.now();
        const degraded = isDegraded(fresh);
        memory.set(token, fresh, storedAt, degraded ? DEGRADED_TTL_MS : TTL_MS);
        if (!degraded) scheduleBackground(writeSupabase(token, fresh), opts.waitUntil);
      }
      return decorate(fresh, 'none', Date.now());
    } catch (err) {
      // analyzeTokenSafety never throws; this guards the cache plumbing itself.
      console.error(`[cacheLayer] unexpected error for ${token}: ${err?.message ?? err}`);
      return decorate(await analyzeTokenSafety(token, opts.engineOptions), 'none', Date.now());
    } finally {
      inflight.delete(token);
    }
  })();
  inflight.set(token, work);
  return work;
}

/** Warm the cache for a list of tokens (e.g. from a cron route). */
export async function prewarm(tokens, opts = {}) {
  const list = [...new Set(tokens.map(normalizeTokenAddress).filter(Boolean))];
  const results = await Promise.allSettled(list.map((t) => getTokenSafety(t, { ...opts, forceRefresh: true })));
  return results.map((r, i) => ({ token_address: list[i], ok: r.status === 'fulfilled', status: r.status === 'fulfilled' ? r.value.status : null }));
}

export function cacheStats() {
  return { memory_entries: memory.size, inflight: inflight.size, supabase_configured: Boolean(getSupabase()), ttl_seconds: TTL_MS / 1000 };
}

export function invalidate(tokenAddress) {
  const token = normalizeTokenAddress(tokenAddress);
  if (token) memory.delete(token);
}
