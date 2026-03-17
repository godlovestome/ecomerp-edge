import axios from "axios";
import { config } from "../../config.js";
import { spApiAuth } from "../../auth/sp-api-auth.js";
import { BaseCollector } from "../base-collector.js";
import { TokenBucketRateLimiter } from "../../utils/rate-limiter.js";
import { createChildLogger } from "../../utils/logger.js";

const log = createChildLogger("sp-catalog");

/**
 * SP-API Catalog Items Collector.
 * Fetches catalog item details for known ASINs.
 * Rate limit: 5 RPS, burst: 40
 */
export class CatalogCollector extends BaseCollector {
  protected readonly apiType = "sp_api";
  protected readonly dataType = "catalog";
  protected readonly name = "SP-API Catalog";

  constructor(rateLimiter: TokenBucketRateLimiter) {
    super(rateLimiter);
  }

  protected async fetchData(params?: Record<string, any>): Promise<Record<string, any>[]> {
    const headers = await spApiAuth.getHeaders();
    const marketplaceId = params?.marketplaceId || config.spApi.marketplaceId;
    const asins: string[] = params?.asins || [];

    if (asins.length === 0) {
      log.info("No ASINs provided for catalog fetch, using search");
      return this.searchCatalog(headers, marketplaceId, params?.keywords || []);
    }

    const catalogItems: Record<string, any>[] = [];
    for (const asin of asins) {
      try {
        const response = await this.rateLimitedRequest(async () => {
          const res = await axios.get(
            `${config.spApi.endpoint}/catalog/2022-04-01/items/${asin}`,
            {
              headers,
              params: {
                marketplaceIds: marketplaceId,
                includedData: "attributes,dimensions,identifiers,images,productTypes,salesRanks,summaries",
              },
            }
          );
          this.rateLimiter.updateFromHeader(res.headers["x-amzn-ratelimit-limit"]);
          return res;
        }, `getCatalogItem:${asin}`);

        catalogItems.push(response.data);
      } catch (err: any) {
        log.warn({ asin, error: err.message }, "Failed to fetch catalog item");
      }
    }

    log.info({ itemCount: catalogItems.length }, "Catalog items fetched");
    return catalogItems;
  }

  private async searchCatalog(
    headers: Record<string, string>,
    marketplaceId: string,
    keywords: string[]
  ): Promise<Record<string, any>[]> {
    if (keywords.length === 0) return [];

    const allItems = await this.paginatedFetch<Record<string, any>>(async (nextToken) => {
      const queryParams: Record<string, string> = {
        marketplaceIds: marketplaceId,
        keywords: keywords.join(","),
        includedData: "attributes,dimensions,identifiers,images,productTypes,salesRanks,summaries",
      };
      if (nextToken) queryParams.pageToken = nextToken;

      const response = await this.rateLimitedRequest(async () => {
        const res = await axios.get(
          `${config.spApi.endpoint}/catalog/2022-04-01/items`,
          { headers, params: queryParams }
        );
        this.rateLimiter.updateFromHeader(res.headers["x-amzn-ratelimit-limit"]);
        return res;
      }, "searchCatalogItems");

      return {
        data: response.data?.items || [],
        nextToken: response.data?.pagination?.nextToken,
      };
    });

    return allItems;
  }
}
