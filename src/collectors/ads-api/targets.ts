import axios from "axios";
import { config } from "../../config.js";
import { adsApiAuth } from "../../auth/ads-api-auth.js";
import { BaseCollector } from "../base-collector.js";
import { TokenBucketRateLimiter } from "../../utils/rate-limiter.js";
import { createChildLogger } from "../../utils/logger.js";

const log = createChildLogger("ads-targets");

/**
 * Amazon Ads API Targets Collector.
 * Fetches product/audience targets for SP, SB, and SD campaigns.
 * Rate limit: ~10 RPS (dynamic)
 */
export class TargetsCollector extends BaseCollector {
  protected readonly apiType = "ads_api";
  protected readonly dataType = "targets";
  protected readonly name = "Ads API Targets";

  constructor(rateLimiter: TokenBucketRateLimiter) {
    super(rateLimiter);
  }

  protected async fetchData(params?: Record<string, any>): Promise<Record<string, any>[]> {
    const headers = await adsApiAuth.getHeaders();
    const adTypes = params?.adTypes || ["sp", "sb", "sd"];
    const allTargets: Record<string, any>[] = [];

    for (const adType of adTypes) {
      try {
        const targets = await this.fetchTargetsByType(headers, adType);
        allTargets.push(...targets.map((t: any) => ({ ...t, adType })));
      } catch (err: any) {
        log.warn({ adType, error: err.message }, "Failed to fetch targets");
      }
    }

    log.info({ totalTargets: allTargets.length }, "All targets fetched");
    return allTargets;
  }

  private async fetchTargetsByType(headers: Record<string, string>, adType: string): Promise<any[]> {
    const endpoints: Record<string, string> = {
      sp: "/sp/targets/list",
      sb: "/sb/v4/targets/list",
      sd: "/sd/targets/list",
    };

    const endpoint = endpoints[adType];
    if (!endpoint) return [];

    const allTargets = await this.paginatedFetch(async (nextToken) => {
      const body: Record<string, any> = { maxResults: 100 };
      if (nextToken) body.nextToken = nextToken;

      const response = await this.rateLimitedRequest(async () => {
        return axios.post(`${config.adsApi.endpoint}${endpoint}`, body, { headers });
      }, `listTargets:${adType}`);

      return {
        data: response.data?.targetingClauses || response.data?.targets || [],
        nextToken: response.data?.nextToken,
      };
    });

    return allTargets;
  }
}
