import type { MiddlewareHandler } from "hono";
import { getConfig } from "../config.js";

const hits = new Map<string, { window: number; count: number }>();

export function resetRateLimitForTests(): void {
  hits.clear();
}

export function rateLimit(): MiddlewareHandler {
  return async (c, next) => {
    const limit = getConfig().rateLimitPerMin;
    if (limit <= 0) {
      await next();
      return;
    }
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";
    const window = Math.floor(Date.now() / 60_000);
    const row = hits.get(ip);
    if (!row || row.window !== window) hits.set(ip, { window, count: 1 });
    else {
      row.count += 1;
      if (row.count > limit) {
        return c.json({ error: "rate_limited", message: `Limit is ${limit} token-safety requests per minute.` }, 429);
      }
    }
    await next();
  };
}
