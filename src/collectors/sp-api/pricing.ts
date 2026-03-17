import axios from "axios";
import { config } from "../../config.js";
import { spApiAuth } from "../../auth/sp-api-auth.js";
import { BaseCollector } from "../base-collector.js";
import { TokenBucketRateLimiter } from "../../utils/rate-limiter.js";
import { createChildLogger } from "../../utils/logger.js";

const log = createChildLogger("sp-pricing");

/**
 * SP-API Product Pricing Collector.
 * Fetches competitive pricing data.
 * Rate limit: 0.5 RPS, burst: 1 (very restrictive!)
 */
export class PricingCollector extends BaseCollector {
  protected readonly apiType = "sp_api";
  protected readonly dataType = "pricing";
  protected readonly name = "SP-API Pricing";

  constructor(rateLimiter: TokenBucketRateLimiter) {
    super(rateLimiter);
  }

  protected async fetchData(params?: Record<string, any>): Promise<Record<string, any>[]> {
    const headers = await spApiAuth.getHeaders();
    const marketplaceId = params?.marketplaceId || config.spApi.marketplaceId;
    const asins: string[] = params?.asins || [];

    if (asins.length === 0) {
      log.info("No ASINs provided for pricing fetch");
      return [];
    }

    // Pricing API accepts up to 20 ASINs per request
    const pricingData: Record<string, any>[] = [];
    const batchSize = 20;

    for (let i = 0; i < asins.length; i += batchSize) {
      const batch = asins.slice(i, i + batchSize);

      try {
        const response = await this.rateLimitedRequest(async () => {
          const res = await axios.get(
            `${config.spApi.endpoint}/products/pricing/v0/competitivePrice`,
            {
              headers,
              params: {
                MarketplaceId: marketplaceId,
                ItemType: "Asin",
                Asins: batch.join(","),
              },
            }
          );
          this.rateLimiter.updateFromHeader(res.headers["x-amzn-ratelimit-limit"]);
          return res;
        }, `getCompetitivePricing:batch${Math.floor(i / batchSize)}`);

        const prices = response.data?.payload || [];
        pricingData.push(...prices);
      } catch (err: any) {
        log.warn({ batchIndex: Math.floor(i / batchSize), error: err.message }, "Failed to fetch pricing batch");
      }
    }

    log.info({ pricingCount: pricingData.length }, "Pricing data fetched");
    return pricingData;
  }
}
