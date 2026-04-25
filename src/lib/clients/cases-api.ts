/**
 * Client for Arham's internal Cases API.
 *
 * Cases logged by Arham itself land here. Partner-NGO-handled cases do NOT
 * go through this API, so closure summaries are opportunistic — only fire
 * when a matching case shows up.
 *
 * The exact contract of the API isn't yet finalized; this client codes the
 * minimum we need (lookup by reporter phone, lookup by case id) and is
 * easy to swap when the user provides real spec.
 */

export interface ArhamCase {
  id: string;
  reporter_phone: string;
  reporter_name?: string | null;
  animal_type?: string | null;
  treatment_summary?: string | null;
  medications?: string | null;
  photos?: string[];
  videos?: string[];
  case_status?: "open" | "treated" | "released" | "closed" | string;
  treated_at?: string | null;
  created_at?: string;
}

const BASE = process.env.CASES_API_BASE;
const KEY = process.env.CASES_API_KEY;

function authHeaders(): Record<string, string> {
  if (!KEY) return {};
  return { Authorization: `Bearer ${KEY}` };
}

/** Find the most recent case for a reporter, optionally bounded by lookback days. */
export async function getCaseByReporter(
  phone: string,
  daysBack = 14
): Promise<ArhamCase | null> {
  if (!BASE) {
    console.warn("CASES_API_BASE not set — case lookup disabled.");
    return null;
  }
  const url = new URL("/cases", BASE);
  url.searchParams.set("reporter_phone", phone);
  url.searchParams.set("days_back", String(daysBack));
  url.searchParams.set("limit", "1");
  url.searchParams.set("sort", "-created_at");

  try {
    const res = await fetch(url.toString(), { headers: { ...authHeaders() } });
    if (!res.ok) {
      if (res.status === 404) return null;
      console.warn(`Cases API ${res.status}: ${await res.text()}`);
      return null;
    }
    const body = (await res.json()) as { cases?: ArhamCase[]; results?: ArhamCase[] } | ArhamCase[];
    const cases = Array.isArray(body) ? body : body.cases ?? body.results ?? [];
    return cases[0] ?? null;
  } catch (e) {
    console.warn("Cases API fetch threw:", e);
    return null;
  }
}

/** List cases since a timestamp — used by the closure cron to find new cases efficiently. */
export async function listCasesSince(sinceISO: string): Promise<ArhamCase[]> {
  if (!BASE) return [];
  const url = new URL("/cases", BASE);
  url.searchParams.set("since", sinceISO);
  url.searchParams.set("sort", "created_at");
  try {
    const res = await fetch(url.toString(), { headers: { ...authHeaders() } });
    if (!res.ok) return [];
    const body = (await res.json()) as { cases?: ArhamCase[]; results?: ArhamCase[] } | ArhamCase[];
    return Array.isArray(body) ? body : body.cases ?? body.results ?? [];
  } catch {
    return [];
  }
}
