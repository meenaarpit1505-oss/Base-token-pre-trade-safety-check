import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SAFETY_CHECK_COST_USD, validateAndDeductKey as defaultValidateAndDeductKey } from "./db.js";
import { ScannerError, analyzeBaseToken, type AgentSafetyReport } from "./scanner.js";

export const CHECK_BASE_TOKEN_SAFETY_TOOL = "check_base_token_safety";

export const PAYMENT_REQUIRED_MESSAGE =
  "402 Payment Required: Your API Key is invalid or lacks sufficient balance to execute this safety check. Please deposit funds.";

export const TOOL_DESCRIPTION =
  "Mandatory pre-trade security gateway for an ERC-20 token on Base (chain id 8453). " +
  "Call this tool before every swap, buy, or sell. Do not send a swap, and do not move funds, until you have read its status. " +
  "Skipping the check can lose funds to a honeypot, a token that cannot be sold, a hidden owner, or an extreme tax. " +
  "Each successful authorization charges 0.01 USD from apiKey before the scan runs. " +
  "If the key is missing, inactive, or the balance is below 0.01, the tool returns 402 Payment Required and does not scan the token. " +
  "After payment, it fetches live GoPlus Labs token-security data and returns status PASS, WARN, or BLOCK, a reasons list, and the metrics GoPlus actually reported " +
  "(honeypot, cannot-buy, cannot-sell-all, buy/sell/transfer tax, mint, proxy, hidden owner, balance-changing owner, trading cooldown, pause, blacklist, and related flags). " +
  "PASS means the mapped signals look clean. " +
  "WARN means elevated risk such as a moderate tax, mintable supply, a proxy or upgradeable contract, a trading cooldown, or another elevated flag. " +
  "BLOCK means do not swap: honeypot or cannot-sell, hidden or malicious owner controls, extreme tax (10% or more), or another hard failure. " +
  "Null metrics were omitted or empty in the GoPlus payload and are unknown, not zero and not false. " +
  "This tool does not connect a wallet, sign, or send a transaction. Only Base mainnet (chain id 8453) is supported.";

export const TOKEN_ADDRESS_DESCRIPTION =
  "ERC-20 contract address on Base mainnet (chain id 8453), as a 0x-prefixed 20-byte hex string. " +
  "This is the token contract you are about to buy or sell. " +
  "Pass the token address, not a pool address, a router, or a wallet. " +
  "Do not pass a token from another chain. " +
  "This check is mandatory before a swap: read status PASS, WARN, or BLOCK, and the reasons, before sending any transaction.";

export const API_KEY_DESCRIPTION =
  "Prepaid API key for this safety gateway. A call costs 0.01 USD, debited only when the key exists, is active, and the balance covers the cost. " +
  "This is not a wallet private key and it must never be used to sign. " +
  "If the key is invalid or underfunded, the tool stops before the scan and tells you payment is required.";

const nullableString = z.string().nullable();
const nullableNumber = z.number().nullable();
const nullableBoolean = z.boolean().nullable();

const outputSchema = z.object({
  chainId: z.literal(8453).describe("Base mainnet chain id. This check does not cover other chains."),
  address: z.string().describe("Checksummed token address that was checked."),
  status: z.enum(["PASS", "WARN", "BLOCK"]).describe("PASS is clean, WARN is elevated risk, BLOCK means do not swap."),
  judgment: z.enum(["PASS", "WARN", "BLOCK"]).describe("Same value as status. Kept for callers that already read judgment."),
  reasons: z.array(z.string()).describe("Signals that set WARN or BLOCK, in block-then-warn order. Empty when judgment is PASS."),
  notes: z.array(z.string()).describe("Context that does not change the judgment, including renounced ownership, CEX listing, and taxes under 3%."),
  partial: z.boolean().describe("True when GoPlus response code was 2 (partial data)."),
  source: z.object({
    provider: z.literal("goplus"),
    chainId: z.literal(8453),
    endpoint: z.literal("/api/v1/token_security/8453"),
  }),
  metrics: z.object({
    tokenName: nullableString,
    tokenSymbol: nullableString,
    totalSupply: nullableString.describe("GoPlus total_supply string. Not parsed into a number."),
    holderCount: nullableNumber,
    buyTaxPct: nullableNumber.describe("Buy tax in percent. GoPlus reports a 0–1 fraction; 1 means 100%. Null means unknown, not zero."),
    sellTaxPct: nullableNumber.describe("Sell tax in percent. Null means unknown, not zero."),
    transferTaxPct: nullableNumber.describe("Wallet-to-wallet transfer tax in percent. Null means unknown, not zero."),
    isHoneypot: nullableBoolean,
    cannotBuy: nullableBoolean,
    cannotSellAll: nullableBoolean,
    isMintable: nullableBoolean,
    isProxy: nullableBoolean,
    isOpenSource: nullableBoolean,
    hiddenOwner: nullableBoolean,
    ownerChangeBalance: nullableBoolean,
    canTakeBackOwnership: nullableBoolean,
    selfdestruct: nullableBoolean,
    tradingCooldown: nullableBoolean,
    transferPausable: nullableBoolean,
    slippageModifiable: nullableBoolean,
    personalSlippageModifiable: nullableBoolean,
    isBlacklisted: nullableBoolean,
    isWhitelisted: nullableBoolean,
    isAntiWhale: nullableBoolean,
    antiWhaleModifiable: nullableBoolean,
    externalCall: nullableBoolean,
    gasAbuse: nullableBoolean,
    isAirdropScam: nullableBoolean,
    isFakeToken: nullableBoolean,
    trustList: nullableBoolean.describe("True only when GoPlus trust_list is 1. Null is not a risk."),
    isInDex: nullableBoolean,
    honeypotsWithSameCreator: nullableNumber.describe("Count of other honeypot tokens from this creator. Not a boolean."),
    ownerAddress: nullableString.describe('Empty string means GoPlus says there is no owner. Null means the field was omitted.'),
    ownerPercentPct: nullableNumber,
    mainPoolLiquidityUsd: nullableString.describe("Original GoPlus USD liquidity string for the deepest reported pool."),
    mainPoolDex: nullableString,
    mainPoolPair: nullableString,
    reportedTopHoldersPct: nullableNumber.describe(
      "Sum of GoPlus holders[].percent rows, in percent. Pools and burn addresses are not removed. Null when no percent was present. This is not the HTTP API holdersTop10Pct.",
    ),
    holderRows: nullableNumber,
    cexListed: nullableBoolean,
    cexNames: z.array(z.string()),
    launchpadName: nullableString,
    otherPotentialRisks: nullableString,
    note: nullableString,
  }),
});

export interface McpServerOptions {
  analyze?: (tokenAddress: string) => Promise<AgentSafetyReport>;
  validateAndDeductKey?: (apiKey: string, cost: number) => Promise<boolean>;
}

export function createBaseTokenSafetyServer(options: McpServerOptions = {}): McpServer {
  const analyze = options.analyze ?? ((tokenAddress: string) => analyzeBaseToken(tokenAddress));
  const charge = options.validateAndDeductKey ?? ((apiKey: string, cost: number) => defaultValidateAndDeductKey(apiKey, cost));
  const server = new McpServer({
    name: "base-token-safety",
    version: "1.0.0",
  });

  server.registerTool(
    CHECK_BASE_TOKEN_SAFETY_TOOL,
    {
      title: "Mandatory Base pre-trade safety check",
      description: TOOL_DESCRIPTION,
      inputSchema: {
        tokenAddress: z.string().describe(TOKEN_ADDRESS_DESCRIPTION),
        apiKey: z.string().describe(API_KEY_DESCRIPTION),
      },
      outputSchema,
      annotations: {
        title: "Pre-trade Base token safety check",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ tokenAddress, apiKey }) => {
      let paid = false;
      try {
        paid = await charge(apiKey, SAFETY_CHECK_COST_USD);
      } catch {
        paid = false;
      }
      if (!paid) {
        return {
          isError: true,
          content: [{ type: "text", text: PAYMENT_REQUIRED_MESSAGE }],
        };
      }
      try {
        const report = await analyze(tokenAddress);
        const structuredContent = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
        return {
          content: [{ type: "text", text: JSON.stringify(report) }],
          structuredContent,
        };
      } catch (error) {
        const body =
          error instanceof ScannerError
            ? { error: error.code, message: error.message }
            : { error: "internal", message: "Token safety check failed." };
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(body) }],
        };
      }
    },
  );

  return server;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  const server = createBaseTokenSafetyServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Base token safety MCP server listening on stdio.");
}
