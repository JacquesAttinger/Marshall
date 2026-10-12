// Last edited: 2026-10-11 21:45 PDT
// The "Add project" markup: the Linear first-steps note, a password field that is not remembered,
// the repo choice, and the page wiring (one script, one stylesheet, nothing inline).

import { describe, expect, test } from "bun:test";
import { html } from "../../src/dashboard/html.ts";
import { renderAddProject } from "../../src/dashboard/render/add-project.ts";
import { renderPage } from "../../src/dashboard/render/page.ts";

describe("renderAddProject", () => {
  const out = renderAddProject().value;

  test("tells the owner to make the Linear workspace and key first, with the menu path", () => {
    expect(out).toContain("Create a workspace");
    expect(out).toContain("Settings &rarr; Account &rarr; Security &amp; access");
  });

  test("the key field is a password field that is never autofilled or checked", () => {
    const key = /<input id="addp-key"[^>]*>/.exec(out)?.[0] ?? "";
    expect(key).toContain('type="password"');
    expect(key).toContain('autocomplete="off"');
    expect(key).toContain('spellcheck="false"');
  });

  test("has both repo choices, Check key, and a Create button that starts disabled", () => {
    expect(out).toContain('value="new" checked');
    expect(out).toContain('value="existing"');
    expect(out).toContain('id="addp-check"');
    expect(out).toMatch(/id="addp-create" disabled/);
  });

  test("has a hidden Switch block that reuses the project menu's switch code", () => {
    expect(out).toMatch(/id="addp-switch" class="addp-switch" hidden/);
    expect(out).toContain("data-switch-msg");
    expect(out).not.toContain("data-switch=");
  });

  test("has no inline script, inline style, or event handler", () => {
    expect(out).not.toMatch(/<script|style=|\son[a-z]+=/i);
  });
});

describe("renderPage wiring", () => {
  const page = renderPage(
    { strip: "", needsYou: "", agents: "", queue: "" },
    "2026-10-11T00:00:00Z",
    html`<details class="help"></details>`,
  );

  test("loads the add-project script and stylesheet from /assets and puts the button in the header", () => {
    expect(page).toContain('<script src="/assets/add-project.js" defer></script>');
    expect(page).toContain('href="/assets/add-project.css"');
    expect(page.indexOf("data-addp-open")).toBeLessThan(page.indexOf("<main"));
  });
});
