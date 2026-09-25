import { describe, it, expect } from "vitest";
import { parseDirectoryCsv, normalizePhone, parseAreasCovered, isPartnerNameLeak } from "@/server/directory/ingest";

describe("ingest helpers", () => {
  it("normalizes phones to E.164", () => {
    expect(normalizePhone("6262 0909 15")).toBe("+916262090915");
    expect(normalizePhone("916262090915")).toBe("+916262090915");
    expect(normalizePhone("06262090915")).toBe("+916262090915");
  });
  it("parses areas covered", () => {
    expect(parseAreasCovered("Entire City", "Rajkot", "")).toEqual(["Rajkot"]);
    expect(parseAreasCovered("Ghatkopar, Vikhroli ,Kurla", "Mumbai", "Ghatkopar")).toEqual(["Ghatkopar", "Vikhroli", "Kurla"]);
    expect(parseAreasCovered("", "Mumbai", "Malad")).toEqual(["Malad"]);
  });
  it("detects partner names leaked into the area column", () => {
    expect(isPartnerNameLeak("ALAI Trust", "ALAI Trust")).toBe(true);
    expect(isPartnerNameLeak("K9 Safe Animal", "K9 Safe Animal - Vision Gaushala")).toBe(true);
    expect(isPartnerNameLeak("Ghatkopar", "Arham Yuva Seva Group")).toBe(false);
  });
  it("splits ambulances and clinics", () => {
    const csv = `Type,Name,City,Area,State,Phone,Area of Operation,Category,Operated By
Ambulance,Mumbai - Ghatkopar,Mumbai,Ghatkopar,Maharashtra,7000000001,"Ghatkopar, Vikhroli",Animal Ambulance,Arham Yuva Seva Group
Clinic,Arham Clinic Surat,"Surat, Gujarat",Vesu,Gujarat,02612345678,,Clinic,Arham Yuva Seva Group
Note,ignore me,,,,,,,`;
    const r = parseDirectoryCsv(csv);
    expect(r.ambulances).toHaveLength(1);
    expect(r.clinics).toHaveLength(1);
  });
});
