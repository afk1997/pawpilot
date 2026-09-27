import { getConfig } from "../config";
import { log, maskPhone } from "../log";

export interface InteraktResult {
  ok: boolean;
  status: number;
  body: unknown;
  error?: string;
  messageId?: string;
}

export interface InteractiveListSpec {
  body: string;
  buttonLabel: string;
  sectionTitle?: string;
  rows: { id: string; title: string; description?: string }[];
}

let fetchImpl: typeof fetch | null = null;
export function setFetchForTests(fn: typeof fetch | null): void {
  fetchImpl = fn;
}

export function isTestPhone(phone: string): boolean {
  return phone.startsWith("+91TEST_");
}

/** ITU-T E.164 two-digit country codes. Codes are prefix-free; codes not listed here (other than 1 and 7) have three digits. */
const TWO_DIGIT_COUNTRY_CODES = new Set([
  "20", "27", "30", "31", "32", "33", "34", "36", "39", "40", "41", "43", "44", "45", "46", "47", "48", "49",
  "51", "52", "53", "54", "55", "56", "57", "58", "60", "61", "62", "63", "64", "65", "66",
  "81", "82", "84", "86", "90", "91", "92", "93", "94", "95", "98",
]);

function countryCodeLength(digits: string): number {
  if (digits.startsWith("1") || digits.startsWith("7")) return 1;
  return TWO_DIGIT_COUNTRY_CODES.has(digits.slice(0, 2)) ? 2 : 3;
}

/**
 * An explicit "+" is E.164, so the country code comes from the ITU length table ("+6581234567" is Singapore,
 * not +91 6581234567). Bare numbers keep the India heuristics, split by length: a greedy regex once produced
 * "+919" + 9 digits and silently dropped messages.
 */
export function splitPhone(phone: string): { countryCode: string; phoneNumber: string } {
  const digits = phone.replace(/\D/g, "");
  if (phone.startsWith("+")) {
    const ccLength = countryCodeLength(digits);
    return { countryCode: `+${digits.slice(0, ccLength)}`, phoneNumber: digits.slice(ccLength) };
  }
  if (digits.length === 10) return { countryCode: "+91", phoneNumber: digits };
  if (digits.length === 12 && digits.startsWith("91")) return { countryCode: "+91", phoneNumber: digits.slice(2) };
  if (digits.length === 11 && digits.startsWith("0")) return { countryCode: "+91", phoneNumber: digits.slice(1) };
  if (digits.length > 10) return { countryCode: `+${digits.slice(0, -10)}`, phoneNumber: digits.slice(-10) };
  return { countryCode: "+91", phoneNumber: digits };
}

/** Caps a stalled Interakt call; Node's fetch would otherwise wait minutes, past the turn job's expiry. */
export const SEND_TIMEOUT_MS = 15_000;

/**
 * Node's fetch rejects network failures as TypeError("fetch failed") and keeps the reason in `cause`. That cause can be
 * an AggregateError with an empty message, so its `code` (ECONNREFUSED, ENOTFOUND, UND_ERR_SOCKET, ...) is preferred.
 */
function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = e.cause;
  if (!(cause instanceof Error)) return e.message;
  const code = (cause as { code?: unknown }).code;
  const detail = typeof code === "string" && code !== "" ? code : cause.message;
  return detail ? `${e.message}: ${detail}` : e.message;
}

type Payload = Record<string, unknown> & { countryCode: string; phoneNumber: string };

/** `to` is checked for test phones; logs only ever see the payload's normalized recipient, masked. */
async function post(payload: Payload, to: string): Promise<InteraktResult> {
  if (isTestPhone(to)) {
    return { ok: false, status: 0, body: null, error: "refusing to send to a test phone" };
  }
  const maskedTo = maskPhone(`${payload.countryCode}${payload.phoneNumber}`);
  const doFetch = fetchImpl ?? fetch;
  try {
    const cfg = getConfig();
    const res = await doFetch(cfg.interakt.apiBase, {
      method: "POST",
      headers: { Authorization: `Basic ${cfg.interakt.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    const body = await res.json().catch(() => null);
    const messageId = body && typeof body === "object" && typeof (body as { id?: unknown }).id === "string" ? (body as { id: string }).id : undefined;
    const result: InteraktResult = { ok: res.ok, status: res.status, body, messageId };
    if (!res.ok) {
      result.error = `interakt ${res.status}: ${JSON.stringify(body).slice(0, 300)}`;
      log.warn({ to: maskedTo, status: res.status }, "interakt send failed");
    }
    return result;
  } catch (e) {
    const error = describeError(e);
    log.error({ to: maskedTo, error }, "interakt send threw");
    return { ok: false, status: 0, body: null, error };
  }
}

/** Free-form text; valid only inside the 24 h customer-service window. */
export async function sendText(to: string, body: string): Promise<InteraktResult> {
  const { countryCode, phoneNumber } = splitPhone(to);
  return post({ countryCode, phoneNumber, type: "Text", callbackData: "agent", data: { message: body } }, to);
}

/** WhatsApp list message (≤10 rows, titles ≤24 chars, button ≤20 chars). */
export async function sendInteractiveList(to: string, list: InteractiveListSpec): Promise<InteraktResult> {
  const { countryCode, phoneNumber } = splitPhone(to);
  return post(
    {
      countryCode,
      phoneNumber,
      type: "InteractiveList",
      callbackData: "agent",
      data: {
        message: {
          type: "list",
          body: { text: list.body },
          action: {
            button: list.buttonLabel,
            sections: [{ title: list.sectionTitle ?? "Options", rows: list.rows }],
          },
        },
      },
    },
    to
  );
}
