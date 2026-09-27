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

/** A phone-like run of 7+ digits (the spec's scrub pattern, §5.9): never allowed in a code or a class name. */
const PHONE_LIKE_RE = /(?:\+?\d[\s-]?){7,}/;
/** A class name as written in source: PascalCase. A minifier's name ("e", "tA", "$n") is not one. */
const CLASS_NAME_RE = /^[A-Z][A-Za-z0-9]{2,63}$/;

/**
 * The error's class: its constructor's name, or, where a production bundle minified that name (Next's does), the
 * error's own `name` ("TimeoutError", or "Error" when the class never set one) while it looks like a label.
 */
function errorClassOf(err: Error): string {
  const ctor = typeof err.constructor?.name === "string" ? err.constructor.name : "";
  if (CLASS_NAME_RE.test(ctor)) return ctor;
  const name = typeof err.name === "string" ? err.name : "";
  return name.length > 0 && name.length <= 64 && !PHONE_LIKE_RE.test(name) ? name : "Error";
}

/**
 * What an error may put in a log line or an event: its class name and its code. Never the message, the
 * params or `cause.detail`, which can quote reporter data. The code comes from `cause` first (drizzle wraps
 * the driver's error, which carries the SQLSTATE) and is kept only while it looks like a code: at most 64
 * characters and no phone-like run of 7+ digits.
 */
export function safeErrorFields(err: unknown): { errorClass: string; code?: string } {
  const e = (err ?? {}) as { code?: unknown; cause?: { code?: unknown } | null };
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const code = str(e.cause?.code) ?? str(e.code);
  const errorClass = err instanceof Error ? errorClassOf(err) : typeof err;
  return code !== undefined && code.length <= 64 && !PHONE_LIKE_RE.test(code) ? { errorClass, code } : { errorClass };
}
