import axios from "axios";
import { config } from "../../config.js";
import { adsApiAuth } from "../../auth/ads-api-auth.js";
import { BaseCollector } from "../base-collector.js";
import { TokenBucketRateLimiter } from "../../utils/rate-limiter.js";
import { createChildLogger } from "../../utils/logger.js";

const log = createChildLogger("ads-campaigns");

/**
 * Amazon Ads API Campaigns Collector.
 * Fetches campaigns for Sponsored Products, Sponsored Brands, and Sponsored Display.
 * Rate limit: ~10 RPS (dynamic)
 */
export class CampaignsCollector extends BaseCollector {
  protected readonly apiType = "ads_api";
  protected readonly dataType = "campaigns";
  protected readonly name = "Ads API Campaigns";

  constructor(rateLimiter: TokenBucketRateLimiter) {
    super(rateLimiter);
  }

  protected async fetchData(params?: Record<string, any>): Promise<Record<string, any>[]> {
    const headers = await adsApiAuth.getHeaders();
    const adTypes = params?.adTypes || ["sp", "sb", "sd"];
    const allCampaigns: Record<string, any>[] = [];

    for (const adType of adTypes) {
      try {
        const campaigns = await this.fetchCampaignsByType(headers, adType);
        allCampaigns.push(...campaigns.map((c: any) => ({ ...c, adType })));
      } catch (err: any) {
        log.warn({ adType, error: err.message }, "Failed to fetch campaigns");
      }
    }

    log.info({ totalCampaigns: allCampaigns.length }, "All campaigns fetched");
    return allCampaigns;
  }

  private async fetchCampaignsByType(headers: Record<string, string>, adType: string): Promise<any[]> {
    const endpoints: Record<string, string> = {
      sp: "/sp/campaigns/list",
      sb: "/sb/v4/campaigns/list",
      sd: "/sd/campaigns/list",
    };

    const endpoint = endpoints[adType];
    if (!endpoint) return [];

    const allCampaigns = await this.paginatedFetch(async (nextToken) => {
      const body: Record<string, any> = {
        maxResults: 100,
      };
      if (nextToken) body.nextToken = nextToken;

      const response = await this.rateLimitedRequest(async () => {
        return axios.post(`${config.adsApi.endpoint}${endpoint}`, body, { headers });
      }, `listCampaigns:${adType}`);

      return {
        data: response.data?.campaigns || [],
        nextToken: response.data?.nextToken,
      };
    });

    log.info({ adType, count: allCampaigns.length }, "Campaigns fetched for ad type");
    return allCampaigns;
  }
}
