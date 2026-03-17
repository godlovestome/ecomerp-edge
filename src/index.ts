import { config } from "./config.js";
import { createChildLogger } from "./utils/logger.js";
import { Scheduler } from "./scheduler/cron.js";
import { spApiAuth } from "./auth/sp-api-auth.js";
import { adsApiAuth } from "./auth/ads-api-auth.js";

const log = createChildLogger("main");

async function main() {
  log.info("===========================================");
  log.info("  EcoMerp Edge - Data Collection Service");
  log.info("===========================================");
  log.info({
    coreUrl: config.core.apiUrl,
    edgeHostId: config.core.edgeHostId,
    syncMode: config.sync.mode,
    spApiConfigured: spApiAuth.isConfigured(),
    adsApiConfigured: adsApiAuth.isConfigured(),
  }, "Configuration loaded");

  // Validate essential configuration
  if (!config.core.edgeHostId || !config.core.edgeApiKey) {
    log.error("EDGE_HOST_ID and EDGE_API_KEY are required. Register this edge host in Core ERP first.");
    process.exit(1);
  }

  if (!spApiAuth.isConfigured() && !adsApiAuth.isConfigured()) {
    log.error("At least one API (SP-API or Ads API) must be configured.");
    process.exit(1);
  }

  const scheduler = new Scheduler();

  // Graceful shutdown
  const shutdown = () => {
    log.info("Shutting down...");
    scheduler.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await scheduler.start();
    log.info("Edge service is running. Press Ctrl+C to stop.");
  } catch (error: any) {
    log.error({ error: error.message }, "Failed to start scheduler");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
