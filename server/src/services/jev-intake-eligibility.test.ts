import { describe, expect, it } from "vitest";
import { isJevIntakeEligible } from "./jev-intake-eligibility.js";

const unassigned = {
  status: "todo",
  assigneeAgentId: null,
  assigneeUserId: null,
};

describe("JEV intake eligibility", () => {
  it("permits an unassigned ready issue", () => {
    expect(isJevIntakeEligible(unassigned, [])).toBe(true);
  });

  it("refuses any route that has already been selected", () => {
    expect(isJevIntakeEligible({ ...unassigned, assigneeAgentId: "agent" }, [])).toBe(false);
    expect(isJevIntakeEligible({ ...unassigned, assigneeUserId: "user" }, [])).toBe(false);
    expect(isJevIntakeEligible({ ...unassigned, status: "in_progress" }, [])).toBe(false);
  });

  it("refuses unresolved dependencies even when status is todo", () => {
    expect(isJevIntakeEligible(unassigned, [{ status: "blocked" }])).toBe(false);
    expect(isJevIntakeEligible(unassigned, [{ status: "cancelled" }])).toBe(false);
    expect(isJevIntakeEligible(unassigned, [{ status: "done" }])).toBe(true);
  });
});
