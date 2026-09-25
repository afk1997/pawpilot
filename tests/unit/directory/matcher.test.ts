import { describe, it, expect } from "vitest";
import { matchAmbulances, normalize, type DirectoryAmbulance } from "@/server/directory/matcher";

const row = (p: Partial<DirectoryAmbulance> & Pick<DirectoryAmbulance, "id" | "city">): DirectoryAmbulance => ({
  label: p.id, area: null, state: "X", areasCovered: [], category: "Animal Ambulance", phone: "+910000000000",
  operatorName: "Arham Yuva Seva Group", operatorIsArham: true, ...p,
});

const rows: DirectoryAmbulance[] = [
  row({ id: "ghatkopar", city: "Mumbai", area: "Ghatkopar", areasCovered: ["Ghatkopar", "Vikhroli", "Kurla"] }),
  row({ id: "malad", city: "Mumbai", area: "Malad", areasCovered: ["Malad", "Kandivali"] }),
  row({ id: "andheri", city: "Mumbai", area: "Andheri", areasCovered: ["Andheri", "Jogeshwari"] }),
  row({ id: "bandra", city: "Mumbai", area: "Bandra", areasCovered: ["Bandra", "Khar"] }),
  row({ id: "rajkotA", city: "Rajkot", areasCovered: ["Rajkot"], operatorName: "Blue Cross", operatorIsArham: false }),
  row({ id: "rajkotB", city: "Rajkot", areasCovered: ["Rajkot"], operatorName: "Hope for Indies Trust", operatorIsArham: false }),
  row({ id: "bengaluru", city: "Bengaluru", areasCovered: ["Bengaluru"] }),
  row({ id: "surat", city: "Surat", areasCovered: ["Surat", "Vesu"] }),
];
const ids = (r: { candidates: DirectoryAmbulance[] }) => r.candidates.map((c) => c.id).sort();

describe("normalize", () => {
  it("lowercases, strips punctuation, applies aliases", () => {
    expect(normalize("Munbai - Goregaon!")).toBe("munbai goregaon");
    expect(normalize("Bangalore Indiranagar")).toBe("bengaluru indiranagar");
    expect(normalize("मुंबई घाटकोपर")).toBe("mumbai ghatkopar");
    expect(normalize("સુરત")).toBe("surat");
  });

  it("ignores inherited object keys when looking up aliases", () => {
    expect(normalize("constructor")).toBe("constructor");
  });

  it("NFC-normalizes input so a precomposed nukta spelling still aliases", () => {
    expect(normalize("गुड़गांव".normalize("NFD"))).toBe("gurugram");
    // U+095C is a composition exclusion: NFD and NFC both give ड + ़, so only an
    // explicit escape produces the precomposed letter a keyboard may send.
    expect(normalize("\u0917\u0941\u095C\u0917\u093E\u0902\u0935")).toBe("gurugram");
  });
});

describe("matchAmbulances", () => {
  it("tier area: exact area wins over city", () => {
    const r = matchAmbulances(rows, { city: "Mumbai", area: "Ghatkopar", query: "ghatkopar" });
    expect(ids(r)).toEqual(["ghatkopar"]);
    expect(r.match).toBe("area");
  });

  it("tier city: city with many units returns all and the area list", () => {
    const r = matchAmbulances(rows, { city: "Mumbai", area: null, query: "mumbai" });
    expect(ids(r)).toEqual(["andheri", "bandra", "ghatkopar", "malad"]);
    expect(r.match).toBe("city");
    expect(r.cityAreas).toEqual(["Andheri", "Bandra", "Ghatkopar", "Malad"]);
  });

  it("city with two partner units and no areas returns both (Rajkot)", () => {
    const r = matchAmbulances(rows, { query: "rajkot" });
    expect(ids(r)).toEqual(["rajkotA", "rajkotB"]);
    expect(r.cityAreas).toBeNull();
  });

  it("alias: Bangalore resolves to Bengaluru", () => {
    expect(ids(matchAmbulances(rows, { query: "Bangalore" }))).toEqual(["bengaluru"]);
  });

  it("fuzzy: Munbai typo resolves to Mumbai units", () => {
    const r = matchAmbulances(rows, { query: "munbai" });
    expect(r.match).toBe("fuzzy");
    expect(ids(r)).toEqual(["andheri", "bandra", "ghatkopar", "malad"]);
  });

  it("neighbour: Goregaon maps to Malad/Andheri", () => {
    const r = matchAmbulances(rows, { city: "Mumbai", area: "Goregaon", query: "goregaon" });
    expect(r.match).toBe("neighbour");
    expect(ids(r)).toEqual(["andheri", "malad"]);
  });

  it("Devanagari area matches via aliases", () => {
    expect(ids(matchAmbulances(rows, { query: "घाटकोपर में कुत्ता" }))).toEqual(["ghatkopar"]);
  });

  it("Gujarati city matches via aliases", () => {
    expect(ids(matchAmbulances(rows, { query: "સુરતમાં ગાય ઘાયલ છે" }))).toEqual(["surat"]);
  });

  it("out of coverage returns empty", () => {
    const r = matchAmbulances(rows, { query: "Lucknow" });
    expect(r.candidates).toEqual([]);
    expect(r.outOfCoverage).toBe(true);
  });

  it("city restricts area search to that city", () => {
    const r = matchAmbulances(rows, { city: "Rajkot", area: "Ghatkopar", query: "ghatkopar rajkot" });
    expect(ids(r)).toEqual(["rajkotA", "rajkotB"]);
  });

  it("area first: a city in the free text does not pre-empt the area's neighbours", () => {
    const r = matchAmbulances(rows, { city: "Mumbai", area: "Goregaon", query: "Goregaon, Mumbai" });
    expect(r.match).toBe("neighbour");
    expect(ids(r)).toEqual(["andheri", "malad"]);
  });

  it("area first: an unknown area falls through to the city", () => {
    const r = matchAmbulances(rows, { city: "Mumbai", area: "Nowhere", query: "Nowhere, Mumbai" });
    expect(r.match).toBe("city");
    expect(ids(r)).toEqual(["andheri", "bandra", "ghatkopar", "malad"]);
  });

  it("Station Road, Ghatkopar: an exact area wins and generic street words match nothing", () => {
    const withMira = [...rows, row({ id: "mira", city: "Mumbai", area: "Mira Road", areasCovered: ["Mira Road", "Bhayandar"] })];
    expect(ids(matchAmbulances(withMira, { city: "Mumbai", area: "Station Road", query: "Station Road, Ghatkopar" }))).toEqual(["ghatkopar"]);
    expect(ids(matchAmbulances(withMira, { query: "Station Road" }))).toEqual([]);
  });

  it("a direction word does not stop an exact area match (andheri east)", () => {
    expect(ids(matchAmbulances(rows, { query: "andheri east" }))).toEqual(["andheri"]);
  });
});
