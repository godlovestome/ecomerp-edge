import axios from "axios";
import { config } from "../../config.js";
import { adsApiAuth } from "../../auth/ads-api-auth.js";
import { BaseCollector } from "../base-collector.js";
import { TokenBucketRateLimiter } from "../../utils/rate-limiter.js";
import { createChildLogger } from "../../utils/logger.js";

const log = createChildLogger("ads-adgroups");

/**
 * Amazon Ads API Ad Groups Collector.
 * Fetches ad groups for SP, SB, and SD campaigns.
 * Rate limit: ~10 RPS (dynamic)
 */
export class AdGroupsCollector extends BaseCollector {
  protected readonly apiType = "ads_api";
  protected readonly dataType = "ad_groups";
  protected readonly name = "Ads API Ad Groups";

  constructor(rateLimiter: TokenBucketRateLimiter) {
    super(rateLimiter);
  }

  protected async fetchData(params?: Record<string, any>): Promise<Record<string, any>[]> {
    const headers = await adsApiAuth.getHeaders();
    const adTypes = params?.adTypes || ["sp", "sb", "sd"];
    const allAdGroups: Record<string, any>[] = [];

    for (const adType of adTypes) {
      try {
        const adGroups = await this.fetchAdGroupsByType(headers, adType);
        allAdGroups.push(...adGroups.map((ag: any) => ({ ...ag, adType })));
      } catch (err: any) {
        log.warn({ adType, error: err.message }, "Failed to fetch ad groups");
      }
    }

    log.info({ totalAdGroups: allAdGroups.length }, "All ad groups fetched");
    return allAdGroups;
  }

  private async fetchAdGroupsByType(headers: Record<string, string>, adType: string): Promise<any[]> {
    const endpoints: Record<string, string> = {
      sp: "/sp/adGroups/list",
      sb: "/sb/v4/adGroups/list",
      sd: "/sd/adGroups/list",
    };

    const endpoint = endpoints[adType];
    if (!endpoint) return [];

    const allAdGroups = await this.paginatedFetch(async (nextToken) => {
      const body: Record<string, any> = { maxResults: 100 };
      if (nextToken) body.nextToken = nextToken;

      const response = await this.rateLimitedRequest(async () => {
        return axios.post(`${config.adsApi.endpoint}${endpoint}`, body, { headers });
      }, `listAdGroups:${adType}`);

      return {
        data: response.data?.adGroups || [],
        nextToken: response.data?.nextToken,
      };
    });

    return allAdGroups;
  }
}
