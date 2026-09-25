import pino from "pino";

export const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: process.env.SERVICE_NAME ?? "arham" },
  redact: { paths: ["*.body", "req.headers.authorization"], remove: true },
});

/** "+919876543210" → "+91xxxxxx3210". Non-numeric tails (test phones) are left alone. */
export function maskPhone(phone: string): string {
  if (!phone) return phone;
  const m = phone.match(/^(\+?\d{2})(\d+)(\d{4})$/);
  if (!m) return phone;
  return `${m[1]}${"x".repeat(m[2].length)}${m[3]}`;
}

/**
 * What an error may put in a log line or an event: its class name and its code. Never the message, the
 * params or `cause.detail`, which can quote reporter data. The code comes from `cause` first (drizzle wraps
 * the driver's error, which carries the SQLSTATE) and is kept only while it looks like a code: at most 64
 * characters and no phone-like run of 7+ digits (the spec's scrub pattern, §5.9).
 */
export function safeErrorFields(err: unknown): { errorClass: string; code?: string } {
  const e = (err ?? {}) as { code?: unknown; cause?: { code?: unknown } | null };
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const code = str(e.cause?.code) ?? str(e.code);
  const errorClass = err instanceof Error ? err.constructor.name : typeof err;
  return code !== undefined && code.length <= 64 && !/(?:\+?\d[\s-]?){7,}/.test(code) ? { errorClass, code } : { errorClass };
}
