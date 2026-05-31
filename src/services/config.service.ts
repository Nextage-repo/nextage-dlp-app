// Loads DLP config from Azure Functions proxy. Caches in sessionStorage for 60min.

import { DLPConfig } from "../models/customer.model";
import { CacheService } from "../shared/cache";
import { API_BASE_URL, API_TIMEOUT_MS, CONFIG_CACHE_TTL_MS } from "../shared/constants";

const CACHE_KEY = "dlp:config";

export class ConfigService {
  private readonly cache = new CacheService();

  constructor(private readonly accessToken: string) {}

  async getConfig(): Promise<DLPConfig> {
    const cached = this.cache.get<DLPConfig>(CACHE_KEY);
    if (cached) {
      console.log("[Config] Cache hit");
      return cached;
    }

    console.log("[Config] Cache miss — fetching from API");
    const config = await this.fetchFromApi();
    this.cache.set(CACHE_KEY, config, CONFIG_CACHE_TTL_MS);
    return config;
  }

  /**
   * Force refresh from API, bypassing cache. Used by manual refresh button.
   */
  async refreshConfig(): Promise<DLPConfig> {
    this.cache.delete(CACHE_KEY);
    return this.getConfig();
  }

  private async fetchFromApi(): Promise<DLPConfig> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    try {
      const response = await fetch(`${API_BASE_URL}/config`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(
          `Config API returned ${response.status}: ${response.statusText}`,
        );
      }

      const raw = await response.json();

      // Map PostgreSQL field names → DLPConfig model field names
      const customers = Array.isArray(raw.customers)
        ? raw.customers.map((c: any) => ({
            id: String(c.id),
            partitionKey: "customers" as const,
            customerName: c.name,
            aliases: Array.isArray(c.aliases) ? c.aliases : [],
            primaryDomain: c.primary_domain || (Array.isArray(c.domains) && c.domains[0]) || "",
            additionalDomains: Array.isArray(c.domains) ? c.domains : [],
            status: "ACTIVE" as const,
            updatedAt: new Date().toISOString(),
          }))
        : [];

      const advisors = Array.isArray(raw.advisors)
        ? raw.advisors.map((a: any) => ({
            id: String(a.id),
            partitionKey: "advisors" as const,
            advisorName: a.name,
            emailDomain: a.email?.split("@")[1] || "",
            linkedCustomers: [],
            status: "ACTIVE" as const,
            updatedAt: new Date().toISOString(),
          }))
        : [];

      const exemptions = Array.isArray(raw.exemptions)
        ? raw.exemptions.map((e: any) => ({
            id: String(e.id),
            partitionKey: "exemptions" as const,
            userEmail: e.email,
            fullName: e.reason || "",
            exemptionType: "ALL_CHECKS" as const,
            scope: "ALL",
            expiryDate: null,
          }))
        : [];

      const exclusions = Array.isArray(raw.exclusions)
        ? raw.exclusions.map((ex: any) => ({
            id: String(ex.id),
            partitionKey: "exclusions" as const,
            emailAddress: null,
            domainPattern: null,
            allowUnencrypted: true,
            reason: ex.reason || ex.extension,
            expiryDate: null,
            extension: ex.extension,
          }))
        : [];

      return { customers, advisors, exemptions, exclusions };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
