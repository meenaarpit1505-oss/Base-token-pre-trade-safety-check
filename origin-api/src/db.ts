import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Prepaid MCP keys live in Supabase `public.api_keys`.
 * `validateAndDeductKey` calls the SECURITY DEFINER function
 * `deduct_api_key_balance`, which runs one
 * `UPDATE ... WHERE active AND balance >= cost`.
 * A missing, inactive, or underfunded key updates zero rows and returns false.
 * Two concurrent calls cannot both pass that WHERE clause for the same last cent.
 *
 * Missing `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` fails closed (returns false)
 * and does not throw during process startup. The HTTP API does not import this module.
 */
export const DEDUCT_API_KEY_RPC = "deduct_api_key_balance";
export const SAFETY_CHECK_COST_USD = 0.01;

export interface DeductRpcResult {
  data: unknown;
  error: { message: string } | null;
}

export interface DeductRpc {
  (
    fn: typeof DEDUCT_API_KEY_RPC,
    args: { p_key: string; p_cost: string },
  ): Promise<DeductRpcResult>;
}

export interface ValidateKeyDeps {
  /** Injected database call. Omit to use the Supabase service-role client. */
  rpc?: DeductRpc | null;
}

let cachedClient: SupabaseClient | null | undefined;
let missingEnvWarned = false;

export function resetSupabaseForTests(): void {
  cachedClient = undefined;
  missingEnvWarned = false;
}

export async function validateAndDeductKey(
  apiKey: string,
  cost: number,
  deps: ValidateKeyDeps = {},
): Promise<boolean> {
  const key = apiKey.trim();
  if (!key || !Number.isFinite(cost) || cost <= 0) return false;

  const rpc = deps.rpc === undefined ? supabaseRpc() : deps.rpc;
  if (!rpc) return false;

  let result: DeductRpcResult;
  try {
    result = await rpc(DEDUCT_API_KEY_RPC, { p_key: key, p_cost: formatUsd(cost) });
  } catch (error) {
    logDeductFailure(error, key);
    return false;
  }
  if (result.error) {
    logDeductFailure(result.error.message, key);
    return false;
  }
  return result.data === true;
}

function supabaseRpc(): DeductRpc | null {
  const client = getSupabaseClient();
  if (!client) return null;
  return async (fn, args) => {
    const { data, error } = await client.rpc(fn, args);
    return { data, error: error ? { message: error.message } : null };
  };
}

function getSupabaseClient(): SupabaseClient | null {
  if (cachedClient !== undefined) return cachedClient;
  const url = process.env.SUPABASE_URL?.trim() ?? "";
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!url || !serviceRoleKey || !isHttpsUrl(url)) {
    cachedClient = null;
    if (!missingEnvWarned) {
      missingEnvWarned = true;
      console.error(
        "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is unset or not https. MCP safety checks fail closed until both are set.",
      );
    }
    return null;
  }
  cachedClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return cachedClient;
}

function isHttpsUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Fixed-point USD so Postgres numeric does not inherit a binary float. */
export function formatUsd(amount: number): string {
  return amount.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

function logDeductFailure(error: unknown, apiKey: string): void {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "deduct failed";
  const redacted = apiKey ? raw.split(apiKey).join("[redacted]") : raw;
  console.error(JSON.stringify({ event: "api_key_deduct_failed", message: redacted.slice(0, 200) }));
}
