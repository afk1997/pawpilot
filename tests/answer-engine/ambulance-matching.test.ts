import { describe, expect, it } from "vitest";
import { matchInRows, type AmbulanceMatchRow } from "../../src/lib/tools/find-ambulance-by-area";

describe("matchInRows", () => {
  it("returns every active row for a city-only query, including area-specific rows", () => {
    const rows: AmbulanceMatchRow[] = [
      {
        label: "Kolkata",
        city: "Kolkata",
        area: null,
        areas_covered: ["Hazra", "Bhowanipore"],
      },
      {
        label: "Kolkata",
        city: "Kolkata",
        area: null,
        areas_covered: ["Kolkata"],
      },
      {
        label: "Kolkata",
        city: "Kolkata",
        area: null,
        areas_covered: ["Kolkata"],
      },
    ];

    expect(matchInRows("kolkata", ["kolkata"], rows)).toHaveLength(3);
  });
});
