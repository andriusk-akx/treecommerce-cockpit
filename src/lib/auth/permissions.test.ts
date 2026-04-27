import { describe, it, expect } from "vitest";
import {
  ALL_TABS,
  canAccessPilot,
  canAccessTab,
  visiblePilotIds,
  filterAccessiblePilots,
  allowedTabsFor,
  requireAdmin,
  landingPath,
  type UserAuthState,
  type TabKey,
} from "./permissions";

function makeUser(opts: Partial<UserAuthState> & { isAdmin?: boolean }): UserAuthState {
  return {
    id: opts.id ?? "u1",
    username: opts.username ?? "u",
    isAdmin: opts.isAdmin ?? false,
    pilotAccess: opts.pilotAccess ?? new Map(),
  };
}

describe("canAccessPilot", () => {
  it("admin → always true", () => {
    expect(canAccessPilot(makeUser({ isAdmin: true }), "any")).toBe(true);
  });
  it("anonymous → always false", () => {
    expect(canAccessPilot(null, "any")).toBe(false);
  });
  it("non-admin with grant → true", () => {
    const u = makeUser({
      pilotAccess: new Map([["p1", new Set<TabKey>(["overview"])]]),
    });
    expect(canAccessPilot(u, "p1")).toBe(true);
  });
  it("non-admin without grant → false", () => {
    expect(canAccessPilot(makeUser({}), "p1")).toBe(false);
  });
  it("grant exists but tabs empty → false (denied)", () => {
    const u = makeUser({
      pilotAccess: new Map([["p1", new Set<TabKey>()]]),
    });
    expect(canAccessPilot(u, "p1")).toBe(false);
  });
});

describe("canAccessTab", () => {
  it("admin → all tabs in any pilot", () => {
    const a = makeUser({ isAdmin: true });
    for (const t of ALL_TABS) expect(canAccessTab(a, "x", t)).toBe(true);
  });
  it("non-admin: only granted tabs", () => {
    const u = makeUser({
      pilotAccess: new Map([["p1", new Set<TabKey>(["overview", "timeline"])]]),
    });
    expect(canAccessTab(u, "p1", "overview")).toBe(true);
    expect(canAccessTab(u, "p1", "timeline")).toBe(true);
    expect(canAccessTab(u, "p1", "inventory")).toBe(false);
    expect(canAccessTab(u, "p1", "datahealth")).toBe(false);
  });
  it("wrong pilot → false even if tab is granted in another", () => {
    const u = makeUser({
      pilotAccess: new Map([["p1", new Set<TabKey>(["overview"])]]),
    });
    expect(canAccessTab(u, "p2", "overview")).toBe(false);
  });
});

describe("visiblePilotIds", () => {
  it("admin → 'all'", () => {
    expect(visiblePilotIds(makeUser({ isAdmin: true }))).toBe("all");
  });
  it("non-admin returns set of pilots with non-empty grants", () => {
    const u = makeUser({
      pilotAccess: new Map([
        ["p1", new Set<TabKey>(["overview"])],
        ["p2", new Set<TabKey>()], // empty grant — excluded
        ["p3", new Set<TabKey>(["timeline"])],
      ]),
    });
    const ids = visiblePilotIds(u) as Set<string>;
    expect(ids instanceof Set).toBe(true);
    expect(ids.has("p1")).toBe(true);
    expect(ids.has("p3")).toBe(true);
    expect(ids.has("p2")).toBe(false);
  });
});

describe("filterAccessiblePilots", () => {
  it("admin → returns full list unchanged", () => {
    const pilots = [{ id: "a" }, { id: "b" }];
    expect(filterAccessiblePilots(makeUser({ isAdmin: true }), pilots)).toEqual(pilots);
  });
  it("non-admin → filters to granted ids", () => {
    const u = makeUser({
      pilotAccess: new Map([["b", new Set<TabKey>(["overview"])]]),
    });
    expect(filterAccessiblePilots(u, [{ id: "a" }, { id: "b" }, { id: "c" }])).toEqual([{ id: "b" }]);
  });
  it("anonymous → empty", () => {
    expect(filterAccessiblePilots(null, [{ id: "a" }])).toEqual([]);
  });
});

describe("allowedTabsFor", () => {
  it("admin → all tabs", () => {
    const r = allowedTabsFor(makeUser({ isAdmin: true }), "p1");
    expect(r.size).toBe(ALL_TABS.length);
  });
  it("non-admin → exactly granted tabs", () => {
    const u = makeUser({
      pilotAccess: new Map([["p1", new Set<TabKey>(["overview", "timeline"])]]),
    });
    const tabs = allowedTabsFor(u, "p1");
    expect(tabs.size).toBe(2);
    expect(tabs.has("overview")).toBe(true);
    expect(tabs.has("timeline")).toBe(true);
  });
  it("non-admin with no grant → empty", () => {
    expect(allowedTabsFor(makeUser({}), "p1").size).toBe(0);
  });
});

describe("requireAdmin", () => {
  it("type guard + boolean", () => {
    expect(requireAdmin(null)).toBe(false);
    expect(requireAdmin(makeUser({}))).toBe(false);
    expect(requireAdmin(makeUser({ isAdmin: true }))).toBe(true);
  });
});

describe("landingPath", () => {
  it("anonymous → /login", () => {
    expect(landingPath(null, [])).toBe("/login");
  });
  it("admin → / (regardless of pilot count)", () => {
    expect(landingPath(makeUser({ isAdmin: true }), [])).toBe("/");
    expect(landingPath(makeUser({ isAdmin: true }), ["a"])).toBe("/");
    expect(landingPath(makeUser({ isAdmin: true }), ["a", "b"])).toBe("/");
  });
  it("non-admin with exactly one pilot → that pilot's URL", () => {
    expect(landingPath(makeUser({}), ["pilot-x"])).toBe("/retellect/pilot-x");
  });
  it("non-admin with multiple pilots → /retellect hub", () => {
    expect(landingPath(makeUser({}), ["a", "b"])).toBe("/retellect");
    expect(landingPath(makeUser({}), ["a", "b", "c"])).toBe("/retellect");
  });
  it("non-admin with no pilots → /no-access", () => {
    expect(landingPath(makeUser({}), [])).toBe("/no-access");
  });
});
