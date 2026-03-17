import axios from "axios";
import { config } from "../../config.js";
import { spApiAuth } from "../../auth/sp-api-auth.js";
import { BaseCollector } from "../base-collector.js";
import { TokenBucketRateLimiter } from "../../utils/rate-limiter.js";
import { createChildLogger } from "../../utils/logger.js";

const log = createChildLogger("sp-finances");

/**
 * SP-API Finances Collector.
 * Fetches financial event groups and financial events.
 * Rate limit: 0.5 RPS, burst: 30
 */
export class FinancesCollector extends BaseCollector {
  protected readonly apiType = "sp_api";
  protected readonly dataType = "finances";
  protected readonly name = "SP-API Finances";

  constructor(rateLimiter: TokenBucketRateLimiter) {
    super(rateLimiter);
  }

  protected async fetchData(params?: Record<string, any>): Promise<Record<string, any>[]> {
    const headers = await spApiAuth.getHeaders();
    const postedAfter = params?.postedAfter || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // First, fetch financial event groups
    const eventGroups = await this.paginatedFetch<Record<string, any>>(async (nextToken) => {
      const queryParams: Record<string, string> = {
        FinancialEventGroupStartedAfter: postedAfter,
      };
      if (nextToken) queryParams.NextToken = nextToken;

      const response = await this.rateLimitedRequest(async () => {
        const res = await axios.get(
          `${config.spApi.endpoint}/finances/v0/financialEventGroups`,
          { headers, params: queryParams }
        );
        this.rateLimiter.updateFromHeader(res.headers["x-amzn-ratelimit-limit"]);
        return res;
      }, "listFinancialEventGroups");

      const payload = response.data?.payload;
      return {
        data: payload?.FinancialEventGroupList || [],
        nextToken: payload?.NextToken,
      };
    });

    // Then, fetch detailed financial events for each group
    const allEvents: Record<string, any>[] = [];
    for (const group of eventGroups as Record<string, any>[]) {
      try {
        const events = await this.paginatedFetch(async (nextToken) => {
          const queryParams: Record<string, string> = {};
          if (nextToken) queryParams.NextToken = nextToken;

          const response = await this.rateLimitedRequest(async () => {
            return axios.get(
              `${config.spApi.endpoint}/finances/v0/financialEventGroups/${group.FinancialEventGroupId}/financialEvents`,
              { headers, params: queryParams }
            );
          }, `listFinancialEvents:${group.FinancialEventGroupId}`);

          const payload = response.data?.payload;
          return {
            data: payload?.FinancialEvents ? [payload.FinancialEvents] : [],
            nextToken: payload?.NextToken,
          };
        });

        allEvents.push({
          eventGroup: group,
          financialEvents: events,
        });
      } catch (err: any) {
        log.warn({ groupId: group.FinancialEventGroupId, error: err.message }, "Failed to fetch financial events");
        allEvents.push({ eventGroup: group, financialEvents: [] });
      }
    }

    log.info({ groupCount: eventGroups.length, eventCount: allEvents.length }, "Finances fetched");
    return allEvents;
  }
}
