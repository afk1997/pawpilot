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
