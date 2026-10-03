import { APITimeoutError } from "@typesafe-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { JevDecisionAdapter } from "./jev-decision-adapter.js";
import {
  approvedJevIssueSummary,
  JEV_ISSUE_LANE_MODEL,
  type JevIssueLane,
} from "./jev-issue-lane-policy.js";

const lanes: JevIssueLane[] = [
  "engineering",
  "provider",
  "studio",
  "needs_review",
  "no_match",
];

function response(choice: JevIssueLane, confidence = 0.9) {
  const remainder = (1 - confidence) / (lanes.length - 1);
  return {
    model: JEV_ISSUE_LANE_MODEL,
    answers: {
      issue_lane: {
        type: "choice" as const,
        choice,
        confidence,
        probabilities: Object.fromEntries(
          lanes.map((lane) => [lane, lane === choice ? confidence : remainder]),
        ),
      },
    },
    usage: { input_tokens: 25, output_tokens: 5 },
  };
}

function observation(issueIdentifier: string, overrides: Partial<{
  runId: string;
  issueStatus: string;
  unresolvedDependencyCount: number;
  duplicateRun: boolean;
  issueTitle: string | null;
}> = {}) {
  return {
    runId: overrides.runId ?? `run-${issueIdentifier}`,
    issueIdentifier,
    issueStatus: overrides.issueStatus ?? "in_progress",
    unresolvedDependencyCount: overrides.unresolvedDependencyCount ?? 0,
    duplicateRun: overrides.duplicateRun ?? false,
    issueTitle: overrides.issueTitle,
  };
}

function adapterFor(choice: JevIssueLane, confidence = 0.9) {
  let clock = 100;
  const systemOne = vi.fn().mockResolvedValue(response(choice, confidence));
  const adapter = new JevDecisionAdapter({
    enabled: true,
    apiKey: "test-only",
    client: { systemOne } as never,
    now: () => (clock += 25),
  });
  return { adapter, systemOne };
}

describe("JevDecisionAdapter shadow issue-lane suggestions", () => {
  it.each([
    ["engineering", "JEV-TRIAL-ENGINEERING", "engineering"],
    ["provider", "JEV-TRIAL-PROVIDER", "provider"],
    ["Studio", "JEV-TRIAL-STUDIO", "studio"],
    ["ambiguous", "JEV-TRIAL-AMBIGUOUS", "needs_review"],
    ["no-match", "JEV-TRIAL-NO-MATCH", "no_match"],
  ] as const)("records the %s corpus case", async (_caseName, identifier, lane) => {
    const { adapter, systemOne } = adapterFor(lane);

    const receipt = await adapter.suggestIssueLane(observation(identifier));

    expect(receipt).toEqual({
      suggestedLane: lane,
      probabilities: expect.objectContaining({ [lane]: 0.9 }),
      modelVersion: JEV_ISSUE_LANE_MODEL,
      elapsedMs: 25,
      tokens: { input: 25, output: 5, total: 30 },
      errorCategory: null,
    });
    expect(systemOne).toHaveBeenCalledTimes(1);
    const request = systemOne.mock.calls[0]![0];
    expect(request).toEqual(expect.objectContaining({
      model: JEV_ISSUE_LANE_MODEL,
      state: {
        approved_sanitized_issue_summary: expect.any(String),
        policy_version: "tyr-issue-lanes-v2",
      },
    }));
    expect(JSON.stringify(request)).not.toContain(identifier);
  });

  it("converts a low-confidence lane to needs_review", async () => {
    const { adapter } = adapterFor("engineering", 0.55);
    await expect(
      adapter.suggestIssueLane(observation("JEV-TRIAL-ENGINEERING")),
    ).resolves.toMatchObject({ suggestedLane: "needs_review" });
  });

  it.each([
    ["blocked", { issueStatus: "blocked" }],
    ["dependency-blocked", { unresolvedDependencyCount: 1 }],
    ["duplicate", { duplicateRun: true }],
  ] as const)("does not call TypeSafe for %s work", async (_caseName, overrides) => {
    const { adapter, systemOne } = adapterFor("engineering");
    await expect(
      adapter.suggestIssueLane(observation("JEV-TRIAL-ENGINEERING", overrides)),
    ).resolves.toBeNull();
    expect(systemOne).not.toHaveBeenCalled();
  });

  it("observes an already-running wake at most once", async () => {
    const { adapter, systemOne } = adapterFor("engineering");
    const running = observation("JEV-TRIAL-ENGINEERING", { runId: "run-one-wake" });

    const [first, duplicate] = await Promise.all([
      adapter.suggestIssueLane(running),
      adapter.suggestIssueLane(running),
    ]);

    expect(first?.suggestedLane).toBe("engineering");
    expect(duplicate).toBeNull();
    expect(systemOne).toHaveBeenCalledTimes(1);
  });

  it("does not call TypeSafe for an identifier that is neither a trial nor a real issue", async () => {
    const { adapter, systemOne } = adapterFor("engineering");
    await expect(
      adapter.suggestIssueLane(observation("TYR-UNREVIEWED", {
        issueTitle: "Implement a server-side retry guard and add unit tests",
      })),
    ).resolves.toBeNull();
    expect(systemOne).not.toHaveBeenCalled();
  });

  it.each(["PAP-1842", "PC1A2-7"])(
    "derives a summary for real issue %s and does not send the identifier",
    async (identifier) => {
      const { adapter, systemOne } = adapterFor("engineering");
      const receipt = await adapter.suggestIssueLane(observation(identifier, {
        issueTitle: `Repair the checkout retry ${identifier} https://example.com/run`,
      }));

      expect(receipt).toEqual({
        suggestedLane: "engineering",
        probabilities: expect.objectContaining({ engineering: 0.9 }),
        modelVersion: JEV_ISSUE_LANE_MODEL,
        elapsedMs: 25,
        tokens: { input: 25, output: 5, total: 30 },
        errorCategory: null,
      });
      expect(JSON.stringify(receipt)).not.toContain(identifier);
      expect(JSON.stringify(receipt)).not.toContain("checkout");
      expect(systemOne).toHaveBeenCalledTimes(1);
      const request = systemOne.mock.calls[0]![0];
      expect(request.state.approved_sanitized_issue_summary).toBe("Repair the checkout retry");
      expect(JSON.stringify(request)).not.toContain(identifier);
      expect(JSON.stringify(request)).not.toContain("http");
      expect(JSON.stringify(request)).not.toContain("example.com");
    },
  );

  it("keeps a synthetic trial on its reviewed summary when a title is also present", async () => {
    const { adapter, systemOne } = adapterFor("engineering");
    await adapter.suggestIssueLane(observation("JEV-TRIAL-ENGINEERING", {
      issueTitle: "customer contract password https://secret.example/a PAP-1",
    }));

    const request = systemOne.mock.calls[0]![0];
    expect(request.state.approved_sanitized_issue_summary).toBe(
      approvedJevIssueSummary("JEV-TRIAL-ENGINEERING"),
    );
    expect(JSON.stringify(request)).not.toContain("password");
    expect(JSON.stringify(request)).not.toContain("http");
    expect(JSON.stringify(request)).not.toContain("PAP-1");
  });

  it.each([
    ["missing title", undefined],
    ["identifier-only title", "PAP-1842"],
    ["restricted title", "Reset the api key for the provider"],
  ] as const)("does not call TypeSafe for a real issue with a %s", async (_caseName, issueTitle) => {
    const { adapter, systemOne } = adapterFor("engineering");
    await expect(
      adapter.suggestIssueLane(observation("PAP-1842", { issueTitle })),
    ).resolves.toBeNull();
    expect(systemOne).not.toHaveBeenCalled();
  });

  it("does not call TypeSafe for a real issue when the flag is off", async () => {
    const systemOne = vi.fn();
    const adapter = new JevDecisionAdapter({
      enabled: false,
      apiKey: "test-only",
      client: { systemOne } as never,
    });
    await expect(
      adapter.suggestIssueLane(observation("PAP-1842", {
        issueTitle: "Repair the checkout retry",
      })),
    ).resolves.toBeNull();
    expect(systemOne).not.toHaveBeenCalled();
  });

  it("does not call TypeSafe for a real issue when the key is missing", async () => {
    const adapter = new JevDecisionAdapter({ enabled: true, apiKey: "" });
    await expect(
      adapter.suggestIssueLane(observation("PAP-1842", {
        issueTitle: "Repair the checkout retry",
      })),
    ).resolves.toBeNull();
  });

  it("does not treat a non-exact flag or a missing env key as enabled", async () => {
    const previousFlag = process.env.PAPERCLIP_JEV_SHADOW_ENABLED;
    const previousKey = process.env.TYPESAFE_API_KEY;
    const realIssue = observation("PAP-1842", { issueTitle: "Repair the checkout retry" });
    try {
      process.env.PAPERCLIP_JEV_SHADOW_ENABLED = "TRUE";
      process.env.TYPESAFE_API_KEY = "test-only";
      await expect(new JevDecisionAdapter().suggestIssueLane(realIssue)).resolves.toBeNull();

      process.env.PAPERCLIP_JEV_SHADOW_ENABLED = "true";
      delete process.env.TYPESAFE_API_KEY;
      await expect(new JevDecisionAdapter().suggestIssueLane(realIssue)).resolves.toBeNull();
    } finally {
      if (previousFlag === undefined) delete process.env.PAPERCLIP_JEV_SHADOW_ENABLED;
      else process.env.PAPERCLIP_JEV_SHADOW_ENABLED = previousFlag;
      if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previousKey;
    }
  });

  it("does not send an email address or unused issue text for a real issue", async () => {
    const { adapter, systemOne } = adapterFor("engineering");
    const input = {
      ...observation("PAP-1842", {
        issueTitle: "Repair the checkout retry for ada@example.com",
      }),
      issueDescription: "customer contract raw description",
      commentBody: "password in a comment",
    };

    await adapter.suggestIssueLane(input);

    expect(systemOne).toHaveBeenCalledTimes(1);
    const request = JSON.stringify(systemOne.mock.calls[0]![0]);
    expect(request).toContain("Repair the checkout retry for");
    expect(request).not.toContain("ada@");
    expect(request).not.toContain("example.com");
    expect(request).not.toContain("customer contract");
    expect(request).not.toContain("password");
    expect(request).not.toContain("PAP-1842");
  });

  it("fails open with a bounded timeout category", async () => {
    const systemOne = vi.fn().mockRejectedValue(new APITimeoutError(1_500));
    const adapter = new JevDecisionAdapter({
      enabled: true,
      apiKey: "test-only",
      client: { systemOne } as never,
      now: (() => {
        let value = 0;
        return () => (value += 1_500);
      })(),
    });

    await expect(
      adapter.suggestIssueLane(observation("JEV-TRIAL-PROVIDER")),
    ).resolves.toEqual({
      suggestedLane: null,
      probabilities: null,
      modelVersion: JEV_ISSUE_LANE_MODEL,
      elapsedMs: 1_500,
      tokens: null,
      errorCategory: "timeout",
    });
  });

  it.each([
    ["unexpected model", { model: "provider-controlled-value" }],
    ["negative usage", { usage: { input_tokens: -1, output_tokens: 5 } }],
  ])("rejects %s without copying provider fields into the receipt", async (_caseName, override) => {
    const systemOne = vi.fn().mockResolvedValue({
      ...response("engineering"),
      ...override,
    });
    const adapter = new JevDecisionAdapter({
      enabled: true,
      apiKey: "test-only",
      client: { systemOne } as never,
      now: (() => {
        let value = 0;
        return () => (value += 10);
      })(),
    });

    await expect(
      adapter.suggestIssueLane(observation("JEV-TRIAL-ENGINEERING")),
    ).resolves.toEqual({
      suggestedLane: null,
      probabilities: null,
      modelVersion: JEV_ISSUE_LANE_MODEL,
      elapsedMs: 10,
      tokens: null,
      errorCategory: "invalid_response",
    });
  });

  it("stays disabled without the explicit feature flag and credential", async () => {
    const systemOne = vi.fn();
    const adapter = new JevDecisionAdapter({
      enabled: false,
      client: { systemOne } as never,
    });
    await expect(
      adapter.suggestIssueLane(observation("JEV-TRIAL-ENGINEERING")),
    ).resolves.toBeNull();
    expect(systemOne).not.toHaveBeenCalled();
  });

  it("stays disabled when enabled without a credential", async () => {
    const adapter = new JevDecisionAdapter({ enabled: true, apiKey: "" });
    await expect(
      adapter.suggestIssueLane(observation("JEV-TRIAL-ENGINEERING")),
    ).resolves.toBeNull();
  });
});
