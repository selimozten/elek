import { describe, expect, it } from "bun:test";
import { spinnerHeader, spinnerHtml } from "../src/github/spinner";

describe("spinner branding", () => {
  it("renders an elek-branded inline image", () => {
    const html = spinnerHtml();

    expect(html).toContain("assets/elek-spinner.svg");
    expect(html).toContain('alt="elek"');
    expect(html).toContain('width="18"');
  });

  it("renders the elek name with the model and status", () => {
    const html = spinnerHeader("deepseek/deepseek-v4-pro", "analysis complete");

    expect(html).toContain("<strong>elek</strong>");
    expect(html).toContain("<strong>deepseek/deepseek-v4-pro</strong>");
    expect(html).toContain("analysis complete");
  });

  it("escapes model labels before rendering GitHub HTML", () => {
    const html = spinnerHeader('openrouter/<bad>"model', "done > now");

    expect(html).toContain("openrouter/&lt;bad&gt;&quot;model");
    expect(html).toContain("done &gt; now");
    expect(html).not.toContain('<bad>"model');
  });
});
