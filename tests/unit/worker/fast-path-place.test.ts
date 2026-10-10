import { describe, it, expect } from "vitest";
import { EVERYDAY_AREA_NAMES, GENERIC_AREA_WORDS, hasGenericAreaWord, isVagueAreaName, type DirectoryAmbulance } from "@/server/directory/matcher";
import { placeDecision } from "@/server/worker/fast-path";

/** A directory-like unit with a dummy phone: the place columns are what the fast path reads. */
const unit = (id: string, city: string, area: string | null, areasCovered: string[]): DirectoryAmbulance => ({
  id, label: id, city, area, state: "X", areasCovered, category: "Animal Ambulance", phone: "+910000000000",
  operatorName: "Arham Yuva Seva Group", operatorIsArham: true,
});

/** Modelled on the real directory's place columns: shared locality names, everyday-word areas, a city of one unit. */
const rows: DirectoryAmbulance[] = [
  unit("ghatkopar", "Mumbai", "Ghatkopar", ["Ghatkopar", "Vikhroli"]),
  unit("malad", "Mumbai", "Malad", ["Malad", "Kandivali"]),
  unit("andheri", "Mumbai", "Andheri", ["Andheri West", "Vile Parle West", "Juhu", "Lokhandwala"]),
  unit("miraroad", "Mumbai", "Mira Road", ["Mira Road", "Bhayandar"]),
  unit("pmc", "Pune", "PMC", ["Kothrud", "Karve Nagar", "Ghorpadi"]),
  unit("pcmc", "Pune", "PCMC", ["Pimpri Chinchwad", "Dehu Road"]),
  unit("ahmedabad", "Ahmedabad", null, ["Satellite", "Bopal", "South Bopal", "Ghuma", "Ambli"]),
  unit("delhi", "Delhi", "Old Delhi", ["Shalimar Bagh", "Model Town", "Kamla Nagar", "Patel Nagar"]),
  unit("indore", "Indore", null, ["Vijay Nagar", "Bengali Square"]),
  unit("kolkata", "Kolkata", null, ["Hazra", "Minto Park"]),
  unit("nagpur", "Nagpur", null, ["Nagpur"]),
  unit("solapur", "Solapur", null, []),
  unit("surat", "Surat", null, ["Surat", "Vesu"]),
];

const decide = (text: string) => {
  const d = placeDecision(rows, text);
  return d.fire ? { fire: true, unit: d.unit.id, matchType: d.matchType } : d;
};

describe("fast path place checks", () => {
  it.each([
    ["ghatkopar me kutta ghayal hai", "ghatkopar", "area"],
    ["Karve Nagar, Pune", "pmc", "area"], // a generic name, with the unit's city named
    ["Model Town, Delhi, dog injured", "delhi", "area"],
    ["Mira Road, Mumbai", "miraroad", "area"],
    ["south bopal me kutta ghayal hai", "ahmedabad", "area"], // the plain name "Bopal" beside the generic "South Bopal"
    ["Vikhroli station ke paas", "ghatkopar", "area"],
    ["Solapur me kutta ghayal hai", "solapur", "city"],
    ["Nagpur, injured cow", "nagpur", "area"],
    // An everyday-word area name with its city named.
    ["Satellite, Ahmedabad", "ahmedabad", "area"],
    ["Andheri West, Mumbai", "andheri", "area"],
    ["Hazra, Kolkata me kutta ghayal hai", "kolkata", "area"],
    ["Ghorpadi, Pune", "pmc", "area"],
    // A city name that is also an everyday word, next to a locative cue or alone.
    ["surat me kutta ghayal hai", "surat", "area"],
    ["Surat", "surat", "area"],
    ["સુરતમાં ગાય ઘાયલ છે", "surat", "area"],
    ["in surat, a dog is hurt", "surat", "area"],
    ["surat se hun, kutta ghayal hai", "surat", "area"],
  ])("fires for %s", (text, id, matchType) => {
    expect(decide(text)).toEqual({ fire: true, unit: id, matchType });
  });

  it.each([
    ["Model Town, Ludhiana", "generic_area"],
    ["Vijay Nagar, Jabalpur", "generic_area"],
    ["Patel Nagar, Dehradun me kutta ghayal", "generic_area"],
    ["Kamla Nagar, Agra, injured cow", "generic_area"],
    ["Karve Nagar me kutta ghayal hai", "generic_area"],
    ["mira road me kutta", "generic_area"],
    // Area names that are also everyday words, verb forms or surnames need their city named.
    ["ambli na jhad pase kutru ghayal che", "generic_area"],
    ["Satellite ke paas kutta ghayal hai", "generic_area"],
    ["gaadi ghuma rahe the, kutta ghayal ho gaya", "generic_area"],
    ["Hazra ji ka kutta ghayal hai, Lucknow", "generic_area"],
    ["Lokhandwala ji ki gali me kutta ghayal hai", "generic_area"],
    ["andheri raat me kutta ghayal pada tha", "generic_area"],
    ["andheri west me kutta ghayal hai", "generic_area"],
    ["ghorpadi disli", "generic_area"], // monitor lizards (Marathi घोरपडी), an animal people report
    ["kutte ki surat pe chot hai", "everyday_city"], // the dog's face
    ["कुत्ते की सूरत पर चोट है", "everyday_city"],
    ["kutte ki surat se khoon aa raha hai", "everyday_city"], // a cue after a possessive: still the face
    ["Mumbai me gaadi ghuma rahe the", "other_city"],
    ["Hazra ji ka kutta ghayal hai, Mumbai", "other_city"],
    ["Ghatkopar, Pune", "other_city"],
    ["Solapur aur Nagpur me kutte ghayal hain", "other_city"],
    ["Model Town, Mumbai", "other_city"],
    ["Mumbai", "no_single_match"],
    ["Ghatkoparr", "no_single_match"],
    ["the dog is bleeding", "no_single_match"],
  ])("leaves %s to the model (%s)", (text, reason) => {
    expect(decide(text)).toEqual({ fire: false, reason });
  });

  it("reads a generic word as a whole word of the area name, in any case", () => {
    for (const name of ["Model Town", "Vijay Nagar", "MIRA ROAD", "Andheri West", "Old Delhi", "Central-Egmore", "South Bopal"]) {
      expect(hasGenericAreaWord(name), name).toBe(true);
    }
    for (const name of ["Ghatkopar", "Ramdevnagar", "Shivajinagar", "Ranigunj", "Satellite", "Shalimar Bagh", "Bengali Square"]) {
      expect(hasGenericAreaWord(name), name).toBe(false);
    }
  });

  it("reads an everyday-word area name as vague, like a generic one", () => {
    for (const name of ["Satellite", "Ghuma", "Ambli", "Khadki", "Lokhandwala", "Hazra", "Andheri", "Andheri West", "Khar", "Sela", "Ghorpadi", "Model Town"]) {
      expect(isVagueAreaName(name), name).toBe(true);
    }
    // Whole words only: Kharghar holds "khar" but is not Khar.
    for (const name of ["Ghatkopar", "Bopal", "Vikhroli", "Kharghar"]) expect(isVagueAreaName(name), name).toBe(false);
    expect(hasGenericAreaWord("Satellite")).toBe(false);
    expect([...EVERYDAY_AREA_NAMES]).toEqual(["satellite", "ghuma", "ambli", "khadki", "lokhandwala", "hazra", "andheri", "khar", "sela", "ghorpadi"]);
  });

  it("is the one generic word list the ruling fixed", () => {
    expect([...GENERIC_AREA_WORDS]).toEqual([
      "nagar", "town", "colony", "road", "park", "garden", "vihar", "puram", "gunj", "ganj", "chowk", "market", "marg", "gali",
      "society", "sector", "phase", "block", "layout", "extension", "enclave", "camp", "lines", "bazaar", "bazar", "basti",
      "model", "new", "old", "east", "west", "north", "south", "central",
    ]);
  });
});
