import { describe, it, expect } from "vitest";
import { buildCoverageSummary } from "@/server/directory/coverage";
import type { DirectoryAmbulance } from "@/server/directory/matcher";
import { findDigitRuns } from "@/server/agent/scrub";

const amb = (id: string, city: string, area: string | null, areas: string[], arham = true): DirectoryAmbulance => ({
  id, label: id, city, area, state: "S", areasCovered: areas, category: "Animal Ambulance", phone: "+910000000000",
  operatorName: arham ? "Arham Yuva Seva Group" : "Blue Cross", operatorIsArham: arham,
});

describe("buildCoverageSummary", () => {
  it("lists cities with their areas and extra covered localities, never phones", () => {
    const text = buildCoverageSummary(
      [
        amb("g", "Mumbai", "Ghatkopar", ["Ghatkopar", "Vikhroli"]),
        amb("m", "Mumbai", "Malad", ["Malad", "Kandivali"]),
        amb("r1", "Rajkot", null, ["Rajkot"], false),
        amb("r2", "Rajkot", null, ["Rajkot"], false),
      ],
      [{ id: "c", label: "Arham Clinic Surat", city: "Surat", area: "Vesu", state: "Gujarat", phone: "+912612345678", address: null, hours: null }]
    );
    expect(text).toContain("- Mumbai: Ghatkopar, Malad (also covers Kandivali, Vikhroli)");
    expect(text).toContain("- Rajkot: whole city (2 units, partner-operated)");
    expect(text).toContain("Clinics: Surat (Vesu)");
    expect(text).not.toMatch(/\d{7,}/);
  });

  it("removes a phone-shaped run typed into any directory cell, in any script, before the summary reaches the prompt", () => {
    const text = buildCoverageSummary(
      [
        amb("g", "Mumbai", "Ghatkopar 70000 00009", ["Ghatkopar 70000 00009", "Vikhroli, call 98765-43210", "९८७६५४३२१०", "Kurla"]),
        amb("p", "Pune ७०००००००१०", null, ["Pune ७०००००००१०"]),
      ],
      [{ id: "c", label: "Arham Clinic Surat", city: "Surat", area: "Vesu +91 98765 43211", state: "Gujarat", phone: "+912612345678", address: null, hours: null }]
    );
    expect(findDigitRuns(text)).toEqual([]);
    expect(text).toContain("- Mumbai: Ghatkopar (also covers Kurla, Vikhroli, call)");
    expect(text).toContain("- Pune: whole city (1 unit)");
    expect(text).toContain("Clinics: Surat (Vesu)");
  });
});
