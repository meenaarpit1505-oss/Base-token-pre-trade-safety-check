import { getAddress, toFunctionSelector, type Address, type Hex } from "viem";
import { ZERO } from "./addresses.js";

const MINT = [
  "mint(address,uint256)",
  "mint(uint256)",
  "mintTo(address,uint256)",
  "ownerMint(address,uint256)",
];
const BLACKLIST = [
  "blacklist(address)",
  "unBlacklist(address)",
  "setBlacklist(address,bool)",
  "setIsBlacklisted(address,bool)",
  "addBlackList(address)",
  "addBot(address)",
  "setBot(address,bool)",
];
const PAUSE = ["pause()", "unpause()", "setPaused(bool)"];
const TAX = [
  "setBuyTax(uint256)",
  "setSellTax(uint256)",
  "setBuyFee(uint256)",
  "setSellFee(uint256)",
  "setTax(uint256)",
  "setFees(uint256,uint256)",
  "updateFees(uint256,uint256)",
  "setTaxFee(uint256)",
  "setFee(uint256)",
];

function needles(signatures: string[]): string[] {
  return signatures.map((signature) => `63${toFunctionSelector(signature).slice(2).toLowerCase()}`);
}

const MINT_NEEDLES = needles(MINT);
const BLACKLIST_NEEDLES = needles(BLACKLIST);
const PAUSE_NEEDLES = needles(PAUSE);
const TAX_NEEDLES = needles(TAX);

export interface BytecodeFlags {
  hasMint: boolean;
  hasBlacklist: boolean;
  hasPause: boolean;
  hasTaxSetter: boolean;
}

function hit(bytecode: string, list: string[]): boolean {
  return list.some((needle) => bytecode.includes(needle));
}

/** Solidity's dispatcher emits PUSH4 selector (0x63) immediately before the 4-byte selector. */
export function scanBytecode(code: Hex | null | undefined): BytecodeFlags {
  const body = (code ?? "0x").toLowerCase();
  return {
    hasMint: hit(body, MINT_NEEDLES),
    hasBlacklist: hit(body, BLACKLIST_NEEDLES),
    hasPause: hit(body, PAUSE_NEEDLES),
    hasTaxSetter: hit(body, TAX_NEEDLES),
  };
}

export function mergeFlags(flags: BytecodeFlags[]): BytecodeFlags {
  return {
    hasMint: flags.some((flag) => flag.hasMint),
    hasBlacklist: flags.some((flag) => flag.hasBlacklist),
    hasPause: flags.some((flag) => flag.hasPause),
    hasTaxSetter: flags.some((flag) => flag.hasTaxSetter),
  };
}

export function readMinimalProxy(code: Hex | null | undefined): Address | null {
  const raw = (code ?? "").toLowerCase();
  const marker = "363d3d373d3d3d363d73";
  const index = raw.indexOf(marker);
  if (index < 0) return null;
  const address = raw.slice(index + marker.length, index + marker.length + 40);
  if (!/^[\da-f]{40}$/.test(address)) return null;
  const parsed = getAddress(`0x${address}`);
  return parsed === ZERO ? null : parsed;
}

export function addressFromSlot(slot: Hex | null | undefined): Address | null {
  if (!slot) return null;
  const hex = slot.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  if (!/^[\da-f]{64}$/.test(hex)) return null;
  const parsed = getAddress(`0x${hex.slice(24)}`);
  return parsed === ZERO ? null : parsed;
}

const MINT_NAME = /^(mint|mintTo|ownerMint)$/i;
const BLACKLIST_NAME = /(blacklist|blocklist|^addBot$|^setBot$|^setIsBlacklisted$)/i;
const PAUSE_NAME = /^(pause|unpause|setPaused)$/i;
const TAX_NAME = /^(setTax|setBuyTax|setSellTax|setBuyFee|setSellFee|setFees|updateFees|setTaxFee|setFee)$/i;

export interface AbiItem {
  type?: string;
  name?: string;
  stateMutability?: string;
}

export function flagsFromAbi(abi: AbiItem[]): BytecodeFlags {
  const fns = abi.filter((item) => item.type === "function" && item.name);
  const writable = fns.filter((item) => item.stateMutability !== "view" && item.stateMutability !== "pure");
  return {
    hasMint: writable.some((item) => MINT_NAME.test(item.name ?? "")),
    hasBlacklist: writable.some((item) => BLACKLIST_NAME.test(item.name ?? "")),
    hasPause: writable.some((item) => PAUSE_NAME.test(item.name ?? "")),
    hasTaxSetter: writable.some((item) => TAX_NAME.test(item.name ?? "")),
  };
}
