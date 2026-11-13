import { getAddress, isAddress, type Address } from "viem";
import { DEAD, ZERO } from "./domain/addresses.js";

/**
 * GoPlus token-security judgment for one Base token.
 *
 * Field names and scales come from the live `GET /api/v1/token_security/8453`
 * payload and from GoPlus response details
 * (https://docs.gopluslabs.io/reference/response-details):
 *
 * - Flags are the strings `"1"` (true), `"0"` (false), or omitted / `""` (unknown).
 *   Unknown is null. It is never coerced to false.
 * - `buy_tax`, `sell_tax`, and `transfer_tax` are fractions on a 0–1 scale.
 *   `"1"` is 100%. `""` or a missing field is unknown, not zero.
 * - `honeypot_with_same_creator` is a count, not a boolean.
 * - Holder and owner `percent` values use the same 0–1 scale (1 = 100%).
 * - `dex[].liquidity` is a USD string. It is copied, not rounded into a new number.
 *
 * Judgment, evaluated after those fields are parsed:
 *
 * BLOCK (any one is enough): honeypot, cannot buy, cannot sell all, hidden owner,
 * owner can change balances, ownership can be taken back, per-address tax,
 * self-destruct, gas abuse, airdrop scam, counterfeit token, or buy/sell/transfer
 * tax >= 10%. The same hard signals inside `b20_token.b20_info` count too.
 *
 * WARN: tax >= 3% and < 10%, mintable, proxy, trading cooldown, pausable
 * transfers, blacklist, whitelist, modifiable tax, anti-whale, external call,
 * closed source, no mainstream DEX pair, creator honeypot count >= 1,
 * a non-empty `other_potential_risks`, partial GoPlus data (response code 2),
 * or a missing honeypot/tax value on a contract GoPlus should have been able to
 * score (not closed-source and not a proxy).
 *
 * PASS: none of the above. Notes never change the judgment.
 */
export const BASE_CHAIN_ID = 8453;

/** Buy, sell, or transfer tax at or above this percent is BLOCK. GoPlus `"0.1"` is 10%. */
export const TAX_BLOCK_PCT = 10;
/** Tax at or above this percent, and below the block line, is WARN. */
export const TAX_WARN_PCT = 3;

export type Judgment = "PASS" | "WARN" | "BLOCK";
export type ParseErrorKind = "invalid_response" | "empty_result" | "api_error";

export class ParseError extends Error {
  readonly kind: ParseErrorKind;

  constructor(kind: ParseErrorKind, message: string) {
    super(message);
    this.name = "ParseError";
    this.kind = kind;
  }
}

export interface TokenSafetyMetrics {
  tokenName: string | null;
  tokenSymbol: string | null;
  totalSupply: string | null;
  holderCount: number | null;
  /** Percent. Null when GoPlus omitted the tax or returned `""`. */
  buyTaxPct: number | null;
  sellTaxPct: number | null;
  transferTaxPct: number | null;
  isHoneypot: boolean | null;
  cannotBuy: boolean | null;
  cannotSellAll: boolean | null;
  isMintable: boolean | null;
  isProxy: boolean | null;
  isOpenSource: boolean | null;
  hiddenOwner: boolean | null;
  ownerChangeBalance: boolean | null;
  canTakeBackOwnership: boolean | null;
  selfdestruct: boolean | null;
  tradingCooldown: boolean | null;
  transferPausable: boolean | null;
  slippageModifiable: boolean | null;
  personalSlippageModifiable: boolean | null;
  isBlacklisted: boolean | null;
  isWhitelisted: boolean | null;
  isAntiWhale: boolean | null;
  antiWhaleModifiable: boolean | null;
  externalCall: boolean | null;
  gasAbuse: boolean | null;
  /** True only for `"1"`. Omitted is null, not false. Only `"1"` means a scam. */
  isAirdropScam: boolean | null;
  /** True for `is_true_token` `"0"` or `fake_token.value` 1. */
  isFakeToken: boolean | null;
  /** True only for `trust_list` `"1"`. Omitted is null and is not a risk. */
  trustList: boolean | null;
  isInDex: boolean | null;
  honeypotsWithSameCreator: number | null;
  /** Empty string means GoPlus says the contract has no owner. Null means omitted. */
  ownerAddress: string | null;
  ownerPercentPct: number | null;
  /** Original GoPlus USD string for the pool with the highest parsed liquidity. */
  mainPoolLiquidityUsd: string | null;
  mainPoolDex: string | null;
  mainPoolPair: string | null;
  /**
   * Sum of the holder `percent` rows GoPlus returned, as a percent.
   * Pools, burn addresses, and lockers are not removed. Null when no row had a percent.
   * This is not the HTTP API's pool-excluded `holdersTop10Pct`.
   */
  reportedTopHoldersPct: number | null;
  holderRows: number | null;
  cexListed: boolean | null;
  cexNames: string[];
  launchpadName: string | null;
  otherPotentialRisks: string | null;
  note: string | null;
}

export interface TokenSafetyJudgment {
  chainId: typeof BASE_CHAIN_ID;
  address: string;
  judgment: Judgment;
  reasons: string[];
  notes: string[];
  partial: boolean;
  source: {
    provider: "goplus";
    chainId: typeof BASE_CHAIN_ID;
    endpoint: "/api/v1/token_security/8453";
  };
  metrics: TokenSafetyMetrics;
}

const FLAG_FIELDS = [
  "is_open_source",
  "is_proxy",
  "is_mintable",
  "is_honeypot",
  "cannot_buy",
  "cannot_sell_all",
  "hidden_owner",
  "owner_change_balance",
  "can_take_back_ownership",
  "selfdestruct",
  "external_call",
  "gas_abuse",
  "slippage_modifiable",
  "personal_slippage_modifiable",
  "trading_cooldown",
  "transfer_pausable",
  "is_blacklisted",
  "is_whitelisted",
  "is_anti_whale",
  "anti_whale_modifiable",
  "is_in_dex",
  "is_airdrop_scam",
  "trust_list",
] as const;

type FlagField = (typeof FLAG_FIELDS)[number];

interface ParsedToken {
  partial: boolean;
  flags: Record<FlagField, boolean | null>;
  buyTaxPct: number | null;
  sellTaxPct: number | null;
  transferTaxPct: number | null;
  tokenName: string | null;
  tokenSymbol: string | null;
  totalSupply: string | null;
  holderCount: number | null;
  honeypotsWithSameCreator: number | null;
  ownerAddress: string | null;
  ownerPercentPct: number | null;
  isFakeToken: boolean | null;
  otherPotentialRisks: string | null;
  note: string | null;
  mainPoolLiquidityUsd: string | null;
  mainPoolDex: string | null;
  mainPoolPair: string | null;
  reportedTopHoldersPct: number | null;
  holderRows: number | null;
  cexListed: boolean | null;
  cexNames: string[];
  launchpadName: string | null;
  b20: B20Flags;
}

interface B20Flags {
  present: boolean;
  isB20: boolean | null;
  mintable: boolean | null;
  transferPausable: boolean | null;
  ownerChangeBalance: boolean | null;
  metadataModifiable: boolean | null;
  blacklist: boolean | null;
  whitelist: boolean | null;
  cannotSell: boolean | null;
  cannotBuy: boolean | null;
}

const B20_FEATURES = [
  "mintable",
  "transfer_pausable",
  "owner_change_balance",
  "metadata_modifiable",
  "blacklist",
  "whitelist",
  "cannot_sell",
  "cannot_buy",
] as const;

export function judgeGoPlusPayload(payload: unknown, address: string): TokenSafetyJudgment {
  const checksum = requireAddress(address);
  const { token, partial } = unwrapEnvelope(payload, checksum);
  return judgeToken(parseToken(token, partial), checksum);
}

function requireAddress(address: string): Address {
  const trimmed = address.trim();
  if (!isAddress(trimmed, { strict: false })) {
    throw new ParseError("invalid_response", "address must be a 20-byte hex string (0x plus 40 hex characters).");
  }
  const checksum = getAddress(trimmed);
  if (checksum === ZERO) {
    throw new ParseError("invalid_response", "address must not be the zero address.");
  }
  return checksum;
}

function unwrapEnvelope(payload: unknown, address: Address): { token: Record<string, unknown>; partial: boolean } {
  if (!isRecord(payload)) {
    throw new ParseError("invalid_response", "GoPlus response was not a JSON object.");
  }
  if (typeof payload.code !== "number" || !Number.isFinite(payload.code)) {
    throw new ParseError("invalid_response", "GoPlus response code was missing.");
  }
  if (payload.code === 4029) {
    throw new ParseError(
      "api_error",
      "GoPlus token security rate limit was reached (code 4029). Set GOPLUS_ACCESS_TOKEN or retry later.",
    );
  }
  if (payload.code !== 1 && payload.code !== 2) {
    const message = typeof payload.message === "string" && payload.message.trim() ? payload.message.trim().slice(0, 200) : "request rejected";
    throw new ParseError("api_error", `GoPlus token security failed (code ${payload.code}): ${message}`);
  }
  if (!("result" in payload) || payload.result == null) {
    throw new ParseError("empty_result", "GoPlus returned no token security result.");
  }
  if (!isRecord(payload.result)) {
    throw new ParseError("invalid_response", "GoPlus result was not an object keyed by token address.");
  }
  const keys = Object.keys(payload.result);
  if (keys.length === 0) {
    throw new ParseError("empty_result", "GoPlus returned no token security record for this address.");
  }
  const key = keys.find((item) => item.toLowerCase() === address.toLowerCase());
  if (!key) {
    throw new ParseError("empty_result", "GoPlus returned no token security record for this address.");
  }
  const token = payload.result[key];
  if (token == null || (isRecord(token) && Object.keys(token).length === 0)) {
    throw new ParseError("empty_result", "GoPlus returned an empty token security record for this address.");
  }
  if (!isRecord(token)) {
    throw new ParseError("invalid_response", "GoPlus token security record was not an object.");
  }
  return { token, partial: payload.code === 2 };
}

function parseToken(token: Record<string, unknown>, partial: boolean): ParsedToken {
  const flags = {} as Record<FlagField, boolean | null>;
  for (const field of FLAG_FIELDS) flags[field] = readFlag(token, field);

  return {
    partial,
    flags,
    buyTaxPct: readTaxPercent(token, "buy_tax"),
    sellTaxPct: readTaxPercent(token, "sell_tax"),
    transferTaxPct: readTaxPercent(token, "transfer_tax"),
    tokenName: readText(token, "token_name"),
    tokenSymbol: readText(token, "token_symbol"),
    totalSupply: readText(token, "total_supply"),
    holderCount: readCount(token, "holder_count"),
    honeypotsWithSameCreator: readCount(token, "honeypot_with_same_creator"),
    ownerAddress: readOwnerAddress(token),
    ownerPercentPct: readFractionPercent(token, "owner_percent"),
    isFakeToken: readFakeToken(token),
    otherPotentialRisks: readText(token, "other_potential_risks"),
    note: readText(token, "note"),
    ...readDex(token),
    ...readHolders(token),
    ...readCex(token),
    launchpadName: readLaunchpad(token),
    b20: readB20(token),
  };
}

function judgeToken(parsed: ParsedToken, address: Address): TokenSafetyJudgment {
  const block: string[] = [];
  const warn: string[] = [];
  const notes: string[] = [];
  const flags = parsed.flags;

  if (flags.is_honeypot === true) {
    block.push("GoPlus marks this token as a honeypot (is_honeypot=1). A sell can fail or the contract can contain malicious transfer code.");
  }
  if (flags.cannot_sell_all === true) {
    block.push("Holders cannot sell the full balance (cannot_sell_all=1).");
  }
  if (flags.cannot_buy === true) {
    block.push("The token cannot be bought (cannot_buy=1). A swap that buys it is expected to fail.");
  }
  if (flags.hidden_owner === true) {
    block.push("The contract has a hidden owner (hidden_owner=1), so control can survive an apparent renounce.");
  }
  if (flags.owner_change_balance === true || parsed.b20.ownerChangeBalance === true) {
    block.push("An admin can change holder balances (owner_change_balance=1).");
  }
  if (flags.can_take_back_ownership === true) {
    block.push("Ownership can be taken back after it is renounced (can_take_back_ownership=1).");
  }
  if (flags.personal_slippage_modifiable === true) {
    block.push("The owner can set a different tax for a chosen address (personal_slippage_modifiable=1), which can block that address from trading.");
  }
  if (flags.selfdestruct === true) {
    block.push("The contract can self-destruct (selfdestruct=1).");
  }
  if (flags.gas_abuse === true) {
    block.push("The contract uses the caller's gas to mint other assets (gas_abuse=1).");
  }
  if (flags.is_airdrop_scam === true) {
    block.push("GoPlus marks this token as an airdrop scam (is_airdrop_scam=1).");
  }
  if (parsed.isFakeToken === true) {
    block.push("GoPlus marks this token as a counterfeit of another asset (is_true_token=0 or fake_token.value=1).");
  }
  if (parsed.b20.cannotSell === true && flags.cannot_sell_all !== true && flags.is_honeypot !== true) {
    block.push("GoPlus B20 data says this token cannot be sold (b20_token.b20_info.cannot_sell.status=1).");
  }
  if (parsed.b20.cannotBuy === true && flags.cannot_buy !== true) {
    block.push("GoPlus B20 data says this token cannot be bought (b20_token.b20_info.cannot_buy.status=1).");
  }

  addTaxReasons("Buy", parsed.buyTaxPct, block, warn);
  addTaxReasons("Sell", parsed.sellTaxPct, block, warn);
  addTaxReasons("Transfer", parsed.transferTaxPct, block, warn);

  if (flags.is_open_source === false) {
    warn.push("Contract source is closed (is_open_source=0). GoPlus does not score honeypot, mint, or owner controls on closed-source contracts.");
  }
  if (flags.is_proxy === true) {
    warn.push("Contract is a proxy (is_proxy=1). The implementation can change, and GoPlus may omit other risk flags.");
  }
  if (flags.is_mintable === true || parsed.b20.mintable === true) {
    warn.push("The contract can mint supply (is_mintable=1).");
  }
  if (flags.trading_cooldown === true) {
    warn.push("Trading cooldown is enabled (trading_cooldown=1). A swap can revert if it follows another transfer too soon. GoPlus may also report sell_tax as 1 while cooldown is on.");
  }
  if (flags.transfer_pausable === true || parsed.b20.transferPausable === true) {
    warn.push("Transfers can be paused (transfer_pausable=1).");
  }
  if (flags.is_blacklisted === true || parsed.b20.blacklist === true) {
    warn.push("The contract has a blacklist (is_blacklisted=1).");
  }
  if (flags.is_whitelisted === true || parsed.b20.whitelist === true) {
    warn.push("The contract has a whitelist (is_whitelisted=1). Addresses outside it may be unable to trade.");
  }
  if (flags.slippage_modifiable === true) {
    warn.push("Buy or sell tax can be changed (slippage_modifiable=1).");
  }
  if (flags.is_anti_whale === true) {
    warn.push("The contract limits transaction size or wallet size (is_anti_whale=1).");
  }
  if (flags.anti_whale_modifiable === true) {
    warn.push("The anti-whale limit can be changed (anti_whale_modifiable=1). A very small limit blocks trading.");
  }
  if (flags.external_call === true) {
    warn.push("Primary token methods call another contract (external_call=1).");
  }
  if (flags.is_in_dex === false) {
    warn.push("GoPlus found no mainstream DEX pair (is_in_dex=0), so a swap may have no pool.");
  }
  if (parsed.honeypotsWithSameCreator !== null && parsed.honeypotsWithSameCreator >= 1) {
    warn.push(`This creator has ${parsed.honeypotsWithSameCreator} other honeypot token(s) (honeypot_with_same_creator).`);
  }
  if (parsed.otherPotentialRisks) {
    warn.push(`GoPlus other_potential_risks: ${parsed.otherPotentialRisks}`);
  }
  if (parsed.b20.metadataModifiable === true) {
    warn.push("Token metadata can be changed (b20_token.b20_info.metadata_modifiable.status=1).");
  }
  if (parsed.b20.isB20 === true && !b20HasSpecificRisk(parsed.b20)) {
    warn.push("GoPlus B20 data flags this token (b20_token.is_b20=1) without a more specific status.");
  }
  if (parsed.partial) {
    warn.push("GoPlus returned partial data (response code 2). Retry in about 15 seconds for a complete scan.");
  }

  addCoverageWarnings(parsed, warn);
  addNotes(parsed, notes);

  const judgment: Judgment = block.length > 0 ? "BLOCK" : warn.length > 0 ? "WARN" : "PASS";
  return {
    chainId: BASE_CHAIN_ID,
    address,
    judgment,
    reasons: [...block, ...warn],
    notes,
    partial: parsed.partial,
    source: {
      provider: "goplus",
      chainId: BASE_CHAIN_ID,
      endpoint: "/api/v1/token_security/8453",
    },
    metrics: metricsFrom(parsed),
  };
}

function addTaxReasons(side: "Buy" | "Sell" | "Transfer", percent: number | null, block: string[], warn: string[]): void {
  if (percent === null) return;
  if (percent >= TAX_BLOCK_PCT) {
    block.push(`${side} tax is ${formatPct(percent)}%, at or above the ${TAX_BLOCK_PCT}% block line.`);
    return;
  }
  if (percent >= TAX_WARN_PCT) {
    warn.push(`${side} tax is ${formatPct(percent)}%, at or above the ${TAX_WARN_PCT}% warn line and below the ${TAX_BLOCK_PCT}% block line.`);
  }
}

function addCoverageWarnings(parsed: ParsedToken, warn: string[]): void {
  const blinded = parsed.flags.is_open_source === false || parsed.flags.is_proxy === true;
  if (blinded) return;
  if (parsed.flags.is_honeypot === null) {
    warn.push("GoPlus did not report is_honeypot. A missing flag is unknown, not a pass.");
  }
  if (parsed.flags.is_in_dex === false) return;
  if (parsed.buyTaxPct === null) {
    warn.push("GoPlus did not report buy_tax. An empty or missing tax is unknown, not zero.");
  }
  if (parsed.sellTaxPct === null) {
    warn.push("GoPlus did not report sell_tax. An empty or missing tax is unknown, not zero.");
  }
}

function addNotes(parsed: ParsedToken, notes: string[]): void {
  noteSmallTax(notes, "Buy", parsed.buyTaxPct);
  noteSmallTax(notes, "Sell", parsed.sellTaxPct);
  noteSmallTax(notes, "Transfer", parsed.transferTaxPct);
  if (parsed.ownerAddress === "") {
    notes.push("GoPlus owner_address is empty, which means the contract reports no owner.");
  } else if (parsed.ownerAddress && sameAddress(parsed.ownerAddress, ZERO)) {
    notes.push("owner_address is the zero address, so ownership is renounced.");
  } else if (parsed.ownerAddress && sameAddress(parsed.ownerAddress, DEAD)) {
    notes.push("owner_address is the dead address, so ownership is renounced.");
  }
  if (parsed.flags.trust_list === true) {
    notes.push("GoPlus trust_list is 1. That marks a well-known token and does not clear BLOCK or WARN.");
  }
  if (parsed.cexListed === true) {
    const names = parsed.cexNames.length > 0 ? parsed.cexNames.join(", ") : "a major venue";
    notes.push(`Listed on a major CEX (${names}). GoPlus treats that as widely traded. It does not clear BLOCK or WARN.`);
  }
  if (parsed.launchpadName) {
    notes.push(`GoPlus lists this as a launchpad token (${parsed.launchpadName}).`);
  }
  if (parsed.note) notes.push(`GoPlus note: ${parsed.note}`);
  if (parsed.holderRows !== null && parsed.holderRows > 0 && parsed.holderRows < 10 && parsed.reportedTopHoldersPct !== null) {
    notes.push(`GoPlus returned ${parsed.holderRows} holder rows, so reportedTopHoldersPct sums only those rows.`);
  }
}

function noteSmallTax(notes: string[], side: "Buy" | "Sell" | "Transfer", percent: number | null): void {
  if (percent === null || percent <= 0 || percent >= TAX_WARN_PCT) return;
  notes.push(`${side} tax is ${formatPct(percent)}%, below the ${TAX_WARN_PCT}% warn line.`);
}

function b20HasSpecificRisk(b20: B20Flags): boolean {
  return (
    b20.mintable === true ||
    b20.transferPausable === true ||
    b20.ownerChangeBalance === true ||
    b20.metadataModifiable === true ||
    b20.blacklist === true ||
    b20.whitelist === true ||
    b20.cannotSell === true ||
    b20.cannotBuy === true
  );
}

function metricsFrom(parsed: ParsedToken): TokenSafetyMetrics {
  const flags = parsed.flags;
  return {
    tokenName: parsed.tokenName,
    tokenSymbol: parsed.tokenSymbol,
    totalSupply: parsed.totalSupply,
    holderCount: parsed.holderCount,
    buyTaxPct: parsed.buyTaxPct,
    sellTaxPct: parsed.sellTaxPct,
    transferTaxPct: parsed.transferTaxPct,
    isHoneypot: flags.is_honeypot,
    cannotBuy: flags.cannot_buy,
    cannotSellAll: flags.cannot_sell_all,
    isMintable: flags.is_mintable === true || parsed.b20.mintable === true ? true : flags.is_mintable,
    isProxy: flags.is_proxy,
    isOpenSource: flags.is_open_source,
    hiddenOwner: flags.hidden_owner,
    ownerChangeBalance: flags.owner_change_balance === true || parsed.b20.ownerChangeBalance === true ? true : flags.owner_change_balance,
    canTakeBackOwnership: flags.can_take_back_ownership,
    selfdestruct: flags.selfdestruct,
    tradingCooldown: flags.trading_cooldown,
    transferPausable: flags.transfer_pausable === true || parsed.b20.transferPausable === true ? true : flags.transfer_pausable,
    slippageModifiable: flags.slippage_modifiable,
    personalSlippageModifiable: flags.personal_slippage_modifiable,
    isBlacklisted: flags.is_blacklisted === true || parsed.b20.blacklist === true ? true : flags.is_blacklisted,
    isWhitelisted: flags.is_whitelisted === true || parsed.b20.whitelist === true ? true : flags.is_whitelisted,
    isAntiWhale: flags.is_anti_whale,
    antiWhaleModifiable: flags.anti_whale_modifiable,
    externalCall: flags.external_call,
    gasAbuse: flags.gas_abuse,
    isAirdropScam: flags.is_airdrop_scam,
    isFakeToken: parsed.isFakeToken,
    trustList: flags.trust_list,
    isInDex: flags.is_in_dex,
    honeypotsWithSameCreator: parsed.honeypotsWithSameCreator,
    ownerAddress: parsed.ownerAddress,
    ownerPercentPct: parsed.ownerPercentPct,
    mainPoolLiquidityUsd: parsed.mainPoolLiquidityUsd,
    mainPoolDex: parsed.mainPoolDex,
    mainPoolPair: parsed.mainPoolPair,
    reportedTopHoldersPct: parsed.reportedTopHoldersPct,
    holderRows: parsed.holderRows,
    cexListed: parsed.cexListed,
    cexNames: parsed.cexNames,
    launchpadName: parsed.launchpadName,
    otherPotentialRisks: parsed.otherPotentialRisks,
    note: parsed.note,
  };
}

function readFlag(record: Record<string, unknown>, key: string): boolean | null {
  if (!(key in record) || record[key] == null) return null;
  const value = record[key];
  if (typeof value !== "string") {
    throw new ParseError("invalid_response", `GoPlus field ${key} must be a string "0" or "1".`);
  }
  if (value === "") return null;
  if (value === "1") return true;
  if (value === "0") return false;
  throw new ParseError("invalid_response", `GoPlus field ${key} must be "0", "1", or empty.`);
}

function readTaxPercent(record: Record<string, unknown>, key: string): number | null {
  return readFractionPercent(record, key);
}

function readFractionPercent(record: Record<string, unknown>, key: string): number | null {
  if (!(key in record) || record[key] == null) return null;
  const value = record[key];
  if (typeof value !== "string") {
    throw new ParseError("invalid_response", `GoPlus field ${key} must be a 0–1 fraction string.`);
  }
  if (value.trim() === "") return null;
  const micros = fractionMicros(value, key);
  return micros / 10_000;
}

function readCount(record: Record<string, unknown>, key: string): number | null {
  if (!(key in record) || record[key] == null) return null;
  const value = record[key];
  if (typeof value !== "string") {
    throw new ParseError("invalid_response", `GoPlus field ${key} must be a decimal string.`);
  }
  if (value.trim() === "") return null;
  if (!/^\d+$/.test(value)) {
    throw new ParseError("invalid_response", `GoPlus field ${key} must be a non-negative integer string.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ParseError("invalid_response", `GoPlus field ${key} is outside the safe integer range.`);
  }
  return parsed;
}

function readText(record: Record<string, unknown>, key: string): string | null {
  if (!(key in record) || record[key] == null) return null;
  const value = record[key];
  if (typeof value !== "string") {
    throw new ParseError("invalid_response", `GoPlus field ${key} must be a string.`);
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readOwnerAddress(record: Record<string, unknown>): string | null {
  if (!("owner_address" in record) || record.owner_address == null) return null;
  const value = record.owner_address;
  if (typeof value !== "string") {
    throw new ParseError("invalid_response", "GoPlus field owner_address must be a string.");
  }
  return value.trim();
}

function readFakeToken(record: Record<string, unknown>): boolean | null {
  const trueToken = readOptionalTrueToken(record);
  const fakeValue = readFakeValue(record);
  if (trueToken === false || fakeValue === true) return true;
  if (trueToken === true || fakeValue === false) return false;
  return null;
}

function readOptionalTrueToken(record: Record<string, unknown>): boolean | null {
  if (!("is_true_token" in record) || record.is_true_token == null) return null;
  const value = record.is_true_token;
  if (typeof value !== "string") {
    throw new ParseError("invalid_response", 'GoPlus field is_true_token must be "0" or "1".');
  }
  if (value === "") return null;
  if (value === "1") return true;
  if (value === "0") return false;
  throw new ParseError("invalid_response", 'GoPlus field is_true_token must be "0", "1", or empty.');
}

function readFakeValue(record: Record<string, unknown>): boolean | null {
  if (!("fake_token" in record) || record.fake_token == null) return null;
  if (!isRecord(record.fake_token)) {
    throw new ParseError("invalid_response", "GoPlus field fake_token must be an object.");
  }
  if (!("value" in record.fake_token) || record.fake_token.value == null || record.fake_token.value === "") return null;
  const value = record.fake_token.value;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  throw new ParseError("invalid_response", "GoPlus fake_token.value must be 0 or 1.");
}

function readDex(record: Record<string, unknown>): {
  mainPoolLiquidityUsd: string | null;
  mainPoolDex: string | null;
  mainPoolPair: string | null;
} {
  if (!("dex" in record) || record.dex == null) {
    return { mainPoolLiquidityUsd: null, mainPoolDex: null, mainPoolPair: null };
  }
  if (!Array.isArray(record.dex)) {
    throw new ParseError("invalid_response", "GoPlus field dex must be an array.");
  }
  let best: { liquidity: number; raw: string; name: string | null; pair: string | null } | null = null;
  for (const entry of record.dex) {
    if (!isRecord(entry) || typeof entry.liquidity !== "string" || !/^\d+(\.\d+)?$/.test(entry.liquidity)) continue;
    const liquidity = Number(entry.liquidity);
    if (!Number.isFinite(liquidity)) continue;
    if (!best || liquidity > best.liquidity) {
      best = {
        liquidity,
        raw: entry.liquidity,
        name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : null,
        pair: typeof entry.pair === "string" && entry.pair.trim() ? entry.pair.trim() : null,
      };
    }
  }
  if (!best) return { mainPoolLiquidityUsd: null, mainPoolDex: null, mainPoolPair: null };
  return { mainPoolLiquidityUsd: best.raw, mainPoolDex: best.name, mainPoolPair: best.pair };
}

function readHolders(record: Record<string, unknown>): { reportedTopHoldersPct: number | null; holderRows: number | null } {
  if (!("holders" in record) || record.holders == null) return { reportedTopHoldersPct: null, holderRows: null };
  if (!Array.isArray(record.holders)) {
    throw new ParseError("invalid_response", "GoPlus field holders must be an array.");
  }
  let micros = 0;
  let used = 0;
  const rows = record.holders.slice(0, 10);
  for (const row of rows) {
    if (!isRecord(row) || typeof row.percent !== "string" || row.percent.trim() === "") continue;
    try {
      micros += fractionMicros(row.percent.trim(), "holders.percent");
      used += 1;
    } catch {
      continue;
    }
  }
  return {
    reportedTopHoldersPct: used > 0 ? micros / 10_000 : null,
    holderRows: record.holders.length,
  };
}

function readCex(record: Record<string, unknown>): { cexListed: boolean | null; cexNames: string[] } {
  if (!("is_in_cex" in record) || record.is_in_cex == null) return { cexListed: null, cexNames: [] };
  if (!isRecord(record.is_in_cex)) {
    throw new ParseError("invalid_response", "GoPlus field is_in_cex must be an object.");
  }
  const listed = readFlag(record.is_in_cex, "listed");
  const names: string[] = [];
  if ("cex_list" in record.is_in_cex && record.is_in_cex.cex_list != null) {
    if (!Array.isArray(record.is_in_cex.cex_list)) {
      throw new ParseError("invalid_response", "GoPlus field is_in_cex.cex_list must be an array.");
    }
    for (const item of record.is_in_cex.cex_list) {
      if (typeof item === "string" && item.trim()) names.push(item.trim());
    }
  }
  return { cexListed: listed, cexNames: names };
}

function readLaunchpad(record: Record<string, unknown>): string | null {
  if (!("launchpad_token" in record) || record.launchpad_token == null) return null;
  if (!isRecord(record.launchpad_token)) {
    throw new ParseError("invalid_response", "GoPlus field launchpad_token must be an object.");
  }
  const flag = readFlag(record.launchpad_token, "is_launchpad_token");
  if (flag !== true) return null;
  const name = readText(record.launchpad_token, "launchpad_name");
  return name ?? "unknown launchpad";
}

function readB20(record: Record<string, unknown>): B20Flags {
  const empty: B20Flags = {
    present: false,
    isB20: null,
    mintable: null,
    transferPausable: null,
    ownerChangeBalance: null,
    metadataModifiable: null,
    blacklist: null,
    whitelist: null,
    cannotSell: null,
    cannotBuy: null,
  };
  if (!("b20_token" in record) || record.b20_token == null) return empty;
  if (!isRecord(record.b20_token)) {
    throw new ParseError("invalid_response", "GoPlus field b20_token must be an object.");
  }
  const info = record.b20_token.b20_info;
  const features: Record<(typeof B20_FEATURES)[number], boolean | null> = {
    mintable: null,
    transfer_pausable: null,
    owner_change_balance: null,
    metadata_modifiable: null,
    blacklist: null,
    whitelist: null,
    cannot_sell: null,
    cannot_buy: null,
  };
  if (info != null) {
    if (!isRecord(info)) throw new ParseError("invalid_response", "GoPlus field b20_token.b20_info must be an object.");
    for (const feature of B20_FEATURES) {
      if (!(feature in info) || info[feature] == null) continue;
      if (!isRecord(info[feature])) {
        throw new ParseError("invalid_response", `GoPlus field b20_token.b20_info.${feature} must be an object.`);
      }
      features[feature] = readFlag(info[feature], "status");
    }
  }
  return {
    present: true,
    isB20: readFlag(record.b20_token, "is_b20"),
    mintable: features.mintable,
    transferPausable: features.transfer_pausable,
    ownerChangeBalance: features.owner_change_balance,
    metadataModifiable: features.metadata_modifiable,
    blacklist: features.blacklist,
    whitelist: features.whitelist,
    cannotSell: features.cannot_sell,
    cannotBuy: features.cannot_buy,
  };
}

/** Fraction string on a 0–1 scale, as millionths. 1_000_000 is 100%. */
function fractionMicros(raw: string, key: string): number {
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new ParseError("invalid_response", `GoPlus field ${key} must be a 0–1 fraction string.`);
  }
  const [whole = "0", frac = ""] = raw.split(".");
  if (whole.length > 1 || (whole !== "0" && whole !== "1")) {
    throw new ParseError("invalid_response", `GoPlus field ${key} must be between 0 and 1.`);
  }
  if (whole === "1" && /[1-9]/.test(frac)) {
    throw new ParseError("invalid_response", `GoPlus field ${key} must be between 0 and 1.`);
  }
  const padded = frac + "0000000";
  let micros = Number(whole) * 1_000_000 + Number(padded.slice(0, 6));
  if (padded[6] !== undefined && padded[6] >= "5") micros += 1;
  if (micros > 1_000_000) micros = 1_000_000;
  return micros;
}

function formatPct(percent: number): string {
  const rounded = Math.round(percent * 10_000) / 10_000;
  return String(rounded);
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
