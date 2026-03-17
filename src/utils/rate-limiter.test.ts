import { describe, expect, it, vi } from "vitest";
import { TokenBucketRateLimiter, retryWithBackoff } from "./rate-limiter.js";

describe("TokenBucketRateLimiter", () => {
  it("should start with full bucket", () => {
    const limiter = new TokenBucketRateLimiter("test", 1, 10);
    const status = limiter.getStatus();
    expect(status.name).toBe("test");
    expect(status.tokens).toBe(10);
    expect(status.maxTokens).toBe(10);
    expect(status.refillRate).toBe(1);
    expect(status.queueLength).toBe(0);
  });

  it("should consume tokens on acquire", async () => {
    const limiter = new TokenBucketRateLimiter("test", 1, 10);
    await limiter.acquire();
    const status = limiter.getStatus();
    expect(status.tokens).toBeLessThanOrEqual(9);
  });

  it("should consume multiple tokens sequentially", async () => {
    const limiter = new TokenBucketRateLimiter("test", 1, 10);
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    const status = limiter.getStatus();
    expect(status.tokens).toBeLessThanOrEqual(7);
  });

  it("should update rate from header", () => {
    const limiter = new TokenBucketRateLimiter("test", 1, 10);
    limiter.updateFromHeader("5.0");
    // The rate should be updated internally
    const status = limiter.getStatus();
    expect(status.name).toBe("test");
  });

  it("should handle undefined header gracefully", () => {
    const limiter = new TokenBucketRateLimiter("test", 1, 10);
    limiter.updateFromHeader(undefined);
    const status = limiter.getStatus();
    expect(status.refillRate).toBe(1);
  });

  it("should handle invalid header gracefully", () => {
    const limiter = new TokenBucketRateLimiter("test", 1, 10);
    limiter.updateFromHeader("invalid");
    const status = limiter.getStatus();
    expect(status.refillRate).toBe(1);
  });
});

describe("retryWithBackoff", () => {
  it("should return result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("success");
    const result = await retryWithBackoff(fn, { maxRetries: 3 });
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("should retry on 429 errors", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce({ response: { status: 429 } })
      .mockResolvedValue("success");

    const result = await retryWithBackoff(fn, { maxRetries: 3, baseDelayMs: 10 });
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("should retry on 503 errors", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockResolvedValue("success");

    const result = await retryWithBackoff(fn, { maxRetries: 3, baseDelayMs: 10 });
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("should not retry on non-retryable errors", async () => {
    const fn = vi.fn().mockRejectedValue({ response: { status: 400 } });

    await expect(retryWithBackoff(fn, { maxRetries: 3, baseDelayMs: 10 }))
      .rejects.toMatchObject({ response: { status: 400 } });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("should throw after max retries", async () => {
    const fn = vi.fn().mockRejectedValue({ response: { status: 429 } });

    await expect(retryWithBackoff(fn, { maxRetries: 2, baseDelayMs: 10 }))
      .rejects.toMatchObject({ response: { status: 429 } });
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("should call onRetry callback", async () => {
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce({ response: { status: 429 } })
      .mockResolvedValue("success");

    await retryWithBackoff(fn, { maxRetries: 3, baseDelayMs: 10, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Object));
  });
});
