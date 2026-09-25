import { describe, it, expect } from "vitest";
import { DIGIT_RUN_RE, digitsOf, findDigitRuns, foreignDigitRuns, stripRuns, hasDispatchLanguage, replaceDispatchSentences } from "@/server/agent/scrub";

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
    expect(stripRuns("Call 9876543210 now.", ["9876543210"])).toBe("Call now.");
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
    expect(stripRuns(text, runs)).toBe("कॉल करें");
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
    expect(stripRuns(text, runs)).toBe("x y z");
  });
});

describe("digit scrubber: separators", () => {
  it.each([
    "98765\u00A043210", "98765\u202F43210", "98765\t43210", "98765  43210", "98765 \u2009 43210", "98765\n43210",
    "98765\u201343210", "98765\u201443210", "98765\u221243210", "98765\uFF0D43210", "98765\u201143210",
    "98765\u200B43210", "98765\u00AD43210", "98765\u206043210", "98765\u200D43210", "9 8 7 6 5 4 3 2 1 0",
  ])("reads %j as one run and strips it", (hidden) => {
    const text = `Call ${hidden} now.`;
    const runs = foreignDigitRuns(text, []);
    expect(runs).toHaveLength(1);
    expect(stripRuns(text, runs)).toBe("Call now.");
  });

  it("returns runs with plain separators", () => {
    expect(findDigitRuns("a 98765\u00A043210 b 98765\u201343210 c")).toEqual(["98765 43210", "98765-43210"]);
  });

  it("rewrites separators only between digits, so prose keeps its dashes and line breaks", () => {
    const text = "Stay calm \u2014 the dog is safe.\n\nCall 9876543210 now.\nThanks";
    expect(stripRuns(text, foreignDigitRuns(text, []))).toBe("Stay calm \u2014 the dog is safe.\n\nCall now.\nThanks");
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
