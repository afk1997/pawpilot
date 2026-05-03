import { describe, expect, it } from "vitest";
import { buildAmbulanceCard } from "../../src/lib/ambulance-card";

describe("buildAmbulanceCard", () => {
  it("preserves workbook ambulance category in the display name", () => {
    const card = buildAmbulanceCard({
      city: "Kolkata",
      area: null,
      category: "Rescue Ambulance",
      phone: "+919830211138",
      operator_name: "Chayya Animal Hospital",
      operator_is_arham: false,
    });

    expect(card.display_name).toBe("Rescue Ambulance, Kolkata");
  });
});
