import dotenv from "dotenv";
dotenv.config();

export const config = {
  // Core ERP connection
  core: {
    apiUrl: process.env.CORE_API_URL || "http://localhost:3000",
    edgeHostId: process.env.EDGE_HOST_ID || "",
    edgeApiKey: process.env.EDGE_API_KEY || "",
  },

  // Amazon SP-API
  spApi: {
    clientId: process.env.SP_API_CLIENT_ID || "",
    clientSecret: process.env.SP_API_CLIENT_SECRET || "",
    refreshToken: process.env.SP_API_REFRESH_TOKEN || "",
    marketplaceId: process.env.SP_API_MARKETPLACE_ID || "ATVPDKIKX0DER",
    region: process.env.SP_API_REGION || "us-east-1",
    endpoint: process.env.SP_API_ENDPOINT || "https://sellingpartnerapi-na.amazon.com",
    tokenUrl: "https://api.amazon.com/auth/o2/token",
  },

  // Amazon Advertising API
  adsApi: {
    clientId: process.env.ADS_API_CLIENT_ID || "",
    clientSecret: process.env.ADS_API_CLIENT_SECRET || "",
    refreshToken: process.env.ADS_API_REFRESH_TOKEN || "",
    profileId: process.env.ADS_API_PROFILE_ID || "",
    endpoint: process.env.ADS_API_ENDPOINT || "https://advertising-api.amazon.com",
    tokenUrl: "https://api.amazon.com/auth/o2/token",
  },

  // Sync configuration
  sync: {
    mode: (process.env.SYNC_MODE || "scheduled") as "realtime" | "scheduled" | "manual",
    cron: process.env.SYNC_CRON || "0 */6 * * *",
    heartbeatInterval: parseInt(process.env.HEARTBEAT_INTERVAL || "60", 10) * 1000,
  },

  // Logging
  logLevel: process.env.LOG_LEVEL || "info",
};
