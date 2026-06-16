import { describe, expect, it } from "bun:test";
import { spinnerHeader, spinnerHtml } from "../src/github/spinner";

describe("spinner branding", () => {
  it("does not render an external inline image", () => {
    expect(spinnerHtml()).toBe("");
  });

  it("renders the elek name with status only", () => {
    const html = spinnerHeader("deepseek/deepseek-v4-pro", "analysis complete");

    expect(html).toContain("<strong>elek</strong>");
    expect(html).toContain("analysis complete");
    expect(html).not.toContain("deepseek/deepseek-v4-pro");
    expect(html).not.toContain("<img");
  });

  it("escapes status text before rendering GitHub HTML", () => {
    const html = spinnerHeader('openrouter/<bad>"model\'x', "done > now");

    expect(html).toContain("done &gt; now");
    expect(html).not.toContain('<bad>"model');
  });
});
