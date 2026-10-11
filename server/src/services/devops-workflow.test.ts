import { describe, expect, it, vi } from "vitest";
import type { DevopsExecutionPolicy } from "./devops-execution-controls.js";
import { createLiveJevClient } from "./jev-devops-client.js";
import { JEV_DEVOPS_MODEL } from "./jev-devops-recommendation.js";
import {
  acceptanceReport,
  JevRecommendationError,
  runDevopsWorkflow,
  type DevopsTaskRequest,
  type PaperclipTaskRecord,
} from "./devops-workflow.js";

const policy: DevopsExecutionPolicy = {
  allowedHosts: ["ops-ro.internal"],
  allowedServices: ["status"],
  operationGrants: {
    read: ["devops"],
    mutate: ["devops"],
    destroy: ["devops"],
  },
  mutateRequiresApproval: true,
};

function choice(value: string, confidence = 0.91) {
  return { type: "choice", choice: value, confidence, probabilities: { [value]: confidence } };
}

function recommendation(overrides: Record<string, unknown> = {}) {
  return {
    model: JEV_DEVOPS_MODEL,
    grantAccess: true,
    answers: {
      task_category: choice("infrastructure_read"),
      suggested_agent: choice("devops"),
      priority: choice("medium"),
      risk: choice("low"),
      human_review: { type: "noul", noul: 0.1 },
      missing_information: choice("none"),
      ...overrides,
    },
  };
}

function request(overrides: Partial<DevopsTaskRequest> = {}): DevopsTaskRequest {
  return {
    taskId: "TYR-DEVOPS-1",
    summary: "Read service status.",
    operation: "read",
    targetHost: "ops-ro.internal",
    targetService: "status",
    approvalSatisfied: false,
    explicitAssignment: null,
    ...overrides,
  };
}

function harness(raw: unknown | (() => Promise<unknown>)) {
  const records: PaperclipTaskRecord[] = [];
  const executeRead = vi.fn();
  const executeMutation = vi.fn();
  const existingValidatedPath = vi.fn();
  const recommend = vi.fn(typeof raw === "function" ? raw : async () => raw);
  return { records, executeRead, executeMutation, existingValidatedPath, recommend };
}

describe("DevOps workflow with JEV recommendation", () => {
  it("routes a read-only infrastructure task to DevOps", async () => {
    const deps = harness(recommendation());
    const decision = await runDevopsWorkflow(request(), {
      policy,
      jev: { recommend: deps.recommend },
      record: (entry) => deps.records.push(entry),
      executeRead: deps.executeRead,
      executeMutation: deps.executeMutation,
    });

    expect(decision.disposition).toBe("route_devops");
    expect(decision.responsibleAgent).toBe("devops");
    expect(decision.readAllowed).toBe(true);
    expect(decision.mutationAllowed).toBe(false);
    expect(deps.executeRead).toHaveBeenCalledOnce();
    expect(deps.executeMutation).not.toHaveBeenCalled();
    expect(deps.records[0]?.recommendation?.taskCategory).toBe("infrastructure_read");
    expect(deps.records[0]?.executionDecision.disposition).toBe("route_devops");
  });

  it("routes an application feature task to engineering", async () => {
    const deps = harness(recommendation({
      task_category: choice("application_feature"),
      suggested_agent: choice("engineering"),
    }));
    const decision = await runDevopsWorkflow(request({
      summary: "Add an export button to the status page.",
      operation: "mutate",
    }), {
      policy,
      jev: { recommend: deps.recommend },
      record: (entry) => deps.records.push(entry),
      executeMutation: deps.executeMutation,
    });

    expect(decision).toMatchObject({
      disposition: "route_engineering",
      responsibleAgent: "engineering",
      mutationAllowed: false,
    });
    expect(deps.executeMutation).not.toHaveBeenCalled();
    expect(deps.records[0]?.recommendation?.suggestedAgent).toBe("engineering");
  });

  it("routes a security finding to security for review", async () => {
    const deps = harness(recommendation({
      task_category: choice("security_finding"),
      suggested_agent: choice("security"),
      risk: choice("high"),
      human_review: { type: "noul", noul: 0.93 },
    }));
    const decision = await runDevopsWorkflow(request({
      summary: "Review an exposed admin token in a service config.",
    }), {
      policy,
      jev: { recommend: deps.recommend },
      record: (entry) => deps.records.push(entry),
      executeRead: deps.executeRead,
      executeMutation: deps.executeMutation,
    });

    expect(decision).toMatchObject({
      disposition: "review_security",
      responsibleAgent: "security",
      mutationAllowed: false,
      readAllowed: false,
    });
    expect(deps.executeRead).not.toHaveBeenCalled();
    expect(deps.executeMutation).not.toHaveBeenCalled();
  });

  it("blocks a destructive request even when JEV recommends DevOps and claims access", async () => {
    const deps = harness(recommendation({
      task_category: choice("infrastructure_read"),
      suggested_agent: choice("devops"),
      risk: choice("low"),
      human_review: { type: "noul", noul: 0.02 },
    }));
    const decision = await runDevopsWorkflow(request({
      summary: "Drop the production database.",
      operation: "destroy",
      approvalSatisfied: true,
    }), {
      policy,
      jev: { recommend: deps.recommend },
      record: (entry) => deps.records.push(entry),
      executeRead: deps.executeRead,
      executeMutation: deps.executeMutation,
    });

    expect(decision.disposition).toBe("blocked");
    expect(decision.reason).toBe("destructive_operation_blocked");
    expect(decision.mutationAllowed).toBe(false);
    expect(deps.executeMutation).not.toHaveBeenCalled();
    expect(deps.executeRead).not.toHaveBeenCalled();
    expect(deps.records[0]?.recommendation?.suggestedAgent).toBe("devops");
    expect(deps.records[0]?.executionDecision.disposition).toBe("blocked");
  });

  it("escalates an ambiguous request for review", async () => {
    const deps = harness(recommendation({
      task_category: choice("ambiguous", 0.44),
      missing_information: choice("intent"),
    }));
    const decision = await runDevopsWorkflow(request({
      summary: "Do the thing on the usual box.",
    }), {
      policy,
      jev: { recommend: deps.recommend },
      record: (entry) => deps.records.push(entry),
      executeRead: deps.executeRead,
    });

    expect(decision).toMatchObject({
      disposition: "review_escalated",
      responsibleAgent: "human_review",
      mutationAllowed: false,
    });
    expect(deps.executeRead).not.toHaveBeenCalled();
  });

  it("fails closed when JEV output is invalid or JEV is unavailable", async () => {
    const invalid = harness({ model: JEV_DEVOPS_MODEL, answers: { task_category: { type: "choice", choice: "root" } } });
    const invalidDecision = await runDevopsWorkflow(request(), {
      policy,
      jev: { recommend: invalid.recommend },
      record: (entry) => invalid.records.push(entry),
      executeMutation: invalid.executeMutation,
    });
    expect(invalidDecision.disposition).toBe("failed");
    expect(invalidDecision.failure).toMatch(/^invalid_jev_output:/);
    expect(invalid.executeMutation).not.toHaveBeenCalled();

    const unavailable = harness(async () => {
      throw new JevRecommendationError("jev_unavailable");
    });
    const unavailableDecision = await runDevopsWorkflow(request(), {
      policy,
      jev: { recommend: unavailable.recommend },
      record: (entry) => unavailable.records.push(entry),
      executeMutation: unavailable.executeMutation,
    });
    expect(unavailableDecision).toMatchObject({
      disposition: "failed",
      failure: "jev_unavailable",
      mutationAllowed: false,
    });
    expect(unavailable.executeMutation).not.toHaveBeenCalled();
  });

  it("skips JEV when the task is explicitly assigned and authorized", async () => {
    const deps = harness(recommendation());
    const decision = await runDevopsWorkflow(request({
      explicitAssignment: { agent: "devops", authorized: true },
    }), {
      policy,
      jev: { recommend: deps.recommend },
      record: (entry) => deps.records.push(entry),
      existingValidatedPath: deps.existingValidatedPath,
      executeMutation: deps.executeMutation,
    });

    expect(deps.recommend).not.toHaveBeenCalled();
    expect(deps.existingValidatedPath).toHaveBeenCalledOnce();
    expect(deps.executeMutation).not.toHaveBeenCalled();
    expect(decision.disposition).toBe("bypass_existing_path");
    expect(deps.records[0]).toMatchObject({
      recommendation: null,
      jevCalled: false,
      executionDecision: { disposition: "bypass_existing_path" },
    });
  });

  it("fails closed when the live JEV client has no credential", async () => {
    const previous = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    const deps = harness(recommendation());
    const decision = await runDevopsWorkflow(request(), {
      policy,
      jev: createLiveJevClient(),
      record: (entry) => deps.records.push(entry),
      executeRead: deps.executeRead,
      executeMutation: deps.executeMutation,
    });
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;

    expect(decision).toMatchObject({ disposition: "failed", failure: "jev_unavailable", mutationAllowed: false });
    expect(deps.executeRead).not.toHaveBeenCalled();
    expect(deps.executeMutation).not.toHaveBeenCalled();
    expect(deps.records[0]?.recommendation).toBeNull();
  });

  it("keeps DevOps execution acceptance separate from JEV operational status", () => {
    expect(acceptanceReport({
      controlTestsPassed: true,
      routingTestsPassed: true,
      liveCallsSucceeded: false,
    })).toEqual({
      devopsExecution: "accepted",
      jevIntegration: "not_operational",
    });
    expect(acceptanceReport({
      controlTestsPassed: true,
      routingTestsPassed: true,
      liveCallsSucceeded: true,
    })).toEqual({
      devopsExecution: "accepted",
      jevIntegration: "operational",
    });
  });
});
