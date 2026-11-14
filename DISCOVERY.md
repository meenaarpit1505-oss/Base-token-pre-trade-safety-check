# Listing and discovery

Metadata in this repository prepares the live services to be found by agents. **Nothing is listed automatically.** Publishing to the official MCP Registry or Smithery, and appearing in the Coinbase x402 Bazaar, each need an action that only the repo owner can complete. No pay-to address or API key is stored here.

Live endpoints:

- Origin API: `https://origin-api-production-6bf51463.up.railway.app` — `GET /health`, `GET /v1/token-safety?chain=base&address=0x…`
- v2 HTTP: `https://base-safety-v2-production.up.railway.app/api/analyze`
- v2 MCP (Streamable HTTP): `https://base-safety-v2-production.up.railway.app/api/mcp`

## 1. x402 facilitator (Base mainnet USDC)

Payments use x402 v2, scheme `exact`, network `eip155:8453`, asset Base USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 decimals, EIP-3009). Set `X402_PAY_TO` to your own public Base address and `X402_FACILITATOR_URL` on Railway when you are ready to charge. Do not use a made-up address.

| Facilitator | URL | Base mainnet USDC | Auth | CDP Bazaar indexing |
| --- | --- | --- | --- | --- |
| **Coinbase CDP (recommended for Bazaar)** | `https://api.cdp.coinbase.com/platform/v2/x402` | Yes (`eip155:8453`, exact / upto / batch-settlement) | **Required:** Coinbase Developer Platform account and `CDP_API_KEY_ID` + `CDP_API_KEY_SECRET`. CDP authenticates verify/settle with JWTs, not a static Bearer token. | Yes, after the first successful settlement that carries Bazaar metadata and `paymentPayload.resource` |
| **PayAI** (listed in official x402.org seller docs as a production option) | `https://facilitator.payai.network` | Yes (x402 v2 `exact` on `eip155:8453`, confirmed via `/supported`) | No API key | No (this is not the CDP Facilitator, so it does not catalog into CDP Bazaar) |
| x402.org public facilitator | `https://x402.org/facilitator` | **No.** Testnet only (Base Sepolia `eip155:84532`, Solana Devnet). | None | Test catalog only |

Official sources: [CDP network support](https://docs.cdp.coinbase.com/x402/network-support), [CDP seller quickstart](https://docs.cdp.coinbase.com/x402/quickstart-for-sellers), [x402.org running on mainnet](https://docs.x402.org/getting-started/quickstart-for-sellers), [x402.org facilitators](https://docs.x402.org/dev-tools/facilitators).

CDP pricing: first 1,000 onchain facilitator settlements per month are free, then $0.001 each. Verification is free.

This codebase talks to a facilitator with `X402_FACILITATOR_URL` plus optional `X402_FACILITATOR_AUTH` (sent as `Authorization`). A raw CDP API secret cannot be pasted into `X402_FACILITATOR_AUTH`. To use the CDP Facilitator you will need either a small JWT signer (from `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET`, never committed) or a documented no-key production facilitator such as PayAI. **CDP Bazaar listing only happens through the CDP Facilitator.**

## 2. x402 Bazaar (Coinbase discovery)

There is **no registration form**. Per [CDP Bazaar docs](https://docs.cdp.coinbase.com/x402/bazaar) and the [x402 Bazaar extension](https://docs.x402.org/extensions/bazaar):

1. Merge this change so 402 responses include `extensions.bazaar` (`info` + `schema`) and resource metadata (`serviceName`, `tags`).
2. Turn on `BILLING_MODE=x402` with your `X402_PAY_TO` and the **CDP** facilitator URL (and working CDP auth).
3. Optionally preflight with `POST https://api.cdp.coinbase.com/platform/v2/x402/validate` (`resource` + `method`). Validation does not index the service.
4. Complete **one successful paid settlement** through the CDP Facilitator. The payment payload must include `paymentPayload.resource` and must echo the `bazaar` extension. Indexing is after settle, not verify, and usually appears in 10–15 minutes.
5. Confirm with the public discovery APIs (no API key): search / list resources, or `GET {facilitator}/discovery/resources?payTo=YOUR_ADDRESS`.

The 402 body advertises HTTP input for `/api/analyze` and `/v1/token-safety`, and MCP input (`type: "mcp"`, `toolName: analyze_base_token_safety`, `transport: "streamable-http"`) for `/api/mcp`.

## 3. Official MCP Registry

File: [`server.json`](./server.json), schema `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`.

- Name: `io.github.meenaarpit1505-oss/base-token-safety` (GitHub namespace of the repo owner).
- Remote: Streamable HTTP at the live v2 MCP URL. Origin-api's MCP is stdio-only and is not listed as a remote.
- Description is ≤ 100 characters, as the official registry requires.

**Remaining steps (repo owner only — do not publish from another GitHub login):**

1. Install `mcp-publisher` ([quickstart](https://modelcontextprotocol.io/registry/quickstart)).
2. In the repo root: `mcp-publisher validate server.json`.
3. Authenticate as **meenaarpit1505-oss**: `mcp-publisher login github`, then complete the GitHub device flow at `https://github.com/login/device`.
4. Publish: `mcp-publisher publish`.
5. Confirm: `curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.meenaarpit1505-oss/base-token-safety"`.

The registry checks that you control the `io.github.meenaarpit1505-oss` namespace; it does not verify control of the Railway URL. Docs: [authentication](https://modelcontextprotocol.io/registry/authentication), [remote servers](https://modelcontextprotocol.io/registry/remote-servers).

## 4. Smithery

Official publish path for an already-hosted remote server ([Smithery publish docs](https://smithery.ai/docs/build/publish)):

1. Confirm `POST https://base-safety-v2-production.up.railway.app/api/mcp` answers `initialize` and `tools/list` without auth (it does today; billing, when enabled, applies only to `tools/call`).
2. Sign in at Smithery and open [https://smithery.ai/new](https://smithery.ai/new).
3. Enter the public HTTPS MCP URL above, choose a namespace/server id you control, and finish the publishing flow.
4. Wait for the automatic scan (`SmitheryBot/1.0`). If a scan is blocked, the static card at `/.well-known/mcp/server-card.json` on the v2 service can be used as fallback metadata.

CLI alternative (also requires your Smithery login): `smithery mcp publish "https://base-safety-v2-production.up.railway.app/api/mcp" -n @your-namespace/base-token-safety`.

Do not publish this server under someone else's Smithery or GitHub account.
