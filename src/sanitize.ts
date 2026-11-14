// oxlint-disable-next-line no-control-regex -- ANSI CSI sanitization (§11.3 step 1)
const ANSI_CSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
// oxlint-disable-next-line no-control-regex -- ANSI OSC sanitization (§11.3 step 1)
const ANSI_OSC_RE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
// oxlint-disable-next-line no-control-regex -- ANSI two-byte ESC sanitization (§11.3 step 1)
const ANSI_OTHER_RE = /\u001b[\s\S]?/g;
// Removes C0 controls except \t (0x09) and \n (0x0a), DEL (0x7f), C1 (0x80-0x9f),
// BiDi controls, and zero-width / format characters (§11.3 step 1).
const UNSAFE_CONTROLS_RE =
  // oxlint-disable-next-line no-control-regex -- intentional control/BiDi character strip (§11.3 step 1)
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;

const REDACT_BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const REDACT_PREFIX_KEY_RE = /\b(?:sk|pk|rk|sess)-[A-Za-z0-9_-]{16,}/gi;
const REDACT_GOOGLE_KEY_RE = /\bAIza[0-9A-Za-z_-]{35}\b/gi;
const REDACT_KV_RE =
  /\b(api[_-]?key|x-api-key|authorization|token|secret|password)\b(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi;
const REDACT_QUERY_RE =
  /([?&](?:key|api_key|apikey|token|access_token)=)[^&\s"']+/gi;

/** Strips ANSI CSI/OSC/ESC sequences and unsafe control/BiDi characters (§11.3 step 1). */
export function sanitizeControlChars(text: string): string {
  return text
    .replace(ANSI_CSI_RE, '')
    .replace(ANSI_OSC_RE, '')
    .replace(ANSI_OTHER_RE, '')
    .replace(UNSAFE_CONTROLS_RE, '');
}

/** Strips unsafe controls and collapses newlines/tabs into single spaces for inline slots (§11.3 steps 1–2). */
export function sanitizeInline(text: string): string {
  return sanitizeControlChars(text).replaceAll(/\r?\n|\r|\t/g, ' ');
}

/** Applies the §12.3 best-effort secret redaction patterns in order. */
export function redactSecrets(text: string): string {
  return text
    .replace(REDACT_BEARER_RE, 'Bearer [REDACTED]')
    .replace(REDACT_PREFIX_KEY_RE, '[REDACTED]')
    .replace(REDACT_GOOGLE_KEY_RE, '[REDACTED]')
    .replace(
      REDACT_KV_RE,
      (_m, k: string, sep: string) => `${k}${sep}[REDACTED]`,
    )
    .replace(REDACT_QUERY_RE, (_m, prefix: string) => `${prefix}[REDACTED]`);
}
