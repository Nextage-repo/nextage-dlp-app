// commands.ts — OnMessageSend handler (Production active blocking)
// Runs in Shared Runtime. Invoked automatically by Office.js when user clicks Send.
// Office.js Mailbox API 1.14 required.

import { EmailData, RecipientInfo } from "../models/dlp-result.model";
import { AuditService } from "../services/audit.service";
import { authService } from "../services/auth.service";
import { ConfigService } from "../services/config.service";
import { SAFE_MODE } from "../shared/constants";
import { DLPValidator } from "../validators/validators";
import { readAttachmentsWithHeaders } from "./attachment-reader";

Office.onReady(() => {
  // Register handlers under BOTH names — older manifests reference
  // `onMessageSend`, newer ones use `onMessageSendHandler`. Registering
  // both keeps us compatible with any manifest version still floating around.
  Office.actions.associate("onMessageSendHandler", onMessageSendHandler);
  Office.actions.associate("onMessageSend", onMessageSendHandler);
  Office.actions.associate("onNewComposeHandler", onNewComposeHandler);
  console.log("[Commands] LaunchEvent handlers registered");
});

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

  let token: string | null = null;
  let partialEmail: Partial<EmailData> | undefined;

  try {
    // Step 1: Auth token (silent SSO)
    token = await authService.getTokenSilent();

    // Step 2: Load config (cached after first call)
    const configService = new ConfigService(token);
    const config = await configService.getConfig();

    // Step 3: Read email data (also kept around for unavailable-event context)
    const emailData = await getEmailData();
    partialEmail = emailData;
    console.log("[OnSend] Email data:", {
      subject: emailData.subject,
      recipientCount: emailData.recipients.length,
      attachmentCount: emailData.attachments.length,
    });

    // Step 4: Run DLP checks
    const validator = new DLPValidator(config);
    const result = await validator.runAllChecks(emailData);

    // Step 5: Audit log (fire-and-forget; never blocks send)
    const audit = new AuditService(token);
    audit.writeAudit(emailData, result);

    // Step 6: Decide
    if (result.shouldBlock) {
      console.log("[OnSend] BLOCKING send");
      const issueMessages = result.results
        .filter((r) => r.severity === "BLOCK")
        .map((r) => r.message)
        .join("\n");

      const fullMessage = `DLP חוסם את השליחה:\n${issueMessages}`;

      // For Outlook Classic (ItemSend event), add a notification message to the
      // mail item's InfoBar BEFORE calling event.completed. This is what
      // shows up in the popup dialog and InfoBar that blocks the send.
      try {
        const item = Office.context.mailbox.item as Office.MessageCompose;
        await new Promise<void>((resolve) => {
          item.notificationMessages.replaceAsync(
            "dlpBlock",
            {
              type: Office.MailboxEnums.ItemNotificationMessageType.ErrorMessage,
              message: fullMessage.substring(0, 150), // Classic InfoBar limit
            },
            () => resolve(),
          );
        });
      } catch (notifyErr) {
        console.warn("[OnSend] Could not set notification message:", notifyErr);
      }

      // event.completed options below are honored by modern Outlook (Smart Alerts).
      // Outlook Classic ignores the extra fields but still blocks via allowEvent:false
      // and shows the InfoBar notification message we just set above.
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

    console.log("[OnSend] ALLOWING send");
    event.completed({ allowEvent: true });
  } catch (error: unknown) {
    // Fail-open with observability. We never want a network blip to stop
    // the user from sending, but we DO want to see coverage gaps in audit.
    console.error("[OnSend] Critical error — failing open:", error);
    const reason = error instanceof Error ? error.message : String(error);

    if (token) {
      try {
        new AuditService(token).recordUnavailable(reason, partialEmail);
      } catch (auditErr) {
        console.error("[OnSend] Failed to record DLP_UNAVAILABLE event:", auditErr);
      }
    } else {
      console.error("[OnSend] No token — cannot record DLP_UNAVAILABLE event");
    }

    event.completed({ allowEvent: true });
  }
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
