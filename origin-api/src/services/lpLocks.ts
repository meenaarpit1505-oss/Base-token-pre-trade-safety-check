import { decodeAbiParameters, encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { DEAD, sameAddress } from "../domain/addresses.js";
import { aggregate, type BaseClient } from "./rpc.js";

/**
 * Concentrated-liquidity (V3 / Slipstream) LP lock floor.
 *
 * CL liquidity lives in position NFTs, so "locked" means NFTs held by an address that can never withdraw
 * (0x…dEaD) or by an operator-verified locker (LP_NFT_LOCKERS). For each NonfungiblePositionManager we keep
 * an in-memory index of the positions those holders own (ERC721Enumerable walk + positions()). The pool
 * metric is: in-range liquidity of indexed positions / pool.liquidity(). Positions held anywhere else are
 * unknown, so the number is a lower bound (`floor`), and 0 is reported as unknown (null), not "unlocked".
 *
 * Position managers (verified on-chain: factory() returns the pool factory used for discovery):
 *   Uniswap V3  0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1 -> 0x33128a8fC17869897dcE68Ed026d694621f6FDfD
 *   Pancake V3  0x46A15B0b27311cedF172AB29E4f4766fbE7F4364 -> 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865
 *   Slipstream  read per pool from CLPool.nft() (each Slipstream factory has its own manager).
 */
export const UNI_V3_NPM = getAddress("0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1");
export const PANCAKE_V3_NPM = getAddress("0x46A15B0b27311cedF172AB29E4f4766fbE7F4364");

const npmAbi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "tokenOfOwnerByIndex",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  { type: "function", name: "positions", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [] },
] as const;

// positions(): (uint96 nonce, address operator, address token0, address token1, uint24 fee | int24 tickSpacing,
//               int24 tickLower, int24 tickUpper, uint128 liquidity, ...). Same word layout for V3, Pancake, Slipstream.
const positionWords = [
  { type: "uint96" },
  { type: "address" },
  { type: "address" },
  { type: "address" },
  { type: "int24" },
  { type: "int24" },
  { type: "int24" },
  { type: "uint128" },
] as const;

export interface LockedPosition {
  token0: string;
  token1: string;
  /** V3/Pancake fee (hundredths of a bip) or Slipstream tickSpacing. */
  feeOrSpacing: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
}

interface HolderIndex {
  holder: Address;
  /** Number of enumerated NFTs (indices 0..count-1). */
  count: number;
  positions: LockedPosition[];
  complete: boolean;
  builtAt: number;
}

export interface ClPoolLockInput {
  npm: Address;
  token0: Address;
  token1: Address;
  feeOrSpacing: number;
  tick: number;
  liquidity: bigint;
}

export interface LpLockOptions {
  holders?: readonly Address[];
  maxPerHolder?: number;
  refreshMs?: number;
  budgetMs?: number;
}

const indexes = new Map<string, { value: HolderIndex | null; pending: Promise<HolderIndex> | null }>();

export function resetLpLockIndexForTests(): void {
  indexes.clear();
}

export function lpLockHoldersFromEnv(raw = process.env.LP_NFT_LOCKERS ?? ""): Address[] {
  const extra = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => /^0x[0-9a-fA-F]{40}$/.test(part))
    .map((part) => getAddress(part));
  const out: Address[] = [DEAD];
  for (const address of extra) if (!out.some((known) => sameAddress(known, address))) out.push(address);
  return out.slice(0, 10);
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && process.env[name] !== "" && process.env[name] !== undefined
    ? Math.min(max, Math.max(min, Math.floor(value)))
    : fallback;
}

export function decodePosition(data: Hex): LockedPosition | null {
  if (!data || data.length < 2 + 64 * 8) return null;
  try {
    const words = decodeAbiParameters(positionWords, `0x${data.slice(2, 2 + 64 * 8)}` as Hex);
    return {
      token0: (words[2] as string).toLowerCase(),
      token1: (words[3] as string).toLowerCase(),
      feeOrSpacing: Number(words[4]),
      tickLower: Number(words[5]),
      tickUpper: Number(words[6]),
      liquidity: words[7] as bigint,
    };
  } catch {
    return null;
  }
}

function word(data: Hex | undefined): bigint | null {
  if (!data || data.length < 66) return null;
  try {
    return BigInt(`0x${data.slice(2, 66)}`);
  } catch {
    return null;
  }
}

async function buildIndex(
  client: BaseClient,
  npm: Address,
  holder: Address,
  previous: HolderIndex | null,
  maxPerHolder: number,
): Promise<HolderIndex> {
  const [balanceRow] = await aggregate(client, [
    { target: npm, data: encodeFunctionData({ abi: npmAbi, functionName: "balanceOf", args: [holder] }) },
  ]);
  const balance = balanceRow?.success ? word(balanceRow.returnData) : null;
  if (balance === null) throw new Error("position manager balanceOf failed");
  // The burn address can never move an NFT out, so its enumeration is append-only: only read the new tail.
  const appendOnly = sameAddress(holder, DEAD) && previous !== null && BigInt(previous.count) <= balance;
  const start = appendOnly ? previous.count : 0;
  const end = Math.min(Number(balance), maxPerHolder);
  const positions = appendOnly ? [...previous.positions] : [];
  if (end > start) {
    const idCalls = [];
    for (let index = start; index < end; index += 1) {
      idCalls.push({
        target: npm,
        data: encodeFunctionData({ abi: npmAbi, functionName: "tokenOfOwnerByIndex", args: [holder, BigInt(index)] }),
      });
    }
    const idRows = await aggregate(client, idCalls);
    const ids = idRows.map((row) => (row?.success ? word(row.returnData) : null)).filter((id): id is bigint => id !== null);
    const positionRows = await aggregate(
      client,
      ids.map((id) => ({
        target: npm,
        data: encodeFunctionData({ abi: npmAbi, functionName: "positions", args: [id] }) as Hex,
      })),
    );
    for (const row of positionRows) {
      if (!row?.success) continue;
      const position = decodePosition(row.returnData);
      if (position && position.liquidity > 0n) positions.push(position);
    }
  }
  return { holder, count: end, positions, complete: Number(balance) <= maxPerHolder, builtAt: Date.now() };
}

function ensureIndex(client: BaseClient, npm: Address, holder: Address, options: Required<LpLockOptions>): Promise<HolderIndex> | HolderIndex {
  const key = `${npm.toLowerCase()}|${holder.toLowerCase()}`;
  let entry = indexes.get(key);
  if (!entry) {
    entry = { value: null, pending: null };
    indexes.set(key, entry);
  }
  const fresh = entry.value && Date.now() - entry.value.builtAt < options.refreshMs;
  if (fresh && entry.value) return entry.value;
  if (!entry.pending) {
    const current = entry;
    current.pending = buildIndex(client, npm, holder, current.value, options.maxPerHolder)
      .then((value) => {
        current.value = value;
        return value;
      })
      .finally(() => {
        current.pending = null;
      });
    current.pending.catch(() => undefined);
  }
  // A stale index is still a valid floor while it refreshes.
  return entry.value ?? entry.pending!;
}

/** Pure part: share of the pool's active liquidity held by indexed (burned / locked) in-range positions. */
export function lockedSharePct(pool: ClPoolLockInput, positions: readonly LockedPosition[]): number | null {
  if (pool.liquidity <= 0n) return null;
  const t0 = pool.token0.toLowerCase();
  const t1 = pool.token1.toLowerCase();
  let locked = 0n;
  for (const position of positions) {
    if (position.token0 !== t0 || position.token1 !== t1 || position.feeOrSpacing !== pool.feeOrSpacing) continue;
    if (position.tickLower <= pool.tick && pool.tick < position.tickUpper) locked += position.liquidity;
  }
  if (locked <= 0n) return null; // nothing found in burned / known-locker positions: unknown, not "unlocked"
  const basisPoints = Number((locked * 10_000n) / pool.liquidity);
  if (basisPoints < 1) return null; // dust (< 0.01%): says nothing about the pool
  return Math.min(100, basisPoints / 100);
}

/**
 * Lock floor per pool (same order as input). null = unknown (index not ready within budget, no burned /
 * locked in-range liquidity found, or unreadable pool). Never throws.
 */
export async function clLockFloors(client: BaseClient, pools: readonly ClPoolLockInput[], options: LpLockOptions = {}): Promise<(number | null)[]> {
  if (pools.length === 0) return [];
  const resolved: Required<LpLockOptions> = {
    holders: options.holders ?? lpLockHoldersFromEnv(),
    maxPerHolder: options.maxPerHolder ?? envInt("LP_NFT_INDEX_MAX_PER_HOLDER", 10_000, 0, 100_000),
    refreshMs: options.refreshMs ?? envInt("LP_NFT_INDEX_REFRESH_MS", 15 * 60_000, 10_000, 24 * 3_600_000),
    // Default 0: the request path only uses an index that is already built (discovery has a 1.5 s budget);
    // a missing / stale index is (re)built in the background and serves later calls.
    budgetMs: options.budgetMs ?? envInt("LP_NFT_INDEX_BUDGET_MS", 0, 0, 20_000),
  };
  if (resolved.maxPerHolder === 0) return pools.map(() => null);
  const managers = [...new Set(pools.map((pool) => pool.npm.toLowerCase()))].map((npm) => getAddress(npm));
  const jobs = managers.flatMap((npm) => resolved.holders.map((holder) => ({ npm, index: ensureIndex(client, npm, holder, resolved) })));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    if (resolved.budgetMs <= 0) resolve(null);
    else timer = setTimeout(() => resolve(null), resolved.budgetMs);
  });
  const settled = await Promise.all(
    jobs.map(async (job) => {
      try {
        const value = job.index instanceof Promise ? await Promise.race([job.index, deadline]) : job.index;
        return value ? { npm: job.npm, value } : null;
      } catch {
        return null;
      }
    }),
  );
  if (timer) clearTimeout(timer);
  return pools.map((pool) => {
    const positions = settled
      .filter((row): row is { npm: Address; value: HolderIndex } => row !== null && sameAddress(row.npm, pool.npm))
      .flatMap((row) => row.value.positions);
    return lockedSharePct(pool, positions);
  });
}

function resolvedOptions(options: LpLockOptions = {}): Required<LpLockOptions> {
  return {
    holders: options.holders ?? lpLockHoldersFromEnv(),
    maxPerHolder: options.maxPerHolder ?? envInt("LP_NFT_INDEX_MAX_PER_HOLDER", 10_000, 0, 100_000),
    refreshMs: options.refreshMs ?? envInt("LP_NFT_INDEX_REFRESH_MS", 15 * 60_000, 10_000, 24 * 3_600_000),
    budgetMs: 0,
  };
}

/** Build the burn / locker indexes for the Uniswap V3 and Pancake V3 managers (call once at startup). */
export async function warmLpLockIndex(client: BaseClient, options: LpLockOptions = {}): Promise<{ positions: number; ms: number }> {
  const started = Date.now();
  const resolved = resolvedOptions(options);
  if (resolved.maxPerHolder === 0) return { positions: 0, ms: 0 };
  const built = await Promise.allSettled(
    [UNI_V3_NPM, PANCAKE_V3_NPM].flatMap((npm) => resolved.holders.map((holder) => Promise.resolve(ensureIndex(client, npm, holder, resolved)))),
  );
  const positions = built.reduce((sum, row) => sum + (row.status === "fulfilled" ? row.value.positions.length : 0), 0);
  return { positions, ms: Date.now() - started };
}
