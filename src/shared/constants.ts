// Shared constants for the DLP add-in

// ⚠️ SAFE_MODE — when true, BLOCK severities still allow send (warnings-only mode).
//
// CURRENT VALUE: false — Production Mode (חסימה אקטיבית).
// Check 1 (encryption) and Check 3 (unknown domain / missing subject) will BLOCK send.
export const SAFE_MODE = false;

// Internal organization domain — emails to this domain skip encryption checks
export const INTERNAL_DOMAIN = "nextage.co.il";

// App version — displayed in taskpane footer. Bump on every release.
export const APP_VERSION = "1.8.0";

// API base — Azure Functions proxy URL. In dev, falls back to localhost:7071.
export const API_BASE_URL =
  (typeof process !== "undefined" && process.env?.AZURE_FUNCTIONS_URL) ||
  "https://nextage-dlp-app-gchqasbzeqgkccf7.westeurope-01.azurewebsites.net/api";

// Session cache TTL for config (1 minute — near real-time updates from admin UI)
export const CONFIG_CACHE_TTL_MS = 60 * 1000;

// Network timeouts
export const API_TIMEOUT_MS = 5000;

// Audit log retention — 90 days in seconds
export const AUDIT_TTL_SECONDS = 90 * 24 * 60 * 60;

// Magic bytes used for binary attachment detection
export const MAGIC_BYTES = {
  CFB_OLE2: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const,
  ZIP: [0x50, 0x4b, 0x03, 0x04] as const,
  PDF: [0x25, 0x50, 0x44, 0x46] as const,
};

// Image extensions — skipped in Check 1 (cannot be encrypted by extension)
export const IMAGE_EXTENSIONS_REGEX = /\.(png|jpg|jpeg|gif|bmp|webp|svg|ico)$/i;

// Archive extensions — assumed encrypted (cannot be verified easily)
export const ARCHIVE_EXTENSIONS_REGEX = /\.(zip|rar|7z)$/i;

// Office file extensions (modern ZIP-based formats)
export const OFFICE_EXTENSIONS_REGEX = /\.(xlsx|docx|pptx)$/i;

// PDF extension
export const PDF_EXTENSION_REGEX = /\.pdf$/i;
