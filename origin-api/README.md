# Base token safety API

Pre-trade check for autonomous trading agents on Base (chainId 8453). One call answers whether a token looks like a honeypot, what the live buy and sell tax is, whether an admin can mint, how much of the LP is locked or burned, how deep the main pool is, and how concentrated the top holders are.

Price is **$0.01 per successful check**. A competitor charges $0.02. Solana and batch checks are not built; the single-token checker is the extension point for both.

## Run it

```bash
npm install
cp .env.example .env   # optional; public Base RPC works with the defaults
npm run dev            # http://127.0.0.1:8787
```

Production build:

```bash
npm run build
npm start
```

Docker:

```bash
docker build -t base-token-safety .
docker run --rm -p 8787:8787 --env-file .env base-token-safety
```

## MCP server

`check_base_token_safety` is a stdio MCP tool and a mandatory pre-trade gateway for an ERC-20 on Base (chain id 8453). Call it before a swap. It charges **$0.01** from a prepaid Supabase API key, then calls the public GoPlus token-security API and returns `status` `PASS`, `WARN`, or `BLOCK` plus `reasons` and the metrics GoPlus actually sent. It does not connect a wallet, sign, or submit a transaction.

Arguments are `tokenAddress` (the Base token) and `apiKey` (the prepaid key, not a wallet key). The handler debits first. If the key is missing, inactive, or the balance is below $0.01, the tool returns this text and does not scan:

```text
402 Payment Required: Your API Key is invalid or lacks sufficient balance to execute this safety check. Please deposit funds.
```

A GoPlus failure after a successful debit is not refunded automatically.

The HTTP API stays on `src/index.ts` and `src/app.ts` so Vercel can keep detecting the Hono app. The MCP process is `src/mcp.ts`. The scan is `src/scanner.ts` (`analyzeBaseToken`) and `src/parser.ts`. Billing for the tool is `src/db.ts`. The HTTP verdict (`safe` / `caution` / `danger`) and its own `API_KEYS` / x402 meter are unchanged. The MCP judgment is GoPlus-only.

```bash
npx tsx src/mcp.ts          # stdio. Do not wrap this in npm run; npm can write to stdout.
npm run build
node dist/mcp.js            # same server after tsc
```

Stdout is the JSON-RPC channel. Logs go to stderr.

Cursor (`.cursor/mcp.json`) or Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "base-token-safety": {
      "command": "node",
      "args": ["dist/mcp.js"],
      "cwd": "/absolute/path/to/base-token-safety-api",
      "env": {
        "SUPABASE_URL": "https://your-project.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "",
        "GOPLUS_ACCESS_TOKEN": ""
      }
    }
  }
}
```

For a checkout that has not been built, set `command` to `npx` and `args` to `["tsx", "src/mcp.ts"]` with the same `cwd`. Leave `GOPLUS_ACCESS_TOKEN` unset to use the public endpoint. Set it when GoPlus returns HTTP 429 or code `4029`. `GOPLUS_TIMEOUT_MS` defaults to 8000. `GOPLUS_BASE_URL` defaults to `https://api.gopluslabs.io`.

### Supabase keys

Create `public.api_keys` and `deduct_api_key_balance` from `supabase/migrations/20261105120000_api_keys.sql` in the Supabase SQL editor. The debit is one `UPDATE ... WHERE active AND balance >= cost`, so two concurrent calls cannot spend the same last cent. The service role is the only role granted execute. Row level security is on and no anon policy is added.

| Column | Role |
| --- | --- |
| `key` | The caller secret. Unique. Do not log it |
| `active` | `false` refuses the check and does not debit |
| `balance` | USD `numeric`. A check costs `0.01` |
| `metadata` | Optional JSON |

Set `SUPABASE_URL` (https, no userinfo) and `SUPABASE_SERVICE_ROLE_KEY`. If either is missing, or the URL is not https, `validateAndDeductKey` returns false and the tool answers 402. The MCP process still starts. The HTTP server does not read these variables.

Insert a key yourself. Do not commit it:

```sql
insert into public.api_keys (key, active, balance)
values ('replace-with-a-long-random-secret', true, 10.00);
```

The tool arguments are `tokenAddress` (the Base ERC-20 you are about to buy or sell) and `apiKey`. A missing GoPlus field is `null`, not zero and not false. Buy and sell tax use GoPlus's 0–1 scale (`"0.1"` is 10%). Tax at or above 10% is `BLOCK`. Tax at or above 3% and below 10% is `WARN`. Honeypot, cannot-sell, hidden owner, balance edits, per-address tax, self-destruct, gas abuse, airdrop scams, and counterfeit tokens are `BLOCK`. Mint, proxy, cooldown, pause, blacklist, whitelist, modifiable tax, anti-whale, external calls, closed source, and no mainstream DEX pair are `WARN`. `reportedTopHoldersPct` sums the GoPlus holder rows as published. It does not exclude pools, so it is not the HTTP field `holdersTop10Pct`. `mainPoolLiquidityUsd` is the original GoPlus USD string for the deepest pool they returned, or `null` when that array is absent (Base USDC's payload often omits `dex`).

A live read of Base USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) is `WARN` because `is_proxy` is `"1"`. GoPlus does not send `is_mintable` for that proxy, so the metric stays `null`. Taxes are 0 and `is_honeypot` is false. DEGEN (`0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed`) is `WARN` because `is_mintable` is `"1"`.

## Deploy on Vercel

Vercel detects this repo as a Hono app because `src/app.ts` default-exports the app (`src/index.ts` does too). The platform runs it as a Node.js function on Fluid compute. There is no `vercel.json`: a rewrite onto a source file would hide that entry. Do not set the Edge runtime. The service uses Node APIs (`pg`, `node:crypto`, viem).

`npm start` and Docker still run `src/index.ts`, which listens on `PORT` only when `VERCEL` is unset. On Vercel that variable is `1`, so the file does not call `listen`.

Import the Git repository at vercel.com/new. No build command or output directory is required.

### Production environment variables

Nothing is required for a public deployment. Unset variables use the code defaults: public Base RPC, open billing, and an in-memory usage meter that resets when the instance goes cold.

Set these in the Vercel project when you leave that default:

| Variable | Set it when | Production value |
| --- | --- | --- |
| `BASE_RPC_URL` | You want a stable sub-second check | A Base HTTPS endpoint that honors `eth_call` state overrides. `BASE_RPC_FALLBACKS` is optional |
| `BILLING_MODE` | Callers must pay | `api_key` or `x402`. Leave unset for open access |
| `API_KEYS` | `BILLING_MODE=api_key` | Comma-separated secrets. Not logged |
| `PRICE_USD` | You want a price other than $0.01 | `0.01` is 10000 USDC atomic units in x402 mode |
| `X402_PAY_TO` | x402 should settle | A Base address you control. The server does not need its private key |
| `X402_FACILITATOR_URL` | x402 should settle | A mainnet facilitator that supports `eip155:8453` and EIP-3009. The public x402.org facilitator is for testnet |
| `X402_FACILITATOR_AUTH` | That facilitator requires a credential | Bearer token or a full `Authorization` value. Not logged |
| `X402_ACCEPT_STUB` | x402 is live | `false`. While `true`, `X-Payment: stub:<id>` is accepted and not settled |
| `USAGE_STORE` | A Redis URL and `DATABASE_URL` are both set | `redis` or `postgres` |
| `REDIS_URL` or `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | Usage must survive cold starts | `rediss://` or `https://….upstash.io`. Plain `redis://` is only for private hosts |
| `DATABASE_URL` | Usage is stored in Postgres | `postgres://` or `postgresql://`. The process creates `token_safety_usage` if it can |
| `ETHERSCAN_API_KEY` | You want Etherscan as a second ABI or holder source | A plan that includes Base. Holder concentration already works without it |
| `HOLDER_SOURCES`, `BLOCKSCOUT_BASE_URL`, `GOPLUS_BASE_URL` | You run a mirror | Defaults are the public no-key indexes |

Do not set `PORT`. Vercel assigns the port. The full list and defaults are in `.env.example`.

## Endpoint

`GET /v1/token-safety?chain=base&address=0x...`

`chain` must be `base` or `8453`. Anything else, including `solana`, is **400** `unsupported_chain`. A non-address is **400** `invalid_address`. An address with no bytecode is **404** `not_a_contract`. If the configured RPC is down, the response is **503** `rpc_unavailable`.

`GET /health` is an unauthenticated liveness check. `GET /` describes the service.

### Sample: USDC on Base

Measured against Base mainnet. USDC is not `safe`: Circle can mint, blacklist, and pause. It is not a honeypot, and both taxes are zero. That is the result an agent should see before it treats admin power as a separate decision from "can I sell".

```json
{
  "verdict": "caution",
  "honeypot": false,
  "buyTax": 0,
  "sellTax": 0,
  "ownerCanMint": true,
  "lpLockedPct": -1,
  "liquidityUsd": 150502544,
  "holdersTop10Pct": 26.94,
  "reasons": [
    "A mint-like function is present and ownership is not renounced, so an admin can increase supply.",
    "The contract exposes blacklist or bot-blocking controls.",
    "The contract exposes a pause control."
  ],
  "notes": [
    "LP locked percent was not measured. Concentrated-liquidity positions are NFTs, and Aerodrome gauge stakes are not treated as locked. lpLockedPct is -1."
  ],
  "token": {
    "name": "USD Coin",
    "symbol": "USDC",
    "decimals": 6,
    "proxy": true,
    "implementation": "0x2Ce6311ddAE708829bc0784C967b7d77D19FD779"
  },
  "pool": {
    "address": "0x6c561B446416E1A00E8E93E221854d6eA4171372",
    "dex": "uniswap-v3",
    "kind": "cl",
    "quoteSymbol": "WETH",
    "feeBps": 30
  },
  "simulation": { "status": "ok", "path": "cl" },
  "latencyMs": 190
}
```

Fresh USDC checks on `https://mainnet.base.org` measured **644 ms, 175 ms, and 130 ms**. The first call includes the holder index. Later calls reuse the in-process holder cache. A cached repeat of the whole report is a few milliseconds. Liquidity in the sample is a snapshot and moves with the pool.

DEGEN (`0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed`) on the same RPC: cold check **612 ms**, `holdersTop10Pct` **63.1** from GoPlus, verdict `caution`, taxes 0, honeypot false, about $232k of WETH liquidity. After Blockscout's raw holder page landed in the cache, a new check reported **62.82** from Blockscout in **230 ms**.

## Verdict

`verdict` is `safe`, `caution`, or `danger`. `reasons` lists the risk flags that set it. `notes` explains missing data and does not change the verdict.

| Condition | Verdict |
| --- | --- |
| Sell reverted, round-trip kept under half the quote, sell tax ≥ 50%, or buy tax ≥ 80% | `danger` (`honeypot: true`) |
| Buy or sell tax ≥ 10% | `danger` |
| Priced liquidity under $1,000, or no supported pool | `danger` |
| Token is paused | `danger` |
| Tax ≥ 3% and < 10% | `caution` |
| Mint function with an owner that is not zero or dead | `caution` |
| Blacklist, pause, or tax-setter function | `caution` |
| Top 10 holders ≥ 70% of supply | `caution` |
| LP locked/burned < 50% and liquidity under $100,000 | `caution` |
| Liquidity under $10,000 but at least $1,000 | `caution` |
| Buy simulation failed or timed out | `caution` (`honeypot` stays false) |
| None of the above | `safe` |

Taxes at or below **0.5%** are reported as `0`. That floor covers AMM rounding on a small probe swap. A `safe` verdict means the sell path was simulated. `honeypot: false` together with a `caution` reason about simulation failure means the sell was **not** verified.

## How each field is computed

**honeypot, buyTax, sellTax.** The service `eth_call`s a measurement contract that exists only as a state-override code blob (`contracts/TokenSafetySimulator.sol`). It is never deployed and never signed. The call buys the token with the pool's quote asset and sells it back on the deepest pool:

- Uniswap V2-style routers (BaseSwap, SushiSwap), including the fee-on-transfer router methods, with a direct pair swap if the router reverts.
- Aerodrome volatile and stable routers, same fallback.
- Uniswap V3, PancakeSwap V3, and Aerodrome Slipstream by calling `pool.swap` and paying the callback (`uniswapV3SwapCallback`, plus Pancake and Algebra aliases).

Buy tax is `1 - tokensReceived / quotedBuy`. The quote is `getAmountsOut` (or the V3 output delta) before transfer tax. Sell tax is `1 - quoteReceived / quotedSell`, quoted after the buy so the buy's price impact is in both numbers. The probe size is about 0.1% of the quote in the pool, clamped to roughly $2–$25 and never more than 1% of that balance. `tx.origin` is an EOA with no code, so a check of `extcodesize(tx.origin)` still sees an externally owned account. The swap itself runs from the harness contract.

**liquidityUsd.** Pools are discovered in one Multicall3 batch against WETH, USDC, USDbC, DAI, and AERO:

- Aerodrome volatile and stable (`0x420DD381…`)
- Aerodrome Slipstream factories (initial, gauge-caps, gauges v3), tick spacings 1, 50, 100, 200, 2000
- Uniswap V3 fee tiers 100, 500, 3000, 10000
- PancakeSwap V3 fee tiers 100, 500, 2500, 10000
- BaseSwap and SushiSwap pairs

V2/Aerodrome TVL is `quoteReserve × quoteUsd × 2`. Concentrated-liquidity TVL is the sum of both token balances held by the pool, priced from `slot0`. ETH/USD comes from the Uniswap V3 WETH/USDC 0.05% pool. AERO/USD comes from the deepest AERO/USDC oracle pool that holds at least 100 USDC. DAI/USD comes from the deepest Uniswap V3 DAI/USDC pool (0.01% or 0.05%) or the Aerodrome stable DAI/USDC pool, with the same 100 USDC floor. A live read of the 0.01% pool priced DAI at about **$0.997**. USDC and USDbC stay at $1. The main pool is the highest USD value. `0` means none of those venues had liquidity. `-1` means a pool was found but its quote could not be priced.

**lpLockedPct.** For V2-style and Aerodrome LP tokens: `(balance of burn addresses + known lockers) / totalSupply × 100`. Burn addresses are `0x000…000` and `0x000…dEaD`. Lockers are UNCX V2 (`0xc4E6…4131`), UNCX Sushi (`0xBedd…Aae8`), UNCX Aerodrome (`0x30e5…D870`), and PinkLock V2 (`0xdD6E…bBDC`). Aerodrome gauge stakes are not counted; that LP can be withdrawn. Concentrated liquidity is an NFT position, so this field is `-1` and a note says so. Extend the list in `src/domain/addresses.ts`.

**ownerCanMint.** Runtime bytecode of the token and, when it is a proxy, of its implementation is scanned for the Solidity dispatcher pattern `PUSH4 <selector>`. Selectors cover `mint(address,uint256)`, `mint(uint256)`, `mintTo`, and `ownerMint`. Proxies are followed through `implementation()`, the FiatToken/ZeppelinOS slot (Base USDC), EIP-1967, and EIP-1167. `owner()` is called on-chain. The flag is true when a mint selector exists and the owner is not the zero or dead address. If there is no `owner()` and a mint selector exists, the flag is still true. If ownership is renounced and a mint selector still exists, the service `eth_call`s `mint`, `mintTo`, and `ownerMint` from an unrelated EOA. A call that does not revert sets the flag and says the mint is public. A verified ABI from Sourcify, or from Etherscan when `ETHERSCAN_API_KEY` is set, is OR-ed in so a mint that the bytecode scan missed is still caught. The same pass sets blacklist, pause, and tax-setter flags. `paused()` is called when a pause selector exists; a live pause is `danger`.

**holdersTop10Pct.** The service asks Blockscout's Base token-holder API and GoPlus in parallel, and Etherscan V2 `tokenholderlist` when `ETHERSCAN_API_KEY` is set. The caller waits up to `HOLDERS_TIMEOUT_MS` (default 900). The first usable list is returned. A slower raw list (Blockscout or Etherscan) keeps downloading for up to 4 seconds and replaces the cache when it arrives, so the next check in the same process does not wait. Cached lists live for `HOLDER_CACHE_TTL_MS` (default 10 minutes). The percentage is the largest 10 remaining balances over on-chain `totalSupply`, after removing the token, every discovered pool, the zero address, the dead address, known lockers, and the canonical quote tokens. GoPlus publishes shares instead of raw balances and only 10 rows, so if an exclusion would leave fewer than 10 rows the field stays `-1` rather than under-reporting concentration. A missing or truncated list is `-1` plus a note. It does not change the verdict. The free Etherscan tier does not serve Base `tokenholderlist`.

**Metadata.** `token`, `pool`, `simulation`, `flags`, `sources`, `checkedAt`, `latencyMs`, `cache`, and `priceUsd` are extra. `simulation.amountIn` is the quote-asset amount actually spent, in raw units.

## Environment

See `.env.example`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | HTTP port |
| `BASE_RPC_URL` | `https://mainnet.base.org` | Primary Base JSON-RPC. Must support `eth_call` state overrides |
| `BASE_RPC_FALLBACKS` | publicnode, 1rpc | Tried only when the primary URL fails a chain-id probe |
| `ETHERSCAN_API_KEY` | empty | Optional second ABI source. Holder list only if the plan allows `tokenholderlist` on chain 8453 |
| `SOURCIFY_BASE_URL` | `https://sourcify.dev/server` | No-key verified ABI. Public https only |
| `HOLDER_SOURCES` | blockscout, goplus, etherscan | Which holder indexes to query |
| `BLOCKSCOUT_BASE_URL` | `https://base.blockscout.com` | No-key Base holder list |
| `GOPLUS_BASE_URL` | `https://api.gopluslabs.io` | Fast no-key top-10 shares, and the MCP token-security scan |
| `GOPLUS_ACCESS_TOKEN` | empty | Optional Bearer token for the MCP GoPlus call. Public access works without it |
| `GOPLUS_TIMEOUT_MS` | `8000` | MCP GoPlus timeout. Minimum 100 |
| `SUPABASE_URL` | empty | MCP key ledger. Unset fails closed with 402. Not used by the HTTP API |
| `SUPABASE_SERVICE_ROLE_KEY` | empty | Service role for `deduct_api_key_balance`. Not logged |
| `HOLDER_CACHE_TTL_MS` | `600000` | Holder-list cache. `0` disables it |
| `CACHE_TTL_MS` | `20000` | Success-cache TTL. `0` disables it. Timeouts are not cached |
| `PRICE_USD` | `0.01` | Recorded unit price |
| `BILLING_MODE` | `open` | `open`, `api_key`, or `x402` |
| `API_KEYS` | empty | Comma-separated keys when mode is `api_key` |
| `X402_PAY_TO` | empty | Address echoed in the 402 body |
| `X402_ACCEPT_STUB` | `true` | Accept `X-Payment: stub:<id>` |
| `SIM_TIMEOUT_MS` | `1200` | Cap on the swap simulation |
| `HOLDERS_TIMEOUT_MS` | `900` | How long the check waits for a holder list. The fetch may continue and fill the cache |
| `SOURCE_TIMEOUT_MS` | `500` | Cap on Sourcify / Etherscan ABI |
| `DISCOVERY_TIMEOUT_MS` | `1500` | Cap on pool discovery and bytecode intel |
| `RATE_LIMIT_PER_MIN` | `120` | Per IP. `0` disables it |

Discovery, bytecode/proxy intel, Sourcify, and the holder request run at the same time. The simulation starts after the main pool is known. Each optional source has its own timeout so a slow explorer cannot hold the RPC work.

## Billing hook

Successful **200** responses are the billable event. Validation errors are not billed. The price is `PRICE_USD` (default **$0.01**).

- `BILLING_MODE=open` — no credential. Usage is counted under `anonymous`. Header `X-Price-Usd: 0.01`.
- `BILLING_MODE=api_key` — require `X-Api-Key` to match `API_KEYS`. Missing keys get **401**. `GET /v1/usage` returns `{ calls, usd }` for that key. `X-Usage-Calls` and `X-Usage-Usd` are set on billed responses. The stored identity is a SHA-256 of the key, not the key itself.
- `BILLING_MODE=x402` — require a payment header. See below.

The meter is `src/http/usageStore.ts`. With no store configured it stays in memory and resets on restart. Set one of:

- `REDIS_URL` (`redis://` or `rediss://`, private hosts allowed, public plaintext redis rejected) or Upstash `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (`https://*.upstash.io` only)
- `DATABASE_URL` (`postgres://` or `postgresql://`). The process creates `token_safety_usage (identity_hash, calls, cents, updated_at)` if it can.

If both Redis and Postgres are set, `USAGE_STORE` must be `redis` or `postgres`. A store outage is logged, counted in memory, and flushed on the next successful write. `GET /health` reports `usageStore` and `usageDegraded`.

### Going live with x402

Settlement is implemented and stays off until both `X402_PAY_TO` and `X402_FACILITATOR_URL` are set. Nothing in this repo is a receiving wallet. No payment is submitted without those two values.

1. Create a Base address you control. It only receives USDC. The server does not need its private key. The facilitator submits the EIP-3009 `transferWithAuthorization` and pays gas.
2. Set `BILLING_MODE=x402`, `PRICE_USD=0.01`, and `X402_PAY_TO` to that address (checksummed, not the zero address). $0.01 is **10000** atomic units of Base USDC (`X402_ASSET`, 6 decimals).
3. Set `X402_FACILITATOR_URL` to a facilitator that supports **eip155:8453** and the `exact` scheme with `assetTransferMethod: eip3009`. The public `x402.org` facilitator is for testnet, not Base mainnet. Use a production facilitator (Coinbase CDP, Circle, or your own) and confirm `/supported` lists `eip155:8453`. If it requires a credential, set `X402_FACILITATOR_AUTH` to the header value or a raw bearer token. The server calls `POST {X402_FACILITATOR_URL}/verify` and, only after a **200** check, `POST .../settle` with:

```json
{ "x402Version": 2, "paymentPayload": {}, "paymentRequirements": {} }
```

4. Leave the EIP-712 domain at the Base USDC defaults unless you change the asset: `X402_ASSET_NAME=USD Coin`, `X402_ASSET_VERSION=2`. A non-USDC asset must set both explicitly.
5. Set `X402_ACCEPT_STUB=false` before production. While it is true, `X-Payment: stub:<client-id>` is still accepted and is not settled.
6. A client that has not paid receives **402** with a `PAYMENT-REQUIRED` header (base64 JSON, `x402Version` 2) and a JSON body. `accepts[0]` is `scheme: exact`, `network: eip155:8453`, `amount: "10000"`, `asset` Base USDC, `payTo` your address, `maxTimeoutSeconds` 60. The client signs EIP-3009 for that exact amount and nonce, with `validBefore` no further than `maxTimeoutSeconds` ahead, and retries with `PAYMENT-SIGNATURE` (or `X-PAYMENT`) set to the base64 payload.
7. On success the response carries `PAYMENT-RESPONSE` (base64 settlement JSON: `success`, `payer`, `transaction`, `network`). A failed verify or settle is **402** and the report is not returned. The same nonce cannot be used twice in one process.

`X402_VERIFY_TIMEOUT_MS` defaults to 2500 and `X402_SETTLE_TIMEOUT_MS` to 8000. Facilitator URLs must be https, except `http://127.0.0.1` or `http://localhost` for a local facilitator. Redirects are not followed.

## Tests

```bash
npm test                 # verdict thresholds, tax math, validation, billing, GoPlus judgment, scanner errors, MCP schema
npm run test:integration # live USDC check plus a 400 for chain=solana
npm run check -- 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
```

`npm run check` prints the JSON report and exits 2 when the verdict is `danger`.

### Trying a honeypot

Honeypot addresses on Base go stale as soon as liquidity is pulled, so this repo does not hardcode one. Pick a token that a public Base honeypot list currently marks as unsellable, then:

```bash
npm run check -- 0x<token>
```

Expect `"honeypot": true` and `"verdict": "danger"`. A sell that reverts inside the simulator, a sell tax of 50% or more, or a round trip that returns under half the quote is what sets the flag. Re-run USDC afterwards to confirm the harness still clears a normal token.

Regenerate the harness bytecode after editing the Solidity:

```bash
npm run compile:simulator
```

## Limitations

- A token can detect `eth_call`, a state override, or the harness address and behave differently than it will for a real wallet. Delayed honeypots that turn on later are invisible.
- The harness is a contract. Tokens that refuse to sell to contracts can be flagged even if an EOA could sell. Trading agents are usually contracts, so that failure is reported.
- Tax under 0.5% is reported as zero.
- Only WETH, USDC, USDbC, DAI, and AERO quote pairs on the DEXes listed above are searched. A token that only trades against something else looks illiquid.
- V3 / Slipstream LP locks are not measured. The locker list is not exhaustive. Team Finance's Base vault is not hardcoded because the public docs do not pin one address.
- LP burned with `_burn` (supply reduced, dead balance unchanged) is not visible. Only tokens sitting on the dead address or a known locker are counted.
- A renounced owner plus a public `mint` is probed with `eth_call`. A payable mint, a mint that needs a signature, or a mint the selector scan missed can still be reported as `ownerCanMint: false`.
- Selector scan looks for `PUSH4 selector`. A via-IR dispatcher that never emits that pattern can be missed; the verified ABI covers that when Sourcify or Etherscan has the source.
- Holder concentration uses Blockscout and GoPlus without a key. The first response may be GoPlus shares; a later request in the same process uses Blockscout raw balances when that page arrives. The holder cache is in memory. Etherscan's free tier does not serve Base `tokenholderlist`. If every index times out, the field is `-1`.
- DAI is priced from a DAI/USDC pool. USDbC is still priced at $1. A USDbC depeg is not detected. If the DAI oracle pools hold under 100 USDC, DAI-quoted liquidity is `-1`.
- The public RPC is fast enough in the sample above (p95 of the three fresh USDC calls was 387 ms). A dedicated node is still the right setup under load. State overrides are required; a pruned endpoint that rejects them cannot simulate.
- The usage meter survives restarts only when Redis, Upstash, or Postgres is configured. x402 payments are settled only when `X402_PAY_TO` and `X402_FACILITATOR_URL` are both set.
- Solana and batch requests are not implemented.

## Layout

- `src/app.ts` — HTTP routes
- `src/index.ts` — HTTP listener. Default-exports the Hono app and does not start the MCP server
- `src/mcp.ts` — stdio MCP server. Tool name `check_base_token_safety`. Charges $0.01, then scans
- `src/db.ts` — Supabase `validateAndDeductKey`
- `src/scanner.ts` — GoPlus `token_security/8453` fetch. `analyzeBaseToken` adds `status`
- `src/parser.ts` — GoPlus field parse and `PASS` / `WARN` / `BLOCK`
- `supabase/migrations/20261105120000_api_keys.sql` — `api_keys` table and the atomic debit function
- `src/services/safety.ts` — parallel orchestration
- `src/services/pools.ts` — multicall discovery, TVL, LP lock
- `src/services/simulate.ts` — state-override buy/sell
- `src/services/intel.ts` — proxy, mint, blacklist, pause
- `src/domain/verdict.ts` — pure verdict rules, unit tested
- `src/http/billing.ts` — the $0.01 hook
