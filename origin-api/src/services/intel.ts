import { encodeFunctionData, type Address, type Hex } from "viem";
import {
  DEAD,
  EIP1967_IMPLEMENTATION_SLOT,
  FIAT_PROXY_IMPLEMENTATION_SLOT,
  SIMULATION_CALLER,
  ZERO,
  sameAddress,
} from "../domain/addresses.js";
import { addressFromSlot, flagsFromAbi, mergeFlags, readMinimalProxy, scanBytecode, type AbiItem, type BytecodeFlags } from "../domain/selectors.js";
import type { BaseClient } from "./rpc.js";

const ownerAbi = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;
const implementationAbi = [
  {
    type: "function",
    name: "implementation",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;
const pausedAbi = [
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
] as const;

export interface ContractIntel {
  hasCode: boolean;
  proxy: boolean;
  implementation: Address | null;
  owner: Address | null;
  ownershipRenounced: boolean;
  hasMint: boolean;
  hasBlacklist: boolean;
  hasPause: boolean;
  hasTaxSetter: boolean;
  isPaused: boolean;
  implUnreadable: boolean;
}

async function tryCall(client: BaseClient, to: Address, data: Hex): Promise<Hex | null> {
  try {
    const result = await client.call({ to, data });
    return result.data && result.data !== "0x" ? result.data : null;
  } catch {
    return null;
  }
}

function wordAddress(data: Hex | null): Address | null {
  if (!data) return null;
  return addressFromSlot(data.length >= 66 ? (`0x${data.slice(-64)}` as Hex) : data);
}

export async function loadIntel(client: BaseClient, token: Address, abi: AbiItem[] | null): Promise<ContractIntel> {
  const [code, eip1967, fiatSlot, ownerData, implementationData] = await Promise.all([
    client.getBytecode({ address: token }),
    client.getStorageAt({ address: token, slot: EIP1967_IMPLEMENTATION_SLOT }),
    client.getStorageAt({ address: token, slot: FIAT_PROXY_IMPLEMENTATION_SLOT }),
    tryCall(client, token, encodeFunctionData({ abi: ownerAbi, functionName: "owner" })),
    tryCall(client, token, encodeFunctionData({ abi: implementationAbi, functionName: "implementation" })),
  ]);

  const bytecode = code && code !== "0x" ? code : null;
  if (!bytecode) {
    return { ...emptyIntel(), hasCode: false };
  }
  const implCandidates = [
    wordAddress(implementationData),
    addressFromSlot(fiatSlot),
    addressFromSlot(eip1967),
    bytecode ? readMinimalProxy(bytecode) : null,
  ].filter((address): address is Address => Boolean(address) && !sameAddress(address!, token));

  let implementation: Address | null = null;
  let implCode: Hex | null = null;
  for (const candidate of implCandidates) {
    const next = await client.getBytecode({ address: candidate });
    if (next && next !== "0x") {
      implementation = candidate;
      implCode = next;
      break;
    }
  }

  if (implCode) {
    const nested = readMinimalProxy(implCode) ?? addressFromSlot(await client.getStorageAt({
      address: implementation!,
      slot: EIP1967_IMPLEMENTATION_SLOT,
    }));
    if (nested && !sameAddress(nested, token) && !sameAddress(nested, implementation!)) {
      const nestedCode = await client.getBytecode({ address: nested });
      if (nestedCode && nestedCode !== "0x") {
        implementation = nested;
        implCode = nestedCode;
      }
    }
  }

  const onChain = mergeFlags([scanBytecode(bytecode), scanBytecode(implCode)]);
  const fromAbi = abi ? flagsFromAbi(abi) : emptyFlags();
  const flags = mergeFlags([onChain, fromAbi]);
  const owner = wordAddress(ownerData);
  const ownershipRenounced = owner === ZERO || owner === DEAD;
  let isPaused = false;
  if (flags.hasPause || (implCode ?? bytecode ?? "").toLowerCase().includes("635c975abb")) {
    const pausedData = await tryCall(client, token, encodeFunctionData({ abi: pausedAbi, functionName: "paused" }));
    isPaused = Boolean(pausedData && pausedData.endsWith("1"));
  }

  const hinted = implCandidates[0] ?? null;
  const proxy = implementation !== null || hinted !== null;
  return {
    hasCode: true,
    proxy,
    implementation: implementation ?? hinted,
    owner,
    ownershipRenounced,
    hasMint: flags.hasMint,
    hasBlacklist: flags.hasBlacklist,
    hasPause: flags.hasPause,
    hasTaxSetter: flags.hasTaxSetter,
    isPaused,
    implUnreadable: hinted !== null && implCode === null,
  };
}

function emptyFlags(): BytecodeFlags {
  return { hasMint: false, hasBlacklist: false, hasPause: false, hasTaxSetter: false };
}

const mintAddressAbi = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [],
  },
] as const;
const mintAmountAbi = [
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
] as const;
const mintToAbi = [
  {
    type: "function",
    name: "mintTo",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [],
  },
] as const;
const ownerMintAbi = [
  {
    type: "function",
    name: "ownerMint",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [],
  },
] as const;

/**
 * True when an unrelated caller can mint after ownership was renounced.
 * A revert means the leftover selector is not a public mint.
 */
export async function probePublicMint(client: BaseClient, token: Address): Promise<boolean> {
  const calls = [
    encodeFunctionData({ abi: mintAddressAbi, functionName: "mint", args: [SIMULATION_CALLER, 1n] }),
    encodeFunctionData({ abi: mintAmountAbi, functionName: "mint", args: [1n] }),
    encodeFunctionData({ abi: mintToAbi, functionName: "mintTo", args: [SIMULATION_CALLER, 1n] }),
    encodeFunctionData({ abi: ownerMintAbi, functionName: "ownerMint", args: [SIMULATION_CALLER, 1n] }),
  ];
  const results = await Promise.all(calls.map((data) => mintSucceeds(client, token, data)));
  return results.some(Boolean);
}

async function mintSucceeds(client: BaseClient, token: Address, data: Hex): Promise<boolean> {
  try {
    await client.call({ to: token, data, account: SIMULATION_CALLER });
    return true;
  } catch {
    return false;
  }
}

export function applyAbi(intel: ContractIntel, abi: AbiItem[] | null): ContractIntel {
  if (!abi) return intel;
  const flags = flagsFromAbi(abi);
  const hasPause = intel.hasPause || flags.hasPause;
  return {
    ...intel,
    hasMint: intel.hasMint || flags.hasMint,
    hasBlacklist: intel.hasBlacklist || flags.hasBlacklist,
    hasPause,
    hasTaxSetter: intel.hasTaxSetter || flags.hasTaxSetter,
  };
}

export function emptyIntel(): ContractIntel {
  return {
    hasCode: false,
    proxy: false,
    implementation: null,
    owner: null,
    ownershipRenounced: false,
    hasMint: false,
    hasBlacklist: false,
    hasPause: false,
    hasTaxSetter: false,
    isPaused: false,
    implUnreadable: false,
  };
}
