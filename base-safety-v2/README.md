# Base Token Pre-Trade Safety Check — v2.1

A read-only risk check that a trading agent calls before it swaps a token on Base (chain 8453). You send one `token_address` and get back `status` (SAFE | WARN | DANGER), a `risk_score` from 0 to 100, a `risk_matrix` with three threat models, and a recommendation (with `reasons`) the agent can act on.

| File | Role |
| --- | --- |
| `ai-plugin.json` | Tool manifest (MCP-style). Defines `analyze_base_token_safety`, its strict `inputSchema` and full `outputSchema`, scoring weights, thresholds, cascade rubric and venue coverage |
| `lib/safetyEngine.js` | The three threat models, run in parallel. Uses viem with multicall batching, per-check timeouts and bounded log windows. It never throws |
| `lib/clMath.js` | Pure concentrated-liquidity math: tick bitmap decoding, piecewise liquidity profile, in-range swap simulation, window amounts, CP helpers |
| `lib/cacheLayer.js` | In-memory LRU, then single-flight, then a 300 s Supabase lookup, then the engine. Writes back to Supabase in the background via `waitUntil` |
| `app/api/analyze/route.js` | Next.js Edge route: `GET ?token_address=` or `POST {"token_address"}` |
| `app/api/mcp/route.js` | Stateless MCP server (Streamable HTTP, JSON responses) that supports `initialize`, `tools/list` and `tools/call` |
| `supabase/schema.sql` | Cache table, indexes and RLS |
| `scripts/validate-manifest.mjs`, `scripts/smoke.mjs`, `scripts/unit.mjs` | Manifest validation (input + output fixtures), live mainnet smoke test, offline unit tests |
| `HANDOFF.md` | What is done here, what is intentionally left for the Origin repo, and the sources behind every hardcoded address |

## Run

```bash
npm install
cp .env.example .env.local      # Supabase is optional; without it the cache runs in memory only
npm run check                   # node --check on all JS + Ajv validation of ai-plugin.json (input + output fixtures)
npm test                        # offline: sandwich / JIT / pending detectors, CL math, multi-hop + V4 routing, V4 log decoding, status rules
npm run smoke                   # live Base mainnet run (USDC, AERO, DEGEN, BRETT, cbBTC, EOA, invalid input) + cache checks
npm run build                   # next build (both routes on the Edge runtime)
npm run dev                     # curl 'localhost:3000/api/analyze?token_address=0x...'
```

Supabase setup: run `supabase/schema.sql` in the SQL editor, then set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` as **server-side** env vars.

## Coverage

| Venue | Discovery | State | Logs (mempool forensics + JIT) |
| --- | --- | --- | --- |
| Uniswap V2 | `getPair` | reserves, balances, LP supply | Swap / Mint / Burn + LP mints |
| Uniswap V3 | `getPool` × fee 100/500/3000/10000 | slot0, liquidity, balances, tick bitmap + `ticks()` | Swap / Mint / Burn |
| **Uniswap V4** | PoolId = `keccak256(abi.encode(PoolKey))` for hookless pools at 100/1, 500/10, 3000/60, 10000/200, plus `UNISWAP_V4_POOL_KEYS` | StateView `getSlot0`, `getLiquidity`, `getTickBitmap`, `getTickLiquidity` | PoolManager `Swap` / `ModifyLiquidity` filtered by pool id (topic1) |
| Aerodrome basic | `getPool(a,b,stable)` | reserves, balances, LP supply | Swap / Burn + LP mints |
| Aerodrome Slipstream | 3 official factories × tick spacing 1/50/100/200/2000 | slot0, liquidity, balances, tick bitmap + `ticks()` | Swap / Mint / Burn (V3 layout) |

Quote assets: **WETH**, **native ETH** (V4 only), **USDC**, and the intermediates **USDbC** and **cbBTC**. An intermediate-quoted pool is a two-hop route (`TOKEN → cbBTC → USDC|WETH`): its USD price and second-leg depth come from that asset's own USDC/WETH pools (Uniswap V3 100/500/3000, Aerodrome volatile/stable, Slipstream 1/100). No other intermediates are used: there is no verified, official list of further "liquid" Base quote assets, so none is invented.

Uniswap V4 addresses on Base (from the official deployments page): PoolManager `0x498581ff718922c3f8e6a244956af099b2652b2b`, StateView `0xa3c0c9b65bad0b08107aa264b0f3db444b867a71`, PositionManager `0x7c5f5a4bbd8fd63184577525326123b519429bdc` (router list only), Universal Router 2.1.1 / 2.1.2 (router list only).

Dust: pools with depth below `DUST_POOL_USD` ($1,000 default) are ignored as long as at least one deeper pool exists (`dust_pools_ignored` in cascade metrics).

## Threat models

1. **Mempool front-running attack surface** (`mempool_front_running`)
   - The engine looks for pending transactions in this order: `txpool_content`, then a genuine `pending` block (only counted if its hash is null), then `eth_newPendingTransactionFilter` sampled for `PENDING_SAMPLE_MS`.
   - **On Base this is almost always unavailable.** The sequencer mempool is private; `mainnet.base.org` rejects `txpool_content`, the pending filter and `eth_getLogs`. The engine then switches to **recent-block forensics** (`data_source = "recent_blocks_fallback"`, `PRIVATE_MEMPOOL` info signal): same-block sandwiches over `LOG_BLOCK_RANGE` blocks on the deepest `LOG_MAX_POOLS` pools (V4 included), router-mediated swaps resolved to `tx.from` (bounded by `MAX_TX_LOOKUPS`), `MEV_BOT_ADDRESSES`, and high-frequency two-sided actors.
   - V4 `Swap` amounts are the swapper's deltas (sign opposite to V3); the decoder handles that (unit-tested).
2. **JIT liquidity vampire** (`jit_liquidity_vampire`)
   - V3 / Slipstream: `Mint`/`Burn` pair with the same owner and tick range, burning ≥90% of the minted liquidity within `JIT_WINDOW_BLOCKS`.
   - V4: `ModifyLiquidity` with positive then negative `liquidityDelta`, matched on (sender, tickLower, tickUpper, **salt**). PositionManager is the sender for most users, so the position salt (= tokenId) is what identifies a position; `top_jit_providers` shows `v4_position_salt_prefix`.
   - V2 / Aerodrome basic: LP token mint to a provider, then `Burn(to = provider)` within the window.
   - For a taker the risk is **phantom depth**: quoted depth disappears right after the trade.
3. **Cross-pair liquidity cascade** (`cross_pair_cascade`) — see the CL model below.
   - Builds the pool graph with USD depth and per-quote routes (`routes`: hops, path, second-leg depth).
   - Shock test: the secondary asset (group: ETH/WETH, USDC, USDbC, cbBTC) of the largest pool suffers a `CASCADE_SHOCK_PCT` liquidation. Pools in that group lose that share of liquidity (CL: `L` scaled; CP: depth scaled; hop leg scaled too). If the asset is volatile, the token is re-marked depth-weighted (`repricing_pct`). Then a `REFERENCE_TRADE_USD` sell is routed across all pools.
   - `systemic_collapse` is true when the projected drop is ≥ 40%, post-shock impact ≥ 15%, remaining depth < 5× the reference trade, or ≥ 20% of the post-shock sell cannot be filled inside known CL liquidity.

## Concentrated-liquidity model (V3 / Slipstream / V4)

Inside one initialized-tick range a CL pool is exactly a constant-product pool on virtual reserves `x = L/√P`, `y = L·√P`. The engine therefore:

1. Reads `slot0` (√P, tick) and in-range `liquidity()` for every CL pool (V4 via StateView).
2. For the deepest `CL_TICK_SCAN_MAX_POOLS` CL pools, reads three tick-bitmap words around the current tick, then `liquidityNet` of the nearest `CL_TICK_WALK_MAX_TICKS` initialized ticks on each side. That gives a piecewise-constant liquidity profile out to a known window edge.
3. Simulates the sell segment by segment (`token0` in: `1/√P' = 1/√P + Δx/L`; `token1` in: `√P' = √P + Δy/L`), crossing ticks and applying `liquidityNet`. `ticks_crossed` is reported.
4. If the sell runs past the known window: V3/Slipstream fall back to constant-product on the pool's remaining balances (`residual_balance_fallback`); V4 (no per-pool balances) reports the remainder as unfilled (`post_shock_unfilled_pct`, `CL_LIQUIDITY_EXHAUSTED`), and unfilled flow counts as 100% impact.
5. Pools without tick data (beyond the top N, an RPC failure, or the context budget is spent) use the provable bound: liquidity is constant only between the two tick-spacing multiples around the current tick (`tick_data = tick_spacing_bound`, conservative).
6. Routing across pools is a two-pass allocation: first proportional to each pool's small-probe CP-equivalent depth, then re-weighted by the CP-equivalent depth implied by the first pass, so exhausted pools receive less flow. Reported impact is allocation-weighted.
7. Two-hop routes compose impacts: `1 − (1 − i_leg1)(1 − i_leg2)` with leg 2 = CP on the intermediate's own USDC/WETH depth. If that depth is unknown, leg 2 is assumed no deeper than leg 1 (`HOP_LEG_UNPRICED`).

Constant-product pools (V2, Aerodrome volatile) keep x·y=k on balances. Aerodrome stable pools are treated as constant product too (conservative for the stable curve) and are not used for pricing.

**Limits.** Fees are ignored (real impact is slightly worse). Liquidity outside the scanned window is unknown. Dynamic fees, hooks and V4 custom accounting are not modeled. Routing is an approximation of an optimal router, not a quote. V4 `depth_usd` is the in-range liquidity inside the scanned window (no per-pool balances exist), so it can understate a V4 pool's full TVL.

## Scoring

- `risk_score` = confidence-weighted blend: mempool 0.35, JIT 0.30, cascade 0.35. A model with no data keeps only 5% of its weight.
- Status:
  - **SAFE** when the score is below 35.
  - **WARN** when the score is 35–64; or SAFE-range but overall confidence < 0.35 (`LOW_CONFIDENCE` reason); or SAFE-range but any model with confidence ≥ 0.5 raised a **critical** signal (critical-signal floor, new in 2.1).
  - **DANGER** when the score is ≥ 65, when any single model scores ≥ 85 with confidence ≥ 0.5, or when the address has no bytecode (score 100).
- Degraded / no data (RPC outage): WARN, score 50, confidence 0, cached for 20 s only. Never a false SAFE.
- **Cascade rubric**: `impact×2.5 + repricing×0.6` (so a WETH pairing alone cannot reach DANGER) `+ 8` if HHI > 0.85, `+20 / +10 / +4` if depth < $50k / $250k / $1M, `+10` if the token's pools exceed half of the secondary asset's own depth (non-reference tokens), `+8 / +3` if ≥ 50% / ≥ 20% of depth needs a second hop, `+15 / +8` if ≥ 20% / > 0% of the post-shock sell is unfillable inside known CL liquidity, `+5` if ≥ 50% of depth is in hooked V4 pools. Confidence 0.75 (0.45 without a USD price), −0.1 if the deepest CL pool lacks tick data, −0.1 for an unpriced hop leg, −0.15 if mostly hooked.
- New signals: `CL_TICK_WALK` (info), `CL_LIQUIDITY_EXHAUSTED` (warn/critical), `CL_TICK_DATA_LIMITED` (info), `ROUTED_VIA_INTERMEDIATE` (info) / `MULTI_HOP_ROUTE` (warn), `HOP_LEG_UNPRICED` (warn), `V4_HOOKED_POOL` (warn). They show up in `risk_matrix.*.signals` and in `recommendation.reasons`.

Live calibration (Base mainnet, 2026-11-11, public RPC): USDC SAFE 0, WETH SAFE 0, cbBTC SAFE 3, AERO SAFE 9, BRETT SAFE 16 (cascade 34), DEGEN SAFE 16–17 (cascade 37 = WARN inside the model, ref impact 4.2% vs 8.2% under the old CP-only model), `0x…dEaD` DANGER 100, invalid input DANGER 100 / HTTP 400.

## Performance

- Round trips: (1) metadata + factory discovery + intermediate reference discovery + V4 StateView reads (pool ids computed off-chain); (2) pool state; (3) tick bitmaps; (4) `liquidityNet` for nearest ticks. Rounds 3–4 are skipped (tick-spacing bound) when `CL_TICK_SCAN_BUDGET_MS` is already spent. Typical uncached latency on public RPC: 1.1–1.3 s.
- One shared, memoized log fetch serves both log-based models; at most 10 addresses per `eth_getLogs`; V4 logs are one PoolManager query filtered by pool ids.
- Per-model `AbortController` deadlines plus the global `ENGINE_TIMEOUT_MS` (9.5 s).
- Cache layers: in-memory LRU, single-flight, Supabase read capped at 250 ms, `CDN-Cache-Control: s-maxage≤60` on GET.

## Environment

See `.env.example`. New in 2.1: `ENABLE_UNISWAP_V4`, `UNISWAP_V4_POOL_KEYS`, `ENABLE_EXTRA_QUOTES`, `DUST_POOL_USD`, `CL_TICK_SCAN_MAX_POOLS`, `CL_TICK_WALK_MAX_TICKS`, `CL_TICK_SCAN_BUDGET_MS`. Use a paid Base RPC for `BASE_RPC_URL` and a logs-capable endpoint for `BASE_LOGS_RPC_URL` in production.

## Limitations

- **No public mempool on Base.** The front-running score is forensic (what happened to this token's flow in the last hour), not what is queued now.
- **Uniswap V4 hooked pools are not discoverable** without an index of `Initialize` events (most Base launchpad pools, e.g. Clanker/Zora-style, use hooks). Only hookless pools at the four standard tiers are found automatically; list others in `UNISWAP_V4_POOL_KEYS`. Hook behavior is never modeled and is flagged.
- **Other venues** (PancakeSwap, SushiSwap, Balancer, Curve, BaseSwap, …) and intermediates other than USDbC/cbBTC are not scanned.
- **CL model limits**: see above.
- **Public RPC limits:** `mainnet.base.org` rejects `eth_getLogs`; logs go to `BASE_LOGS_RPC_URL` / `BASE_RPC_FALLBACK_URLS` (publicnode by default, max 10 addresses per query).
- **Untuned heuristics:** MEV-bot detection is heuristic; add known searchers through `MEV_BOT_ADDRESSES`. Sandwich and JIT detectors are verified on synthetic data; live sandwich/JIT hits have not been observed on the smoke tokens yet.
