// commands.ts — OnMessageSend handler (Production active blocking)
// Runs in Shared Runtime. Invoked automatically by Office.js when user clicks Send.
// Office.js Mailbox API 1.14 required.

import { DLPConfig } from "../models/customer.model";
import { DLPResult, EmailData, RecipientInfo } from "../models/dlp-result.model";
import { AuditService } from "../services/audit.service";
import { authService } from "../services/auth.service";
import { ConfigService, ResolvedContext } from "../services/config.service";
import {
  RESOLVE_CACHE_TTL_MS,
  RESOLVE_NEGATIVE_TTL_MS,
  SAFE_MODE,
} from "../shared/constants";
import { isInternalOnly, splitRecipients } from "../shared/recipients";
import { DLPValidator } from "../validators/validators";
import { readAttachmentsWithHeaders } from "./attachment-reader";

// In-memory config cache for the JS-only runtime (no sessionStorage available there).
// Persists for the lifetime of the Outlook session — avoids an API round-trip on every send.
let cachedConfig: DLPConfig | null = null;

async function getConfigCached(): Promise<DLPConfig> {
  if (cachedConfig) {
    console.log("[OnSend] In-memory config cache hit");
    return cachedConfig;
  }
  const token = await authService.getTokenSilent();
  const configService = new ConfigService(token);
  const config = await configService.getConfig();
  cachedConfig = config;
  return config;
}

// Recipient-scoped answers from POST /api/resolve, memoised in memory for the same
// reason as cachedConfig: this runtime has no sessionStorage, so ConfigService's own
// CacheService silently misses on every call here.
//
// Keyed by sender + recipient set. An answer that matched a customer is held for the
// same hour the config cache uses; an answer that matched nothing is held for
// minutes, so a customer added in the knowledge centre starts being recognised
// quickly instead of looking as though the change was ignored.
const resolveMemo = new Map<string, { value: ResolvedContext; expiresAt: number }>();

async function resolveCached(userEmail: string, recipients: string[]): Promise<ResolvedContext> {
  const key = `${userEmail}|${recipients.map((r) => r.toLowerCase()).sort().join(",")}`;
  const hit = resolveMemo.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    console.log("[OnSend] In-memory resolve cache hit");
    return hit.value;
  }

  const token = await authService.getTokenSilent();
  const value = await new ConfigService(token).resolve(userEmail, recipients);
  const ttl = value.matchedCustomers.length ? RESOLVE_CACHE_TTL_MS : RESOLVE_NEGATIVE_TTL_MS;
  resolveMemo.set(key, { value, expiresAt: Date.now() + ttl });
  return value;
}

// Single place where resolve is combined with the checks, used by the send handler,
// the compose InfoBar and the task pane. On failure checks 2-3 are reported as
// unavailable rather than silently passing; `onResolveFailure` lets the send path
// additionally record the enforcement failure the Azure alert watches for.
async function runChecksWithResolve(
  config: DLPConfig,
  emailData: EmailData,
  onResolveFailure?: (err: unknown) => Promise<void>,
): Promise<DLPResult> {
  let resolved: ResolvedContext | null = null;
  try {
    resolved = await resolveCached(emailData.userEmail, emailData.recipients);
  } catch (err) {
    console.warn("[DLP] resolve failed — checks 2-3 unavailable:", err);
    if (onResolveFailure) await onResolveFailure(err);
  }

  const validator = resolved
    ? new DLPValidator(
        {
          ...config,
          customers: resolved.matchedCustomers,
          excludedRecipients: resolved.excludedRecipients,
          // /api/config no longer ships the exemption list — it named the addresses
          // that bypass DLP. The server reports only whether THIS sender is exempt,
          // so rebuild the single row the checks look for. Without this an exempt
          // user would silently lose their exemption.
          exemptions: resolved.userExempt
            ? [
                {
                  id: "resolved",
                  partitionKey: "exemptions" as const,
                  userEmail: emailData.userEmail,
                  fullName: "",
                  exemptionType: "ALL_CHECKS" as const,
                  scope: "ALL",
                  expiryDate: null,
                },
              ]
            : [],
        },
        { unknownDomains: resolved.unknownDomains },
      )
    : new DLPValidator(config, { degraded: true });

  return validator.runAllChecks(emailData);
}

// Register handlers under BOTH names — older manifests reference `onMessageSend`,
// newer ones use `onMessageSendHandler`. Registering both keeps us compatible.
function registerCommands(): void {
  Office.actions.associate("onMessageSendHandler", onMessageSendHandler);
  Office.actions.associate("onMessageSend", onMessageSendHandler);
  Office.actions.associate("onNewComposeHandler", onNewComposeHandler);
  console.log("[Commands] LaunchEvent handlers registered");
}

// CLASSIC Outlook on Windows runs the send event in a JavaScript-only runtime where
// Office.onReady's callback may NOT fire before the event arrives. If we only
// registered inside Office.onReady, the handler would be missing and Outlook would
// report the add-in as "unavailable". So we register at the TOP LEVEL immediately —
// in the JS-only runtime, Office is already injected when this file executes.
if (typeof Office !== "undefined" && typeof Office.actions !== "undefined") {
  registerCommands();
}

// HTML runtimes (web, new Outlook, Mac): also register once Office.js is initialized.
if (typeof Office !== "undefined" && typeof Office.onReady === "function") {
  Office.onReady(() => registerCommands());
}

/**
 * Runs automatically when user opens a new compose window.
 * Triggers DLP checks and adds InfoBar warnings, without requiring the user
 * to manually click the DLP Guard button.
 */
async function onNewComposeHandler(event: Office.AddinCommands.Event): Promise<void> {
  console.log("[OnNewCompose] === Invoked ===");
  try {
    const token = await authService.getTokenSilent();
    const configService = new ConfigService(token);
    const config = await configService.getConfig();
    const emailData = await getEmailData();

    // Same resolve step as the send path. Without it, once /api/config stops
    // shipping the roster this compose-time InfoBar would call every external
    // recipient an unknown domain.
    const result = await runChecksWithResolve(config, emailData);

    // Add InfoBar notifications on the email — visible at the top.
    await addInfoBarNotifications(result);
  } catch (err) {
    console.error("[OnNewCompose] error:", err);
  } finally {
    event.completed();
  }
}

async function addInfoBarNotifications(result: { results: { severity: string; isValid: boolean; message: string }[] }): Promise<void> {
  const item = Office.context.mailbox.item as Office.MessageCompose;
  if (!item?.notificationMessages) return;

  const keys = ["dlp_check1", "dlp_check2", "dlp_check3"];
  await Promise.all(
    result.results.map((r, idx) => {
      const key = keys[idx]!;
      if (r.severity === "INFO" || r.isValid) {
        return new Promise<void>((resolve) =>
          item.notificationMessages.removeAsync(key, () => resolve()),
        );
      }
      const type =
        r.severity === "BLOCK"
          ? Office.MailboxEnums.ItemNotificationMessageType.ErrorMessage
          : Office.MailboxEnums.ItemNotificationMessageType.InformationalMessage;
      const prefix = r.severity === "BLOCK" ? "❌ חסום DLP: " : "⚠️ DLP: ";
      const message = (prefix + r.message).substring(0, 150);

      return new Promise<void>((resolve) =>
        item.notificationMessages.replaceAsync(
          key,
          { type, message, icon: "Icon.16x16", persistent: r.severity === "BLOCK" },
          () => resolve(),
        ),
      );
    }),
  );
}

// Expose handler globally so V1_0 ItemSend event (Outlook Classic) can find it.
// The legacy <Event Type="ItemSend" FunctionName="onMessageSendHandler"/> looks
// for a global function with this exact name.
(globalThis as any).onMessageSendHandler = onMessageSendHandler;
if (typeof window !== "undefined") {
  (window as any).onMessageSendHandler = onMessageSendHandler;
}

async function onMessageSendHandler(event: Office.AddinCommands.Event): Promise<void> {
  console.log("[OnSend] === Invoked ===");

  let partialEmail: Partial<EmailData> | undefined;

  try {
    // Fast-path: if every recipient is internal, skip all DLP checks and allow immediately.
    // Internal emails do not require encryption, filename, or subject checks.
    // An internal distribution group counts as internal even though it has no SMTP
    // address of its own — see shared/recipients.ts.
    if (isInternalOnly(splitRecipients(await getAllRecipientEntries()))) {
      console.log("[OnSend] All recipients internal — allowing send");
      event.completed({ allowEvent: true });
      return;
    }

    // Load config (in-memory cached after first call)
    const config = await getConfigCached();

    // Read full email data
    const emailData = await getEmailData();
    partialEmail = emailData;

    // Recipient-scoped data now comes from the server: /api/config no longer needs
    // to hand out the whole customer roster. A failure here is not fatal — check 1
    // (encryption) runs from the cached global lists and still blocks — but checks 2
    // and 3 cannot run, so the user is warned rather than left to assume they passed.
    const result = await runChecksWithResolve(config, emailData, async () => {
      // Record the enforcement failure the Azure alert on
      // DLP_ENFORCEMENT_FAILED_OPEN watches for. Bounded so it cannot hold the send.
      await withTimeout(
        authService
          .getTokenSilent()
          .then((t) => new AuditService(t).recordUnavailable("resolve-unavailable", emailData))
          .catch((e) => console.warn("[OnSend] resolve-unavailable audit failed:", e)),
        AUDIT_FLUSH_MS,
      );
    });

    // Audit log — MUST be awaited before event.completed(). In Classic Outlook's
    // JS-only send runtime the process is torn down once event.completed() fires,
    // which killed the previous fire-and-forget POST (no entries were persisted).
    // flushAudit swallows errors and is time-bounded so it never blocks the send.
    await flushAudit(emailData, result);

    if (result.shouldBlock) {
      console.log("[OnSend] BLOCKING send");
      const issueMessages = result.results
        .filter((r) => r.severity === "BLOCK")
        .map((r) => r.message)
        .join("\n");
      const fullMessage = `DLP חוסם את השליחה:\n${issueMessages}`;

      try {
        const item = Office.context.mailbox.item as Office.MessageCompose;
        await new Promise<void>((resolve) => {
          item.notificationMessages.replaceAsync(
            "dlpBlock",
            {
              type: Office.MailboxEnums.ItemNotificationMessageType.ErrorMessage,
              message: fullMessage.substring(0, 150),
            },
            () => resolve(),
          );
        });
      } catch (notifyErr) {
        console.warn("[OnSend] Could not set notification message:", notifyErr);
      }

      event.completed({
        allowEvent: false,
        errorMessage: fullMessage,
        cancelLabel: "תקן את הבעיות",
      } as Office.SmartAlertsEventCompletedOptions);
      return;
    }

    if (result.hasBlock && SAFE_MODE) {
      console.log("[OnSend] Safe Mode — would-block detected, allowing send");
    }

    // Warnings (no hard block): show a soft prompt with "Send Anyway" / "Don't Send".
    // sendModeOverride="promptUser" needs Mailbox 1.14; on older clients we don't
    // hard-block a warning — we allow the send (the DLP panel still shows it).
    const warnings = result.results.filter((r) => r.severity === "WARNING" && !r.isValid);
    if (warnings.length > 0) {
      const warnMessage = `אזהרת DLP:\n${warnings.map((r) => r.message).join("\n")}`;
      const supportsPrompt =
        !!Office.context?.requirements?.isSetSupported?.("Mailbox", "1.14");
      if (supportsPrompt) {
        console.log("[OnSend] WARNING — prompting user (Send Anyway / Don't Send)");
        event.completed({
          allowEvent: false,
          errorMessage: warnMessage,
          sendModeOverride: "promptUser",
        } as Office.SmartAlertsEventCompletedOptions);
      } else {
        console.log("[OnSend] WARNING — client lacks 1.14 promptUser; allowing send");
        event.completed({ allowEvent: true });
      }
      return;
    }

    console.log("[OnSend] ALLOWING send");
    event.completed({ allowEvent: true });
  } catch (err: unknown) {
    console.error("[OnSend] Critical error — failing open:", err);
    const reason = err instanceof Error ? err.message : "unknown error";
    // Awaited (bounded) so the record survives the runtime teardown; never rethrows.
    await withTimeout(
      authService
        .getTokenSilent()
        .then((t) => new AuditService(t).recordUnavailable(reason, partialEmail))
        .catch((e) => console.warn("[OnSend] unavailable audit failed:", e)),
      AUDIT_FLUSH_MS,
    );
    event.completed({ allowEvent: true });
  }
}

// Max time the send will wait for audit writes. Audit normally completes in well
// under a second; this cap ensures a slow/down audit endpoint can never hold up a
// user's send. If it elapses, the send proceeds and that entry is simply lost.
const AUDIT_FLUSH_MS = 3000;

function withTimeout(p: Promise<unknown>, ms: number): Promise<void> {
  return Promise.race([
    p.then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ]);
}

// Writes all audit entries for this send and awaits their POSTs. Never throws.
async function flushAudit(emailData: EmailData, result: DLPResult): Promise<void> {
  const work = (async () => {
    const token = await authService.getTokenSilent();
    const audit = new AuditService(token);
    const jobs: Promise<void>[] = [audit.writeAudit(emailData, result)];

    // Log "חוקים" encryption exemption if the subject matched a rule.
    const exemption = result.results.find(
      (r) =>
        r.check === 1 &&
        !!(r.details as { encryptionExemptExpression?: string })?.encryptionExemptExpression,
    );
    if (exemption) {
      const expr = (exemption.details as { encryptionExemptExpression?: string })
        .encryptionExemptExpression!;
      jobs.push(audit.recordExemption(emailData, expr));
    }
    await Promise.allSettled(jobs);
  })().catch((e) => console.warn("[OnSend] audit flush failed:", e));

  await withTimeout(work, AUDIT_FLUSH_MS);
}

// ============================================================================
// Email data retrieval (Office.js)
// ============================================================================

async function getEmailData(): Promise<EmailData> {
  const item = Office.context.mailbox.item as Office.MessageCompose;
  const userEmail = Office.context.mailbox.userProfile.emailAddress;

  const [subject, to, cc, bcc, attachments] = await Promise.all([
    getSubject(item),
    getRecipients(item.to),
    getRecipients(item.cc),
    getRecipients(item.bcc),
    readAttachmentsWithHeaders(item),
  ]);

  const split = splitRecipients([...to, ...cc, ...bcc]);

  return {
    subject,
    userEmail,
    to,
    cc,
    bcc,
    recipients: split.addresses,
    groupRecipients: split.groups,
    attachments,
  };
}

function getSubject(item: Office.MessageCompose): Promise<string> {
  return new Promise((resolve) => {
    item.subject.getAsync((result) => {
      if (result.status === Office.AsyncResultStatus.Succeeded) {
        resolve(result.value ?? "");
      } else {
        console.warn("[OnSend] getSubject failed:", result.error);
        resolve("");
      }
    });
  });
}

// Returns every recipient entry (to+cc+bcc) as Outlook reported it, addresses and
// groups alike. Used for the internal fast-path check before any config fetch.
function getAllRecipientEntries(): Promise<RecipientInfo[]> {
  const item = Office.context.mailbox.item as Office.MessageCompose;
  return Promise.all([
    getRecipients(item.to),
    getRecipients(item.cc),
    getRecipients(item.bcc),
  ]).then(([to, cc, bcc]) => [...to, ...cc, ...bcc]);
}

function getRecipients(field: Office.Recipients): Promise<RecipientInfo[]> {
  return new Promise((resolve) => {
    field.getAsync((result) => {
      if (result.status === Office.AsyncResultStatus.Succeeded) {
        const value = result.value ?? [];
        resolve(
          value.map((r) => ({
            emailAddress: r.emailAddress ?? "",
            displayName: r.displayName ?? "",
            recipientType: (r as Office.EmailAddressDetails).recipientType ?? "",
          })),
        );
      } else {
        console.warn("[OnSend] getRecipients failed:", result.error);
        resolve([]);
      }
    });
  });
}
