import type { DirectoryAmbulance } from "./matcher";
import { loadActiveAmbulances, loadActiveClinics, type DirectoryClinic } from "./repo";
import { findDigitRuns, maskDigitRuns } from "../agent/scrub";
import { log } from "../log";

/**
 * Plain-text coverage list for the system prompt. Contains no phone numbers: it is the only directory text that
 * reaches the model without the tool-boundary scrub, so every value is read through the digit scrubber first and a
 * phone-shaped run typed into a city, area or areas-covered cell is removed (the ingest warns about such cells).
 */
export function buildCoverageSummary(ambs: DirectoryAmbulance[], clinicRows: DirectoryClinic[]): string {
  let removed = 0;
  /** The value without its phone-shaped runs (in any script), whitespace tidied; "" when nothing else was in it. */
  const clean = (value: string): string => {
    const runs = findDigitRuns(value).length;
    if (runs === 0) return value;
    removed += runs;
    return maskDigitRuns(value, "").replace(/\s+/g, " ").trim();
  };
  const byCity = new Map<string, DirectoryAmbulance[]>();
  for (const a of ambs) {
    const city = clean(a.city);
    byCity.set(city, [...(byCity.get(city) ?? []), a]);
  }

  const lines = ["Ambulance coverage (city: areas with a unit; also covers = nearby localities served):"];
  for (const city of [...byCity.keys()].sort()) {
    const units = byCity.get(city)!;
    const areas = [...new Set(units.map((u) => (u.area ? clean(u.area) : "")).filter((a) => a !== ""))].sort();
    const covered = [...new Set(units.flatMap((u) => u.areasCovered.map(clean)))]
      .filter((c) => c !== "" && c.toLowerCase() !== city.toLowerCase() && !areas.some((a) => a.toLowerCase() === c.toLowerCase()))
      .sort();
    const partnerOnly = units.every((u) => !u.operatorIsArham);
    let line: string;
    if (areas.length === 0) {
      line = `- ${city}: whole city (${units.length} unit${units.length === 1 ? "" : "s"}${partnerOnly ? ", partner-operated" : ""})`;
      if (covered.length) line += ` (also covers ${covered.join(", ")})`;
    } else {
      line = `- ${city}: ${areas.join(", ")}`;
      if (covered.length) line += ` (also covers ${covered.join(", ")})`;
    }
    lines.push(line);
  }
  const clinicCities = [...new Set(clinicRows.map((c) => {
    const city = clean(c.city);
    const area = c.area ? clean(c.area) : "";
    return area ? `${city} (${area})` : city;
  }))].sort();
  // The hospitals and the clinic share the clinics table; find_clinics' labels say which is which.
  lines.push(clinicCities.length ? `Hospitals and clinics: ${clinicCities.join(", ")}` : "Hospitals and clinics: none listed");
  const text = lines.join("\n");
  // Counts only: the runs are directory data and stay out of logs.
  if (removed > 0) log.warn({ runs: removed }, "digits removed from the coverage summary");
  // A run cannot form across the joins above (", ", ": ", " ("); this keeps the prompt free of one even so.
  return findDigitRuns(text).length === 0 ? text : maskDigitRuns(text, "");
}

let cache: { text: string; at: number } | null = null;
const TTL_MS = 60 * 60 * 1000;

export async function getCoverageSummary(now: number = Date.now()): Promise<string> {
  if (cache && now - cache.at < TTL_MS) return cache.text;
  const [ambs, cls] = await Promise.all([loadActiveAmbulances(), loadActiveClinics()]);
  cache = { text: buildCoverageSummary(ambs, cls), at: now };
  return cache.text;
}

export function resetCoverageCache(): void {
  cache = null;
}
