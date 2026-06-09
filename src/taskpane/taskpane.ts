// taskpane.ts — Manual DLP check UI (also opened when OnSend blocks)

import { CheckResult, DLPResult, EmailData, RecipientInfo } from "../models/dlp-result.model";
import { AuditService } from "../services/audit.service";
import { authService } from "../services/auth.service";
import { ConfigService } from "../services/config.service";
import { SAFE_MODE } from "../shared/constants";
import { DLPValidator } from "../validators/validators";
import { readAttachmentsWithHeaders } from "../commands/attachment-reader";

Office.onReady((info) => {
  if (info.host !== Office.HostType.Outlook) return;

  console.log("[Taskpane] Ready, platform:", info.platform);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
});

function init(): void {
  // Update Safe Mode banner from constant
  const banner = document.getElementById("safe-mode-banner");
  if (banner && !SAFE_MODE) banner.style.display = "none";

  document.getElementById("refresh-btn")?.addEventListener("click", runChecks);
  document.getElementById("send-btn")?.addEventListener("click", () => {
    // Send button in the task pane is informational only — real send is via Outlook
    showStatus("יש ללחוץ Send בחלון Outlook עצמו", "info");
  });
  document.getElementById("cancel-btn")?.addEventListener("click", closeTaskpane);

  // Re-run checks automatically when user changes recipients or attachments.
  // The Office.js types don't expose addHandlerAsync on these subfields, but
  // it exists at runtime — cast through `any` to access it.
  try {
    const item = Office.context.mailbox.item as any;
    const debouncedRecheck = debounce(runChecks, 600);
    item.to?.addHandlerAsync?.(Office.EventType.RecipientsChanged, debouncedRecheck);
    item.cc?.addHandlerAsync?.(Office.EventType.RecipientsChanged, debouncedRecheck);
    item.bcc?.addHandlerAsync?.(Office.EventType.RecipientsChanged, debouncedRecheck);
    item.addHandlerAsync?.(Office.EventType.AttachmentsChanged, debouncedRecheck);
  } catch (err) {
    console.warn("[Taskpane] Could not register change handlers:", err);
  }

  runChecks();
}

function debounce<T extends (...args: any[]) => any>(fn: T, ms: number): T {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  return ((...args: any[]) => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), ms);
  }) as T;
}

async function runChecks(): Promise<void> {
  console.log("[Taskpane] ===== Starting checks =====");
  showStatus("🔄 מעבדים בדיקות...", "info");
  resetCheckDisplay();

  try {
    const token = await authService.getTokenSilent();

    const configService = new ConfigService(token);
    const config = await configService.getConfig();

    const emailData = await getEmailData();

    // Empty recipients guard
    if (emailData.recipients.length === 0) {
      showStatus(
        "⚠️ אין נמענים. אם הקלדת כתובת – לחץ Tab או Enter כדי לאשר.",
        "warning",
      );
      ["check1", "check2", "check3"].forEach((id, idx) => {
        displayResult(id, {
          check: (idx + 1) as 1 | 2 | 3,
          isValid: false,
          severity: "WARNING",
          message: "אין נמענים - לא ניתן לבצע בדיקה",
        });
      });
      setSendEnabled(false);
      return;
    }

    const validator = new DLPValidator(config);
    const result = await validator.runAllChecks(emailData);

    // Audit log (fire-and-forget)
    new AuditService(token).writeAudit(emailData, result);

    displayResult("check1", result.results[0]);
    displayResult("check2", result.results[1]);
    displayResult("check3", result.results[2]);

    updateOverallStatus(result);

    // Add persistent banner notifications on the email itself.
    // These show at the top of the email (InfoBar) and stay visible even when
    // the taskpane is closed. This is how we warn users in Outlook Classic
    // without requiring OnMessageSend (Smart Alerts) support.
    await updateEmailNotifications(result);
  } catch (error: unknown) {
    console.error("[Taskpane] error:", error);
    showStatus(`שגיאה: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

/**
 * Adds warning/error banners to the top of the email (InfoBar). Visible to
 * the user without needing the taskpane open. Works in Outlook Classic.
 *
 * Notification keys (max ~5 active per item):
 *   - dlp_check1 → Encryption result
 *   - dlp_check2 → Filename match result
 *   - dlp_check3 → Subject + domain result
 */
async function updateEmailNotifications(result: DLPResult): Promise<void> {
  const item = Office.context.mailbox.item as Office.MessageCompose;
  if (!item?.notificationMessages) return;

  const keys = ["dlp_check1", "dlp_check2", "dlp_check3"];
  await Promise.all(
    result.results.map((r, idx) => {
      const key = keys[idx]!;
      // Clear pass results — no need to show green banners on every email
      if (r.severity === "INFO" || r.isValid) {
        return new Promise<void>((resolve) =>
          item.notificationMessages.removeAsync(key, () => resolve()),
        );
      }

      const type =
        r.severity === "BLOCK"
          ? Office.MailboxEnums.ItemNotificationMessageType.ErrorMessage
          : Office.MailboxEnums.ItemNotificationMessageType.InformationalMessage;

      // Notification messages have a 150-char limit on Outlook desktop
      const prefix = r.severity === "BLOCK" ? "❌ חסום DLP: " : "⚠️ DLP: ";
      const message = (prefix + r.message).substring(0, 150);

      return new Promise<void>((resolve) =>
        item.notificationMessages.replaceAsync(
          key,
          {
            type,
            message,
            icon: "Icon.16x16",
            persistent: r.severity === "BLOCK",
          },
          () => resolve(),
        ),
      );
    }),
  );
}

async function getEmailData(): Promise<EmailData> {
  const item = Office.context.mailbox.item as Office.MessageCompose;
  const userEmail = Office.context.mailbox?.userProfile?.emailAddress || "";

  const [subject, to, cc, bcc, attachments] = await Promise.all([
    getSubject(item),
    getRecipients(item.to),
    getRecipients(item.cc),
    getRecipients(item.bcc),
    readAttachmentsWithHeaders(item),
  ]);

  const all = [...to, ...cc, ...bcc]
    .map((r) => r.emailAddress.toLowerCase().trim())
    .filter((e) => e.length > 0 && e.includes("@"));
  const unique = Array.from(new Set(all));

  return { subject, userEmail, to, cc, bcc, recipients: unique, attachments };
}

function getSubject(item: Office.MessageCompose): Promise<string> {
  return new Promise((resolve) => {
    item.subject.getAsync((result) => {
      resolve(result.status === Office.AsyncResultStatus.Succeeded ? result.value ?? "" : "");
    });
  });
}

function getRecipients(field: Office.Recipients): Promise<RecipientInfo[]> {
  return new Promise((resolve) => {
    field.getAsync((result) => {
      if (result.status === Office.AsyncResultStatus.Succeeded) {
        resolve(
          (result.value ?? []).map((r) => ({
            emailAddress: r.emailAddress ?? "",
            displayName: r.displayName ?? "",
          })),
        );
      } else {
        resolve([]);
      }
    });
  });
}

// ============================================================================
// UI
// ============================================================================

type StatusType = "info" | "success" | "warning" | "error";

function showStatus(message: string, type: StatusType): void {
  const statusDiv = document.getElementById("status");
  if (!statusDiv) return;

  const colors: Record<StatusType, { color: string; icon: string }> = {
    info: { color: "#3525cd", icon: "ℹ️" },
    success: { color: "#107c10", icon: "✓" },
    warning: { color: "#d18b00", icon: "⚠️" },
    error: { color: "#ba1a1a", icon: "❌" },
  };
  const { color, icon } = colors[type];

  // Build via DOM API rather than innerHTML — message may contain user-derived
  // content (error messages bubbled from the API).
  statusDiv.replaceChildren();
  const p = document.createElement("p");
  p.style.color = color;
  p.style.fontWeight = "600";
  p.textContent = `${icon} ${message}`;
  statusDiv.appendChild(p);
}

function resetCheckDisplay(): void {
  ["check1", "check2", "check3"].forEach((id) => {
    const el = document.getElementById(id);
    const r = document.getElementById(`${id}-result`);
    el?.classList.remove("success", "warning", "error");
    if (r) r.textContent = "מחכה...";
  });
}

function displayResult(elementId: string, result: CheckResult): void {
  const el = document.getElementById(elementId);
  const r = document.getElementById(`${elementId}-result`);
  if (!el || !r) return;

  el.classList.remove("success", "warning", "error");

  if (result.severity === "BLOCK") {
    el.classList.add("error");
    r.textContent = `❌ ${result.message}`;
  } else if (result.severity === "WARNING") {
    el.classList.add("warning");
    r.textContent = `⚠️ ${result.message}`;
  } else {
    el.classList.add("success");
    r.textContent = result.message;
  }
}

function updateOverallStatus(result: DLPResult): void {
  if (result.shouldBlock) {
    showStatus("שליחה חסומה - תקן את הבעיות לפני המשך", "error");
    setSendEnabled(false);
  } else if (result.hasBlock && SAFE_MODE) {
    showStatus("🛡️ Safe Mode: היו חסימות ב-Production - השליחה מאופשרת לצורכי בדיקה", "error");
    setSendEnabled(true);
  } else if (result.hasWarning) {
    showStatus("יש אזהרות - בדוק לפני שליחה", "warning");
    setSendEnabled(true);
  } else {
    showStatus("כל הבדיקות עברו בהצלחה", "success");
    setSendEnabled(true);
  }
}

function setSendEnabled(enabled: boolean): void {
  const btn = document.getElementById("send-btn") as HTMLButtonElement | null;
  if (!btn) return;
  btn.disabled = !enabled;
  btn.style.opacity = enabled ? "1" : "0.5";
  btn.style.cursor = enabled ? "pointer" : "not-allowed";
}

function closeTaskpane(): void {
  try {
    (Office.context.ui as { closeContainer?: () => void }).closeContainer?.();
  } catch {
    /* ignore */
  }
}
