import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { getConfig } from "./config.js";
import { getUsageStore } from "./http/usageStore.js";
import { getBaseClient } from "./services/rpc.js";
import { warmLpLockIndex } from "./services/lpLocks.js";

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

  // Background: index burned / known-locker CL position NFTs so lpLockedPct can be measured for V3 pools.
  if ((process.env.LP_NFT_INDEX_WARM ?? "true").toLowerCase() !== "false") {
    getBaseClient()
      .then((client) => warmLpLockIndex(client))
      .then((result) => console.log(JSON.stringify({ event: "lp_lock_index_ready", ...result })))
      .catch((error) =>
        console.error(
          JSON.stringify({ event: "lp_lock_index_failed", message: error instanceof Error ? error.message.slice(0, 300) : "unknown" }),
        ),
      );
  }

  serve({ fetch: app.fetch, hostname: "0.0.0.0", port: config.port }, (info) => {
    console.log(`Base token safety API at http://127.0.0.1:${info.port}`);
  });
}
