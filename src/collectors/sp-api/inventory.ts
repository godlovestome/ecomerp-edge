import axios from "axios";
import { config } from "../../config.js";
import { spApiAuth } from "../../auth/sp-api-auth.js";
import { BaseCollector } from "../base-collector.js";
import { TokenBucketRateLimiter } from "../../utils/rate-limiter.js";
import { createChildLogger } from "../../utils/logger.js";

const log = createChildLogger("sp-inventory");

/**
 * SP-API FBA Inventory Collector.
 * Fetches FBA inventory summaries.
 * Rate limit: 2 RPS, burst: 30
 */
export class InventoryCollector extends BaseCollector {
  protected readonly apiType = "sp_api";
  protected readonly dataType = "inventory";
  protected readonly name = "SP-API Inventory";

  constructor(rateLimiter: TokenBucketRateLimiter) {
    super(rateLimiter);
  }

  protected async fetchData(params?: Record<string, any>): Promise<Record<string, any>[]> {
    const headers = await spApiAuth.getHeaders();
    const marketplaceId = params?.marketplaceId || config.spApi.marketplaceId;

    const allInventory = await this.paginatedFetch<Record<string, any>>(async (nextToken) => {
      const queryParams: Record<string, string> = {
        granularityType: "Marketplace",
        granularityId: marketplaceId,
        marketplaceIds: marketplaceId,
      };
      if (nextToken) queryParams.nextToken = nextToken;

      const response = await this.rateLimitedRequest(async () => {
        const res = await axios.get(
          `${config.spApi.endpoint}/fba/inventory/v1/summaries`,
          { headers, params: queryParams }
        );
        this.rateLimiter.updateFromHeader(res.headers["x-amzn-ratelimit-limit"]);
        return res;
      }, "getInventorySummaries");

      const payload = response.data?.payload;
      return {
        data: payload?.inventorySummaries || [],
        nextToken: payload?.pagination?.nextToken,
      };
    });

    log.info({ inventoryCount: allInventory.length }, "Inventory fetched");
    return allInventory;
  }
}
