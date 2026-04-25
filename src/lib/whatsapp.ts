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

/** Split internal E.164 (+91XXXXXXXXXX) into Interakt's separate fields. */
function splitPhone(phone: string): { countryCode: string; phoneNumber: string } {
  const cleaned = phone.replace(/[^0-9+]/g, "");
  if (cleaned.startsWith("+")) {
    // +91XXXXXXXXXX → countryCode=+91, phoneNumber=XXXXXXXXXX
    const match = cleaned.match(/^(\+\d{1,3})(\d+)$/);
    if (match) return { countryCode: match[1], phoneNumber: match[2] };
  }
  // Fallback: assume India.
  return { countryCode: "+91", phoneNumber: cleaned.replace(/\D/g, "").slice(-10) };
}

function authHeader(): string {
  const key = process.env.INTERAKT_API_KEY;
  if (!key) throw new Error("INTERAKT_API_KEY not set");
  // Interakt expects the API key directly in the Authorization header (Basic <key>).
  return `Basic ${key}`;
}

async function postInterakt(payload: unknown): Promise<InteraktResult> {
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
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: null, error: e instanceof Error ? e.message : String(e) };
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
