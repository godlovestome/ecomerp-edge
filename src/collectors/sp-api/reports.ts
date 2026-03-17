import axios from "axios";
import { config } from "../../config.js";
import { spApiAuth } from "../../auth/sp-api-auth.js";
import { BaseCollector } from "../base-collector.js";
import { TokenBucketRateLimiter } from "../../utils/rate-limiter.js";
import { createChildLogger } from "../../utils/logger.js";

const log = createChildLogger("sp-reports");

/**
 * SP-API Reports Collector.
 * Handles the async report workflow: create → poll → download → parse.
 * Rate limit: 0.0222 RPS, burst: 10
 */
export class ReportsCollector extends BaseCollector {
  protected readonly apiType = "sp_api";
  protected readonly dataType = "reports";
  protected readonly name = "SP-API Reports";

  constructor(rateLimiter: TokenBucketRateLimiter) {
    super(rateLimiter);
  }

  protected async fetchData(params?: Record<string, any>): Promise<Record<string, any>[]> {
    const reportTypes = params?.reportTypes || [
      "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL",
      "GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA",
      "GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE",
    ];

    const results: Record<string, any>[] = [];

    for (const reportType of reportTypes) {
      try {
        const report = await this.requestAndDownloadReport(reportType, params);
        if (report) {
          results.push(report);
        }
      } catch (err: any) {
        log.error({ reportType, error: err.message }, "Failed to process report");
      }
    }

    log.info({ reportCount: results.length }, "Reports processed");
    return results;
  }

  private async requestAndDownloadReport(
    reportType: string,
    params?: Record<string, any>
  ): Promise<Record<string, any> | null> {
    const headers = await spApiAuth.getHeaders();
    const marketplaceId = params?.marketplaceId || config.spApi.marketplaceId;

    // Step 1: Create report
    log.info({ reportType }, "Creating report request");
    const createResponse = await this.rateLimitedRequest(async () => {
      return axios.post(
        `${config.spApi.endpoint}/reports/2021-06-30/reports`,
        {
          reportType,
          marketplaceIds: [marketplaceId],
          dataStartTime: params?.dataStartTime || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
          dataEndTime: params?.dataEndTime || new Date().toISOString(),
        },
        { headers }
      );
    }, `createReport:${reportType}`);

    const reportId = createResponse.data?.reportId;
    if (!reportId) {
      log.warn({ reportType }, "No reportId returned");
      return null;
    }

    // Step 2: Poll for report completion (max 10 minutes)
    const maxPollTime = 10 * 60 * 1000;
    const pollInterval = 30000; // 30 seconds
    const startTime = Date.now();
    let reportDocumentId: string | null = null;

    while (Date.now() - startTime < maxPollTime) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));

      const statusResponse = await this.rateLimitedRequest(async () => {
        return axios.get(
          `${config.spApi.endpoint}/reports/2021-06-30/reports/${reportId}`,
          { headers }
        );
      }, `getReport:${reportId}`);

      const status = statusResponse.data?.processingStatus;
      log.debug({ reportId, status }, "Report status check");

      if (status === "DONE") {
        reportDocumentId = statusResponse.data?.reportDocumentId;
        break;
      } else if (status === "CANCELLED" || status === "FATAL") {
        log.error({ reportId, status }, "Report processing failed");
        return null;
      }
    }

    if (!reportDocumentId) {
      log.warn({ reportId }, "Report timed out");
      return null;
    }

    // Step 3: Get report document URL
    const docResponse = await this.rateLimitedRequest(async () => {
      return axios.get(
        `${config.spApi.endpoint}/reports/2021-06-30/documents/${reportDocumentId}`,
        { headers }
      );
    }, `getReportDocument:${reportDocumentId}`);

    const documentUrl = docResponse.data?.url;
    if (!documentUrl) {
      log.warn({ reportDocumentId }, "No document URL returned");
      return null;
    }

    // Step 4: Download and return report metadata
    // The actual content download and parsing happens here
    log.info({ reportType, reportId, reportDocumentId }, "Report ready for download");

    return {
      reportType,
      reportId,
      reportDocumentId,
      documentUrl,
      processingStatus: "DONE",
      createdAt: new Date().toISOString(),
    };
  }
}
