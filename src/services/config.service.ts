// Loads DLP config from Azure Functions proxy. Caches in sessionStorage for 60min.

import { Customer, DLPConfig, ExcludedRecipient } from "../models/customer.model";
import { CacheService } from "../shared/cache";
import {
  API_BASE_URL,
  API_TIMEOUT_MS,
  CONFIG_CACHE_TTL_MS,
  RESOLVE_CACHE_TTL_MS,
  RESOLVE_NEGATIVE_TTL_MS,
} from "../shared/constants";
import { getJson, postJsonReturning } from "../shared/http";

/** What POST /api/resolve answers for one set of recipients. */
export interface ResolvedContext {
  matchedCustomers: Customer[];
  unknownDomains: string[];
  excludedRecipients: ExcludedRecipient[];
  userExempt: boolean;
}

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

    console.log("[Config] Cache miss - fetching from API");
    const config = await this.fetchFromApi();
    this.cache.set(CACHE_KEY, config, CONFIG_CACHE_TTL_MS);
    return config;
  }

  async refreshConfig(): Promise<DLPConfig> {
    this.cache.delete(CACHE_KEY);
    return this.getConfig();
  }

  /**
   * Asks the server what these recipients imply, instead of downloading the whole
   * customer roster. Returns only matched customers, unknown domains, applicable
   * exclusions and whether the sender is exempt.
   *
   * Content-Type: text/plain keeps this a CORS "simple" request, so it skips the
   * preflight that Classic Outlook's send runtime cannot complete — the same
   * reason /api/audit uses it. Do not add other headers.
   *
   * Results are cached per recipient set for the session. Negative answers are
   * cached only briefly: caching "domain unknown" for an hour would mean a
   * customer added in the knowledge centre appears not to register until the
   * cache expires, which reads as "the system ignored my change".
   */
  async resolve(userEmail: string, recipients: string[]): Promise<ResolvedContext> {
    const key = `dlp:resolve:${userEmail}|${[...recipients].map((r) => r.toLowerCase()).sort().join(",")}`;
    const cached = this.cache.get<ResolvedContext>(key);
    if (cached) {
      console.log("[Resolve] Cache hit");
      return cached;
    }

    const raw = await postJsonReturning<any>(
      `${API_BASE_URL}/resolve`,
      { "Content-Type": "text/plain" },
      { userEmail, recipients },
      API_TIMEOUT_MS,
    );

    const resolved: ResolvedContext = {
      matchedCustomers: Array.isArray(raw.matchedCustomers)
        ? raw.matchedCustomers.map((c: any) => ({
            id: String(c.id),
            partitionKey: "customers" as const,
            customerName: c.name,
            aliases: Array.isArray(c.aliases) ? c.aliases : [],
            primaryDomain: c.primary_domain || (Array.isArray(c.domains) && c.domains[0]) || "",
            additionalDomains: Array.isArray(c.domains) ? c.domains : [],
            status: "ACTIVE" as const,
            updatedAt: new Date().toISOString(),
          }))
        : [],
      unknownDomains: Array.isArray(raw.unknownDomains) ? raw.unknownDomains : [],
      excludedRecipients: Array.isArray(raw.excludedRecipients)
        ? raw.excludedRecipients.map((x: any) => ({
            id: String(x.id ?? ""),
            email: x.email,
            scope: x.scope === "DOMAIN" ? ("DOMAIN" as const) : ("EMAIL" as const),
            // The server does not return reason/requestedBy: they are admin
            // bookkeeping shown in the panel, not inputs to any check, and leaving
            // them out keeps free text out of the unauthenticated response.
            reason: "",
            expiryDate: x.expiry_date ?? null,
            requestedBy: "",
          }))
        : [],
      userExempt: raw.userExempt === true,
    };

    // Nothing matched means the answer may go stale the moment an admin adds a
    // customer, so hold it for minutes rather than the full session.
    const ttl = resolved.matchedCustomers.length ? RESOLVE_CACHE_TTL_MS : RESOLVE_NEGATIVE_TTL_MS;
    this.cache.set(key, resolved, ttl);
    return resolved;
  }

  private async fetchFromApi(): Promise<DLPConfig> {
    // No custom headers: a bare GET is a CORS "simple request" so it skips the
    // preflight OPTIONS. Classic Outlook's JS-only (event-based) runtime cannot
    // complete a preflight, so adding Authorization/Content-Type here makes the
    // OnMessageSend config fetch fail with "Network request failed". The API does
    // not require auth (accessToken is "no-auth"), so we omit headers entirely.
    void this.accessToken;
    const raw = await getJson<any>(`${API_BASE_URL}/config`, {}, API_TIMEOUT_MS);

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
          linkedCustomers: Array.isArray(a.linked_customers) ? a.linked_customers : [],
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

    const rules = Array.isArray(raw.rules)
      ? raw.rules
          .filter((r: any) => r.active !== false)
          .map((r: any) => ({
            id: String(r.id),
            expression: r.expression ?? "",
            language: r.language ?? "",
            ruleType: r.rule_type ?? "Encryption Exemption",
            active: r.active !== false,
          }))
      : [];

    const roles = Array.isArray(raw.roles)
      ? raw.roles
          .filter((r: any) => r.active !== false)
          .map((r: any) => ({
            id: String(r.id),
            roleName: r.role_name ?? r.roleName ?? "",
            assignedEmails: Array.isArray(r.assigned_emails)
              ? r.assigned_emails
              : Array.isArray(r.assignedEmails)
                ? r.assignedEmails
                : [],
            bypassChecks: Array.isArray(r.bypass_checks)
              ? r.bypass_checks.map((n: any) => Number(n))
              : Array.isArray(r.bypassChecks)
                ? r.bypassChecks.map((n: any) => Number(n))
                : [],
            active: r.active !== false,
          }))
      : [];

    const excludedRecipients = Array.isArray(raw.excludedRecipients)
      ? raw.excludedRecipients.map((e: any) => ({
          id: String(e.id),
          email: e.email ?? "",
          scope: (e.scope ?? "EMAIL") === "DOMAIN" ? "DOMAIN" : "EMAIL",
          reason: e.reason ?? "",
          expiryDate: e.expiry_date ?? e.expiryDate ?? null,
          requestedBy: e.requested_by ?? e.requestedBy ?? "",
        }))
      : [];

    const encryptionKeywords = Array.isArray(raw.encryptionKeywords)
      ? raw.encryptionKeywords
          .filter((k: any) => k.active !== false)
          .map((k: any) => ({
            id: String(k.id),
            keyword: k.keyword ?? "",
            note: k.note ?? "",
            active: k.active !== false,
          }))
      : [];

    return { customers, advisors, exemptions, exclusions, rules, roles, excludedRecipients, encryptionKeywords };
  }
}
