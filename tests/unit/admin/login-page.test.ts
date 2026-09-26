import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import LoginPage from "@/app/admin/login/page";

describe("admin login page", () => {
  it("declares its form as a POST, so a native submit never puts the password in a URL", () => {
    expect(renderToStaticMarkup(createElement(LoginPage))).toMatch(/<form[^>]*\smethod="post"/);
  });
});
