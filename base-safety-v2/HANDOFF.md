# HANDOFF — base-safety-v2 (v2.1.0)

## Done in this package
- Uniswap V4 (Base): hookless pool discovery at 100/1, 500/10, 3000/60, 10000/200 via off-chain PoolId + StateView; optional `UNISWAP_V4_POOL_KEYS` for hooked pools (flagged `V4_HOOKED_POOL`, not modeled). V4 Swap/ModifyLiquidity logs feed the mempool forensics and JIT models.
- Quote assets beyond WETH/USDC: native ETH (V4), USDbC and cbBTC as two-hop intermediates with their own USD price and second-leg depth.
- Concentrated-liquidity tick-walk impact (`lib/clMath.js`) for V3 / Slipstream / V4; constant product kept for V2 / Aerodrome basic.
- Scoring: cascade rubric extended (hop share, CL exhaustion, hooks, <$1M depth step), critical-signal floor (SAFE → WARN), `recommendation.reasons`.
- Tests: 52 offline assertions, manifest input/output fixtures, live smoke, `next build`.

## Address sources (all checked 2026-11-11)
| Address | What | Source |
| --- | --- | --- |
| `0x498581ff718922c3f8e6a244956af099b2652b2b` | Uniswap V4 PoolManager (Base) | https://docs.uniswap.org/contracts/v4/deployments |
| `0xa3c0c9b65bad0b08107aa264b0f3db444b867a71` | Uniswap V4 StateView (Base) | same |
| `0x7c5f5a4bbd8fd63184577525326123b519429bdc` | Uniswap V4 PositionManager (router list) | same |
| `0xfdf682f51fe81aa4898f0ae2163d8a55c127fbc7`, `0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40` | Universal Router 2.1.1 / 2.1.2 (router list) | same |
| `0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A`, `0xaDe65c38CD4849aDBA595a4323a8C7DdfE89716a`, `0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef` | Slipstream PoolFactory (initial, GaugeCaps, GaugesV3) | https://github.com/aerodrome-finance/slipstream#deployments |
| `0xcbBb8035cAc7D4B3Ca7aBb74cF7BdF900215Ce0D`, `0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F` | Slipstream SwapRouter (GaugeCaps, GaugesV3) (router list) | same |
| `0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA` | USDbC (bridged USDC) | https://docs.base.org/base-chain/network-information/ecosystem-bridges , https://www.circle.com/blog/usdc-now-available-natively-on-base |
| `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` | cbBTC | https://www.coinbase.com/cbbtc , https://www.coinbase.com/blog/coinbase-wrapped-btc-cbbtc-is-now-live |
| `0x4200000000000000000000000000000000000006` | WETH9 predeploy | https://docs.base.org/base-chain/network-information/base-contracts |

Note: a Slipstream factory `0x5e7BB104d84c5CB9F079E55B2582Eb12b2062F41` was mentioned in a task brief; it does **not** match the official Slipstream README. The code keeps the official `0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A`.

## Not done here (belongs to the Origin repo / later)
- V3/Slipstream NFT LP lock reporting (`-1`; GoPlus `lp_holders` is not per-pool).
- Team Finance Base LP locker address (only from an official source).
- Durable holder cache in Origin.
- x402 pay-to / facilitator (`X402_PAY_TO`, `X402_FACILITATOR_URL`, `X402_ACCEPT_STUB=false`): needs a real address from the owner.
- Solana and `POST /v1/token-safety/batch`.
- V4 hooked-pool discovery needs an `Initialize`-event index (subgraph or archive logs); not possible within the per-request budget.
