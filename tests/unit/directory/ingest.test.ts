import { describe, it, expect } from "vitest";
import {
  parseDirectoryCsv, normalizePhone, parseAreasCovered, isPartnerNameLeak, validateDirectoryRows, directoryWarnings, isArhamName,
  type CsvRow,
} from "@/server/directory/ingest";
import { findDigitRuns } from "@/server/agent/scrub";

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
    expect(isPartnerNameLeak("Arham Yuva", "arham yuva seva GROUP")).toBe(false);
  });
  it("recognises Arham's name whatever its case and spacing, and nothing else", () => {
    for (const name of ["Arham Yuva Seva Group", "arham yuva seva group", "  ARHAM  Yuva Seva\tGroup ", "ArhamYuva Seva Group"]) {
      expect(isArhamName(name), name).toBe(true);
    }
    for (const name of ["Arham Yuva Sewa Group", "Arham Yuva Seva", "Blue Cross", ""]) expect(isArhamName(name), name).toBe(false);
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
  it("reads the optional Hours and Address columns, and a file without them", () => {
    const csv = `Type,Name,City,Area,State,Phone,Area of Operation,Category,Operated By,Hours,Address
=== AMBULANCES ===,,,,,,,,,,
Ambulance,Mumbai - Ghatkopar,Mumbai,Ghatkopar,Maharashtra,7000000001,"Ghatkopar, Vikhroli",Animal Ambulance,Arham Yuva Seva Group,10am–7pm IST,
Ambulance,Rajkot - ALAI,Rajkot,ALAI Trust,Gujarat,9876500001,Entire City,Animal Ambulance,ALAI Trust,,
,,,,,,,,,,
Clinic,Kolkata - Ludlow Hospital,Kolkata,Ludlow,West Bengal,02612345678,,Hospital,Arham Yuva Seva Group,9am–6pm IST,"Near Chengail Railway Station, Howrah"`;
    const r = parseDirectoryCsv(csv);
    expect(r.ambulances.map((a) => [a.Name, a.Hours, a.Address])).toEqual([
      ["Mumbai - Ghatkopar", "10am–7pm IST", ""],
      ["Rajkot - ALAI", "", ""],
    ]);
    expect(r.clinics.map((c) => [c.Name, c.Hours, c.Address])).toEqual([["Kolkata - Ludlow Hospital", "9am–6pm IST", "Near Chengail Railway Station, Howrah"]]);
    expect(validateDirectoryRows(r)).toEqual([]);
    expect(directoryWarnings(r)).toEqual([]);
    // An older file has no such columns: the cells read as absent.
    const old = parseDirectoryCsv(`Type,Name,City,Area,State,Phone,Area of Operation,Category,Operated By
Ambulance,Mumbai - Ghatkopar,Mumbai,Ghatkopar,Maharashtra,7000000001,Ghatkopar,Animal Ambulance,Arham Yuva Seva Group`);
    expect([old.ambulances[0].Hours, old.ambulances[0].Address]).toEqual([undefined, undefined]);
  });
  it("reads a clinic's optional Maps, Page, Services and Notes columns, and a file without them", () => {
    const csv = `Type,Name,City,Area,State,Phone,Area of Operation,Category,Operated By,Hours,Address,Maps,Page,Services,Notes
Ambulance,Mumbai - Ghatkopar,Mumbai,Ghatkopar,Maharashtra,7000000001,Ghatkopar,Animal Ambulance,Arham Yuva Seva Group,10am–7pm IST,,,,,
=== HOSPITALS ===,,,,,,,,,,,,,,
Clinic,Kolkata - Ludlow Hospital,Kolkata,Ludlow,West Bengal,02612345678,,Hospital,Arham Yuva Seva Group,9am–6pm IST,"Near Chengail Railway Station, Uluberia, Howrah, West Bengal 711315","https://maps.google.com/?q=22.48413,88.13368",https://alwayscare.org/hospitals/ludlow,IPD for cats and dogs; OPD for cats; X-ray,Consultation and first-aid treatment are free; call to check charges for other treatment.
Clinic,Rajkot Clinic,"Rajkot, Gujarat",,Gujarat,02612345679,,Clinic,Arham Yuva Seva Group,10am–11pm IST,,"https://maps.google.com/?q=22.29886,70.77540",https://alwayscare.org/clinics/rajkot,,`;
    const r = parseDirectoryCsv(csv);
    expect(r.clinics.map((c) => [c.Name, c.Maps, c.Page, c.Services, c.Notes])).toEqual([
      [
        "Kolkata - Ludlow Hospital", "https://maps.google.com/?q=22.48413,88.13368", "https://alwayscare.org/hospitals/ludlow",
        "IPD for cats and dogs; OPD for cats; X-ray", "Consultation and first-aid treatment are free; call to check charges for other treatment.",
      ],
      ["Rajkot Clinic", "https://maps.google.com/?q=22.29886,70.77540", "https://alwayscare.org/clinics/rajkot", "", ""],
    ]);
    // A 5-decimal map link holds no phone-shaped run: no warning, no validation problem.
    expect(validateDirectoryRows(r)).toEqual([]);
    expect(directoryWarnings(r)).toEqual([]);
    const old = parseDirectoryCsv(`Type,Name,City,Area,State,Phone,Area of Operation,Category,Operated By,Hours,Address
Ambulance,Mumbai - Ghatkopar,Mumbai,Ghatkopar,Maharashtra,7000000001,Ghatkopar,Animal Ambulance,Arham Yuva Seva Group,,
Clinic,Arham Clinic Surat,"Surat, Gujarat",Vesu,Gujarat,02612345678,,Clinic,Arham Yuva Seva Group,,Vesu Main Road`);
    expect([old.clinics[0].Maps, old.clinics[0].Page, old.clinics[0].Services, old.clinics[0].Notes]).toEqual([undefined, undefined, undefined, undefined]);
    expect(validateDirectoryRows(old)).toEqual([]);
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
const MAPS_RULE = "Maps must be a Google Maps link to coordinates, https://maps.google.com/?q=<lat>,<lng> with at most six decimals, and nothing else";
const PAGE_RULE = (origin: string) => `Page must be a page on ${origin}, with a path of letters, digits, "/", "_" and "-" only`;
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

  it("accepts Arham's name in any case and spacing, and rejects a near-miss of it that would label Arham's units a partner's", () => {
    expect(
      validateDirectoryRows({
        ambulances: [row({ "Operated By": "arham yuva seva group" }), row({ Name: "B", "Operated By": " ARHAM  Yuva Seva Group " })],
        clinics: [clinic({ "Operated By": "Blue Cross" })],
      })
    ).toEqual([]);
    const nearMiss = (name: string) => `Operated By "${name}" is within two letters of "Arham Yuva Seva Group" but is not it: spell Arham's name exactly (a partner's name is shown to reporters as the operator)`;
    expect(
      validateDirectoryRows({
        ambulances: [
          row({ Name: "A", "Operated By": "Arham Yuva Sewa Group" }),
          row({ Name: "B", "Operated By": "Arham Yuva Seva Groups" }),
          row({ Name: "C", "Operated By": "Arham Yuva Seva Grp" }),
        ],
        clinics: [clinic({ "Operated By": "arham yuva seva grup" })],
      })
    ).toEqual([
      `Ambulance "A": ${nearMiss("Arham Yuva Sewa Group")}`,
      `Ambulance "B": ${nearMiss("Arham Yuva Seva Groups")}`,
      `Ambulance "C": ${nearMiss("Arham Yuva Seva Grp")}`,
      `Clinic "Arham Clinic Surat": ${nearMiss("arham yuva seva grup")}`,
    ]);
  });

  it("accepts only a Google Maps link to coordinates and a page on the website, and reads no link cell on an ambulance row", () => {
    const maps = "https://maps.google.com/?q=19.07948,72.90119";
    expect(
      validateDirectoryRows({
        ambulances: [row({ Maps: "near the station", Page: "alwayscare.org" })],
        clinics: [
          clinic({ Maps: ` ${maps} `, Page: "https://alwayscare.org/hospitals/ghatkopar" }),
          clinic({ Name: "Six decimals, south and west", Maps: "https://maps.google.com/?q=-9.079481,-172.901193", Page: "https://www.alwayscare.org/clinics/rajkot" }),
          clinic({ Name: "Empty", Maps: "", Page: " " }),
        ],
      })
    ).toEqual([]);
  });

  it("refuses any other Maps value, naming the row and never echoing its digits", () => {
    const zeroWidth = String.fromCharCode(0x200b);
    const others = [
      "https://wa.me/919876543210", "http://maps.google.com/?q=19.07948,72.90119", "https://maps.google.com/?q=19.07948,72.90119&z=17",
      "https://maps.google.com/maps?q=19.07948,72.90119", "https://maps.google.com/?q=19.07948,72.90119/x", "https://maps.google.com/?q=19.0794812,72.9011934",
      "https://maps.google.com/?q=Arham+Ghatkopar", "https://goo.gl/maps/abcdefgh", "https://maps.google.co.in/?q=19.07948,72.90119",
      `https://maps.google.com/?q=19.07948,72.9${zeroWidth}0119`, "maps.google.com/?q=19.07948,72.90119",
      "https://maps.google.com/?q=19.07948,72.90119 or call 98765 43210", "98765 43210",
    ];
    const errors = validateDirectoryRows({ ambulances: [row()], clinics: others.map((Maps, i) => clinic({ Name: `Clinic ${i}`, Maps })) });
    expect(errors).toEqual(others.map((_, i) => `Clinic "Clinic ${i}": ${MAPS_RULE}`));
    expect(findDigitRuns(errors.join("\n"))).toEqual([]);
  });

  it("refuses a Page that is not a page on the website, the one WEBSITE_URL names when given", () => {
    const pages = [
      "http://alwayscare.org/hospitals/ghatkopar", "https://example.org/hospitals/ghatkopar", "https://alwayscare.org.example.com/hospitals",
      "https://alwayscare.org/hospitals/ghatkopar?ref=bot", "https://alwayscare.org/#volunteer", "https://alwayscare.org", "alwayscare.org/hospitals",
    ];
    const errors = validateDirectoryRows({ ambulances: [row()], clinics: pages.map((Page, i) => clinic({ Name: `Clinic ${i}`, Page })) });
    expect(errors).toEqual(pages.map((_, i) => `Clinic "Clinic ${i}": ${PAGE_RULE("https://alwayscare.org")}`));
    const own = { websiteUrl: "https://helpline.example.org" };
    expect(validateDirectoryRows({ ambulances: [row()], clinics: [clinic({ Page: "https://helpline.example.org/hospitals/x" })] }, own)).toEqual([]);
    expect(validateDirectoryRows({ ambulances: [row()], clinics: [clinic({ Page: "https://alwayscare.org/hospitals/x" })] }, own)).toEqual([
      `Clinic "Arham Clinic Surat": ${PAGE_RULE("https://helpline.example.org")}`,
    ]);
  });

  it("accepts a phone-shaped number in a text cell (directoryWarnings names it instead)", () => {
    expect(validateDirectoryRows({ ambulances: [row({ "Area of Operation": "Ghatkopar, call 98765 43210" })], clinics: [] })).toEqual([]);
  });

  it("refuses a file with no ambulance rows; a file with no clinic rows is fine", () => {
    expect(validateDirectoryRows({ ambulances: [], clinics: [clinic()] })).toEqual([
      "no ambulance rows (check the header row and the Type column)",
    ]);
    expect(validateDirectoryRows({ ambulances: [row()], clinics: [] })).toEqual([]);
  });
});

describe("directoryWarnings", () => {
  it("names each row and text cell holding a phone-shaped number, in any script, without its digits", () => {
    const warnings = directoryWarnings({
      ambulances: [
        row({ "Area of Operation": "Ghatkopar, call 98765 43210" }),
        row({ Name: "Unit 98765-43211", Area: "Malad ९८७६५४३२१२", Category: "Animal Ambulance 7000000009", "Operated By": "Blue Cross +91 70000 00008" }),
        row({ Name: "Clean", City: "Pune", Area: "Sector 21", "Area of Operation": "Sector 21, Sector 22" }),
      ],
      clinics: [clinic({ City: "Surat 7000000007", State: "Gujarat 7000000006" })],
    });
    expect(warnings).toEqual([
      'Ambulance "Mumbai - Ghatkopar": Area of Operation holds a phone-shaped number',
      'Ambulance "Unit [number]": Name, Area, Category, Operated By hold a phone-shaped number',
      'Clinic "Arham Clinic Surat": City, State hold a phone-shaped number',
    ].map((w) => `${w}: put phone numbers only in the Phone column`));
    expect(findDigitRuns(warnings.join("\n"))).toEqual([]);
  });

  it("names the Hours and Address cells too, and never the hours as published", () => {
    const warnings = directoryWarnings({
      ambulances: [row({ Hours: "10am–7pm IST, call 98765 43210 first" }), row({ Name: "Clean", Hours: "10am–7pm IST" })],
      clinics: [
        clinic({ Hours: "10am–11pm IST", Address: "Vesu Main Road, 98765-43212" }),
        clinic({ Name: "Ludlow", Hours: "9am–6pm IST", Address: "Near Chengail Railway Station, Howrah" }),
      ],
    });
    expect(warnings).toEqual([
      'Ambulance "Mumbai - Ghatkopar": Hours holds a phone-shaped number: put phone numbers only in the Phone column',
      'Clinic "Arham Clinic Surat": Address holds a phone-shaped number: put phone numbers only in the Phone column',
    ]);
  });

  it("names the Maps, Page, Services and Notes cells too, and never a map link with 5-decimal coordinates", () => {
    const warnings = directoryWarnings({
      ambulances: [row()],
      clinics: [
        // Coordinates with seven decimals hold a phone-shaped run: the link goes out as written, so the owner is told.
        clinic({ Maps: "https://maps.google.com/?q=19.0794812,72.9011934", Page: "https://alwayscare.org/hospitals/9876543210" }),
        clinic({ Name: "Ludlow", Services: "X-ray; call 98765 43210 for the OT", Notes: "Free first aid. Ward: ९८७६५४३२१२" }),
        clinic({ Name: "Clean", Maps: "https://maps.google.com/?q=22.48413,88.13368", Page: "https://alwayscare.org/hospitals/ludlow", Services: "X-ray", Notes: "Free." }),
      ],
    });
    expect(warnings).toEqual([
      'Clinic "Arham Clinic Surat": Maps, Page hold a phone-shaped number: put phone numbers only in the Phone column',
      'Clinic "Ludlow": Services, Notes hold a phone-shaped number: put phone numbers only in the Phone column',
    ]);
    expect(findDigitRuns(warnings.join("\n"))).toEqual([]);
  });
});
