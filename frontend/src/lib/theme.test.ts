import { describe, expect, it } from "vitest";
import { CONNECTION_COLORS, connectionColor } from "./theme";

describe("connectionColor", () => {
  it("draws a picked swatch in the current theme's version", () => {
    expect(connectionColor(CONNECTION_COLORS[3])).toBe("var(--color-swatch-4)");
    expect(connectionColor(CONNECTION_COLORS[3].toUpperCase())).toBe("var(--color-swatch-4)");
  });
  it("keeps unknown colours and draws none as transparent", () => {
    expect(connectionColor("#123456")).toBe("#123456");
    expect(connectionColor("")).toBe("transparent");
  });
});
