import { describe, it, expect } from "vitest";
import { maskPhone } from "@/server/log";

describe("maskPhone", () => {
  it("keeps only the last four digits", () => {
    expect(maskPhone("+919876543210")).toBe("+91xxxxxx3210");
  });
  it("handles short and empty values", () => {
    expect(maskPhone("1234")).toBe("1234");
    expect(maskPhone("")).toBe("");
  });
  it("masks test phones without crashing", () => {
    expect(maskPhone("+91TEST_ab12cd34")).toBe("+91TEST_ab12cd34");
  });
});
