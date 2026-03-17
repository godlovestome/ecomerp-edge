import { createChildLogger } from "../utils/logger.js";
import { TokenBucketRateLimiter, retryWithBackoff } from "../utils/rate-limiter.js";
import { coreClient } from "../push/core-client.js";

const log = createChildLogger("base-collector");

export interface CollectorResult {
  success: boolean;
  recordCount: number;
  errors: string[];
  duration: number;
}

/**
 * Base class for all data collectors.
 * Provides common functionality: rate limiting, retry, pagination, and data push.
 */
export abstract class BaseCollector {
  protected abstract readonly apiType: string;   // "sp_api" | "ads_api"
  protected abstract readonly dataType: string;  // "orders" | "finances" | etc.
  protected abstract readonly name: string;
  protected rateLimiter: TokenBucketRateLimiter;

  constructor(rateLimiter: TokenBucketRateLimiter) {
    this.rateLimiter = rateLimiter;
  }

  /**
   * Main collection method. Override in subclasses.
   * Should return an array of raw records from the API.
   */
  protected abstract fetchData(params?: Record<string, any>): Promise<Record<string, any>[]>;

  /**
   * Run the collector: fetch data, push to Core, report status.
   */
  async collect(params?: Record<string, any>): Promise<CollectorResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    let totalRecords = 0;

    log.info({ collector: this.name }, "Starting data collection");

    try {
      const records = await this.fetchData(params);
      totalRecords = records.length;

      if (records.length > 0) {
        // Push data in batches of 100 to avoid payload size limits
        const batchSize = 100;
        for (let i = 0; i < records.length; i += batchSize) {
          const batch = records.slice(i, i + batchSize);
          try {
            await coreClient.pushData({
              edgeHostId: "",
              apiType: this.apiType,
              dataType: this.dataType,
              records: batch,
              fetchedAt: new Date().toISOString(),
              metadata: {
                batchIndex: Math.floor(i / batchSize),
                totalBatches: Math.ceil(records.length / batchSize),
                collector: this.name,
              },
            });
          } catch (err: any) {
            errors.push(`Batch ${Math.floor(i / batchSize)} push failed: ${err.message}`);
            log.error({ error: err.message, batch: Math.floor(i / batchSize) }, "Batch push failed");
          }
        }
      }

      const duration = Date.now() - startTime;
      log.info(
        { collector: this.name, records: totalRecords, duration, errors: errors.length },
        "Collection completed"
      );

      return { success: errors.length === 0, recordCount: totalRecords, errors, duration };
    } catch (error: any) {
      const duration = Date.now() - startTime;
      errors.push(error.message);
      log.error({ collector: this.name, error: error.message, duration }, "Collection failed");

      return { success: false, recordCount: totalRecords, errors, duration };
    }
  }

  /**
   * Helper to make a rate-limited API request with retry.
   */
  protected async rateLimitedRequest<T>(
    requestFn: () => Promise<T>,
    context?: string
  ): Promise<T> {
    await this.rateLimiter.acquire();

    return retryWithBackoff(requestFn, {
      maxRetries: 3,
      baseDelayMs: 1000,
      onRetry: (attempt, error) => {
        log.warn(
          { collector: this.name, context, attempt, error: error.message },
          "Retrying API request"
        );
      },
    });
  }

  /**
   * Helper for paginated API calls.
   * Keeps fetching until no more pages are available.
   */
  protected async paginatedFetch<T>(
    fetchPage: (nextToken?: string) => Promise<{ data: T[]; nextToken?: string }>,
    maxPages: number = 100
  ): Promise<T[]> {
    const allData: T[] = [];
    let nextToken: string | undefined;
    let pageCount = 0;

    do {
      const result = await fetchPage(nextToken);
      allData.push(...result.data);
      nextToken = result.nextToken;
      pageCount++;

      if (pageCount >= maxPages) {
        log.warn({ collector: this.name, maxPages }, "Max pages reached, stopping pagination");
        break;
      }
    } while (nextToken);

    return allData;
  }
}
