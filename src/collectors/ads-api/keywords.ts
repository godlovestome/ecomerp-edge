import axios from "axios";
import { config } from "../../config.js";
import { adsApiAuth } from "../../auth/ads-api-auth.js";
import { BaseCollector } from "../base-collector.js";
import { TokenBucketRateLimiter } from "../../utils/rate-limiter.js";
import { createChildLogger } from "../../utils/logger.js";

const log = createChildLogger("ads-keywords");

/**
 * Amazon Ads API Keywords Collector.
 * Fetches keywords for SP and SB campaigns.
 * Rate limit: ~10 RPS (dynamic)
 */
export class KeywordsCollector extends BaseCollector {
  protected readonly apiType = "ads_api";
  protected readonly dataType = "keywords";
  protected readonly name = "Ads API Keywords";

  constructor(rateLimiter: TokenBucketRateLimiter) {
    super(rateLimiter);
  }

  protected async fetchData(params?: Record<string, any>): Promise<Record<string, any>[]> {
    const headers = await adsApiAuth.getHeaders();
    const adTypes = params?.adTypes || ["sp", "sb"];
    const allKeywords: Record<string, any>[] = [];

    for (const adType of adTypes) {
      try {
        const keywords = await this.fetchKeywordsByType(headers, adType);
        allKeywords.push(...keywords.map((kw: any) => ({ ...kw, adType })));
      } catch (err: any) {
        log.warn({ adType, error: err.message }, "Failed to fetch keywords");
      }
    }

    log.info({ totalKeywords: allKeywords.length }, "All keywords fetched");
    return allKeywords;
  }

  private async fetchKeywordsByType(headers: Record<string, string>, adType: string): Promise<any[]> {
    const endpoints: Record<string, string> = {
      sp: "/sp/keywords/list",
      sb: "/sb/v4/keywords/list",
    };

    const endpoint = endpoints[adType];
    if (!endpoint) return [];

    const allKeywords = await this.paginatedFetch(async (nextToken) => {
      const body: Record<string, any> = { maxResults: 100 };
      if (nextToken) body.nextToken = nextToken;

      const response = await this.rateLimitedRequest(async () => {
        return axios.post(`${config.adsApi.endpoint}${endpoint}`, body, { headers });
      }, `listKeywords:${adType}`);

      return {
        data: response.data?.keywords || [],
        nextToken: response.data?.nextToken,
      };
    });

    return allKeywords;
  }
}
