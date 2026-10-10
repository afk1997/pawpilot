import { describe, it, expect } from "vitest";
import {
  EVERYDAY_CITY_NAMES, FACILITY_WORDS, areaNamesIn, cityCueNear, citiesNamed, hasFacilityWord, listedWordFinder, matchAmbulances, normalize,
  precisionIssue, textNames, type DirectoryAmbulance,
} from "@/server/directory/matcher";
import { aliasOfToken } from "@/server/directory/aliases";

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

  it("resolves the short-u सुरत spelling and Marathi locatives", () => {
    expect(normalize("सुरत")).toBe("surat");
    // मुंबईला and नागपुरात resolve by suffix stripping; पुण्यात and मुंबईत need their explicit branches.
    expect(normalize("मुंबईला नागपुरात पुण्यात मुंबईत")).toBe("mumbai nagpur pune mumbai");
  });

  it("reads Akola in Devanagari and Gujarati, with its case suffixes and its Marathi locative", () => {
    expect(normalize("अकोला")).toBe("akola");
    expect(normalize("અકોલા")).toBe("akola");
    expect(normalize("अकोला मध्ये कुत्रा जखमी")).toBe("akola मध्ये कुत्रा जखमी");
    // अकोलामध्ये and અકોલામાં strip their suffix; अकोल्यात changes the stem, like पुण्यात.
    expect(normalize("अकोलामध्ये अकोल्यात અકોલામાં")).toBe("akola akola akola");
  });

  it("names the case suffix a token carried when it aliases (aliasOfToken)", () => {
    expect(aliasOfToken("સુરતમાં")).toEqual({ name: "surat", suffix: "માં" });
    expect(aliasOfToken("सूरत")).toEqual({ name: "surat", suffix: null });
    expect(aliasOfToken("bombay")).toEqual({ name: "mumbai", suffix: null });
    expect(aliasOfToken("अकोल्यात")).toEqual({ name: "akola", suffix: "त" });
    expect(aliasOfToken("surat")).toBeNull();
    expect(aliasOfToken("constructor")).toBeNull();
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

  it("fuzzy: a six-letter misspelling finds a five-letter place (suratt, malaad)", () => {
    const surat = matchAmbulances(rows, { query: "suratt me gaay ghayal hai" });
    expect([surat.match, ids(surat)]).toEqual(["fuzzy", ["surat"]]);
    const malad = matchAmbulances(rows, { query: "malaad station ke paas" });
    expect([malad.match, ids(malad)]).toEqual(["fuzzy", ["malad"]]);
  });

  it("neighbour: Goregaon maps to Malad/Andheri", () => {
    const r = matchAmbulances(rows, { city: "Mumbai", area: "Goregaon", query: "goregaon" });
    expect(r.match).toBe("neighbour");
    expect(ids(r)).toEqual(["andheri", "malad"]);
  });

  it("Devanagari area matches via aliases", () => {
    expect(ids(matchAmbulances(rows, { query: "घाटकोपर में कुत्ता" }))).toEqual(["ghatkopar"]);
  });

  it("Akola's Devanagari and Gujarati names match its unit", () => {
    const withAkola = [...rows, row({ id: "akola", city: "Akola", areasCovered: ["Akola"] })];
    for (const query of ["अकोला मध्ये कुत्रा जखमी", "अकोल्यात कुत्रा जखमी आहे", "અકોલામાં ગાય ઘાયલ છે"]) {
      expect(ids(matchAmbulances(withAkola, { query })), query).toEqual(["akola"]);
    }
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

  it("covered city with no recognisable place falls back to the whole city", () => {
    const r = matchAmbulances(rows, { city: "Mumbai", area: null, query: "near the station" });
    expect(r.match).toBe("city");
    expect(ids(r)).toEqual(["andheri", "bandra", "ghatkopar", "malad"]);
    expect(r.cityAreas).toEqual(["Andheri", "Bandra", "Ghatkopar", "Malad"]);
  });

  describe("with a Chembur unit covering Tilak Nagar", () => {
    const withChembur = [...rows, row({ id: "chembur", city: "Mumbai", area: "Chembur", areasCovered: ["Chembur", "Tilak Nagar"] })];

    it("exact first: an exact area in the free text beats looser matches from the area", () => {
      expect(ids(matchAmbulances(withChembur, { city: "Mumbai", area: "Pant Nagar", query: "Pant Nagar, Ghatkopar" }))).toEqual(["ghatkopar"]);
      // With "nagar" generic the line above passes even without exact-first; this one does
      // not: the area's neighbour tier (Malad, Andheri) must lose to the exact "Malad".
      expect(ids(matchAmbulances(withChembur, { city: "Mumbai", area: "Goregaon", query: "Goregaon, near Malad" }))).toEqual(["malad"]);
    });

    it("a generic locality word alone matches nothing (Pant Nagar)", () => {
      expect(ids(matchAmbulances(withChembur, { query: "Pant Nagar" }))).toEqual([]);
    });
  });

  it("a city merely similar to a covered one gets no fallback (Nagaur is not Nagpur)", () => {
    const withNagpur = [...rows, row({ id: "nagpur", city: "Nagpur", areasCovered: ["Nagpur"] })];
    const r = matchAmbulances(withNagpur, { city: "Nagaur", query: "gaay ghayal hai" });
    expect(r.candidates).toEqual([]);
    expect(r.outOfCoverage).toBe(true);
  });

  it("an uncovered city passed as the city is out of coverage (Lucknow)", () => {
    const r = matchAmbulances(rows, { city: "Lucknow", query: "Lucknow" });
    expect(r.candidates).toEqual([]);
    expect(r.outOfCoverage).toBe(true);
  });

  it("a bare generic word matches nothing, not even as a substring (Nagar, Road)", () => {
    const withGeneric = [
      ...rows,
      row({ id: "chembur", city: "Mumbai", area: "Chembur", areasCovered: ["Chembur", "Tilak Nagar"] }),
      row({ id: "mira", city: "Mumbai", area: "Mira Road", areasCovered: ["Mira Road", "Bhayandar"] }),
    ];
    expect(ids(matchAmbulances(withGeneric, { query: "Nagar" }))).toEqual([]);
    expect(ids(matchAmbulances(withGeneric, { query: "Road" }))).toEqual([]);
  });

  it("an ordinary word never breaks the neighbour lookup (constructor)", () => {
    const r = matchAmbulances(rows, { query: "dog near the constructor site" });
    expect(r.candidates).toEqual([]);
    expect(r.outOfCoverage).toBe(true);
  });

  it("neighbour keys match a word or an adjacent word pair inside longer text", () => {
    const r = matchAmbulances(rows, { query: "goregaon east mein kutta" });
    expect(r.match).toBe("neighbour");
    expect(ids(r)).toEqual(["andheri", "malad"]);
    expect(ids(matchAmbulances(rows, { query: "dog hurt near vile parle east station" }))).toEqual(["andheri"]);
  });

  describe("filler words in the reporter's text", () => {
    const withDadar = [...rows, row({ id: "dadar", city: "Mumbai", area: "Dadar", areasCovered: ["Dadar", "Matunga"] })];

    it.each([
      "Lucknow mein kutta ghayal hai madad karo", // madad is one letter from Malad
      "Lucknow mein mere ghar ke paas kutta ghayal hai", // ghar is one letter from Khar
      "Lucknow mein haalat bahut kharab hai", // the neighbour key "khar" is inside "kharab"
      "Lucknow mein bahut tension hai", // the neighbour key "sion" is inside "tension"
    ])("match no unit in an uncovered city: %s", (query) => {
      const r = matchAmbulances(withDadar, { city: "Lucknow", query });
      expect(r.candidates).toEqual([]);
      expect(r.outOfCoverage).toBe(true);
    });

    it("a word from a unit's label matches nothing (hope you can help)", () => {
      const labelled = rows.map((u) => (u.id === "rajkotB" ? { ...u, label: "Rajkot - Hope" } : u));
      const r = matchAmbulances(labelled, { query: "hope you can help" });
      expect(r.candidates).toEqual([]);
      expect(r.outOfCoverage).toBe(true);
      // A bare label word is a whole-needle substring (tier 3) rather than a token (tier 4).
      expect(ids(matchAmbulances(labelled, { query: "Hope" }))).toEqual([]);
    });

    it("in a covered city they fall back to the whole city (Borivali)", () => {
      const r = matchAmbulances(rows, { city: "Mumbai", area: "Borivali", query: "Borivali mein mere ghar ke paas kutta ghayal hai" });
      expect(r.match).toBe("city");
      expect(ids(r)).toEqual(["andheri", "bandra", "ghatkopar", "malad"]);
    });
  });

  describe("with place names that contain everyday words", () => {
    const withWords = [
      ...rows,
      row({ id: "indore", city: "Indore", area: "Bengali Square", areasCovered: ["Bengali Square"] }),
      row({ id: "lokhandwala", city: "Mumbai", area: "Lokhandwala", areasCovered: ["Lokhandwala", "Vile Parle"] }),
      row({ id: "ambegaon", city: "Pune", area: "Ambegaon", areasCovered: ["Ambegaon"] }),
    ];

    it.each([
      "hamari gali mein kutta ghayal hai", // "gali" (lane) is inside "Bengali Square"
      "ambulance wala ka number do", // "wala" is inside "Lokhandwala"
      "mere gaon mein kutta ghayal hai", // "gaon" (village) is inside "Ambegaon"
      "sab dukaan band hai, kutta ghayal hai", // "band" (closed) starts "Bandra" but is shorter than 5
    ])("a short word inside or at the start of a place name matches nothing: %s", (query) => {
      expect(ids(matchAmbulances(withWords, { query }))).toEqual([]);
    });

    it("tier area: a two-word area in the reporter's words is an exact match (vile parle)", () => {
      const r = matchAmbulances(withWords, { query: "dog hurt near vile parle east station" });
      expect(r.match).toBe("area");
      expect(ids(r)).toEqual(["lokhandwala"]);
      expect(matchAmbulances(withWords, { query: "Vile Parle" }).match).toBe("area");
    });

    it("a whole place word or a 5+ letter start of one still matches (kandi, parle)", () => {
      expect(ids(matchAmbulances(withWords, { query: "kandi" }))).toEqual(["malad"]);
      // Alone, "kandi" is a whole-needle substring (tier 3); in a sentence only tier 4's prefix rule finds it.
      const kandi = matchAmbulances(withWords, { query: "kandi east mein kutta ghayal hai" });
      expect(kandi.match).toBe("token");
      expect(ids(kandi)).toEqual(["malad"]);
      // "parle" is the second word of "Vile Parle": a whole word anywhere in the name counts.
      const parle = matchAmbulances(withWords, { query: "parle east mein kutta ghayal hai" });
      expect(parle.match).toBe("token");
      expect(ids(parle)).toEqual(["lokhandwala"]);
    });
  });
});

describe("citiesNamed", () => {
  const withPairs = [...rows, row({ id: "navi", city: "Navi Mumbai", areasCovered: ["Vashi"] }), row({ id: "mandvi", city: "Mandvi - Kutch", areasCovered: ["Mandvi - Kutch"] })];

  it("finds each directory city the text names once, as the rows spell it", () => {
    expect(citiesNamed(rows, "ghatkopar me kutta ghayal hai")).toEqual([]);
    expect(citiesNamed(rows, "Ghatkopar, Mumbai")).toEqual(["Mumbai"]);
    expect(citiesNamed(rows, "rajkot ya surat, rajkot")).toEqual(["Rajkot", "Surat"]);
    expect(citiesNamed(rows, "")).toEqual([]);
  });

  it("reads the text as the city tier does: aliases, Devanagari and Gujarati names, suffixes", () => {
    expect(citiesNamed(rows, "Bangalore, a cat is hurt")).toEqual(["Bengaluru"]);
    expect(citiesNamed(rows, "मुंबई में कुत्ता घायल है")).toEqual(["Mumbai"]);
    expect(citiesNamed(rows, "સુરતમાં ગાય ઘાયલ છે")).toEqual(["Surat"]);
    expect(citiesNamed(rows, "Bombay")).toEqual(["Mumbai"]);
  });

  it("finds a city of two words as a pair, and never a word inside another word", () => {
    expect(citiesNamed(withPairs, "dog hurt in Navi Mumbai")).toEqual(["Mumbai", "Navi Mumbai"]);
    expect(citiesNamed(withPairs, "Mandvi, Kutch me gaay")).toEqual(["Mandvi - Kutch"]);
    expect(citiesNamed(withPairs, "mandvi me gaay")).toEqual([]);
    expect(citiesNamed(rows, "suratwala dog")).toEqual([]);
  });
});

describe("areaNamesIn", () => {
  const ghatkopar = rows.find((r) => r.id === "ghatkopar")!;

  it("gives the unit's area names the text names as tier 1 reads it, as the directory spells them", () => {
    expect(areaNamesIn(ghatkopar, "ghatkopar me kutta")).toEqual(["Ghatkopar"]);
    expect(areaNamesIn(ghatkopar, "Vikhroli station ke paas")).toEqual(["Vikhroli"]);
    expect(areaNamesIn(ghatkopar, "kurla ya vikhroli")).toEqual(["Vikhroli", "Kurla"]);
    expect(areaNamesIn(ghatkopar, "घाटकोपर")).toEqual(["Ghatkopar"]);
    expect(areaNamesIn(ghatkopar, "mumbai")).toEqual([]);
    expect(areaNamesIn(ghatkopar, "")).toEqual([]);
  });

  it("finds a two-word name as a pair and a short name only as the whole text", () => {
    const pune = row({ id: "pmc", city: "Pune", area: "PMC", areasCovered: ["Kothrud", "Karve Nagar"] });
    expect(areaNamesIn(pune, "Karve Nagar, Pune")).toEqual(["Karve Nagar"]);
    expect(areaNamesIn(pune, "PMC")).toEqual(["PMC"]);
    expect(areaNamesIn(pune, "pmc area")).toEqual([]);
  });
});

describe("textNames", () => {
  it("is true for the whole text or a run of its words, after normalize", () => {
    expect(textNames("Karve Nagar, Pune", "Pune")).toBe(true);
    expect(textNames("karve nagar pune", "Karve Nagar")).toBe(true);
    expect(textNames("मुंबईत", "Mumbai")).toBe(true);
    expect(textNames("Karve Nagar", "PMC")).toBe(false);
    expect(textNames("punekar", "Pune")).toBe(false);
    expect(textNames("anything", "")).toBe(false);
  });
});

describe("precisionIssue", () => {
  const withShared = [
    ...rows,
    row({ id: "delhi", city: "Delhi", area: "Old Delhi", areasCovered: ["Model Town"] }),
    row({ id: "ludhiana", city: "Ludhiana", areasCovered: ["Model Town"] }),
    row({ id: "pmc", city: "Pune", area: "PMC", areasCovered: ["Karve Nagar"] }),
    row({ id: "ahmedabad", city: "Ahmedabad", areasCovered: ["Satellite", "Ghuma"] }),
  ];
  const issue = (text: string, knownCity?: string | null) =>
    precisionIssue(withShared, text, matchAmbulances(withShared, { query: text }), { knownCity });

  it("is null for precise words: a plain area, a generic one with its city, several units of the named city", () => {
    expect(issue("ghatkopar me kutta ghayal hai")).toBeNull();
    expect(issue("Karve Nagar, Pune")).toBeNull();
    expect(issue("rajkot me gaay ghayal hai")).toBeNull(); // two units, both in Rajkot
  });

  it("is other_city when a named city is not every matched unit's", () => {
    expect(issue("Ghatkopar, Pune")).toBe("other_city");
    // Model Town is both Delhi's and Ludhiana's: naming either city leaves the other city's unit in the match, which the
    // model then narrows with a lookup restricted to the named city.
    expect(issue("Model Town, Ludhiana, dog hurt")).toBe("other_city");
    expect(issue("Model Town, Delhi")).toBe("other_city");
  });

  it("is generic_area when some unit is reached only through generic names and its city is not named", () => {
    expect(issue("Karve Nagar me kutta ghayal hai")).toBe("generic_area");
    expect(issue("Model Town me kutta ghayal hai")).toBe("generic_area");
  });

  it("is everyday_city when the words reach a city only through a name that is also an everyday word, with no locative cue", () => {
    // सूरत and "surat" are also a face: "the dog's face is hurt".
    expect(issue("kutte ki surat pe chot hai")).toBe("everyday_city");
    expect(issue("कुत्ते की सूरत पर चोट है")).toBe("everyday_city");
    expect(issue("uski surat kharab ho gayi hai")).toBe("everyday_city");
    // The name next to a locative cue, or alone, names the city.
    for (const text of ["surat me kutta ghayal hai", "Surat", "सूरतમાં", "સુરતમાં", "in surat", "near Surat station", "surat se hun", "Surat city", "सूरत में कुत्ता घायल है", "સુરતમાં ગાય ઘાયલ છે"]) {
      expect(issue(text), text).toBeNull();
    }
    // A city match (the real directory's Surat units cover their areas, not the city's name) follows the same rule.
    const byArea = [row({ id: "vesu", city: "Surat", area: "Vesu", areasCovered: ["Vesu"] }), row({ id: "varachha", city: "Surat", area: "Varachha", areasCovered: ["Varachha"] })];
    const cityIssue = (text: string) => precisionIssue(byArea, text, matchAmbulances(byArea, { query: text }));
    expect(matchAmbulances(byArea, { query: "kutte ki surat pe chot hai" }).match).toBe("city");
    expect(cityIssue("kutte ki surat pe chot hai")).toBe("everyday_city");
    expect(cityIssue("surat me kutta ghayal hai")).toBeNull();
    // An area named beside it pins the place.
    expect(cityIssue("Vesu, kutte ki surat pe chot hai")).toBeNull();
    // The city the conversation already knows counts as named.
    expect(issue("kutte ki surat pe chot hai", "Surat")).toBeNull();
    expect(issue("kutte ki surat pe chot hai", "Mumbai")).toBe("everyday_city");
  });

  it("reads the name after a possessive as a face, whatever cue follows it", () => {
    // "se" is a cue ("surat se hun", from Surat), but after "ki" the name is the dog's face: blood from it.
    expect(issue("kutte ki surat se khoon aa raha hai")).toBe("everyday_city");
    expect(issue("uski surat me kuch ho gaya hai")).toBe("everyday_city");
    expect(issue("कुत्ते की सूरत में चोट है")).toBe("everyday_city");
    // Without a possessive before it, the cue names the city.
    expect(issue("surat se hun")).toBeNull();
    expect(issue("surat me kutta ghayal hai")).toBeNull();
    // Another occurrence next to a cue, and after no possessive, still names it.
    expect(issue("kutte ki surat pe chot hai, hum surat me hain")).toBeNull();
  });

  it("reads the name in an idiom, or with a face word within two words before it, as never the city", () => {
    for (const text of [
      "kisi bhi surat mein", "is surat me", "किसी भी सूरत में", "ऐसी सूरत में", "kutte ki to surat kharab hai", "kutte ki puri surat me khoon hai",
      "kisi bhi surat mein madad karo, kutta ghayal hai", "is surat me kya karein", "किसी भी सूरत में मदद कीजिए", "ऐसी सूरत में क्या करें",
      "kutte ki to surat hi bigad gayi hai", "uski to surat pe khoon hai",
    ]) {
      expect(issue(text), text).toBe("everyday_city");
      // The known city elsewhere does not make the idiom's word name Surat.
      expect(issue(text, "Mumbai"), text).toBe("everyday_city");
    }
    for (const text of ["surat me kutta ghayal hai", "Adajan, Surat", "सूरत मे", "in surat", "sorry, it is in surat", "the dog is in Surat"]) {
      expect(issue(text), text).toBeNull();
    }
  });

  it("looks only two words back: a face word three words before the name is a known residual", () => {
    expect(issue("kutte ki naak aur surat se khoon aa raha hai")).toBeNull();
  });

  it("holds the words to the city the conversation knows, unless they name the unit's city", () => {
    // A unit elsewhere, its city unnamed: the known city stands.
    expect(issue("gaadi ghuma rahe the tab dekha", "Mumbai")).toBe("other_city");
    expect(issue("Karve Nagar me", "Mumbai")).toBe("other_city");
    // A new covered city named in the words, or a unit in the known city, is precise.
    expect(issue("sorry, it is in surat", "Mumbai")).toBeNull();
    expect(issue("vikhroli me ek aur kutta", "Mumbai")).toBeNull();
    expect(issue("vikhroli me ek aur kutta", "Bombay")).toBeNull();
    // The known city counts as named for generic_area.
    expect(issue("Karve Nagar me", "Pune")).toBeNull();
    expect(issue("Karve Nagar me")).toBe("generic_area");
    // No known city: the words alone decide. Ghuma is also a verb (EVERYDAY_AREA_NAMES), so it needs Ahmedabad named.
    expect(issue("vikhroli me ek aur kutta")).toBeNull();
    expect(issue("vikhroli me ek aur kutta", null)).toBeNull();
    expect(issue("gaadi ghuma rahe the tab dekha")).toBe("generic_area");
    expect(issue("gaadi ghuma rahe the, Ahmedabad")).toBeNull();
  });
});

describe("cityCueNear", () => {
  it("is true for the name alone or next to a locative cue, in any spelling the aliases read", () => {
    for (const text of ["Surat", "surat.", "surat me", "Surat mein kutta", "surat mai", "surat main", "surat madhe", "surat madhye", "surat ma", "surat maa", "surat se", "surat mathi", "surat city", "surat shehar"]) {
      expect(cityCueNear(text, "Surat"), text).toBe(true);
    }
    for (const text of ["in surat", "at Surat", "near surat", "सूरत में", "सूरत मे", "सुरत मध्ये", "સુરત માં", "સુરત થી", "સુરત શહેર", "સુરતમાં", "सूरतમાં", "सुरतमध्ये", "सुरतला"]) {
      expect(cityCueNear(text, "Surat"), text).toBe(true);
    }
  });

  it("is true for the bare name as the last word, and for an English locative right before it whatever comes earlier", () => {
    for (const text of ["Adajan, Surat", "kutta ghayal hai, Varachha road, Surat", "the dog is in Surat", "please help us in surat"]) {
      expect(cityCueNear(text, "Surat"), text).toBe(true);
    }
    // "to" is no cue: it is also the Hinglish particle तो.
    expect(cityCueNear("going to surat with the dog", "Surat")).toBe(false);
    // A glued case suffix that is no locative, last: no cue.
    expect(cityCueNear("kutra ghayal che, સુરતના", "Surat")).toBe(false);
  });

  it("is false without a cue next to the name, or for a word that only contains it", () => {
    for (const text of ["kutte ki surat pe chot hai", "कुत्ते की सूरत पर चोट है", "surat, injured dog", "surat kharab hai", "suratwala", "સુરતના કૂતરા", ""]) {
      expect(cityCueNear(text, "Surat"), text).toBe(false);
    }
  });

  it("is false right after a possessive, whatever cue follows: the name is a face", () => {
    for (const text of [
      "kutte ki surat se khoon aa raha hai", "kutte ka surat me", "kutte ke surat me", "uski surat me", "iski surat se",
      "कुत्ते की सूरत में", "का सूरत में", "के सूरत से", "उसकी सूरत में",
      "કૂતરા ની સુરત માં", "નો સુરતમાં", "ના સુરત થી",
      "कुत्र्या ची सुरत मध्ये", "चा सुरतमध्ये", "चे सुरत मध्ये",
    ]) {
      expect(cityCueNear(text, "Surat"), text).toBe(false);
    }
    // A possessive two words back counts too; three words back is out of the window.
    expect(cityCueNear("kutte ki gaadi surat me hai", "Surat")).toBe(false);
    expect(cityCueNear("kutte ki naak aur surat se khoon", "Surat")).toBe(true);
  });

  it("is false with an idiom's word within the two words before the name, whatever cue follows", () => {
    for (const text of [
      "kisi bhi surat mein", "is surat me", "us surat me", "har surat me", "aisi surat me", "aise surat me", "kutte ki puri surat me",
      "kutte ki poori surat se", "किसी भी सूरत में", "इस सूरत में", "उस सूरत में", "हर सूरत में", "ऐसी सूरत में", "ऐसे सूरत में",
      "पूरी सूरत में", "આ સુરતમાં", "એ સુરત માં", "કોઈ પણ સુરત માં", "દરેક સુરત માં", "આખી સુરત માં",
      "ही सुरत मध्ये", "त्या सुरत मध्ये", "कोणत्याही सुरत मध्ये", "प्रत्येक सुरत मध्ये", "पूर्ण सुरत मध्ये",
    ]) {
      expect(cityCueNear(text, "Surat"), text).toBe(false);
    }
  });

  it("is the one everyday city name the ruling fixed", () => {
    expect([...EVERYDAY_CITY_NAMES]).toEqual(["surat"]);
  });
});

describe("facility words", () => {
  it("is the clinic, hospital and doctor list, every word found on its own", () => {
    expect([...FACILITY_WORDS]).toEqual([
      "clinic", "clinik", "hospital", "doctor", "dawakhana", "क्लिनिक", "दवाखाना", "अस्पताल", "हॉस्पिटल", "डॉक्टर", "डाक्टर",
      "દવાખાન", "ક્લિનિક", "હોસ્પિટલ", "ડૉક્ટર", "ડોક્ટર",
    ]);
    for (const word of FACILITY_WORDS) expect(hasFacilityWord(word), word).toBe(true);
  });

  it("finds one at the start of a word, in any case and script, whatever ending follows", () => {
    for (const text of [
      "ghatkopar hospital ka number", "Hospitals in Mumbai?", "Ghatkopar ke doctor ka number do", "दवाखाना कहाँ है",
      "पास में कोई हॉस्पिटल है?", "ડૉક્ટરનો નંબર આપો", "નજીકમાં દવાખાનું છે?", "क्लिनिक का पता",
    ]) {
      expect(hasFacilityWord(text), text).toBe(true);
    }
    for (const text of ["ghatkopar me kutta ghayal hai", "Vesu, Surat", "the dog is bleeding", "घाटकोपर में कुत्ता घायल है"]) {
      expect(hasFacilityWord(text), text).toBe(false);
    }
  });

  it("reads entries as literals, in the listed form (nukta, apostrophes, spaces, nahi's spellings)", () => {
    const finds = listedWordFinder(["didn't pick", "nahi lag", "a.b"]);
    expect(finds("driver didn’t pick up")).toBe(true);
    expect(finds("phone nhi   lag raha")).toBe(true);
    expect(finds("a.b")).toBe(true);
    expect(finds("axb")).toBe(false);
  });
});
