import { describe, it, expect } from "vitest";
import { DIGIT_RUN_RE, digitsOf, findDigitRuns, foreignDigitRuns, maskDigitRuns, stripRuns, hasDispatchLanguage, replaceDispatchSentences } from "@/server/agent/scrub";
import { buildAmbulanceCard, buildHelplineCard, buildMultiAmbulanceCard, partnerSuffix } from "@/server/messages/cards";
import { callDirectlyLine } from "@/server/messages/system-replies";

describe("digit scrubber", () => {
  it("finds runs of 7+ digits with spaces, dashes and plus", () => {
    expect(findDigitRuns("call +91 70000 00001 or 98765-43210 not 112 or 2026")).toEqual(["+91 70000 00001", "98765-43210"]);
  });
  it("allows numbers code inserted, with or without the country code", () => {
    const text = "A +91 70000 00001 B 7000000001 C +91 70000 00007";
    expect(foreignDigitRuns(text, ["+917000000001"])).toEqual(["+91 70000 00007"]);
    expect(foreignDigitRuns(text, ["+917000000001", "917000000007"])).toEqual([]);
  });
  it("strips foreign runs cleanly", () => {
    expect(stripRuns("Call 9876543210 now.", ["9876543210"], [])).toBe("Call now.");
  });
});

describe("dispatch guard", () => {
  it("detects dispatch language in four languages", () => {
    for (const t of ["We are sending an ambulance", "They're on the way!", "Ambulance dispatched.", "हम एम्बुलेंस भेज रहे हैं", "आम्ही पाठवत आहोत", "અમે મોકલી રહ્યા છીએ"]) expect(hasDispatchLanguage(t)).toBe(true);
    expect(hasDispatchLanguage("Please call them directly.")).toBe(false);
  });
  it("replaces only the offending sentence", () => {
    const out = replaceDispatchSentences("Here is the number. We are sending help now! Stay calm.", "Please call them directly and they will guide you.");
    expect(out).toBe("Here is the number. Please call them directly and they will guide you. Stay calm.");
    expect(replaceDispatchSentences("हम एम्बुलेंस भेज रहे हैं। शांत रहें।", "कृपया उन्हें सीधे कॉल करें।")).toBe("कृपया उन्हें सीधे कॉल करें। शांत रहें।");
  });
});

/** Digits in MATHEMATICAL BOLD (U+1D7CE…), which sit outside the BMP. */
const bold = (digits: string) => Array.from(digits, (d) => String.fromCodePoint(0x1d7ce + Number(d))).join("");

describe("digit scrubber: native numerals", () => {
  it("reads a Devanagari number as one foreign run and strips it", () => {
    const text = "कॉल करें ९८७६५४३२१०";
    const runs = foreignDigitRuns(text, []);
    expect(runs).toEqual(["9876543210"]);
    expect(stripRuns(text, runs, [])).toBe("कॉल करें");
  });

  it.each([
    ["Gujarati", "૯૮૭૬૫ ૪૩૨૧૦", "98765 43210"],
    ["Bengali", "৯৮৭৬৫৪৩২১০", "9876543210"],
    ["Tamil", "௯௮௭௬௫௪௩௨௧௦", "9876543210"],
    ["fullwidth", "９８７６５４３２１０", "9876543210"],
    ["mixed-script", "98765 ४३२१०", "98765 43210"],
    ["astral (mathematical bold)", bold("9876543210"), "9876543210"],
  ])("folds %s numerals to ASCII before reading runs", (_script, text, run) => {
    expect(findDigitRuns(`call ${text} now`)).toEqual([run]);
  });

  it("reads digits of any script in allowed numbers and runs alike", () => {
    expect(digitsOf("+९१ ७००००-००००१")).toBe("917000000001");
    expect(foreignDigitRuns("कॉल करें +९१ ७०००० ००००१", ["+917000000001"])).toEqual([]);
    expect(foreignDigitRuns("call +91 70000 00001", ["+९१७००००००००१"])).toEqual([]);
  });
});

describe("digit scrubber: allowed numbers are masked before runs are read", () => {
  it("never lets digits after an inserted number swallow it", () => {
    const text = "+91 70000 00001 24 घंटे";
    expect(findDigitRuns(text)).toEqual(["+91 70000 00001 24"]);
    expect(foreignDigitRuns(text, ["+917000000001"])).toEqual([]);
    expect(stripRuns(text, [], ["+917000000001"])).toBe(text);
  });

  it("finds a typed number next to an inserted one and strips only the typed one", () => {
    const text = "Helpline +91 99999 00000 9876543210";
    const allowed = ["+919999900000"];
    const runs = foreignDigitRuns(text, allowed);
    expect(runs).toEqual(["9876543210"]);
    expect(stripRuns(text, runs, allowed)).toBe("Helpline +91 99999 00000");
  });

  it("never removes characters inside an allowed number, even where a foreign run's text occurs inside it", () => {
    const text = "Call +91 70000 00001, not 0000 0000.";
    const allowed = ["+917000000001"];
    const runs = foreignDigitRuns(text, allowed);
    expect(runs).toEqual(["0000 0000"]);
    expect(stripRuns(text, runs, allowed)).toBe("Call +91 70000 00001, not.");
  });

  it("masks every written form of an allowed number", () => {
    const text = "A 917000000001 B 91-70000-00001 C 1800-419-5860 D +91 70000 00007 E 70000\n00001";
    expect(foreignDigitRuns(text, ["7000000001", "18004195860", "+91 70000 00007"])).toEqual([]);
  });

  it("treats a digit glued to an inserted number as part of a foreign run, so a corrupted number is never sent", () => {
    const text = "Call +91 70000 000012 now.";
    const runs = foreignDigitRuns(text, ["+917000000001"]);
    expect(runs).toEqual(["+91 70000 000012"]);
    expect(stripRuns(text, runs, ["+917000000001"])).toBe("Call now.");
  });

  it("ignores allowed numbers shorter than a run, so they cannot split a foreign run", () => {
    expect(foreignDigitRuns("Dial 98 108 12345", ["108"])).toEqual(["98 108 12345"]);
  });

  it("strips the longer of two nested runs whole", () => {
    const text = "x 1234567 y 1234567 7654321 z";
    const runs = foreignDigitRuns(text, []);
    expect(runs).toEqual(["1234567", "1234567 7654321"]);
    expect(stripRuns(text, runs, [])).toBe("x y z");
  });
});

const HIDDEN_SEPARATORS = [
  "98765\u00A043210", "98765\u202F43210", "98765\t43210", "98765  43210", "98765 \u2009 43210", "98765\n43210",
  "98765\u201343210", "98765\u201443210", "98765\u221243210", "98765\uFF0D43210", "98765\u201143210",
  "98765\u200B43210", "98765\u00AD43210", "98765\u206043210", "98765\u200D43210", "9 8 7 6 5 4 3 2 1 0",
];

describe("digit scrubber: separators", () => {
  it.each(HIDDEN_SEPARATORS)("reads %j as one run and strips it", (hidden) => {
    const text = `Call ${hidden} now.`;
    const runs = foreignDigitRuns(text, []);
    expect(runs).toHaveLength(1);
    expect(stripRuns(text, runs, [])).toBe("Call now.");
  });

  it.each(HIDDEN_SEPARATORS)("masks %j whole, leaving nothing the scrubber would find", (hidden) => {
    const masked = maskDigitRuns(`Call ${hidden} now.`, "[number sent]");
    expect(masked).toBe("Call [number sent] now.");
    expect(findDigitRuns(masked)).toEqual([]);
  });

  it("returns runs with plain separators", () => {
    expect(findDigitRuns("a 98765\u00A043210 b 98765\u201343210 c")).toEqual(["98765 43210", "98765-43210"]);
  });

  it("rewrites separators only between digits, so prose keeps its dashes and line breaks", () => {
    const text = "Stay calm \u2014 the dog is safe.\n\nCall 9876543210 now.\nThanks";
    expect(stripRuns(text, foreignDigitRuns(text, []), [])).toBe("Stay calm \u2014 the dog is safe.\n\nCall now.\nThanks");
  });

  it("reads runs with a fresh pattern, so a caller's exec on DIGIT_RUN_RE cannot skip any", () => {
    DIGIT_RUN_RE.exec("x 9876543210 y");
    try {
      expect(findDigitRuns("9876543210 and 7000000001")).toEqual(["9876543210", "7000000001"]);
      expect(foreignDigitRuns("9876543210 and 7000000001", [])).toEqual(["9876543210", "7000000001"]);
    } finally {
      DIGIT_RUN_RE.lastIndex = 0;
    }
  });
});

describe("dispatch guard: details", () => {
  it("detects a typographic apostrophe", () => {
    expect(hasDispatchLanguage("We\u2019re sending an ambulance")).toBe(true);
  });

  it("keeps paragraph breaks and every other character around a replaced sentence", () => {
    expect(replaceDispatchSentences("Here is the number.\n\nWe are sending help.\n\nStay calm.", "R.")).toBe("Here is the number.\n\nR.\n\nStay calm.");
    expect(replaceDispatchSentences("Stay calm.\n...\nWe are sending help.", "R.")).toBe("Stay calm.\n...\nR.");
  });

  it("returns folded text", () => {
    expect(replaceDispatchSentences("हम भेज रहे हैं। २४ घंटे खुला।", "R।")).toBe("R। 24 घंटे खुला।");
  });
});

const arhamUnit = { city: "Mumbai", area: "Ghatkopar", phone: "+917000000001", operatorName: "Arham Yuva Seva Group", operatorIsArham: true };
const partnerUnit = { city: "Mumbai", area: "Wadala", phone: "+917000000007", operatorName: "Hope for Indies Trust", operatorIsArham: false };

describe("dispatch guard: vocabulary", () => {
  it.each([
    "I'm sending an ambulance.", "I am sending help now.", "I\u2019m sending an ambulance.",
    "The ambulance is coming to you.", "They are coming to you now.", "They're coming to your location.",
    "It is on its way.", "The driver is on his way.", "Thank you, they are on the way.",
    "एम्बुलेंस रास्ते में है।", "एम्बुलेंस आ रही है।", "टीम आ रही है।",
    "एम्बुलेंस रास्ते में है", "गाड़ी आ रही है", "टीम आपके पास आ रही है", "एम्बुलन्स पाठवली आहे", "એમ્બ્યુલન્સ રસ્તામાં છે", "Team is on its way",
    "गा\u0921\u093Cी आ रही है।", "गा\u095Cी आ रही है।",
    "हमने एम्बुलेंस भेज दी है।", "एम्बुलेंस भेजी है।", "एम्बुलेंस भेजी गई है।", "मैं एम्बुलेंस भेज रहा हूँ।",
    "आम्ही एम्बुलन्स पाठवली आहे.", "आम्ही टीम पाठवले आहे.", "एम्बुलन्स वाटेत आहे.", "गाडी रस्त्यात आहे.", "मी एम्बुलन्स पाठवत आहे.",
    "અમે એમ્બ્યુલન્સ મોકલી દીધી છે.", "એમ્બ્યુલન્સ રસ્તામાં છે.",
  ])("detects %j", (text) => {
    expect(hasDispatchLanguage(text)).toBe(true);
  });

  it("reads an Indic coming or road phrase only right after its vehicle or team subject (precision first)", () => {
    // Claims these rules now miss on purpose: a driver or a pronoun as the subject, or the vehicle after the verb.
    for (const t of ["ड्राइवर आ रहा है।", "वे आ रहे हैं, एम्बुलेंस के साथ।", "आप घबराइए मत वे रास्ते में हैं।", "ड्रायव्हर वाटेत आहे.", "ડ્રાઇવર રસ્તામાં છે."]) {
      expect(hasDispatchLanguage(t)).toBe(false);
    }
  });

  it("reads any horizontal whitespace between words, but never a line break", () => {
    for (const t of ["We  are sending help", "We are\u00A0sending help", "They are on\u202Fthe\tway", "एम्बुलेंस रास्ते\u00A0में है"]) {
      expect(hasDispatchLanguage(t)).toBe(true);
    }
    // A line break ends a sentence, so words on either side of it never form a phrase.
    expect(hasDispatchLanguage("We are\nsending help.")).toBe(false);
  });

  it("keeps real claims whose second-person word is an object or sits before a first-person subject", () => {
    for (const t of [
      "हम आप तक एम्बुलेंस भेज रहे हैं।", "हमने आपके लिए एम्बुलेंस भेज दी है।", "तुम्ही सांगितलेल्या ठिकाणी आम्ही एम्बुलन्स पाठवली आहे.",
      "An ambulance for you is on the way.", "आप रुकिए एम्बुलेंस भेज दी है।", "तुम्ही थांबा रुग्णवाहिका वाटेत आहे.",
    ]) {
      expect(hasDispatchLanguage(t)).toBe(true);
    }
  });
});

describe("dispatch guard: exclusions", () => {
  it.each([
    "We are sending you the driver's number.", "We're sending you the number below.", "I am sending you the details.",
    "I'm sending you the driver\u2019s contact.", "We are sending the ambulance driver's phone number again.",
    "They were sending photos.", "were sending a video",
    "Our dispatch team will call you back.", "Please ask the dispatcher.", "The dispatch-team is busy.",
    "On the way to the clinic, keep the dog calm.", "Keep it calm on the way to vet.", "on the way to hospital",
    "Are you on the way to the spot?", "Once you are on the way, call the driver.", "You're already on the way?",
    "हम ड्राइवर का नंबर भेज रहे हैं।", "मैं आपको नंबर भेज रहा हूँ।", "मी तुम्हाला नंबर पाठवत आहे.", "હું તમને નંબર મોકલી રહ્યો છું.",
    "आप फोटो भेज रहे हैं।", "आपने जो फोटो भेजी है, वह मिल गई।", "तुम्ही वाटेत आहात का?", "तुम्ही फोटो पाठवले.", "તમે ફોટો મોકલી રહ્યા છો.", "તમે રસ્તામાં છો?",
    "बारिश आ रही है।", "एम्बुलेंस का नंबर ऊपर है। बारिश आ रही है।",
    "कृपया फोटो भेज दीजिए।", "चौरास्ते में रुकिए।", "संदेश पाठवल्याबद्दल धन्यवाद.", "पाठवलेली माहिती मिळाली.",
    "अगर ड्राइवर से बात करने में दिक्कत आ रही है, तो हेल्पलाइन पर कॉल करें: +91 99999 00000।",
    "दिक्कत आ रही है तो ड्राइवर को दोबारा कॉल करें", "क्या ड्राइवर की आवाज़ नहीं आ रही है?", "अगर कोई दिक्कत आ रही है तो हमारी टीम आपकी मदद करेगी",
    "मैंने ड्राइवर का नंबर पहले ही भेज दिया है", "ड्राइवर का नंबर ऊपर भेजा है।", "आम्ही ड्रायव्हरचा नंबर आधीच पाठवला आहे.", "અમે ડ્રાઇવરનો નંબર પહેલેથી મોકલી દીધો છે.",
    "कुत्ता रास्ते में घायल पड़ा है, यह रहा ड्राइवर का नंबर", "कुत्रा रस्त्यात जखमी आहे", "क्लिनिक के रास्ते में कुत्ते को पानी न दें",
    "मैंने ड्राइवर की जानकारी अभी भेज दी है।", "आम्ही संपर्क तपशील पाठवले आहेत.", "અમે સંપર્ક વિગતો મોકલી દીધી છે.",
    "मैंने नंबर +91 70000 00001 भेज दिया है।", "दवाखान्याची गाडी रस्त्यात आहे.",
  ])("ignores %j", (text) => {
    expect(hasDispatchLanguage(text)).toBe(false);
  });

  it("leaves text without dispatch language as it was, whatever its punctuation", () => {
    const text = "Dr. Shah... see arhamalwayscare.org/help?x=1! Wait...what?! ok।ठीक है।\n\n1. Unit\n   +91 70000 00001";
    expect(replaceDispatchSentences(text, "R.", ["+917000000001"])).toBe(text);
  });

  it("never flags the replacement line or a card, in any language", () => {
    for (const lang of ["en", "hi", "mr", "gu"] as const) {
      expect(hasDispatchLanguage(callDirectlyLine(lang))).toBe(false);
      expect(hasDispatchLanguage(buildAmbulanceCard(partnerUnit, lang))).toBe(false);
      expect(hasDispatchLanguage(buildMultiAmbulanceCard([arhamUnit, partnerUnit], lang))).toBe(false);
      expect(hasDispatchLanguage(buildHelplineCard("+919999900000", lang))).toBe(false);
    }
  });
});

describe("dispatch guard: sentence replacement", () => {
  const R = "Please call them directly and they will guide you.";

  it("re-appends an allowed number the replaced sentence held, as it was written", () => {
    expect(replaceDispatchSentences("Call +91 70000 00001, they're on the way!", R, ["+917000000001"])).toBe(`${R} +91 70000 00001`);
    expect(replaceDispatchSentences("कॉल करें +९१ ७०००० ००००१, एम्बुलेंस रास्ते में है।", "R।", ["+917000000001"])).toBe("R। +91 70000 00001");
  });

  it("keeps the partner label that follows a re-appended number, in every language", () => {
    const allowed = ["+917000000007"];
    const en = partnerSuffix("Hope for Indies Trust", "en");
    expect(replaceDispatchSentences(`Call +91 70000 00007 ${en}, they're on the way!`, R, allowed)).toBe(`${R} +91 70000 00007 ${en}`);
    const hi = partnerSuffix("Hope for Indies Trust", "hi");
    expect(replaceDispatchSentences(`कॉल करें +91 70000 00007 ${hi}, एम्बुलेंस रास्ते में है।`, "R।", allowed)).toBe(`R। +91 70000 00007 ${hi}`);
    for (const lang of ["mr", "gu"] as const) {
      const label = partnerSuffix("Blue Cross", lang);
      expect(replaceDispatchSentences(`Call +91 70000 00007 ${label}, we are sending help.`, "R.", allowed)).toBe(`R. +91 70000 00007 ${label}`);
    }
  });

  it("keeps only a real partner label right after the number, without dispatch wording or digits of its own", () => {
    const allowed = ["+917000000001"];
    expect(replaceDispatchSentences("Call +91 70000 00001 (call now), they're on the way!", "R.", allowed)).toBe("R. +91 70000 00001");
    expect(replaceDispatchSentences("Call +91 70000 00001 now (operated by Blue Cross), they're on the way!", "R.", allowed)).toBe("R. +91 70000 00001");
    expect(replaceDispatchSentences("Call +91 70000 00001 (operated by our team, on the way now)!", "R.", allowed)).toBe("R. +91 70000 00001");
    expect(replaceDispatchSentences("Call +91 70000 00001 (operated by 9876543210), they're on the way!", "R.", allowed)).toBe("R. +91 70000 00001");
  });

  it("merges adjacent replaced sentences into one replacement", () => {
    expect(replaceDispatchSentences("We're sending help. They're on the way! Stay calm.", R)).toBe(`${R} Stay calm.`);
    expect(replaceDispatchSentences("We are sending help.\n\nThey're on the way!\n\nStay calm.", "R.")).toBe("R.\n\nStay calm.");
  });

  it("ends a sentence only at a terminator followed by whitespace or the end, so URLs and titles stay whole", () => {
    expect(replaceDispatchSentences("Visit arhamalwayscare.org/help on the way.", "R.")).toBe("R.");
    expect(replaceDispatchSentences("See arhamalwayscare.org/help. They're on the way!", "R.")).toBe("See arhamalwayscare.org/help. R.");
    expect(replaceDispatchSentences("Dr. Shah's ambulance is on the way. Stay calm.", "R.")).toBe("R. Stay calm.");
  });

  it("puts a space between a danda-ended sentence and a replacement that had none", () => {
    expect(replaceDispatchSentences("शांत रहें।हम भेज रहे हैं।", "R।")).toBe("शांत रहें। R।");
    expect(replaceDispatchSentences("हम भेज रहे हैं।शांत रहें।", "R।")).toBe("R। शांत रहें।");
  });

  it("re-appends each allowed number of the merged sentences once, and drops typed digits", () => {
    const allowed = ["+917000000001", "+917000000007"];
    const text = "Call +91 70000 00001, we're sending help. They're on the way with +91 70000 00007 and 7000000001! Stay calm.";
    const out = replaceDispatchSentences(text, "R.", allowed);
    expect(out).toBe("R. +91 70000 00001 +91 70000 00007 Stay calm.");
    expect(foreignDigitRuns(out, allowed)).toEqual([]);
    expect(replaceDispatchSentences("We are sending 9876543210 now.", "R.", allowed)).toBe("R.");
  });

  it("never re-appends a number the kept text already shows, or one an earlier replacement appended", () => {
    const allowed = ["+917000000001"];
    expect(replaceDispatchSentences("Call +91 70000 00001 now. They're on the way with +91 70000 00001!", "R.", allowed)).toBe("Call +91 70000 00001 now. R.");
    expect(replaceDispatchSentences("They're on the way with +91 70000 00001! Call +91 70000 00001.", "R.", allowed)).toBe("R. Call +91 70000 00001.");
    expect(replaceDispatchSentences("They're on the way, +91 70000 00001! Stay calm. The ambulance is on the way, +91 70000 00001.", "R.", allowed))
      .toBe("R. +91 70000 00001 Stay calm. R.");
  });

  it("ends a sentence before an emoji or a WhatsApp closer, which stay with the sentence they close", () => {
    expect(replaceDispatchSentences("*They're on the way.* Stay calm.", "R.")).toBe("R. Stay calm.");
    expect(replaceDispatchSentences("_Stay calm._ They're on the way!", "R.")).toBe("_Stay calm._ R.");
    expect(replaceDispatchSentences("They're on the way.🚑 Stay calm.", "R.")).toBe("R. Stay calm.");
    expect(replaceDispatchSentences("Stay calm.🙏🏽 They're on the way!", "R.")).toBe("Stay calm.🙏🏽 R.");
  });

  it("reads डॉ. as a title, not a sentence end", () => {
    expect(replaceDispatchSentences("डॉ. शाह की एम्बुलेंस रास्ते में है। शांत रहें।", "R।")).toBe("R। शांत रहें।");
  });

  it("keeps a multi-card's indents after a replaced sentence", () => {
    const card = buildMultiAmbulanceCard([arhamUnit, partnerUnit], "en");
    expect(card).toContain("\n   +91 70000 00001");
    expect(replaceDispatchSentences(`They're on the way.\n\n${card}`, "R.", ["+917000000001", "+917000000007"])).toBe(`R.\n\n${card}`);
  });
});

describe("digit scrubber: allow-list and layout details", () => {
  it("treats an allowed number glued to a digit or a plus as a foreign run", () => {
    expect(foreignDigitRuns("Call 0917000000001 now", ["+917000000001"])).toEqual(["0917000000001"]);
    expect(foreignDigitRuns("Call +7000000001 now", ["+917000000001"])).toEqual(["+7000000001"]);
  });

  it("collapses the double space a removal leaves but keeps a card's indents", () => {
    const card = buildMultiAmbulanceCard([arhamUnit, partnerUnit], "en");
    const text = `Call 9876543210  now.\n\n${card}`;
    const allowed = ["+917000000001", "+917000000007"];
    expect(stripRuns(text, foreignDigitRuns(text, allowed), allowed)).toBe(`Call now.\n\n${card}`);
  });
});
