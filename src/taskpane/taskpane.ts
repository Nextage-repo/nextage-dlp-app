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

// Track which violations the user has already been warned about — so the
// popup doesn't reappear every time they type a character.
const dismissedViolations = new Set<string>();

function init(): void {
  // Update Safe Mode banner from constant
  const banner = document.getElementById("safe-mode-banner");
  if (banner && !SAFE_MODE) banner.style.display = "none";

  document.getElementById("refresh-btn")?.addEventListener("click", () => {
    dismissedViolations.clear();
    runChecks();
  });
  document.getElementById("cancel-btn")?.addEventListener("click", closeTaskpane);
  document.getElementById("dlp-modal-close")?.addEventListener("click", closeDlpModal);

  // Event handlers (addHandlerAsync) don't fire reliably in Outlook Classic.
  // Use polling instead — snapshot the email state and re-run checks when
  // it changes. This works the same way across Web/Classic/New Outlook.
  startPollingForChanges();

  runChecks();
}

let lastEmailSnapshot = "";

function startPollingForChanges(): void {
  setInterval(async () => {
    try {
      const snapshot = await snapshotEmailState();
      if (snapshot && snapshot !== lastEmailSnapshot) {
        lastEmailSnapshot = snapshot;
        runChecks();
      }
    } catch {
      // ignore — polling is best-effort
    }
  }, 1500);
}

async function snapshotEmailState(): Promise<string> {
  const item = Office.context.mailbox.item as Office.MessageCompose;
  if (!item) return "";

  const get = <T>(fn: (cb: (r: { status: string; value: T }) => void) => void) =>
    new Promise<T | null>((resolve) =>
      fn((r) => resolve(r.status === "succeeded" ? r.value : null)),
    );

  const [subject, to, cc, bcc, atts] = await Promise.all([
    get<string>((cb) => item.subject?.getAsync?.(cb as any)),
    get<Office.EmailAddressDetails[]>((cb) => item.to?.getAsync?.(cb as any)),
    get<Office.EmailAddressDetails[]>((cb) => item.cc?.getAsync?.(cb as any)),
    get<Office.EmailAddressDetails[]>((cb) => item.bcc?.getAsync?.(cb as any)),
    get<Office.AttachmentDetailsCompose[]>((cb) =>
      (item as any).getAttachmentsAsync?.(cb),
    ),
  ]);

  const recipients = [...(to ?? []), ...(cc ?? []), ...(bcc ?? [])]
    .map((r) => r.emailAddress)
    .sort()
    .join(",");
  const attachNames = (atts ?? []).map((a: any) => a.name).sort().join(",");
  return `${subject ?? ""}|${recipients}|${attachNames}`;
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

    // Show a popup with violations the user hasn't seen yet.
    // Each unique violation message only triggers the popup once per session;
    // resetting via the refresh button clears the dismissed set.
    showViolationsPopup(result);
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

      // ErrorMessage takes only { type, message }. InformationalMessage REQUIRES
      // both `icon` (a manifest resource id) and `persistent` — omitting them makes
      // Office.js throw "Value cannot be null. Parameter name: icon".
      const payload: Office.NotificationMessageDetails =
        r.severity === "BLOCK"
          ? { type, message }
          : { type, message, icon: "Icon.16x16", persistent: false };

      return new Promise<void>((resolve) =>
        item.notificationMessages.replaceAsync(key, payload, () => resolve()),
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
  statusDiv.textContent = "";
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

function setSendEnabled(_enabled: boolean): void {
  // The taskpane Send button was removed — kept as a no-op so callers don't break.
}

/**
 * Shows a popup with all current violations. Each violation only triggers
 * the popup once — once the user dismisses, we won't bother them again
 * for the same violation until they click refresh or fix the email.
 */
function showViolationsPopup(result: DLPResult): void {
  const violations = result.results.filter(
    (r) => r.severity === "BLOCK" || r.severity === "WARNING",
  );
  if (violations.length === 0) {
    // All clear — reset so future violations re-trigger the popup
    dismissedViolations.clear();
    return;
  }

  // Build a signature from the violations to detect "new" ones
  const signature = violations.map((v) => `${v.check}:${v.severity}:${v.message}`).join("|");
  if (dismissedViolations.has(signature)) return;
  dismissedViolations.add(signature);

  // setTimeout lets the UI render the check results first, then popup.
  setTimeout(() => openDlpModal(result, violations), 150);
}

function openDlpModal(
  result: DLPResult,
  violations: { severity: string; message: string }[],
): void {
  const overlay = document.getElementById("dlp-modal-overlay");
  const header = document.getElementById("dlp-modal-header");
  const body = document.getElementById("dlp-modal-body");
  if (!overlay || !header || !body) return;

  const isBlock = result.shouldBlock;
  header.className = "dlp-modal-header " + (isBlock ? "block" : "warning");
  header.textContent = isBlock
    ? "⛔ DLP חוסם את השליחה"
    : "⚠️ אזהרת DLP — שים לב לפני שליחה";

  // Build body via DOM API so violation text can't break out as HTML.
  body.textContent = "";
  violations.forEach((v) => {
    const div = document.createElement("div");
    div.className = "dlp-modal-issue " + (v.severity === "BLOCK" ? "block" : "warning");
    const icon = v.severity === "BLOCK" ? "🚫" : "⚠️";
    div.textContent = `${icon} ${v.message}`;
    body.appendChild(div);
  });
  const footer = document.createElement("p");
  footer.style.marginTop = "12px";
  footer.style.fontSize = "12px";
  footer.style.color = "#666";
  footer.textContent = isBlock
    ? "אנא תקן את הבעיות לפני שליחת המייל."
    : "המייל יישלח אבל יש לבדוק את הסימונים.";
  body.appendChild(footer);

  overlay.classList.add("open");
}

function closeDlpModal(): void {
  document.getElementById("dlp-modal-overlay")?.classList.remove("open");
}

function closeTaskpane(): void {
  try {
    (Office.context.ui as { closeContainer?: () => void }).closeContainer?.();
  } catch {
    /* ignore */
  }
}
