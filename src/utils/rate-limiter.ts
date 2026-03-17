import { createChildLogger } from "./logger.js";

const log = createChildLogger("rate-limiter");

/**
 * Token Bucket Rate Limiter
 * Implements the same algorithm Amazon uses for SP-API rate limiting.
 * Tokens replenish at a fixed rate up to a maximum burst capacity.
 */
export class TokenBucketRateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per second
  private readonly name: string;
  private queue: Array<{ resolve: () => void; timestamp: number }> = [];
  private processing = false;

  constructor(name: string, ratePerSecond: number, burstCapacity: number) {
    this.name = name;
    this.maxTokens = burstCapacity;
    this.refillRate = ratePerSecond;
    this.tokens = burstCapacity; // Start with full bucket
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    const newTokens = elapsed * this.refillRate;
    this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
    this.lastRefill = now;
  }

  /**
   * Acquire a token. Waits if no tokens are available.
   * Returns a promise that resolves when a token is acquired.
   */
  async acquire(): Promise<void> {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    // No tokens available, queue the request
    return new Promise<void>((resolve) => {
      this.queue.push({ resolve, timestamp: Date.now() });
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      this.refill();

      if (this.tokens >= 1) {
        this.tokens -= 1;
        const item = this.queue.shift();
        if (item) item.resolve();
      } else {
        // Wait until at least one token is available
        const waitMs = Math.ceil((1 / this.refillRate) * 1000);
        await sleep(waitMs);
      }
    }

    this.processing = false;
  }

  /**
   * Update rate limits dynamically based on API response headers.
   * Amazon returns x-amzn-RateLimit-Limit header with current limits.
   */
  updateFromHeader(rateLimitHeader: string | undefined): void {
    if (!rateLimitHeader) return;
    const newRate = parseFloat(rateLimitHeader);
    if (!isNaN(newRate) && newRate > 0) {
      (this as any).refillRate = newRate;
      log.debug({ limiter: this.name, newRate }, "Rate limit updated from header");
    }
  }

  getStatus(): { name: string; tokens: number; maxTokens: number; refillRate: number; queueLength: number } {
    this.refill();
    return {
      name: this.name,
      tokens: Math.floor(this.tokens),
      maxTokens: this.maxTokens,
      refillRate: this.refillRate,
      queueLength: this.queue.length,
    };
  }
}

/**
 * Exponential backoff with jitter for 429 retries.
 * Amazon recommends this approach for handling throttled requests.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    onRetry?: (attempt: number, error: any) => void;
  } = {}
): Promise<T> {
  const { maxRetries = 5, baseDelayMs = 1000, maxDelayMs = 60000, onRetry } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const statusCode = error?.response?.status || error?.status;

      if (attempt === maxRetries || (statusCode && statusCode !== 429 && statusCode !== 503)) {
        throw error;
      }

      // Exponential backoff with full jitter
      const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
      const jitter = Math.random() * exponentialDelay;
      const delay = Math.min(jitter, maxDelayMs);

      if (onRetry) {
        onRetry(attempt + 1, error);
      }

      log.warn(
        { attempt: attempt + 1, maxRetries, delayMs: Math.round(delay), statusCode },
        "Request throttled, retrying with backoff"
      );

      await sleep(delay);
    }
  }

  throw new Error("Max retries exceeded");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pre-configured rate limiters for Amazon APIs.
 * Uses conservative defaults (50% of published limits) to avoid throttling.
 */
export const SP_API_RATE_LIMITS = {
  orders: { rate: 0.0167, burst: 20 },       // ~1 req/min sustained
  finances: { rate: 0.5, burst: 30 },
  inventory: { rate: 2, burst: 30 },
  catalog: { rate: 5, burst: 40 },
  pricing: { rate: 0.5, burst: 1 },
  sales: { rate: 0.5, burst: 15 },
  reports: { rate: 0.0222, burst: 10 },
} as const;

export const ADS_API_RATE_LIMITS = {
  campaigns: { rate: 10, burst: 20 },
  adGroups: { rate: 10, burst: 20 },
  keywords: { rate: 10, burst: 20 },
  targets: { rate: 10, burst: 20 },
  reporting: { rate: 5, burst: 10 },
} as const;

// Create rate limiters with conservative defaults (50% of published limits)
export function createSpApiLimiters() {
  return {
    orders: new TokenBucketRateLimiter("sp-orders", SP_API_RATE_LIMITS.orders.rate * 0.5, SP_API_RATE_LIMITS.orders.burst),
    finances: new TokenBucketRateLimiter("sp-finances", SP_API_RATE_LIMITS.finances.rate * 0.5, SP_API_RATE_LIMITS.finances.burst),
    inventory: new TokenBucketRateLimiter("sp-inventory", SP_API_RATE_LIMITS.inventory.rate * 0.5, SP_API_RATE_LIMITS.inventory.burst),
    catalog: new TokenBucketRateLimiter("sp-catalog", SP_API_RATE_LIMITS.catalog.rate * 0.5, SP_API_RATE_LIMITS.catalog.burst),
    pricing: new TokenBucketRateLimiter("sp-pricing", SP_API_RATE_LIMITS.pricing.rate * 0.5, SP_API_RATE_LIMITS.pricing.burst),
    sales: new TokenBucketRateLimiter("sp-sales", SP_API_RATE_LIMITS.sales.rate * 0.5, SP_API_RATE_LIMITS.sales.burst),
    reports: new TokenBucketRateLimiter("sp-reports", SP_API_RATE_LIMITS.reports.rate * 0.5, SP_API_RATE_LIMITS.reports.burst),
  };
}

export function createAdsApiLimiters() {
  return {
    campaigns: new TokenBucketRateLimiter("ads-campaigns", ADS_API_RATE_LIMITS.campaigns.rate * 0.5, ADS_API_RATE_LIMITS.campaigns.burst),
    adGroups: new TokenBucketRateLimiter("ads-adGroups", ADS_API_RATE_LIMITS.adGroups.rate * 0.5, ADS_API_RATE_LIMITS.adGroups.burst),
    keywords: new TokenBucketRateLimiter("ads-keywords", ADS_API_RATE_LIMITS.keywords.rate * 0.5, ADS_API_RATE_LIMITS.keywords.burst),
    targets: new TokenBucketRateLimiter("ads-targets", ADS_API_RATE_LIMITS.targets.rate * 0.5, ADS_API_RATE_LIMITS.targets.burst),
    reporting: new TokenBucketRateLimiter("ads-reporting", ADS_API_RATE_LIMITS.reporting.rate * 0.5, ADS_API_RATE_LIMITS.reporting.burst),
  };
}
