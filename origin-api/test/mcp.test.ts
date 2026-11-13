import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { SAFETY_CHECK_COST_USD } from "../src/db.js";
import {
  API_KEY_DESCRIPTION,
  CHECK_BASE_TOKEN_SAFETY_TOOL,
  PAYMENT_REQUIRED_MESSAGE,
  TOKEN_ADDRESS_DESCRIPTION,
  TOOL_DESCRIPTION,
  createBaseTokenSafetyServer,
  type McpServerOptions,
} from "../src/mcp.js";
import { judgeGoPlusPayload } from "../src/parser.js";
import { ScannerError, type AgentSafetyReport } from "../src/scanner.js";

const ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const API_KEY = "prepaid-test-key";

function paidReport(address: string): AgentSafetyReport {
  const judgment = judgeGoPlusPayload(
    {
      code: 1,
      message: "OK",
      result: {
        [address.toLowerCase()]: {
          token_name: "Clean",
          token_symbol: "CLN",
          buy_tax: "0",
          sell_tax: "0",
          transfer_tax: "0",
          is_open_source: "1",
          is_proxy: "0",
          is_mintable: "0",
          is_honeypot: "0",
          cannot_buy: "0",
          cannot_sell_all: "0",
          hidden_owner: "0",
          owner_change_balance: "0",
          can_take_back_ownership: "0",
          selfdestruct: "0",
          external_call: "0",
          slippage_modifiable: "0",
          personal_slippage_modifiable: "0",
          trading_cooldown: "0",
          transfer_pausable: "0",
          is_blacklisted: "0",
          is_whitelisted: "0",
          is_anti_whale: "0",
          anti_whale_modifiable: "0",
          is_in_dex: "1",
          honeypot_with_same_creator: "0",
          owner_address: "",
        },
      },
    },
    address,
  );
  return { ...judgment, status: judgment.judgment };
}

async function withClient(options: McpServerOptions) {
  const server = createBaseTokenSafetyServer(options);
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content.find((item) => item.type === "text");
  return block && "text" in block && block.text ? block.text : "";
}

describe("check_base_token_safety", () => {
  const sessions: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.close()));
  });

  it("describes a mandatory paid pre-swap check with tokenAddress and apiKey", async () => {
    const session = await withClient({
      validateAndDeductKey: async () => false,
      analyze: async () => {
        throw new Error("list should not scan");
      },
    });
    sessions.push(session);
    const listed = await session.client.listTools();
    const tool = listed.tools.find((item) => item.name === CHECK_BASE_TOKEN_SAFETY_TOOL);
    expect(tool).toBeDefined();
    expect(tool?.description).toBe(TOOL_DESCRIPTION);
    expect(tool?.description).toMatch(/before every swap/i);
    expect(tool?.description).toMatch(/lose funds/i);
    expect(tool?.description).toMatch(/0\.01 USD/);
    expect(tool?.description).toMatch(/402 Payment Required/);
    const properties = tool?.inputSchema.properties as Record<string, { description?: string }> | undefined;
    expect(properties?.tokenAddress?.description).toBe(TOKEN_ADDRESS_DESCRIPTION);
    expect(properties?.apiKey?.description).toBe(API_KEY_DESCRIPTION);
    expect(properties?.address).toBeUndefined();
    expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
  });

  it("returns 402 and does not scan or debit twice when payment fails", async () => {
    let charges = 0;
    let scans = 0;
    const session = await withClient({
      validateAndDeductKey: async (apiKey, cost) => {
        charges += 1;
        expect(apiKey).toBe(API_KEY);
        expect(cost).toBe(SAFETY_CHECK_COST_USD);
        return false;
      },
      analyze: async () => {
        scans += 1;
        return paidReport(ADDRESS);
      },
    });
    sessions.push(session);
    const result = await session.client.callTool({
      name: CHECK_BASE_TOKEN_SAFETY_TOOL,
      arguments: { tokenAddress: ADDRESS, apiKey: API_KEY },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(PAYMENT_REQUIRED_MESSAGE);
    expect(charges).toBe(1);
    expect(scans).toBe(0);
    expect(textOf(result)).not.toContain(API_KEY);
  });

  it("scans only after a successful 0.01 debit and returns PASS/WARN/BLOCK", async () => {
    const charges: number[] = [];
    const session = await withClient({
      validateAndDeductKey: async (_apiKey, cost) => {
        charges.push(cost);
        return true;
      },
      analyze: async (tokenAddress) => paidReport(tokenAddress),
    });
    sessions.push(session);
    const result = await session.client.callTool({
      name: CHECK_BASE_TOKEN_SAFETY_TOOL,
      arguments: { tokenAddress: ADDRESS, apiKey: API_KEY },
    });
    expect(result.isError).toBeUndefined();
    expect(charges).toEqual([0.01]);
    const structured = result.structuredContent as { status?: string; reasons?: string[]; address?: string };
    expect(structured.status).toBe("PASS");
    expect(structured.reasons).toEqual([]);
    expect(structured.address).toBe(ADDRESS);
    expect(textOf(result)).toContain('"status":"PASS"');
    expect(textOf(result)).not.toContain(API_KEY);
  });

  it("does not include the API key when the scan fails after payment", async () => {
    const session = await withClient({
      validateAndDeductKey: async () => true,
      analyze: async () => {
        throw new ScannerError("timeout", "GoPlus token security request timed out after 8000ms.");
      },
    });
    sessions.push(session);
    const result = await session.client.callTool({
      name: CHECK_BASE_TOKEN_SAFETY_TOOL,
      arguments: { tokenAddress: ADDRESS, apiKey: API_KEY },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("timeout");
    expect(textOf(result)).not.toContain(API_KEY);
    expect(textOf(result)).not.toBe(PAYMENT_REQUIRED_MESSAGE);
  });
});
