// commands.ts — OnMessageSend handler (Production active blocking)
// Runs in Shared Runtime. Invoked automatically by Office.js when user clicks Send.
// Office.js Mailbox API 1.14 required.

import { DLPConfig } from "../models/customer.model";
import { DLPResult, EmailData, RecipientInfo } from "../models/dlp-result.model";
import { AuditService } from "../services/audit.service";
import { authService } from "../services/auth.service";
import { ConfigService } from "../services/config.service";
import { INTERNAL_DOMAIN, SAFE_MODE } from "../shared/constants";
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

    const validator = new DLPValidator(config);
    const result = await validator.runAllChecks(emailData);

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
    const fastRecipients = await getRecipientsRaw();
    const allInternal =
      fastRecipients.length > 0 &&
      fastRecipients.every((r) => r.toLowerCase().endsWith(`@${INTERNAL_DOMAIN}`));

    if (allInternal) {
      console.log("[OnSend] All recipients internal — allowing send");
      event.completed({ allowEvent: true });
      return;
    }

    // Load config (in-memory cached after first call)
    const config = await getConfigCached();

    // Read full email data
    const emailData = await getEmailData();
    partialEmail = emailData;

    // Run DLP checks
    const validator = new DLPValidator(config);
    const result = await validator.runAllChecks(emailData);

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

  const allRecipients = [...to, ...cc, ...bcc]
    .map((r) => r.emailAddress.toLowerCase().trim())
    .filter((e) => e.length > 0 && e.includes("@"));
  const uniqueRecipients = Array.from(new Set(allRecipients));

  return {
    subject,
    userEmail,
    to,
    cc,
    bcc,
    recipients: uniqueRecipients,
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

// Returns all recipient email addresses (to+cc+bcc) as plain strings.
// Used for the internal fast-path check before any config fetch.
function getRecipientsRaw(): Promise<string[]> {
  const item = Office.context.mailbox.item as Office.MessageCompose;
  return Promise.all([
    getRecipients(item.to),
    getRecipients(item.cc),
    getRecipients(item.bcc),
  ]).then(([to, cc, bcc]) =>
    [...to, ...cc, ...bcc]
      .map((r) => r.emailAddress.toLowerCase().trim())
      .filter((e) => e.length > 0 && e.includes("@")),
  );
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
          })),
        );
      } else {
        console.warn("[OnSend] getRecipients failed:", result.error);
        resolve([]);
      }
    });
  });
}
