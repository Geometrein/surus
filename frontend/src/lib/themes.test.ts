import { afterEach, describe, expect, it } from "vitest";
import { applyTheme, DEFAULT_THEME, isTheme, THEMES } from "./themes";

describe("themes", () => {
  afterEach(() => applyTheme(DEFAULT_THEME));

  it("marks the page with the chosen theme, and the default with none", () => {
    applyTheme("tokyo-night");
    expect(document.documentElement.dataset.theme).toBe("tokyo-night");
    applyTheme(DEFAULT_THEME);
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("knows only the listed themes", () => {
    expect(THEMES.map((t) => t.id)).toContain("tokyo-night");
    expect(isTheme("tokyo-night")).toBe(true);
    expect(isTheme("no-such-theme")).toBe(false);
  });
});
