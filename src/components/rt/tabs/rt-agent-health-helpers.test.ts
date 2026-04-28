import { describe, it, expect } from "vitest";
import { classifyAgentHealth, describeAgentHealth } from "./rt-agent-health-helpers";

describe("classifyAgentHealth", () => {
  it("returns 'no-data' when no items are enabled", () => {
    expect(classifyAgentHealth(0, 0, 0)).toBe("no-data");
  });

  it("returns 'healthy' when < 25% are unsupported", () => {
    // 5 of 24 = 20.8% — healthy
    expect(classifyAgentHealth(19, 5, 24)).toBe("healthy");
    expect(classifyAgentHealth(24, 0, 24)).toBe("healthy");
  });

  it("returns 'partial' for 25-50% unsupported", () => {
    // Dangeručio SCO1 case: 8 of 24 = 33%
    expect(classifyAgentHealth(16, 8, 24)).toBe("partial");
    // Boundary at exactly 25%
    expect(classifyAgentHealth(15, 5, 20)).toBe("partial");
    // Just below 50%
    expect(classifyAgentHealth(13, 11, 24)).toBe("partial");
  });

  it("returns 'broken' for > 50% unsupported", () => {
    // Dangeručio SCO2 case: 22 of 24 = 91.7%
    expect(classifyAgentHealth(2, 22, 24)).toBe("broken");
    // Just over 50%
    expect(classifyAgentHealth(11, 13, 24)).toBe("broken");
    // All unsupported
    expect(classifyAgentHealth(0, 24, 24)).toBe("broken");
  });

  it("does not crash on tiny totals", () => {
    expect(classifyAgentHealth(1, 0, 1)).toBe("healthy");
    expect(classifyAgentHealth(0, 1, 1)).toBe("broken");
  });
});

describe("describeAgentHealth", () => {
  it("returns ok tone for healthy", () => {
    const r = describeAgentHealth("healthy");
    expect(r.tone).toBe("ok");
    expect(r.label).toBe("Agent OK");
  });

  it("returns warn tone for partial", () => {
    const r = describeAgentHealth("partial");
    expect(r.tone).toBe("warn");
    expect(r.label).toBe("Partial");
  });

  it("returns alert tone for broken with helpful diagnostic tooltip", () => {
    const r = describeAgentHealth("broken");
    expect(r.tone).toBe("alert");
    expect(r.label).toBe("Agent issues");
    expect(r.tooltip).toMatch(/ZBX_NOTSUPPORTED/);
    expect(r.tooltip).toMatch(/SP admin/);
  });

  it("returns neutral tone for no-data", () => {
    const r = describeAgentHealth("no-data");
    expect(r.tone).toBe("neutral");
    expect(r.label).toBe("No monitoring");
  });
});
