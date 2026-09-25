import { describe, it, expect } from "vitest";
import { parseDirectoryCsv, normalizePhone, parseAreasCovered, isPartnerNameLeak, validateDirectoryRows, type CsvRow } from "@/server/directory/ingest";

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
  it("strips the UTF-8 byte order mark an Excel CSV export starts with", () => {
    const csv = `Type,Name,City,Area,State,Phone,Area of Operation,Category,Operated By
Ambulance,Mumbai - Ghatkopar,Mumbai,Ghatkopar,Maharashtra,7000000001,Ghatkopar,Animal Ambulance,Arham Yuva Seva Group`;
    const withBom = parseDirectoryCsv(`﻿${csv}`);
    expect(withBom.ambulances).toHaveLength(1);
    expect(withBom).toEqual(parseDirectoryCsv(csv));
  });
});

const row = (p: Partial<CsvRow> = {}): CsvRow => ({
  Type: "Ambulance", Name: "Mumbai - Ghatkopar", City: "Mumbai", Area: "Ghatkopar", State: "Maharashtra",
  Phone: "7000000001", "Area of Operation": "", Category: "Animal Ambulance", "Operated By": "Arham Yuva Seva Group", ...p,
});
const clinic = (p: Partial<CsvRow> = {}): CsvRow =>
  row({ Type: "Clinic", Name: "Arham Clinic Surat", City: "Surat", Area: "Vesu", State: "Gujarat", Phone: "02612345678", Category: "Clinic", ...p });
const MOBILE = "Phone must be an Indian mobile number: 10 digits starting 6-9, optionally after 0, 91 or +91";
const ANY_INDIAN = "Phone must be an Indian number: 10 digits, optionally after 0, 91 or +91";

describe("validateDirectoryRows", () => {
  it("accepts mobiles on ambulance rows and landlines on clinic rows, with or without 0, 91 or +91", () => {
    expect(
      validateDirectoryRows({
        ambulances: [row(), row({ Name: "B", Phone: "+91 70000 00002" }), row({ Name: "C", Phone: "07000000003" }), row({ Name: "D", Phone: "917000000004" })],
        clinics: [clinic(), clinic({ Name: "Clinic Two", Phone: "7000000005" })],
      })
    ).toEqual([]);
  });

  it("rejects an ambulance number that is not an Indian mobile, without echoing its digits", () => {
    const phones = ["", "02612345678", "700000001", "98765000012", "+1 415 555 0100", "7000000001 / 7000000002"];
    const errors = validateDirectoryRows({ ambulances: phones.map((Phone, i) => row({ Name: `Unit ${i}`, Phone })), clinics: [] });
    expect(errors).toEqual([
      'Ambulance "Unit 0": Phone is empty',
      `Ambulance "Unit 1": ${MOBILE} (the cell has 11 digits)`,
      `Ambulance "Unit 2": ${MOBILE} (the cell has 9 digits)`,
      `Ambulance "Unit 3": ${MOBILE} (the cell has 11 digits)`,
      `Ambulance "Unit 4": ${MOBILE} (the cell has 11 digits)`,
      `Ambulance "Unit 5": ${MOBILE} (the cell has 20 digits)`,
    ]);
    expect(errors.join("\n")).not.toMatch(/\d{7,}/);
  });

  it("rejects a clinic number that is not an Indian number", () => {
    expect(
      validateDirectoryRows({ ambulances: [row()], clinics: [clinic({ Phone: "700000001" }), clinic({ Name: "Zeroes", Phone: "0000000000" })] })
    ).toEqual([
      `Clinic "Arham Clinic Surat": ${ANY_INDIAN} (the cell has 9 digits)`,
      `Clinic "Zeroes": ${ANY_INDIAN} (the cell has 10 digits)`,
    ]);
  });

  it("names rows with an empty Name, City, State or Operated By", () => {
    expect(
      validateDirectoryRows({
        ambulances: [row({ City: "", State: " " }), row({ Name: "", City: "Pune" }), row({ Name: "X", "Operated By": "" })],
        clinics: [clinic({ State: "" })],
      })
    ).toEqual([
      'Ambulance "Mumbai - Ghatkopar": City is empty; State is empty',
      'Ambulance with no Name (City "Pune"): Name is empty',
      'Ambulance "X": Operated By is empty',
      'Clinic "Arham Clinic Surat": State is empty',
    ]);
  });

  it("rejects a Name used twice, ignoring case, across ambulances and clinics", () => {
    expect(
      validateDirectoryRows({ ambulances: [row({ Name: "Surat" }), row({ Name: "SURAT" })], clinics: [clinic({ Name: "surat" })] })
    ).toEqual([
      'Ambulance "SURAT": Name is already used by Ambulance "Surat"',
      'Clinic "surat": Name is already used by Ambulance "Surat"',
    ]);
  });

  it("refuses a file with no ambulance rows; a file with no clinic rows is fine", () => {
    expect(validateDirectoryRows({ ambulances: [], clinics: [clinic()] })).toEqual([
      "no ambulance rows (check the header row and the Type column)",
    ]);
    expect(validateDirectoryRows({ ambulances: [row()], clinics: [] })).toEqual([]);
  });
});
