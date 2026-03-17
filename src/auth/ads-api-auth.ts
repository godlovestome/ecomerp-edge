import axios from "axios";
import { config } from "../config.js";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("ads-api-auth");

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

/**
 * Amazon Advertising API Authentication.
 * Uses the same LWA OAuth flow but with Ads-specific headers.
 */
export class AdsApiAuth {
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;
  private refreshPromise: Promise<string> | null = null;

  constructor(
    private clientId: string = config.adsApi.clientId,
    private clientSecret: string = config.adsApi.clientSecret,
    private refreshToken: string = config.adsApi.refreshToken,
    private profileId: string = config.adsApi.profileId
  ) {}

  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry - 60000) {
      return this.accessToken;
    }

    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.refreshAccessToken();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async refreshAccessToken(): Promise<string> {
    log.info("Refreshing Ads API access token...");

    try {
      const response = await axios.post<TokenResponse>(config.adsApi.tokenUrl, {
        grant_type: "refresh_token",
        refresh_token: this.refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }, {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });

      this.accessToken = response.data.access_token;
      this.tokenExpiry = Date.now() + response.data.expires_in * 1000;

      log.info({ expiresIn: response.data.expires_in }, "Ads API access token refreshed");
      return this.accessToken;
    } catch (error: any) {
      log.error({ error: error.message }, "Failed to refresh Ads API access token");
      throw new Error(`Ads API auth failed: ${error.message}`);
    }
  }

  /**
   * Get authorization headers for Ads API requests.
   * Includes Amazon-Advertising-API-ClientId and Amazon-Advertising-API-Scope headers.
   */
  async getHeaders(): Promise<Record<string, string>> {
    const token = await this.getAccessToken();
    return {
      Authorization: `Bearer ${token}`,
      "Amazon-Advertising-API-ClientId": this.clientId,
      "Amazon-Advertising-API-Scope": this.profileId,
      "Content-Type": "application/json",
    };
  }

  isConfigured(): boolean {
    return !!(this.clientId && this.clientSecret && this.refreshToken && this.profileId);
  }
}

export const adsApiAuth = new AdsApiAuth();
