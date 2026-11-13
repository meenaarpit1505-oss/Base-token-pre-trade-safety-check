import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    env: {
      RATE_LIMIT_PER_MIN: "0",
      BILLING_MODE: "open",
      CACHE_TTL_MS: "0",
    },
  },
});
