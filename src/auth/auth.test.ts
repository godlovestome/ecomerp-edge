import { describe, expect, it, vi, beforeEach } from "vitest";
import { SpApiAuth } from "./sp-api-auth.js";
import { AdsApiAuth } from "./ads-api-auth.js";

// Mock axios
vi.mock("axios", () => ({
  default: {
    post: vi.fn(),
  },
}));

import axios from "axios";
const mockedAxios = vi.mocked(axios);

describe("SpApiAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should report not configured when credentials are empty", () => {
    const auth = new SpApiAuth("", "", "");
    expect(auth.isConfigured()).toBe(false);
  });

  it("should report configured when all credentials are set", () => {
    const auth = new SpApiAuth("client-id", "client-secret", "refresh-token");
    expect(auth.isConfigured()).toBe(true);
  });

  it("should fetch access token via LWA", async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        access_token: "test-access-token",
        refresh_token: "test-refresh-token",
        token_type: "bearer",
        expires_in: 3600,
      },
    });

    const auth = new SpApiAuth("client-id", "client-secret", "refresh-token");
    const token = await auth.getAccessToken();

    expect(token).toBe("test-access-token");
    expect(mockedAxios.post).toHaveBeenCalledWith(
      "https://api.amazon.com/auth/o2/token",
      expect.objectContaining({
        grant_type: "refresh_token",
        client_id: "client-id",
        client_secret: "client-secret",
        refresh_token: "refresh-token",
      }),
      expect.any(Object)
    );
  });

  it("should cache token and not re-fetch", async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        access_token: "cached-token",
        refresh_token: "refresh",
        token_type: "bearer",
        expires_in: 3600,
      },
    });

    const auth = new SpApiAuth("client-id", "client-secret", "refresh-token");
    const token1 = await auth.getAccessToken();
    const token2 = await auth.getAccessToken();

    expect(token1).toBe("cached-token");
    expect(token2).toBe("cached-token");
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });

  it("should return proper SP-API headers", async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        access_token: "header-token",
        refresh_token: "refresh",
        token_type: "bearer",
        expires_in: 3600,
      },
    });

    const auth = new SpApiAuth("client-id", "client-secret", "refresh-token");
    const headers = await auth.getHeaders();

    expect(headers["x-amz-access-token"]).toBe("header-token");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("should throw on auth failure", async () => {
    mockedAxios.post.mockRejectedValueOnce(new Error("Network error"));

    const auth = new SpApiAuth("client-id", "client-secret", "refresh-token");
    await expect(auth.getAccessToken()).rejects.toThrow("SP-API auth failed");
  });
});

describe("AdsApiAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should report not configured when credentials are empty", () => {
    const auth = new AdsApiAuth("", "", "", "");
    expect(auth.isConfigured()).toBe(false);
  });

  it("should report configured when all credentials are set", () => {
    const auth = new AdsApiAuth("client-id", "client-secret", "refresh-token", "profile-id");
    expect(auth.isConfigured()).toBe(true);
  });

  it("should return proper Ads API headers with profile scope", async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        access_token: "ads-token",
        refresh_token: "refresh",
        token_type: "bearer",
        expires_in: 3600,
      },
    });

    const auth = new AdsApiAuth("client-id", "client-secret", "refresh-token", "profile-123");
    const headers = await auth.getHeaders();

    expect(headers["Authorization"]).toBe("Bearer ads-token");
    expect(headers["Amazon-Advertising-API-ClientId"]).toBe("client-id");
    expect(headers["Amazon-Advertising-API-Scope"]).toBe("profile-123");
    expect(headers["Content-Type"]).toBe("application/json");
  });
});
