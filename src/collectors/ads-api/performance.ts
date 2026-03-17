import axios from "axios";
import { config } from "../../config.js";
import { adsApiAuth } from "../../auth/ads-api-auth.js";
import { BaseCollector } from "../base-collector.js";
import { TokenBucketRateLimiter } from "../../utils/rate-limiter.js";
import { createChildLogger } from "../../utils/logger.js";

const log = createChildLogger("ads-performance");

interface ReportConfig {
  adProduct: "SPONSORED_PRODUCTS" | "SPONSORED_BRANDS" | "SPONSORED_DISPLAY";
  groupBy: string[];
  columns: string[];
  reportTypeId: string;
  timeUnit: "SUMMARY" | "DAILY";
}

/**
 * Amazon Ads API Performance Reports Collector.
 * Uses the V3 Reporting API (async: create → poll → download).
 * Rate limit: ~5 RPS for report creation (dynamic)
 */
export class PerformanceCollector extends BaseCollector {
  protected readonly apiType = "ads_api";
  protected readonly dataType = "performance";
  protected readonly name = "Ads API Performance";

  // Default report configurations for each ad product
  private readonly reportConfigs: ReportConfig[] = [
    {
      adProduct: "SPONSORED_PRODUCTS",
      reportTypeId: "spCampaigns",
      groupBy: ["campaign"],
      columns: [
        "campaignId", "campaignName", "campaignStatus", "campaignBudgetAmount",
        "impressions", "clicks", "cost", "purchases1d", "purchases7d", "purchases14d", "purchases30d",
        "sales1d", "sales7d", "sales14d", "sales30d",
        "unitsSoldClicks1d", "unitsSoldClicks7d", "unitsSoldClicks14d", "unitsSoldClicks30d",
        "costPerClick", "clickThroughRate", "spend",
      ],
      timeUnit: "DAILY",
    },
    {
      adProduct: "SPONSORED_PRODUCTS",
      reportTypeId: "spAdvertisedProduct",
      groupBy: ["advertiser"],
      columns: [
        "campaignId", "adGroupId", "advertisedAsin", "advertisedSku",
        "impressions", "clicks", "cost", "purchases7d", "sales7d",
        "unitsSoldClicks7d", "costPerClick", "clickThroughRate",
      ],
      timeUnit: "DAILY",
    },
    {
      adProduct: "SPONSORED_BRANDS",
      reportTypeId: "sbCampaigns",
      groupBy: ["campaign"],
      columns: [
        "campaignId", "campaignName", "campaignStatus", "campaignBudgetAmount",
        "impressions", "clicks", "cost", "purchases14d", "sales14d",
        "unitsSoldClicks14d", "costPerClick", "clickThroughRate",
      ],
      timeUnit: "DAILY",
    },
    {
      adProduct: "SPONSORED_DISPLAY",
      reportTypeId: "sdCampaigns",
      groupBy: ["campaign"],
      columns: [
        "campaignId", "campaignName", "campaignStatus",
        "impressions", "clicks", "cost", "purchases14d", "sales14d",
        "unitsSoldClicks14d", "costPerClick", "clickThroughRate",
        "viewableImpressions", "viewThroughConversions14d",
      ],
      timeUnit: "DAILY",
    },
  ];

  constructor(rateLimiter: TokenBucketRateLimiter) {
    super(rateLimiter);
  }

  protected async fetchData(params?: Record<string, any>): Promise<Record<string, any>[]> {
    const headers = await adsApiAuth.getHeaders();
    const startDate = params?.startDate || this.getYesterday();
    const endDate = params?.endDate || this.getYesterday();
    const results: Record<string, any>[] = [];

    for (const reportConfig of this.reportConfigs) {
      try {
        const reportData = await this.createAndDownloadReport(headers, reportConfig, startDate, endDate);
        if (reportData) {
          results.push({
            reportType: reportConfig.reportTypeId,
            adProduct: reportConfig.adProduct,
            startDate,
            endDate,
            data: reportData,
          });
        }
      } catch (err: any) {
        log.error(
          { reportType: reportConfig.reportTypeId, error: err.message },
          "Failed to process performance report"
        );
      }
    }

    log.info({ reportCount: results.length }, "Performance reports processed");
    return results;
  }

  private async createAndDownloadReport(
    headers: Record<string, string>,
    reportConfig: ReportConfig,
    startDate: string,
    endDate: string
  ): Promise<any[] | null> {
    // Step 1: Create report
    const createBody = {
      startDate,
      endDate,
      configuration: {
        adProduct: reportConfig.adProduct,
        groupBy: reportConfig.groupBy,
        columns: reportConfig.columns,
        reportTypeId: reportConfig.reportTypeId,
        timeUnit: reportConfig.timeUnit,
        format: "GZIP_JSON",
      },
    };

    log.info({ reportType: reportConfig.reportTypeId, startDate, endDate }, "Creating ads report");

    const createResponse = await this.rateLimitedRequest(async () => {
      return axios.post(`${config.adsApi.endpoint}/reporting/reports`, createBody, { headers });
    }, `createReport:${reportConfig.reportTypeId}`);

    const reportId = createResponse.data?.reportId;
    if (!reportId) {
      log.warn({ reportType: reportConfig.reportTypeId }, "No reportId returned");
      return null;
    }

    // Step 2: Poll for completion (max 15 minutes)
    const maxPollTime = 15 * 60 * 1000;
    const pollInterval = 15000; // 15 seconds
    const startTime = Date.now();
    let downloadUrl: string | null = null;

    while (Date.now() - startTime < maxPollTime) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));

      const statusResponse = await this.rateLimitedRequest(async () => {
        return axios.get(`${config.adsApi.endpoint}/reporting/reports/${reportId}`, { headers });
      }, `getReportStatus:${reportId}`);

      const status = statusResponse.data?.status;
      log.debug({ reportId, status }, "Report status check");

      if (status === "COMPLETED") {
        downloadUrl = statusResponse.data?.url;
        break;
      } else if (status === "FAILURE") {
        log.error({ reportId, failureReason: statusResponse.data?.failureReason }, "Report failed");
        return null;
      }
    }

    if (!downloadUrl) {
      log.warn({ reportId }, "Report timed out or no download URL");
      return null;
    }

    // Step 3: Download report
    try {
      const downloadResponse = await axios.get(downloadUrl, {
        responseType: "arraybuffer",
        headers: { Accept: "application/octet-stream" },
      });

      // Decompress gzip and parse JSON
      const { gunzipSync } = await import("zlib");
      const decompressed = gunzipSync(Buffer.from(downloadResponse.data));
      const reportData = JSON.parse(decompressed.toString("utf-8"));

      log.info(
        { reportType: reportConfig.reportTypeId, recordCount: Array.isArray(reportData) ? reportData.length : 1 },
        "Report downloaded and parsed"
      );

      return Array.isArray(reportData) ? reportData : [reportData];
    } catch (err: any) {
      log.error({ reportId, error: err.message }, "Failed to download/parse report");
      return null;
    }
  }

  private getYesterday(): string {
    const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
    return d.toISOString().split("T")[0];
  }
}
