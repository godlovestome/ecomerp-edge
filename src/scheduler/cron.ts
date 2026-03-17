import cron from "node-cron";
import { config } from "../config.js";
import { coreClient } from "../push/core-client.js";
import { createChildLogger } from "../utils/logger.js";
import { createSpApiLimiters, createAdsApiLimiters } from "../utils/rate-limiter.js";

// SP-API collectors
import { OrdersCollector } from "../collectors/sp-api/orders.js";
import { FinancesCollector } from "../collectors/sp-api/finances.js";
import { InventoryCollector } from "../collectors/sp-api/inventory.js";
import { CatalogCollector } from "../collectors/sp-api/catalog.js";
import { PricingCollector } from "../collectors/sp-api/pricing.js";
import { SalesCollector } from "../collectors/sp-api/sales.js";
import { ReportsCollector } from "../collectors/sp-api/reports.js";

// Ads API collectors
import { CampaignsCollector } from "../collectors/ads-api/campaigns.js";
import { AdGroupsCollector } from "../collectors/ads-api/ad-groups.js";
import { KeywordsCollector } from "../collectors/ads-api/keywords.js";
import { TargetsCollector } from "../collectors/ads-api/targets.js";
import { PerformanceCollector } from "../collectors/ads-api/performance.js";

import { spApiAuth } from "../auth/sp-api-auth.js";
import { adsApiAuth } from "../auth/ads-api-auth.js";
import type { BaseCollector, CollectorResult } from "../collectors/base-collector.js";

const log = createChildLogger("scheduler");

export class Scheduler {
  private spLimiters = createSpApiLimiters();
  private adsLimiters = createAdsApiLimiters();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private cronTask: cron.ScheduledTask | null = null;
  private isRunning = false;

  // All available collectors
  private getSpApiCollectors(): BaseCollector[] {
    if (!spApiAuth.isConfigured()) {
      log.warn("SP-API credentials not configured, skipping SP-API collectors");
      return [];
    }
    return [
      new OrdersCollector(this.spLimiters.orders),
      new FinancesCollector(this.spLimiters.finances),
      new InventoryCollector(this.spLimiters.inventory),
      new CatalogCollector(this.spLimiters.catalog),
      new PricingCollector(this.spLimiters.pricing),
      new SalesCollector(this.spLimiters.sales),
      new ReportsCollector(this.spLimiters.reports),
    ];
  }

  private getAdsApiCollectors(): BaseCollector[] {
    if (!adsApiAuth.isConfigured()) {
      log.warn("Ads API credentials not configured, skipping Ads API collectors");
      return [];
    }
    return [
      new CampaignsCollector(this.adsLimiters.campaigns),
      new AdGroupsCollector(this.adsLimiters.adGroups),
      new KeywordsCollector(this.adsLimiters.keywords),
      new TargetsCollector(this.adsLimiters.targets),
      new PerformanceCollector(this.adsLimiters.reporting),
    ];
  }

  /**
   * Start the scheduler based on configured sync mode.
   */
  async start(): Promise<void> {
    log.info({ mode: config.sync.mode, cron: config.sync.cron }, "Starting scheduler");

    // Start heartbeat
    this.startHeartbeat();

    switch (config.sync.mode) {
      case "realtime":
        // In realtime mode, run collection immediately and then on a tight schedule
        await this.runAllCollectors();
        this.cronTask = cron.schedule("*/30 * * * *", () => this.runAllCollectors()); // Every 30 min
        log.info("Realtime mode: collecting every 30 minutes");
        break;

      case "scheduled":
        this.cronTask = cron.schedule(config.sync.cron, () => this.runAllCollectors());
        log.info({ cron: config.sync.cron }, "Scheduled mode: cron task registered");
        // Run once at startup
        await this.runAllCollectors();
        break;

      case "manual":
        log.info("Manual mode: waiting for trigger from Core");
        break;
    }
  }

  /**
   * Stop the scheduler and clean up.
   */
  stop(): void {
    if (this.cronTask) {
      this.cronTask.stop();
      this.cronTask = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    log.info("Scheduler stopped");
  }

  /**
   * Run all configured collectors sequentially.
   * SP-API collectors run first, then Ads API collectors.
   */
  async runAllCollectors(params?: Record<string, any>): Promise<void> {
    if (this.isRunning) {
      log.warn("Collection already in progress, skipping");
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();
    const results: { name: string; result: CollectorResult }[] = [];

    try {
      log.info("=== Starting full data collection cycle ===");

      // Run SP-API collectors
      const spCollectors = this.getSpApiCollectors();
      for (const collector of spCollectors) {
        try {
          const result = await collector.collect(params);
          results.push({ name: (collector as any).name, result });
        } catch (err: any) {
          log.error({ collector: (collector as any).name, error: err.message }, "Collector failed");
          results.push({
            name: (collector as any).name,
            result: { success: false, recordCount: 0, errors: [err.message], duration: 0 },
          });
        }
      }

      // Run Ads API collectors
      const adsCollectors = this.getAdsApiCollectors();
      for (const collector of adsCollectors) {
        try {
          const result = await collector.collect(params);
          results.push({ name: (collector as any).name, result });
        } catch (err: any) {
          log.error({ collector: (collector as any).name, error: err.message }, "Collector failed");
          results.push({
            name: (collector as any).name,
            result: { success: false, recordCount: 0, errors: [err.message], duration: 0 },
          });
        }
      }

      const totalDuration = Date.now() - startTime;
      const totalRecords = results.reduce((sum, r) => sum + r.result.recordCount, 0);
      const failedCount = results.filter((r) => !r.result.success).length;

      log.info(
        {
          totalDuration,
          totalRecords,
          collectors: results.length,
          failed: failedCount,
        },
        "=== Collection cycle completed ==="
      );

      // Report overall status to Core
      await coreClient.reportSyncEvent({
        edgeHostId: config.core.edgeHostId,
        bindingId: 0,
        status: failedCount === 0 ? "success" : failedCount === results.length ? "error" : "partial",
        recordCount: totalRecords,
        errorMessage: failedCount > 0
          ? `${failedCount}/${results.length} collectors failed`
          : undefined,
        metadata: {
          results: results.map((r) => ({
            name: r.name,
            success: r.result.success,
            records: r.result.recordCount,
            duration: r.result.duration,
            errors: r.result.errors,
          })),
        },
      });
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Run a specific collector by name.
   */
  async runCollector(collectorName: string, params?: Record<string, any>): Promise<CollectorResult | null> {
    const allCollectors = [...this.getSpApiCollectors(), ...this.getAdsApiCollectors()];
    const collector = allCollectors.find((c) => (c as any).dataType === collectorName);

    if (!collector) {
      log.error({ collectorName }, "Collector not found");
      return null;
    }

    return collector.collect(params);
  }

  private startHeartbeat(): void {
    // Send initial heartbeat
    coreClient.sendHeartbeat();

    // Schedule periodic heartbeats
    this.heartbeatTimer = setInterval(() => {
      coreClient.sendHeartbeat();
    }, config.sync.heartbeatInterval);

    log.info({ intervalMs: config.sync.heartbeatInterval }, "Heartbeat started");
  }
}
