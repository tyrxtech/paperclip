import { choice } from "@typesafe-ai/sdk";

export const JEV_ISSUE_LANE_MODEL = "jev-1.13.0";

export const JEV_ISSUE_LANES = [
  "engineering",
  "provider",
  "studio",
  "needs_review",
  "no_match",
] as const;

export type JevIssueLane = (typeof JEV_ISSUE_LANES)[number];

export const JEV_ISSUE_LANE_QUESTIONS = {
  lane: choice("Which advisory lane best matches this sanitized issue summary?", {
    engineering:
      "Paperclip or TYR-X product code, tests, build, database, API, or infrastructure implementation work.",
    provider:
      "External AI provider, model gateway, authentication, quota, rate limit, or provider runtime work.",
    studio:
      "Mac Studio host, local adapter, local service, device, networking, or workstation operations.",
    needs_review:
      "Ambiguous, strategic, security-sensitive, or cross-lane work that requires XO review.",
    no_match:
      "The summary does not contain enough information or does not match an approved lane.",
  }),
} as const;

export const JEV_ISSUE_LANE_RULES = Object.freeze({
  mode: "shadow_only",
  authority: "advisory_only",
  automaticAssignment: false,
  ambiguousOutcome: "needs_review" as const,
  unmatchedOutcome: "no_match" as const,
});
