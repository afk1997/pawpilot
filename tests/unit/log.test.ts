import { describe, it, expect } from "vitest";
import { maskPhone, safeErrorFields } from "@/server/log";

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

describe("safeErrorFields", () => {
  it("keeps the class name and the code, preferring the cause's code (drizzle wraps the driver's error)", () => {
    class DrizzleLikeError extends Error {}
    const wrapped = new DrizzleLikeError("Failed query ... params: +919876543210", { cause: { code: "57P01", detail: "Key (phone)=(+919876543210)" } });
    expect(safeErrorFields(wrapped)).toEqual({ errorClass: "DrizzleLikeError", code: "57P01" });
    expect(safeErrorFields(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }))).toEqual({ errorClass: "Error", code: "ECONNREFUSED" });
  });

  it("never carries the message, and drops a code that could be a phone number", () => {
    const err = Object.assign(new Error("reporter +919876543210"), { code: "919876543210" });
    expect(safeErrorFields(err)).toEqual({ errorClass: "Error" });
    expect(JSON.stringify(safeErrorFields(err))).not.toMatch(/\d/);
    expect(safeErrorFields(Object.assign(new Error("x"), { code: "98765-43210" }))).toEqual({ errorClass: "Error" });
  });

  it("names an error whose class name a production bundle minified by the error's own name", () => {
    const withClassName = (className: string, name?: string) => {
      class Custom extends Error {}
      Object.defineProperty(Custom, "name", { value: className });
      const err = new Custom("failed for +919876543210");
      if (name !== undefined) err.name = name;
      return err;
    };
    expect(safeErrorFields(withClassName("e", "TimeoutError"))).toEqual({ errorClass: "TimeoutError" });
    expect(safeErrorFields(withClassName("", "PostgresError"))).toEqual({ errorClass: "PostgresError" });
    expect(safeErrorFields(withClassName("$n"))).toEqual({ errorClass: "Error" });
    expect(safeErrorFields(withClassName("tA", "sent to +91 98765 43210"))).toEqual({ errorClass: "Error" });
    // An unminified class name still wins over the name it inherited or set.
    expect(safeErrorFields(withClassName("QueryFailed"))).toEqual({ errorClass: "QueryFailed" });
    expect(safeErrorFields(withClassName("QueryFailed", "Other"))).toEqual({ errorClass: "QueryFailed" });
  });

  it("names a non-Error throwable by its type", () => {
    expect(safeErrorFields("boom +919876543210")).toEqual({ errorClass: "string" });
    expect(safeErrorFields(null)).toEqual({ errorClass: "object" });
    expect(safeErrorFields(undefined)).toEqual({ errorClass: "undefined" });
  });
});
