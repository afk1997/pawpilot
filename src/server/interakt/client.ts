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

/** Length-based split; a greedy regex once produced "+919" + 9 digits and silently dropped messages. */
export function splitPhone(phone: string): { countryCode: string; phoneNumber: string } {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return { countryCode: "+91", phoneNumber: digits };
  if (digits.length === 12 && digits.startsWith("91")) return { countryCode: "+91", phoneNumber: digits.slice(2) };
  if (digits.length === 11 && digits.startsWith("0")) return { countryCode: "+91", phoneNumber: digits.slice(1) };
  if (digits.length > 10) return { countryCode: `+${digits.slice(0, -10)}`, phoneNumber: digits.slice(-10) };
  return { countryCode: "+91", phoneNumber: digits };
}

async function post(payload: Record<string, unknown>, to: string): Promise<InteraktResult> {
  if (isTestPhone(to)) {
    return { ok: false, status: 0, body: null, error: "refusing to send to a test phone" };
  }
  const cfg = getConfig();
  const doFetch = fetchImpl ?? fetch;
  try {
    const res = await doFetch(cfg.interakt.apiBase, {
      method: "POST",
      headers: { Authorization: `Basic ${cfg.interakt.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => null);
    const messageId = body && typeof body === "object" && typeof (body as { id?: unknown }).id === "string" ? (body as { id: string }).id : undefined;
    const result: InteraktResult = { ok: res.ok, status: res.status, body, messageId };
    if (!res.ok) {
      result.error = `interakt ${res.status}: ${JSON.stringify(body).slice(0, 300)}`;
      log.warn({ to: maskPhone(to), status: res.status }, "interakt send failed");
    }
    return result;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log.error({ to: maskPhone(to), error }, "interakt send threw");
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
