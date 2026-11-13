# Handoff

Fresh-agent brief for the Base pre-trade token safety API. Read this, then `README.md`, before changing behavior.

## GitHub / Railway

Target repo: `https://github.com/meenaarpit1505-oss/Base-token-pre-trade-safety-check` (public, was empty, default branch `main`).

HTTP on Railway is already the existing entry. Do not move the MCP server into it.

- `src/index.ts` default-exports the Hono app. When `VERCEL` is not `1`, it listens on `0.0.0.0` and `process.env.PORT` (`getConfig().port`, default `8787`).
- `package.json` `build` is `tsc -p tsconfig.json`. `start` is `node dist/index.js`. MCP stays `npm run mcp` / `node dist/mcp.js` and is not the Railway process.
- `Dockerfile` `CMD` is `node dist/index.js` after `npm run build`. Railway can use that image or Nixpacks (`npm run build` then `npm start`). The process still reads `PORT` at runtime. `EXPOSE 8787` does not override `PORT`.
- No new secrets and no wallet code in this step.

Push attempt on 2026-11-05: `git ls-remote` against `https://github.com/meenaarpit1505-oss/Base-token-pre-trade-safety-check.git` returned no refs (empty repo, readable). `git push github main:main` failed with `could not read Username for 'https://github.com': No such device or address`. SSH `git@github.com` was `Permission denied (publickey)`. `gh` is not logged in. `GITHUB_TOKEN` and `GH_TOKEN` are unset. The GitHub MCP server failed discovery, so it could not push either. Origin `main` was not force-pushed. GitHub `main` is still empty. A write credential for `meenaarpit1505-oss` is required before the same `git push github main:main` (no force) can land `f842d08056156d08d32499c99008a03969ae1a65` or a later main SHA.

## MCP billing (current)

`check_base_token_safety` now requires `tokenAddress` and `apiKey` and charges **$0.01** before the GoPlus scan.

- `src/db.ts` exports `validateAndDeductKey(apiKey, cost)`. It calls Supabase RPC `deduct_api_key_balance`. The SQL is one `UPDATE public.api_keys SET balance = balance - p_cost WHERE key = p_key AND active AND balance >= p_cost`. Zero rows means missing, inactive, or underfunded, and the function returns false. It does not throw for that. It does not select-then-write in JavaScript. The cost is sent as a decimal string (`0.01`) so Postgres `numeric` is exact.
- Schema: `supabase/migrations/20261105120000_api_keys.sql`. Columns: `key` (unique), `active`, `balance numeric(18,8)`, `metadata jsonb`. RLS is on. Execute is granted only to `service_role`.
- Env: `SUPABASE_URL` (https, no userinfo) and `SUPABASE_SERVICE_ROLE_KEY`. If either is missing, the debit returns false and the tool answers 402. Importing `src/db.ts` does not throw, and `src/index.ts` does not import it, so the Hono process is unaffected. Do not log either secret or the caller API key. Errors redact the caller key.
- Tool order in `src/mcp.ts`: debit `0.01`, and on false return exactly `402 Payment Required: Your API Key is invalid or lacks sufficient balance to execute this safety check. Please deposit funds.` Then `analyzeBaseToken`. That alias adds `status` equal to the existing `judgment` and keeps the GoPlus fields. A scan error after a debit is not refunded.
- `GOPLUS_ACCESS_TOKEN` stays optional. No wallet, signing, or transaction code.
- Tests: `test/db.test.ts`, updated `test/mcp.test.ts`, `analyzeBaseToken` covered in `test/scanner.test.ts`. HTTP tests were not retargeted.

## MCP tool (previous, still true except the unpaid input)

`check_base_token_safety` is a stdio MCP tool. It does not replace the HTTP API. The input is no longer a lone `address`. See the billing section.

- `src/index.ts` still default-exports the Hono app and listens only when `VERCEL` is not `1`. Do not move the MCP server into that file. Vercel detects `src/app.ts` / `src/index.ts`.
- `src/mcp.ts` is the MCP entry. `npx tsx src/mcp.ts` or, after `npm run build`, `node dist/mcp.js`. Stdout is JSON-RPC. A ready log goes to stderr. `npm run mcp` exists but a client should spawn `tsx` or `node` directly so npm's own stdout cannot corrupt the protocol.
- `src/scanner.ts` calls `GET {GOPLUS_BASE_URL}/api/v1/token_security/8453?contract_addresses={lowercase}`. Default host `https://api.gopluslabs.io`. No API key is required. Optional `GOPLUS_ACCESS_TOKEN` is sent as `Authorization: Bearer` and is not put in the URL or error text. `GOPLUS_TIMEOUT_MS` defaults to 8000 (minimum 100). Timeouts, HTTP errors, empty `result`, code `4029`, and non-JSON bodies throw `ScannerError` and the tool returns `isError`. Invalid and zero addresses never hit the network.
- `src/parser.ts` maps the documented GoPlus token-security object. Flags are `"1"` / `"0"` / omitted or `""`. Omitted is `null`, not false. Taxes are 0–1 fractions (`"1"` = 100%, `""` = unknown, not zero). `honeypot_with_same_creator` is a count. `dex[].liquidity` is copied as a string. Holder percents are summed into `reportedTopHoldersPct` without removing pools. That number is not the HTTP `holdersTop10Pct`.
- Judgment: BLOCK on honeypot, cannot-buy, cannot-sell-all, hidden owner, owner balance edits, take-back ownership, per-address tax, self-destruct, gas abuse, airdrop scam, counterfeit token, B20 cannot-buy/sell, or any buy/sell/transfer tax >= 10%. WARN on tax >= 3% and < 10%, mint, proxy, cooldown, pause, blacklist, whitelist, modifiable tax, anti-whale, external call, closed source, no mainstream DEX, creator honeypot count >= 1, `other_potential_risks`, response code 2, or a missing honeypot/tax on a contract that is not closed-source and not a proxy. PASS when none of those fire. Notes do not change the judgment. Trust-list and CEX listing do not clear WARN or BLOCK.
- Live check with no key: USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` is **WARN** (proxy). `is_mintable` was absent, so the metric is **null**. Taxes 0, honeypot false, `reportedTopHoldersPct` about **26.47**, `mainPoolLiquidityUsd` null because that payload omitted `dex`. DEGEN `0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed` is **WARN** (`is_mintable=1`). Taxes 0, honeypot false, liquidity string kept, holder sum about **63.19**.
- Tests: `test/parser.test.ts`, `test/scanner.test.ts`, `test/mcp.test.ts`. `npm test` was 55 passing after these landed. `npm run typecheck` passed. `npm audit` was 0. The MCP SDK is `@modelcontextprotocol/sdk` 1.32.2 with `zod` 4.6.6 (zod 3 is a high advisory). The HTTP verdict path was not rewired.
- Aikido still needs a signed-in scan of `src/`, `test/`, and `scripts/` if the MCP login is available. Do not treat an auth failure as a clean scan.

## Done

A Node + Hono + TypeScript + viem service is implemented and tested on `cursor/holders-usage-x402-50a4`.

`GET /v1/token-safety?chain=base&address=0x...` returns the same fields as before. `holdersTop10Pct` is now a real percentage when an index answers in time. `-1` still means unknown.

Live checks on `https://mainnet.base.org` (no API key):

| Token | Result |
| --- | --- |
| USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `caution`, honeypot false, taxes 0, decimals 6, owner can mint, `holdersTop10Pct` **26.94** (GoPlus), liquidity about $150.5M, `lpLockedPct` -1 (concentrated liquidity). Fresh latencies **644 ms, 175 ms, 130 ms**. |
| DEGEN `0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed` | `caution`, taxes 0, honeypot false, owner can mint, about $232k WETH liquidity. Cold **612 ms**, `holdersTop10Pct` **63.1** (GoPlus). After the Blockscout page filled the cache, a new check reported **62.82** from Blockscout in **230 ms**. |
| WETH | immediate `safe`; canonical wrapper, no simulation |
| EOA | `404 not_a_contract` |
| `chain=solana` | `400 unsupported_chain` |

`npm test`: 33 passing. `npm run test:integration` passed. `npm audit`: 0 vulnerabilities. DAI/USDC Uniswap v3 0.01% priced DAI at about **$0.997**.

## In progress

Nothing is half-implemented. Solana and batch are still intentionally absent. x402 verify/settle code is in place and does not move funds until `X402_PAY_TO` and `X402_FACILITATOR_URL` are both set. There is no pay-to address in the repo.

The earlier Aikido attempt still needs a browser sign-in. See the MCP section above. Do not treat an auth failure as a clean scan. After sign-in, scan `src/`, `test/`, and `scripts/`.

## Design decisions

- Stack is Hono on Node (not Edge), TypeScript, viem. `src/app.ts` default-exports the app so Vercel’s Hono detector (zero-config, Node / Fluid) picks it up. `src/index.ts` re-exports that app and listens on `0.0.0.0:$PORT` only when `VERCEL` is not `1`. There is no `vercel.json`. `src/vercel.ts` only re-exports the app.
- Honeypot and tax come from one `eth_call` with a state-override code blob. The harness is `contracts/TokenSafetySimulator.sol`, compiled to `src/generated/simulator.ts`. It is never deployed and never signs a transaction.
- Pools, tax math, and verdict thresholds are unchanged except DAI is no longer assumed to be $1. USDC and USDbC are still $1. DAI/USD is the deepest Uniswap v3 DAI/USDC pool at fee 100 or 500, or Aerodrome stable DAI/USDC, and the oracle pool must hold at least 100 USDC. AERO uses the same depth floor on its existing USDC pools.
- LP lock is still `(dead + UNCX V2 + UNCX Sushi + UNCX Aerodrome + PinkLock V2) / totalSupply` for V2-style LP tokens. V3/Slipstream stays `-1`. GoPlus returns NFT LP rows, but they are not tied to one pool, so they are not used. Team Finance was not added. No official Base locker address was verified this round.
- `ownerCanMint` is still true when a mint selector exists and `owner()` is not zero or dead. If ownership is renounced and a mint selector exists, `probePublicMint` `eth_call`s `mint(address,uint256)`, `mint(uint256)`, `mintTo`, and `ownerMint` from `SIMULATION_CALLER`. A non-reverting call sets `ownerCanMint` and the reason says the mint is public. Payable or signature-gated mints can still be missed. This path was not demonstrated on a live renounced token.
- Holders: `src/services/marketData.ts` races Blockscout `module=token&action=getTokenHolders` (no key, up to 40 raw balances), GoPlus `token_security/8453` (no key, top-10 shares), and Etherscan V2 `tokenholderlist` when `ETHERSCAN_API_KEY` is set. The free Etherscan tier returns "Free API access is not supported for this chain" for that action, so the key is not required. The check waits `HOLDERS_TIMEOUT_MS` (default 900). The HTTP calls keep going for 4 seconds and the better raw list replaces an in-memory cache (`HOLDER_CACHE_TTL_MS`, default 10 minutes). Exclusions: token, every discovered pool, burn addresses, `LP_LOCKERS`, and the canonical quote tokens. A truncated page that does not still contain 10 non-excluded holders becomes `-1` instead of a low number. Rank when replacing the cache: etherscan > blockscout > goplus. Transfer logs are not used. A partial log window is not a top-10 list.
- Outbound HTTP is `src/services/outbound.ts`. https only, no redirects, no URL credentials, no cloud metadata addresses, response cap 1 MB, `AbortSignal.timeout`. Private http is allowed for RPC and for a localhost facilitator. Public http is rejected. RPC URLs in logs are redacted (`redactUrl`).
- Verdict rules still live only in `src/domain/verdict.ts`. Unknown holders or unknown LP lock do not change the verdict. Top 10 ≥ 70% is still caution.
- Billing: `src/http/billing.ts` plus `src/http/usageStore.ts`. Only HTTP 200s are metered. Identities are SHA-256'd before they are stored. Backends: memory (default), Redis (`REDIS_URL` or Upstash REST), Postgres (`DATABASE_URL`, table `token_safety_usage`). If both Redis and Postgres env vars are set, `USAGE_STORE` is required. A store error falls back to memory, sets `usageDegraded` on `GET /health`, and is flushed into the store on the next successful write.
- x402: `src/http/x402.ts`. 402 bodies keep `scheme: "x402"` and `priceUsd` and add `x402Version: 2`, `amount` (USDC 6-decimal atomic units, so $0.01 is `"10000"`), and `accepts[]` with `scheme: "exact"`, `network: "eip155:8453"`. The `PAYMENT-REQUIRED` header is that document in standard base64. A real payload is accepted on `PAYMENT-SIGNATURE` or `X-PAYMENT`. The server checks scheme, network, asset, payTo, amount, the 65-byte signature shape, the 32-byte nonce, and that `validBefore - now <= maxTimeoutSeconds` (default 60). It then `POST`s `{x402Version:2, paymentPayload, paymentRequirements}` to `{X402_FACILITATOR_URL}/verify` before the handler and `/settle` only after status 200. Success sets `PAYMENT-RESPONSE`. Stub `X-Payment: stub:<id>` remains while `X402_ACCEPT_STUB` is not `false`. Nonces are locked in process. The server never signs and never broadcasts the USDC transfer itself.

## Env vars

Copy `.env.example`. The process reads `process.env`. There is no dotenv loader. Unset vars use the defaults in `getConfig()` (`src/config.ts`).

| Variable | Code default | Role |
| --- | --- | --- |
| `PORT` | `8787` | Listen port |
| `BASE_RPC_URL` | `https://mainnet.base.org` | Must support `eth_call` state overrides. Public https, or http on a private host. Metadata IPs are rejected |
| `BASE_RPC_FALLBACKS` | publicnode, 1rpc | Used only if the primary fails `eth_chainId == 8453` |
| `ETHERSCAN_API_KEY` | empty | Optional ABI source. `tokenholderlist` on 8453 needs a paid plan |
| `SOURCIFY_BASE_URL` | `https://sourcify.dev/server` | No-key ABI. Public https |
| `HOLDER_SOURCES` | `blockscout,goplus,etherscan` | Subset of those three names |
| `BLOCKSCOUT_BASE_URL` | `https://base.blockscout.com` | Legacy `getTokenHolders` |
| `GOPLUS_BASE_URL` | `https://api.gopluslabs.io` | Fast top-10 shares, and the MCP token-security scan |
| `GOPLUS_ACCESS_TOKEN` | empty | Optional Bearer token for the MCP GoPlus call. Not logged. Public access works without it |
| `GOPLUS_TIMEOUT_MS` | `8000` | MCP GoPlus timeout. Minimum 100 |
| `SUPABASE_URL` | empty | MCP `api_keys` ledger. Unset fails closed (402). Not read by the HTTP API |
| `SUPABASE_SERVICE_ROLE_KEY` | empty | Service role for `deduct_api_key_balance`. Never logged |
| `HOLDER_CACHE_TTL_MS` | `600000` | `0` disables the holder cache |
| `CACHE_TTL_MS` | `20000` | Safety-response cache. `0` disables. Successes only. Does not clear the holder cache |
| `PRICE_USD` | `0.01` | Recorded USD price and, in x402 mode, the USDC amount (`round(PRICE_USD * 1e6)`) |
| `BILLING_MODE` | `open` | `open`, `api_key`, or `x402` |
| `API_KEYS` | empty | Comma-separated. Required for `api_key` mode |
| `USAGE_STORE` | empty | `memory`, `redis`, or `postgres`. Required when both Redis and `DATABASE_URL` are set |
| `REDIS_URL` | empty | `redis://` or `rediss://` |
| `UPSTASH_REDIS_REST_URL` | empty | `https://*.upstash.io` only |
| `UPSTASH_REDIS_REST_TOKEN` | empty | Bearer token. Never logged |
| `DATABASE_URL` | empty | `postgres://` or `postgresql://` |
| `X402_PAY_TO` | empty | Checksummed recipient. Empty disables settlement |
| `X402_FACILITATOR_URL` | empty | Base URL. `/verify` and `/settle` are appended |
| `X402_FACILITATOR_AUTH` | empty | `Authorization` value, or a raw token sent as `Bearer` |
| `X402_NETWORK` | `eip155:8453` | CAIP-2 |
| `X402_ASSET` | Base USDC | 6-decimal asset |
| `X402_ASSET_NAME` / `X402_ASSET_VERSION` | `USD Coin` / `2` for USDC | Required when the asset is not Base USDC |
| `X402_ACCEPT_STUB` | `true` | `false` rejects `stub:<id>` |
| `X402_MAX_TIMEOUT_SECONDS` | `60` | Max `validBefore - now` |
| `X402_VERIFY_TIMEOUT_MS` | `2500` | Facilitator verify |
| `X402_SETTLE_TIMEOUT_MS` | `8000` | Facilitator settle |
| `SIM_TIMEOUT_MS` | `1200` | Per simulation attempt |
| `HOLDERS_TIMEOUT_MS` | `900` | How long the check waits. The fetch may continue after that |
| `SOURCE_TIMEOUT_MS` | `500` | Sourcify / Etherscan ABI |
| `DISCOVERY_TIMEOUT_MS` | `1500` | Pool discovery and bytecode intel |
| `RATE_LIMIT_PER_MIN` | `120` | Per IP. `0` disables. Vitest sets this to `0` |

`getConfig()` caches the first read. Tests must call `resetConfigForTests()` and `resetUsageForTests()` after changing env.

## Run and test

```bash
npm install
npm run dev          # http://127.0.0.1:8787
npm test             # verdict, tax math, validation, billing, holder parsers, redis protocol, x402. No RPC
npm run typecheck
npm run test:integration   # live USDC plus chain=solana 400. Needs network
npm run check -- 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
npm run check -- 0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed
npm run build && npm start
```

Integration asserts: symbol USDC, decimals 6, honeypot false, taxes under 1, liquidity over $1M, `ownerCanMint` true, verdict `caution`, simulation `ok`, max sample under 5 seconds. `npm run check` exits 2 when the verdict is `danger`.

Docker: `docker build -t base-token-safety .` then `docker run --rm -p 8787:8787`. The image runs `node dist/index.js` and does not load a `.env` file unless you pass `--env-file`. `pg` is a production dependency. Redis needs no extra package.

## Layout

- `src/mcp.ts` — stdio MCP server. Tool `check_base_token_safety`. Not the HTTP entry.
- `src/db.ts` — Supabase debit. Not imported by the HTTP server.
- `supabase/migrations/20261105120000_api_keys.sql` — `api_keys` and `deduct_api_key_balance`.
- `src/scanner.ts` — GoPlus `token_security/8453` fetch.
- `src/parser.ts` — GoPlus parse and `PASS` / `WARN` / `BLOCK`.
- `src/domain/verdict.ts` — pure HTTP verdict. Unchanged by the MCP judgment.
- `src/domain/holders.ts` — top-10 math, including share-based lists and truncated pages.
- `src/services/safety.ts` — orchestration, cache, WETH short-circuit, public-mint probe.
- `src/services/pools.ts` — discovery, TVL, LP lock, ETH/AERO/DAI oracles.
- `src/services/marketData.ts` — Sourcify, Etherscan ABI, holder indexes and cache.
- `src/services/outbound.ts` — URL policy and timed fetch.
- `src/services/simulate.ts` — state override call.
- `src/services/intel.ts` — proxy, owner, mint/blacklist/pause, public mint probe.
- `src/http/billing.ts`, `src/http/x402.ts`, `src/http/usageStore.ts`, `src/http/redisClient.ts`.

## Remaining TODOs

1. Point `X402_PAY_TO` and `X402_FACILITATOR_URL` at a real Base USDC recipient and a mainnet facilitator, set `X402_ACCEPT_STUB=false`, and run one signed $0.01 payment. The code path is ready. This repo must not invent a pay-to key.
2. V3 / Slipstream NFT LP locks are still `-1`. Count them only from an index that attributes locked liquidity to the chosen pool. GoPlus `lp_holders` was inspected and is not per-pool.
3. Add Team Finance's Base LP locker only after the address is verified from an official source. Extend `LP_LOCKERS` in `src/domain/addresses.ts`. Do not guess.
4. Exercise Postgres against a real `DATABASE_URL` and Upstash against real REST credentials. The Redis wire client is covered by an in-process server test. The SQL is `INSERT ... ON CONFLICT` into `token_safety_usage`.
5. Find a current Base token whose owner is renounced and whose `mint` is public, and confirm `ownerCanMint: true` with the public-mint reason. Re-check USDC afterward. USDC must stay `ownerCanMint: true` because Circle has not renounced.
6. Persist the holder cache if cold starts must avoid the GoPlus-then-Blockscout hop. It is in memory on purpose so a dead index is not sticky across deploys.
7. Solana and `POST /v1/token-safety/batch` stay unbuilt on purpose.

## Do not break

- Response field names. `-1` means unknown for `lpLockedPct`, `liquidityUsd`, and `holdersTop10Pct`.
- USDC must stay honeypot false with taxes under 1% and liquidity well above $1M. `ownerCanMint: true` is correct for USDC. `holdersTop10Pct` should be a positive number well under 70 when the holder index is up, not `-1`.
- Do not send a real transaction. Simulation is `eth_call` only. x402 settlement is a facilitator POST, not a local private key.
- Do not log `X-Api-Key`, `ETHERSCAN_API_KEY`, `UPSTASH_REDIS_REST_TOKEN`, `X402_FACILITATOR_AUTH`, `DATABASE_URL`, `REDIS_URL`, `GOPLUS_ACCESS_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY`, or a caller `apiKey`.
- Do not put the MCP listener in `src/index.ts`. That file is the Vercel/Hono entry.
- Do not treat MCP `reportedTopHoldersPct` as the HTTP `holdersTop10Pct`. The HTTP field still excludes pools and uses `-1` for unknown.
- State overrides are required. Re-run integration after changing `BASE_RPC_URL`.
- Do not scrape Basescan HTML. Blockscout's JSON API and GoPlus are the no-key sources.
