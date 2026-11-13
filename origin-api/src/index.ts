import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { getConfig } from "./config.js";
import { getUsageStore } from "./http/usageStore.js";
import { getBaseClient } from "./services/rpc.js";

export default app;

// Vercel imports this module for framework detection and must not bind a port.
// `npm start` and Docker run the file directly, with VERCEL unset.
if (process.env.VERCEL !== "1") {
  const config = getConfig();

  try {
    await getUsageStore().ping();
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "usage_store_unavailable",
        message: error instanceof Error ? error.message.slice(0, 300) : "unknown",
      }),
    );
  }

  try {
    await getBaseClient();
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "rpc_warmup_failed",
        message: error instanceof Error ? error.message.slice(0, 300) : "unknown",
      }),
    );
  }

  serve({ fetch: app.fetch, hostname: "0.0.0.0", port: config.port }, (info) => {
    console.log(`Base token safety API at http://127.0.0.1:${info.port}`);
  });
}
