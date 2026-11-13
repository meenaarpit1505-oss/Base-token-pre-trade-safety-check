import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  pad,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { KNOWN_BALANCE_SLOTS, SIMULATION_CALLER, SIMULATOR, WETH, ZERO, sameAddress } from "../domain/addresses.js";
import { SIMULATOR_RUNTIME_BYTECODE } from "../generated/simulator.js";
import type { PricedPool } from "./pools.js";
import type { BaseClient } from "./rpc.js";

const runAbi = [
  {
    type: "function",
    name: "run",
    stateMutability: "nonpayable",
    inputs: [
      { name: "kind", type: "uint8" },
      { name: "router", type: "address" },
      { name: "pool", type: "address" },
      { name: "factory", type: "address" },
      { name: "quote", type: "address" },
      { name: "token", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "stable", type: "bool" },
      { name: "quoteIsWeth", type: "bool" },
      { name: "feeBps", type: "uint16" },
    ],
    outputs: [
      { name: "buyOk", type: "bool" },
      { name: "sellOk", type: "bool" },
      { name: "path", type: "uint8" },
      { name: "amountInUsed", type: "uint256" },
      { name: "quotedBuy", type: "uint256" },
      { name: "tokensBought", type: "uint256" },
      { name: "quotedSell", type: "uint256" },
      { name: "quoteOut", type: "uint256" },
    ],
  },
] as const;

export interface SimulationRaw {
  buyOk: boolean;
  sellOk: boolean;
  path: number;
  amountIn: bigint;
  quotedBuy: bigint;
  tokensBought: bigint;
  quotedSell: bigint;
  quoteOut: bigint;
}

const slotCache = new Map<string, number>(KNOWN_BALANCE_SLOTS);

export function resetSlotCacheForTests(): void {
  slotCache.clear();
  for (const [key, slot] of KNOWN_BALANCE_SLOTS) slotCache.set(key, slot);
}

function balanceSlotKey(holder: Address, slot: number): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder, BigInt(slot)]));
}

async function findBalanceSlot(client: BaseClient, token: Address, holder: Address, expected: bigint): Promise<number | null> {
  const cached = slotCache.get(token.toLowerCase());
  if (cached !== undefined) return cached;
  if (expected <= 0n) return null;
  const target = pad(toHex(expected), { size: 32 }).toLowerCase();
  const slots = Array.from({ length: 20 }, (_, slot) => slot);
  const values = await Promise.all(
    slots.map((slot) => client.getStorageAt({ address: token, slot: balanceSlotKey(holder, slot) })),
  );
  for (let slot = 0; slot < values.length; slot++) {
    if ((values[slot] ?? "").toLowerCase() === target) {
      slotCache.set(token.toLowerCase(), slot);
      return slot;
    }
  }
  return null;
}

function kindCode(pool: PricedPool): number {
  if (pool.kind === "aero") return 2;
  if (pool.kind === "cl") return 3;
  return 1;
}

export async function simulatePool(
  client: BaseClient,
  pool: PricedPool,
  token: Address,
  amountIn: bigint,
): Promise<SimulationRaw | null> {
  if (amountIn <= 0n) return null;
  const quoteIsWeth = sameAddress(pool.quote.address, WETH);
  const stateOverride: {
    address: Address;
    balance?: bigint;
    code?: Hex;
    stateDiff?: { slot: Hex; value: Hex }[];
  }[] = [
    {
      address: SIMULATOR,
      code: SIMULATOR_RUNTIME_BYTECODE,
      balance: quoteIsWeth ? amountIn : 0n,
    },
  ];

  if (!quoteIsWeth) {
    const slot = await findBalanceSlot(client, pool.quote.address, pool.address, pool.quoteBalance);
    if (slot === null) return null;
    stateOverride.push({
      address: pool.quote.address,
      stateDiff: [
        {
          slot: balanceSlotKey(SIMULATOR, slot),
          value: pad(toHex(amountIn), { size: 32 }),
        },
      ],
    });
  }

  const data = encodeFunctionData({
    abi: runAbi,
    functionName: "run",
    args: [
      kindCode(pool),
      pool.router === (ZERO as Address) ? ZERO : pool.router,
      pool.address,
      pool.factory,
      pool.quote.address,
      token,
      amountIn,
      pool.stable ?? false,
      quoteIsWeth,
      pool.feeBps ?? 0,
    ],
  });

  const result = await client.call({
    account: SIMULATION_CALLER,
    to: SIMULATOR,
    data,
    gas: 8_000_000n,
    stateOverride,
  });
  if (!result.data || result.data === "0x") return null;
  const decoded = decodeFunctionResult({ abi: runAbi, functionName: "run", data: result.data });
  const [buyOk, sellOk, path, amountInUsed, quotedBuy, tokensBought, quotedSell, quoteOut] = decoded as unknown as [
    boolean,
    boolean,
    number,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
  ];
  return {
    buyOk,
    sellOk,
    path: Number(path),
    amountIn: amountInUsed,
    quotedBuy,
    tokensBought,
    quotedSell,
    quoteOut,
  };
}
