// Shared constants for the DLP add-in

// ⚠️ SAFE_MODE — when true, BLOCK severities still allow send (warnings-only mode).
//
// CURRENT VALUE: false — Production Mode (חסימה אקטיבית).
// Check 1 (encryption) and Check 3 (unknown domain / missing subject) will BLOCK send.
export const SAFE_MODE = false;

// Internal organization domain — emails to this domain skip encryption checks
export const INTERNAL_DOMAIN = "nextage.co.il";

export const API_BASE_URL = "https://nextage-dlp-app-gchqasbzeqgkccf7.westeurope-01.azurewebsites.net/api";

// Session cache TTL for config (60 minutes)
export const CONFIG_CACHE_TTL_MS = 60 * 60 * 1000;

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

// Plain text — skipped in Check 1 (never requires encryption)
export const TEXT_EXTENSIONS_REGEX = /\.txt$/i;

// RAR/7Z — no internal-structure encryption check implemented yet, so these
// are still assumed encrypted. .zip is EXCLUDED here on purpose: Check 1 now
// inspects the real ZIP local-file-header bit-0 flag via classify() instead
// of trusting the extension (see check1-encryption.ts).
export const ARCHIVE_EXTENSIONS_REGEX = /\.(rar|7z)$/i;

// Office file extensions (modern ZIP-based formats)
export const OFFICE_EXTENSIONS_REGEX = /\.(xlsx|docx|pptx)$/i;

// PDF extension
export const PDF_EXTENSION_REGEX = /\.pdf$/i;
