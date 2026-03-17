import axios from "axios";
import { config } from "../../config.js";
import { spApiAuth } from "../../auth/sp-api-auth.js";
import { BaseCollector } from "../base-collector.js";
import { TokenBucketRateLimiter } from "../../utils/rate-limiter.js";
import { createChildLogger } from "../../utils/logger.js";

const log = createChildLogger("sp-orders");

/**
 * SP-API Orders Collector.
 * Fetches orders from the Orders API v0 endpoint.
 * Rate limit: 0.0167 RPS (1 req/min), burst: 20
 */
export class OrdersCollector extends BaseCollector {
  protected readonly apiType = "sp_api";
  protected readonly dataType = "orders";
  protected readonly name = "SP-API Orders";

  constructor(rateLimiter: TokenBucketRateLimiter) {
    super(rateLimiter);
  }

  protected async fetchData(params?: Record<string, any>): Promise<Record<string, any>[]> {
    const headers = await spApiAuth.getHeaders();
    const marketplaceId = params?.marketplaceId || config.spApi.marketplaceId;

    // Default: fetch orders from last 24 hours
    const createdAfter = params?.createdAfter || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const allOrders = await this.paginatedFetch<Record<string, any>>(async (nextToken) => {
      const queryParams: Record<string, string> = {
        MarketplaceIds: marketplaceId,
        CreatedAfter: createdAfter,
      };
      if (nextToken) queryParams.NextToken = nextToken;

      const response = await this.rateLimitedRequest(async () => {
        const res = await axios.get(`${config.spApi.endpoint}/orders/v0/orders`, {
          headers,
          params: queryParams,
        });

        // Update rate limiter from response header
        this.rateLimiter.updateFromHeader(res.headers["x-amzn-ratelimit-limit"]);
        return res;
      }, "getOrders");

      const payload = response.data?.payload;
      const orders = payload?.Orders || [];
      const token = payload?.NextToken;

      return { data: orders, nextToken: token };
    });

    log.info({ orderCount: allOrders.length, createdAfter }, "Orders fetched");

    // Fetch order items for each order
    const ordersWithItems: Record<string, any>[] = [];
    for (const order of allOrders) {
      const o = order as Record<string, any>;
      try {
        const itemsResponse = await this.rateLimitedRequest(async () => {
          return axios.get(
            `${config.spApi.endpoint}/orders/v0/orders/${o.AmazonOrderId}/orderItems`,
            { headers }
          );
        }, `getOrderItems:${o.AmazonOrderId}`);

        ordersWithItems.push({
          ...o,
          OrderItems: itemsResponse.data?.payload?.OrderItems || [],
        });
      } catch (err: any) {
        log.warn({ orderId: o.AmazonOrderId, error: err.message }, "Failed to fetch order items");
        ordersWithItems.push(o);
      }
    }

    return ordersWithItems;
  }
}
