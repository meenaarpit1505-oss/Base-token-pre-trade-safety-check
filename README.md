# Base-token-pre-trade-safety-check

Pre-trade token safety check for autonomous trading agents on Base (chain 8453).

- `origin-api/` — HTTP API (`GET /v1/token-safety`) plus a stdio MCP tool.
- `base-safety-v2/` — HTTP `POST|GET /api/analyze` and Streamable HTTP MCP at `/api/mcp`.

Live apps and how to list them in the x402 Bazaar, the official MCP Registry, and Smithery: see [DISCOVERY.md](./DISCOVERY.md).
