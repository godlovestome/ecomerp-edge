import axios, { AxiosInstance } from "axios";
import { config } from "../config.js";
import { createChildLogger } from "../utils/logger.js";
import { retryWithBackoff } from "../utils/rate-limiter.js";

const log = createChildLogger("core-client");

export interface PushDataPayload {
  edgeHostId: string;
  apiType: string;
  dataType: string;
  records: Record<string, any>[];
  fetchedAt: string;
  metadata?: Record<string, any>;
}

export interface SyncEventPayload {
  edgeHostId: string;
  bindingId: number;
  status: "success" | "error" | "partial";
  recordCount: number;
  errorMessage?: string;
  metadata?: Record<string, any>;
}

/**
 * HTTP client for pushing data to the Core ERP system.
 * Handles authentication with Edge API key and retry logic.
 */
export class CoreClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: config.core.apiUrl,
      timeout: 30000,
      headers: {
        "Content-Type": "application/json",
        "x-edge-host-id": config.core.edgeHostId,
        "x-edge-api-key": config.core.edgeApiKey,
      },
    });
  }

  /**
   * Push raw data records to Core ERP.
   * Uses the edgePush.push tRPC endpoint.
   */
  async pushData(payload: PushDataPayload): Promise<{ success: boolean; insertedCount: number }> {
    return retryWithBackoff(
      async () => {
        log.info(
          { apiType: payload.apiType, dataType: payload.dataType, recordCount: payload.records.length },
          "Pushing data to Core"
        );

        const response = await this.client.post("/api/trpc/edgePush.push", {
          json: {
            edgeHostId: payload.edgeHostId || config.core.edgeHostId,
            apiKey: config.core.edgeApiKey,
            apiType: payload.apiType,
            dataType: payload.dataType,
            records: payload.records,
            fetchedAt: payload.fetchedAt,
            metadata: payload.metadata,
          },
        });

        const result = response.data?.result?.data?.json;
        log.info(
          { apiType: payload.apiType, dataType: payload.dataType, insertedCount: result?.insertedCount },
          "Data pushed successfully"
        );
        return result;
      },
      {
        maxRetries: 3,
        baseDelayMs: 2000,
        onRetry: (attempt, error) => {
          log.warn({ attempt, error: error.message }, "Retrying Core push");
        },
      }
    );
  }

  /**
   * Report sync event status to Core.
   */
  async reportSyncEvent(payload: SyncEventPayload): Promise<void> {
    try {
      await this.client.post("/api/trpc/edgePush.reportStatus", {
        json: {
          edgeHostId: payload.edgeHostId || config.core.edgeHostId,
          apiKey: config.core.edgeApiKey,
          status: payload.status,
          recordCount: payload.recordCount,
          errorMessage: payload.errorMessage,
          metadata: payload.metadata,
        },
      });
    } catch (error: any) {
      log.error({ error: error.message }, "Failed to report sync event to Core");
    }
  }

  /**
   * Send heartbeat to Core to indicate this edge host is alive.
   */
  async sendHeartbeat(): Promise<void> {
    try {
      await this.client.post("/api/trpc/edgeHosts.heartbeat", {
        json: {
          edgeHostId: config.core.edgeHostId,
          apiKey: config.core.edgeApiKey,
        },
      });
      log.debug("Heartbeat sent to Core");
    } catch (error: any) {
      log.warn({ error: error.message }, "Failed to send heartbeat");
    }
  }

  /**
   * Fetch API bindings configuration from Core.
   * Tells this edge host which APIs to collect data from.
   */
  async fetchBindings(): Promise<any[]> {
    try {
      const response = await this.client.get("/api/trpc/apiBindings.listByEdgeHost", {
        params: {
          input: JSON.stringify({
            json: {
              edgeHostId: config.core.edgeHostId,
              apiKey: config.core.edgeApiKey,
            },
          }),
        },
      });
      return response.data?.result?.data?.json || [];
    } catch (error: any) {
      log.error({ error: error.message }, "Failed to fetch bindings from Core");
      return [];
    }
  }
}

export const coreClient = new CoreClient();
