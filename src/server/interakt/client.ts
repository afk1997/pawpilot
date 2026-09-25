/**
 * Interakt WhatsApp send API.
 *
 * Docs: https://docs.interakt.shop/docs/send-whatsapp-message-api
 *
 * Notes:
 * - We send free-form text inside the 24-hour customer service window. Outside
 *   that window, WhatsApp / Meta require a pre-approved template — see
 *   `sendWhatsAppTemplate` below.
 * - Interakt accepts a `phoneNumber` in 10-digit form plus a separate
 *   `countryCode`. We split internal E.164 (+91XXXXXXXXXX) before sending.
 */

const INTERAKT_BASE = process.env.INTERAKT_API_BASE ?? "https://api.interakt.ai/v1/public/message/";

type InteraktResult = {
  ok: boolean;
  status: number;
  body: unknown;
  error?: string;
};

/**
 * Split internal E.164 (+91XXXXXXXXXX) into Interakt's separate fields.
 *
 * IMPORTANT: a naive `\d{1,3}` regex is greedy and would match "+919" as
 * the country code for "+919096820338", leaving "096820338" — a 9-digit
 * fragment Interakt accepts and silently drops. This is the bug that
 * caused outbound messages to "succeed" with 201 yet never deliver.
 *
 * Use length-based logic instead. India is the dominant country code
 * for this app, but we also handle other 1-3 digit country codes.
 */
function splitPhone(phone: string): { countryCode: string; phoneNumber: string } {
  const digits = phone.replace(/\D/g, "");

  // 10-digit Indian local number — assume +91.
  if (digits.length === 10) {
    return { countryCode: "+91", phoneNumber: digits };
  }
  // 12 digits starting with "91" → India.
  if (digits.length === 12 && digits.startsWith("91")) {
    return { countryCode: "+91", phoneNumber: digits.slice(2) };
  }
  // 11 digits with leading "0" → strip and assume India.
  if (digits.length === 11 && digits.startsWith("0")) {
    return { countryCode: "+91", phoneNumber: digits.slice(1) };
  }
  // International: assume the last 10 digits are the local number.
  if (digits.length > 10) {
    return { countryCode: `+${digits.slice(0, -10)}`, phoneNumber: digits.slice(-10) };
  }
  // Last-ditch: use the digits we have; Interakt may reject, but at least
  // the failure will be visible in the logs.
  return { countryCode: "+91", phoneNumber: digits };
}

function authHeader(): string {
  const key = process.env.INTERAKT_API_KEY;
  if (!key) throw new Error("INTERAKT_API_KEY not set");
  // Interakt expects the API key directly in the Authorization header (Basic <key>).
  return `Basic ${key}`;
}

async function postInterakt(payload: unknown): Promise<InteraktResult> {
  const debug = process.env.INTERAKT_DEBUG_LOG !== "0";
  try {
    const res = await fetch(INTERAKT_BASE, {
      method: "POST",
      headers: {
        Authorization: authHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => null);
    const result = { ok: res.ok, status: res.status, body };
    if (debug || !res.ok) {
      const bodyStr = body ? JSON.stringify(body).slice(0, 400) : "(no body)";
      console.log(
        `[interakt-send] status=${res.status} ok=${res.ok} body=${bodyStr}`
      );
    }
    return result;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("[interakt-send] threw:", error);
    return { ok: false, status: 0, body: null, error };
  }
}

/**
 * Send a free-form text message. Use ONLY inside the 24-hour customer service
 * window (i.e. within 24h of the reporter's most recent inbound message).
 * Outside that window, use sendWhatsAppTemplate.
 */
export async function sendWhatsAppMessage(to: string, body: string): Promise<InteraktResult> {
  const { countryCode, phoneNumber } = splitPhone(to);
  return postInterakt({
    countryCode,
    phoneNumber,
    type: "Text",
    callbackData: "agent",
    data: { message: body },
  });
}

/**
 * Send a pre-approved template. Required for unsolicited messages outside the
 * 24h window — used by closure summaries that land days later.
 *
 * `name` is the template name registered with Interakt / Meta. `languageCode`
 * is the WA template language code (e.g. en, hi, mr, gu).
 * `bodyValues` fills the {{1}}, {{2}} placeholders in template body.
 */
export async function sendWhatsAppTemplate(
  to: string,
  name: string,
  languageCode: string,
  bodyValues: string[] = [],
  headerValues: string[] = []
): Promise<InteraktResult> {
  const { countryCode, phoneNumber } = splitPhone(to);
  return postInterakt({
    countryCode,
    phoneNumber,
    type: "Template",
    callbackData: "agent",
    template: {
      name,
      languageCode,
      headerValues,
      bodyValues,
    },
  });
}
