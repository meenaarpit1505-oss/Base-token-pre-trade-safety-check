import { getAddress, type Address } from "viem";

export const CHAIN_ID = 8453;

/** Harness address. Code and balance exist only inside an eth_call state override. */
export const SIMULATOR = getAddress("0x00000000000000000000000000000000000c0ded");
/** EOA `from` so tx.origin has no code. Anti-bot extcodesize(tx.origin) checks then see an EOA. */
export const SIMULATION_CALLER = getAddress("0x000000000000000000000000000000000000dea1");

export const MULTICALL3 = getAddress("0xcA11bde05977b3631167028862bE2a173976CA11");

export const WETH = getAddress("0x4200000000000000000000000000000000000006");
export const USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
export const USDBC = getAddress("0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA");
export const DAI = getAddress("0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb");
export const AERO = getAddress("0x940181a94A35A4569E4529A3CDfB74e38FD98631");

/** Uniswap V3 WETH/USDC 0.05% pool. Used as the ETH/USD price source. */
export const WETH_USDC_POOL = getAddress("0xd0b53D9277642d899DF5C87A3966A349A798F224");

export const ZERO = getAddress("0x0000000000000000000000000000000000000000");
export const DEAD = getAddress("0x000000000000000000000000000000000000dead");

export const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;
/** ZeppelinOS / FiatToken proxy implementation slot. Base USDC uses this, not EIP-1967. */
export const FIAT_PROXY_IMPLEMENTATION_SLOT =
  "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3" as const;

/**
 * ERC-20 LP lockers on Base. V3 lockers hold NFTs, so they are not balance-checked here.
 * Aerodrome gauges are intentionally absent: staked LP can be withdrawn.
 */
export const LP_LOCKERS: readonly Address[] = [
  getAddress("0xc4E637D37113192F4F1F060DaEbD7758De7F4131"),
  getAddress("0xBeddF48499788607B4c2e704e9099561ab38Aae8"),
  getAddress("0x30e522deDfFE3e3d11Cd53E27d18Cd4F016eD870"),
  getAddress("0xdD6E31A046b828CbBAfb939C2a394629aff8BBdC"),
];

export const BURN_ADDRESSES: readonly Address[] = [ZERO, DEAD];

/** Verified on Base USDC (FiatToken proxy storage layout, mapping slot 9). */
export const KNOWN_BALANCE_SLOTS = new Map<string, number>([[USDC.toLowerCase(), 9]]);

export interface QuoteToken {
  address: Address;
  symbol: string;
  decimals: number;
  usd: "eth" | "stable" | "aero" | "dai";
}

export const QUOTE_TOKENS: readonly QuoteToken[] = [
  { address: WETH, symbol: "WETH", decimals: 18, usd: "eth" },
  { address: USDC, symbol: "USDC", decimals: 6, usd: "stable" },
  { address: USDBC, symbol: "USDbC", decimals: 6, usd: "stable" },
  { address: DAI, symbol: "DAI", decimals: 18, usd: "dai" },
  { address: AERO, symbol: "AERO", decimals: 18, usd: "aero" },
];

export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function quoteByAddress(address: string): QuoteToken | undefined {
  return QUOTE_TOKENS.find((quote) => sameAddress(quote.address, address));
}
