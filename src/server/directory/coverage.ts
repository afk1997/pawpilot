import type { DirectoryAmbulance } from "./matcher";
import { loadActiveAmbulances, loadActiveClinics, type DirectoryClinic } from "./repo";

/** Plain-text coverage list for the system prompt. Contains no phone numbers. */
export function buildCoverageSummary(ambs: DirectoryAmbulance[], clinicRows: DirectoryClinic[]): string {
  const byCity = new Map<string, DirectoryAmbulance[]>();
  for (const a of ambs) byCity.set(a.city, [...(byCity.get(a.city) ?? []), a]);

  const lines = ["Ambulance coverage (city: areas with a unit; also covers = nearby localities served):"];
  for (const city of [...byCity.keys()].sort()) {
    const units = byCity.get(city)!;
    const areas = [...new Set(units.map((u) => u.area).filter((a): a is string => !!a))].sort();
    const covered = [...new Set(units.flatMap((u) => u.areasCovered))]
      .filter((c) => c.toLowerCase() !== city.toLowerCase() && !areas.some((a) => a.toLowerCase() === c.toLowerCase()))
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
  const clinicCities = [...new Set(clinicRows.map((c) => (c.area ? `${c.city} (${c.area})` : c.city)))].sort();
  lines.push(clinicCities.length ? `Clinics: ${clinicCities.join(", ")}` : "Clinics: none listed");
  return lines.join("\n");
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
