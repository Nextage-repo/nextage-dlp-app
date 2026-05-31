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

  runChecks();
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
  } catch (error: unknown) {
    console.error("[Taskpane] error:", error);
    showStatus(`שגיאה: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
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
