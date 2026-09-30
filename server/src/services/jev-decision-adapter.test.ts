import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { queueIssueAssignmentWakeup } from "./issue-assignment-wakeup.js";
import {
  approvedSanitizedIssueSummary,
  JevDecisionAdapter,
  observeJevIssueLaneShadow,
} from "./jev-decision-adapter.js";
import {
  JEV_ISSUE_LANES,
  JEV_ISSUE_LANE_MODEL,
  type JevIssueLane,
} from "./jev-issue-lane-rules.js";

const COMPANY_ID = "company-approved";
const PROJECT_ID = "project-approved";
const enabledEnv = {
  PAPERCLIP_JEV_SHADOW_ENABLED: "true",
  PAPERCLIP_JEV_SHADOW_APPROVED_COMPANY_IDS: COMPANY_ID,
  PAPERCLIP_JEV_SHADOW_APPROVED_PROJECT_IDS: PROJECT_ID,
  TYPESAFE_API_KEY: "test-only-placeholder",
};

function distribution(selected: JevIssueLane) {
  return Object.fromEntries(
    JEV_ISSUE_LANES.map((lane) => [lane, lane === selected ? 0.8 : 0.05]),
  ) as Record<JevIssueLane, number>;
}

function fakeClient(
  choose: (state: string) => JevIssueLane,
): Pick<TypeSafeClient, "systemOne"> {
  return {
    systemOne: vi.fn(async (request) => {
      const selected = choose(String(request.state));
      return {
        model: JEV_ISSUE_LANE_MODEL,
        answers: {
          lane: {
            type: "choice",
            choice: selected,
            confidence: 0.8,
            probabilities: distribution(selected),
          },
        },
        usage: { input_tokens: 12, output_tokens: 1 },
      };
    }) as unknown as TypeSafeClient["systemOne"],
  };
}

describe("JevDecisionAdapter", () => {
  it("matches the offline known-correct trial corpus, including guarded workflow states", async () => {
    const corpus: Array<{
      name: string;
      summary: string;
      expected: JevIssueLane;
      workflowState: string;
    }> = [
      {
        name: "engineering",
        summary: "Fix database migration ordering in Paperclip server",
        expected: "engineering",
        workflowState: "ready",
      },
      {
        name: "provider",
        summary: "Investigate model gateway quota handling for provider runtime",
        expected: "provider",
        workflowState: "ready",
      },
      {
        name: "studio",
        summary: "Repair Mac Studio local adapter networking health check",
        expected: "studio",
        workflowState: "ready",
      },
      {
        name: "ambiguous",
        summary: "Decide ownership for a cross lane strategic architecture change",
        expected: "needs_review",
        workflowState: "ready",
      },
      {
        name: "no-match",
        summary: "Organize a general internal planning discussion",
        expected: "no_match",
        workflowState: "ready",
      },
      {
        name: "blocked",
        summary: "Fix server test after its dependency is approved",
        expected: "engineering",
        workflowState: "blocked_by_dependency",
      },
      {
        name: "already-running",
        summary: "Inspect provider runtime while its assigned worker is active",
        expected: "provider",
        workflowState: "already_running",
      },
    ];
    const client = fakeClient((state) => {
      const row = corpus.find((candidate) => candidate.summary === state);
      if (!row) throw new Error("unexpected state");
      return row.expected;
    });
    const adapter = new JevDecisionAdapter(client);

    const results = await Promise.all(
      corpus.map(async (row) => ({ row, result: await adapter.suggest(row.summary) })),
    );

    expect(results.map(({ result }) => result.suggestedLane)).toEqual(
      corpus.map((row) => row.expected),
    );
    expect(results.every(({ result }) => result.errorCategory === null)).toBe(true);
    expect(results.every(({ result }) => result.tokens?.input === 12)).toBe(true);
    expect(corpus.map((row) => row.workflowState)).toContain("blocked_by_dependency");
    expect(corpus.map((row) => row.workflowState)).toContain("already_running");
  });

  it("fails open with bounded error metadata and no body logging", async () => {
    const client = {
      systemOne: vi.fn(async () => {
        const error = new Error("body that must not be recorded");
        error.name = "APITimeoutError";
        throw error;
      }) as unknown as TypeSafeClient["systemOne"],
    };
    const result = await new JevDecisionAdapter(client).suggest(
      "Repair provider timeout classification without changing dispatch",
    );

    expect(result).toMatchObject({
      suggestedLane: null,
      probabilities: {},
      modelVersion: JEV_ISSUE_LANE_MODEL,
      tokens: null,
      errorCategory: "timeout",
    });
    expect(JSON.stringify(result)).not.toContain("body that must not be recorded");
  });
});

describe("Jev shadow data boundary", () => {
  it("accepts a compact engineering summary and rejects restricted classes", () => {
    expect(
      approvedSanitizedIssueSummary(
        "  Fix Paperclip issue route tests for local adapter behavior  ",
      ),
    ).toBe("Fix Paperclip issue route tests for local adapter behavior");

    for (const rejected of [
      "Use API key abcdefghijklmnopqrstuvwxyz012345 for this request",
      "Contact operator@example.com about this issue",
      "Inspect shipment tracking details before routing this issue",
      "Review vendor ID VENDOR-43210 in the contract",
      "Paste raw log stack trace from the failed worker here",
      "Restricted TYR-X data needs classification",
      "Inspect record 5df14071-f7d4-462f-86b0-de88597ccf97",
      '{"message":"structured dump"}',
    ]) {
      expect(approvedSanitizedIssueSummary(rejected)).toBeNull();
    }
  });

  it("requires every feature, company, project, data and key gate before a call", async () => {
    const adapter = { suggest: vi.fn() } as unknown as JevDecisionAdapter;
    const output = { info: vi.fn() };
    const issue = {
      companyId: COMPANY_ID,
      projectId: PROJECT_ID,
      title: "Fix the Paperclip issue route implementation",
    };

    await observeJevIssueLaneShadow(issue, {
      env: { ...enabledEnv, PAPERCLIP_JEV_SHADOW_ENABLED: "false" },
      adapter,
      logger: output,
    });
    await observeJevIssueLaneShadow(issue, {
      env: { ...enabledEnv, PAPERCLIP_JEV_SHADOW_APPROVED_PROJECT_IDS: "other" },
      adapter,
      logger: output,
    });
    await observeJevIssueLaneShadow(issue, {
      env: { ...enabledEnv, TYPESAFE_API_KEY: "" },
      adapter,
      logger: output,
    });

    expect(adapter.suggest).not.toHaveBeenCalled();
    expect(output.info).toHaveBeenCalledTimes(1);
    expect(output.info.mock.calls[0]?.[0]).toMatchObject({
      errorCategory: "configuration",
    });
  });

  it("records only the allowed observation fields", async () => {
    const client = fakeClient(() => "engineering");
    const adapter = new JevDecisionAdapter(client);
    const output = { info: vi.fn() };
    const title = "Fix Paperclip database migration tests for issue creation";

    await observeJevIssueLaneShadow(
      { companyId: COMPANY_ID, projectId: PROJECT_ID, title },
      { env: enabledEnv, adapter, logger: output },
    );

    expect(output.info).toHaveBeenCalledOnce();
    const fields = output.info.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(fields).sort()).toEqual(
      [
        "elapsedMs",
        "errorCategory",
        "modelVersion",
        "probabilities",
        "suggestedLane",
        "tokens",
      ].sort(),
    );
    expect(JSON.stringify(fields)).not.toContain(title);
    expect(client.systemOne).toHaveBeenCalledOnce();
  });
});

describe("dispatch invariants", () => {
  it("keeps the shadow observation after the one existing assignment wake and after duplicate return", () => {
    const routePath = fileURLToPath(new URL("../routes/issues.ts", import.meta.url));
    const source = readFileSync(routePath, "utf8");
    const createStart = source.indexOf('router.post(\n    "/companies/:companyId/issues"');
    const childStart = source.indexOf('router.post(\n    "/issues/:id/children"', createStart);
    const createRoute = source.slice(createStart, childStart);
    const duplicateReturn = createRoute.indexOf("if (deduplicationReason)");
    const wake = createRoute.lastIndexOf("void queueIssueAssignmentWakeup");
    const shadow = createRoute.indexOf("void observeJevIssueLaneShadow");

    expect(createStart).toBeGreaterThanOrEqual(0);
    expect(duplicateReturn).toBeGreaterThanOrEqual(0);
    expect(wake).toBeGreaterThan(duplicateReturn);
    expect(shadow).toBeGreaterThan(wake);
    expect(createRoute.match(/void queueIssueAssignmentWakeup/g)).toHaveLength(1);
    expect(createRoute.match(/void observeJevIssueLaneShadow/g)).toHaveLength(1);
  });

  it("does not add a second wake for blocked or already-running issue states", async () => {
    for (const status of ["blocked", "in_progress"]) {
      const wakeup = vi.fn(async () => ({ queued: true }));
      await queueIssueAssignmentWakeup({
        heartbeat: { wakeup },
        issue: { id: `issue-${status}`, assigneeAgentId: "agent-one", status },
        reason: "issue_assigned",
        mutation: "create",
        contextSource: "issue.create",
      });
      expect(wakeup).toHaveBeenCalledOnce();
    }
  });
});
