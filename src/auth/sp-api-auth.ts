import axios from "axios";
import { config } from "../config.js";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("sp-api-auth");

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

/**
 * SP-API Authentication using Login with Amazon (LWA).
 * Manages access token lifecycle with automatic refresh.
 */
export class SpApiAuth {
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;
  private refreshPromise: Promise<string> | null = null;

  constructor(
    private clientId: string = config.spApi.clientId,
    private clientSecret: string = config.spApi.clientSecret,
    private refreshToken: string = config.spApi.refreshToken
  ) {}

  /**
   * Get a valid access token. Automatically refreshes if expired.
   */
  async getAccessToken(): Promise<string> {
    // Return cached token if still valid (with 60s buffer)
    if (this.accessToken && Date.now() < this.tokenExpiry - 60000) {
      return this.accessToken;
    }

    // Prevent concurrent refresh requests
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.refreshAccessToken();
    try {
      const token = await this.refreshPromise;
      return token;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async refreshAccessToken(): Promise<string> {
    log.info("Refreshing SP-API access token...");

    try {
      const response = await axios.post<TokenResponse>(config.spApi.tokenUrl, {
        grant_type: "refresh_token",
        refresh_token: this.refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }, {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });

      this.accessToken = response.data.access_token;
      this.tokenExpiry = Date.now() + response.data.expires_in * 1000;

      log.info({ expiresIn: response.data.expires_in }, "SP-API access token refreshed");
      return this.accessToken;
    } catch (error: any) {
      log.error({ error: error.message }, "Failed to refresh SP-API access token");
      throw new Error(`SP-API auth failed: ${error.message}`);
    }
  }

  /**
   * Get authorization headers for SP-API requests.
   */
  async getHeaders(): Promise<Record<string, string>> {
    const token = await this.getAccessToken();
    return {
      "x-amz-access-token": token,
      "Content-Type": "application/json",
    };
  }

  isConfigured(): boolean {
    return !!(this.clientId && this.clientSecret && this.refreshToken);
  }
}

export const spApiAuth = new SpApiAuth();
