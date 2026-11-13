import { describe, expect, it } from "vitest";
import { ParseError, judgeGoPlusPayload } from "../src/parser.js";

const ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function payload(token: Record<string, unknown>, code = 1): unknown {
  return {
    code,
    message: "OK",
    result: {
      [ADDRESS.toLowerCase()]: {
        token_name: "Clean",
        token_symbol: "CLN",
        total_supply: "1000",
        holder_count: "100",
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
        owner_address: "0x0000000000000000000000000000000000000000",
        ...token,
      },
    },
  };
}

function judge(token: Record<string, unknown> = {}, code = 1) {
  return judgeGoPlusPayload(payload(token, code), ADDRESS);
}

describe("judgeGoPlusPayload", () => {
  it("passes a clean open-source token and keeps a 0–1 tax of 0 as 0 percent", () => {
    const result = judge();
    expect(result.judgment).toBe("PASS");
    expect(result.reasons).toEqual([]);
    expect(result.metrics.buyTaxPct).toBe(0);
    expect(result.metrics.sellTaxPct).toBe(0);
    expect(result.metrics.isHoneypot).toBe(false);
    expect(result.metrics.isMintable).toBe(false);
    expect(result.chainId).toBe(8453);
    expect(result.address).toBe(ADDRESS);
    expect(result.notes.some((note) => /zero address/i.test(note))).toBe(true);
  });

  it("converts GoPlus fraction 0.1 to exactly 10 percent", () => {
    const result = judge({ buy_tax: "0.1" });
    expect(result.metrics.buyTaxPct).toBe(10);
    expect(result.judgment).toBe("BLOCK");
    expect(result.reasons[0]).toMatch(/Buy tax is 10%/);
  });

  it("warns on a moderate tax and blocks at the 10 percent line", () => {
    expect(judge({ sell_tax: "0.03" }).judgment).toBe("WARN");
    expect(judge({ sell_tax: "0.029" }).judgment).toBe("PASS");
    expect(judge({ sell_tax: "0.0999" }).judgment).toBe("WARN");
    expect(judge({ transfer_tax: "1" }).judgment).toBe("BLOCK");
    expect(judge({ sell_tax: "0.05" }).reasons[0]).toMatch(/Sell tax is 5%/);
    expect(judge({ buy_tax: "0.029" }).notes.some((note) => /below the 3% warn line/.test(note))).toBe(true);
  });

  it("blocks honeypot, cannot-sell, cannot-buy, and malicious owner controls", () => {
    expect(judge({ is_honeypot: "1" }).judgment).toBe("BLOCK");
    expect(judge({ cannot_sell_all: "1" }).reasons[0]).toMatch(/cannot sell the full balance/i);
    expect(judge({ cannot_buy: "1" }).judgment).toBe("BLOCK");
    expect(judge({ hidden_owner: "1" }).reasons[0]).toMatch(/hidden owner/i);
    expect(judge({ owner_change_balance: "1" }).judgment).toBe("BLOCK");
    expect(judge({ can_take_back_ownership: "1" }).judgment).toBe("BLOCK");
    expect(judge({ personal_slippage_modifiable: "1" }).judgment).toBe("BLOCK");
    expect(judge({ selfdestruct: "1" }).judgment).toBe("BLOCK");
    expect(judge({ gas_abuse: "1" }).judgment).toBe("BLOCK");
    expect(judge({ is_airdrop_scam: "1" }).judgment).toBe("BLOCK");
    expect(judge({ is_true_token: "0" }).judgment).toBe("BLOCK");
    expect(judge({ fake_token: { value: 1, true_token_address: "0xabc" } }).judgment).toBe("BLOCK");
  });

  it("warns on mint, proxy, cooldown, and the other elevated flags", () => {
    expect(judge({ is_mintable: "1" }).judgment).toBe("WARN");
    expect(judge({ is_proxy: "1" }).reasons[0]).toMatch(/proxy/i);
    expect(judge({ trading_cooldown: "1" }).reasons[0]).toMatch(/cooldown/i);
    expect(judge({ transfer_pausable: "1" }).judgment).toBe("WARN");
    expect(judge({ is_blacklisted: "1" }).judgment).toBe("WARN");
    expect(judge({ is_whitelisted: "1" }).judgment).toBe("WARN");
    expect(judge({ slippage_modifiable: "1" }).judgment).toBe("WARN");
    expect(judge({ is_anti_whale: "1" }).judgment).toBe("WARN");
    expect(judge({ anti_whale_modifiable: "1" }).judgment).toBe("WARN");
    expect(judge({ external_call: "1" }).judgment).toBe("WARN");
    expect(judge({ is_open_source: "0" }).reasons[0]).toMatch(/closed/i);
    expect(judge({ is_in_dex: "0" }).reasons[0]).toMatch(/no mainstream DEX/i);
    expect(judge({ honeypot_with_same_creator: "2" }).reasons[0]).toMatch(/2 other honeypot/);
    expect(judge({ other_potential_risks: "Owner can set a fee." }).reasons[0]).toMatch(/Owner can set a fee/);
  });

  it("does not treat a creator honeypot count of 0 as a risk", () => {
    expect(judge({ honeypot_with_same_creator: "0" }).judgment).toBe("PASS");
    expect(judge({ honeypot_with_same_creator: "0" }).metrics.honeypotsWithSameCreator).toBe(0);
  });

  it("keeps omitted taxes and flags unknown instead of inventing zeros", () => {
    const result = judge({
      buy_tax: "",
      sell_tax: undefined,
      is_honeypot: "",
      is_mintable: undefined,
      transfer_tax: "",
    });
    expect(result.metrics.buyTaxPct).toBeNull();
    expect(result.metrics.sellTaxPct).toBeNull();
    expect(result.metrics.transferTaxPct).toBeNull();
    expect(result.metrics.isHoneypot).toBeNull();
    expect(result.metrics.isMintable).toBeNull();
    expect(result.judgment).toBe("WARN");
    expect(result.reasons.some((reason) => /did not report is_honeypot/.test(reason))).toBe(true);
    expect(result.reasons.some((reason) => /did not report buy_tax/.test(reason))).toBe(true);
    expect(result.reasons.some((reason) => /transfer_tax/.test(reason))).toBe(false);
  });

  it("does not invent mint or honeypot flags that a proxy response omitted", () => {
    const result = judgeGoPlusPayload(
      {
        code: 1,
        message: "OK",
        result: {
          [ADDRESS.toLowerCase()]: {
            buy_tax: "0",
            sell_tax: "0",
            is_honeypot: "0",
            is_open_source: "1",
            is_proxy: "1",
            cannot_buy: "0",
            trust_list: "1",
            token_name: "USD Coin",
            token_symbol: "USDC",
            total_supply: "4341305907.582421",
            transfer_tax: "",
            is_in_cex: { listed: "1", cex_list: ["Binance"] },
          },
        },
      },
      ADDRESS,
    );
    expect(result.judgment).toBe("WARN");
    expect(result.metrics.isProxy).toBe(true);
    expect(result.metrics.isMintable).toBeNull();
    expect(result.metrics.isHoneypot).toBe(false);
    expect(result.metrics.transferTaxPct).toBeNull();
    expect(result.metrics.trustList).toBe(true);
    expect(result.metrics.cexListed).toBe(true);
    expect(result.reasons.some((reason) => /proxy/i.test(reason))).toBe(true);
    expect(result.notes.some((note) => /trust_list/.test(note))).toBe(true);
    expect(result.notes.some((note) => /Binance/.test(note))).toBe(true);
  });

  it("warns when the token is mintable and copies pool liquidity as text", () => {
    const result = judge({
      is_mintable: "1",
      is_proxy: "0",
      owner_address: "0x704ec5c12ca20a293c2c0b72b22619a4231f3c0d",
      dex: [
        { name: "UniswapV3", liquidity: "10.5", pair: "0xabc" },
        { name: "Aerodrome", liquidity: "105788.287863175357007313540000000000", pair: "0xdef" },
      ],
      holders: [
        { address: "0x1111111111111111111111111111111111111111", percent: "0.25" },
        { address: "0x2222222222222222222222222222222222222222", percent: "0.25" },
      ],
    });
    expect(result.judgment).toBe("WARN");
    expect(result.metrics.isMintable).toBe(true);
    expect(result.metrics.mainPoolLiquidityUsd).toBe("105788.287863175357007313540000000000");
    expect(result.metrics.mainPoolDex).toBe("Aerodrome");
    expect(result.metrics.reportedTopHoldersPct).toBe(50);
    expect(result.metrics.holderRows).toBe(2);
  });

  it("warns on partial GoPlus data and blocks B20 cannot-sell", () => {
    expect(judge({}, 2).judgment).toBe("WARN");
    expect(judge({}, 2).partial).toBe(true);
    const blocked = judge({
      b20_token: {
        is_b20: "1",
        b20_info: {
          cannot_sell: { status: "1", admin: [] },
          mintable: { status: "0", admin: [] },
        },
      },
    });
    expect(blocked.judgment).toBe("BLOCK");
    expect(blocked.reasons.some((reason) => /cannot be sold/i.test(reason))).toBe(true);
  });

  it("rejects a tax outside the documented 0–1 scale", () => {
    expect(() => judge({ buy_tax: "10" })).toThrow(ParseError);
    expect(() => judge({ is_honeypot: "yes" })).toThrow(ParseError);
  });

  it("treats an empty result and a rate limit as failures, not PASS", () => {
    expect(() => judgeGoPlusPayload({ code: 1, message: "OK", result: {} }, ADDRESS)).toThrow(ParseError);
    try {
      judgeGoPlusPayload({ code: 1, message: "OK", result: {} }, ADDRESS);
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      expect((error as ParseError).kind).toBe("empty_result");
    }
    try {
      judgeGoPlusPayload({ code: 4029, message: "limited", result: {} }, ADDRESS);
    } catch (error) {
      expect((error as ParseError).kind).toBe("api_error");
    }
    expect(() =>
      judgeGoPlusPayload(
        { code: 1, message: "OK", result: { "0x0000000000000000000000000000000000000001": { is_honeypot: "0" } } },
        ADDRESS,
      ),
    ).toThrow(ParseError);
  });
});
