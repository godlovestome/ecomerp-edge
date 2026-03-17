import axios from "axios";
import { config } from "../../config.js";
import { spApiAuth } from "../../auth/sp-api-auth.js";
import { BaseCollector } from "../base-collector.js";
import { TokenBucketRateLimiter } from "../../utils/rate-limiter.js";
import { createChildLogger } from "../../utils/logger.js";

const log = createChildLogger("sp-sales");

/**
 * SP-API Sales Collector.
 * Fetches order metrics (sales data) aggregated by time period.
 * Rate limit: 0.5 RPS, burst: 15
 */
export class SalesCollector extends BaseCollector {
  protected readonly apiType = "sp_api";
  protected readonly dataType = "sales";
  protected readonly name = "SP-API Sales";

  constructor(rateLimiter: TokenBucketRateLimiter) {
    super(rateLimiter);
  }

  protected async fetchData(params?: Record<string, any>): Promise<Record<string, any>[]> {
    const headers = await spApiAuth.getHeaders();
    const marketplaceId = params?.marketplaceId || config.spApi.marketplaceId;

    // Default: last 7 days of sales data
    const interval = params?.interval || this.getDefaultInterval();
    const granularity = params?.granularity || "Day";

    try {
      const response = await this.rateLimitedRequest(async () => {
        const res = await axios.get(
          `${config.spApi.endpoint}/sales/v1/orderMetrics`,
          {
            headers,
            params: {
              marketplaceIds: marketplaceId,
              interval,
              granularity,
            },
          }
        );
        this.rateLimiter.updateFromHeader(res.headers["x-amzn-ratelimit-limit"]);
        return res;
      }, "getOrderMetrics");

      const metrics = response.data?.payload || [];
      log.info({ metricsCount: metrics.length, interval, granularity }, "Sales metrics fetched");
      return metrics;
    } catch (err: any) {
      log.error({ error: err.message }, "Failed to fetch sales metrics");
      throw err;
    }
  }

  private getDefaultInterval(): string {
    const end = new Date();
    const start = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    return `${start.toISOString()}--${end.toISOString()}`;
  }
}
