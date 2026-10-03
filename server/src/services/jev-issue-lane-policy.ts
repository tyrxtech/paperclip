import { normalizeIssueIdentifier } from "@paperclipai/shared/issue-references";
import { choice } from "@typesafe-ai/sdk";

export const JEV_ISSUE_LANE_MODEL = "jev-1.13.0";
export const JEV_ISSUE_LANE_POLICY_VERSION = "tyr-issue-lanes-v2";

export const JEV_ISSUE_LANES = {
  engineering:
    "Paperclip or TYR-X software implementation, tests, debugging, infrastructure code, or technical documentation.",
  provider:
    "External AI provider integration, model access, provider credentials, quotas, routing, or provider reliability.",
  studio:
    "Studio, visual design, brand, media, creative production, or content work.",
  needs_review:
    "Ambiguous, strategic, cross-lane, governed, or insufficiently specified work that XO should review.",
  no_match:
    "The summary does not belong to any supported issue lane.",
} as const;

export type JevIssueLane = keyof typeof JEV_ISSUE_LANES;

export const JEV_ISSUE_LANE_QUESTIONS = {
  issue_lane: choice(
    "Suggest exactly one issue lane. This is advisory shadow output only; do not infer authority or workflow actions.",
    JEV_ISSUE_LANES,
  ),
} as const;

export const JEV_ISSUE_LANE_RULES = {
  minimumConfidence: 0.6,
  lowConfidenceOutcome: "needs_review" as const,
  maximumSummaryCharacters: 800,
  timeoutMs: 1_500,
  maximumRetries: 1,
} as const;

/**
 * Synthetic trial summaries. An exact identifier match uses this text and
 * ignores any issue title. Entries are manually reviewed, contain no
 * identifiers or restricted data, and describe only the minimum facts needed
 * for lane classification.
 */
export const JEV_APPROVED_ISSUE_SUMMARIES: Readonly<Record<string, string>> = {
  "JEV-TRIAL-ENGINEERING":
    "Implement a server-side retry guard and add focused unit tests for the control plane.",
  "JEV-TRIAL-PROVIDER":
    "Investigate an external model provider timeout and verify bounded retry behavior.",
  "JEV-TRIAL-STUDIO":
    "Create a visual layout and final brand assets for a Studio launch page.",
  "JEV-TRIAL-AMBIGUOUS":
    "Decide how a cross-team initiative should proceed when ownership and outcome are unclear.",
  "JEV-TRIAL-NO-MATCH":
    "Organize a voluntary team lunch for next month.",
};

const ISSUE_IDENTIFIER_TOKEN_RE = /\b[A-Z][A-Z0-9]*-\d+\b/gi;
const URL_RE = /\bhttps?:\/\/\S+/gi;
const EMAIL_RE = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const LONG_TOKEN_RE = /\b[A-Za-z0-9+/=_-]{32,}\b/g;

export function approvedJevIssueSummary(identifier: string): string | null {
  return JEV_APPROVED_ISSUE_SUMMARIES[identifier] ?? null;
}

function deriveRealIssueTitleSummary(title: string): string | null {
  const stripped = title
    .normalize("NFKC")
    .replace(URL_RE, " ")
    .replace(EMAIL_RE, " ")
    .replace(UUID_RE, " ")
    .replace(LONG_TOKEN_RE, " ")
    .replace(ISSUE_IDENTIFIER_TOKEN_RE, " ")
    .replace(/[`"'“”]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
  const bounded =
    stripped.length > JEV_ISSUE_LANE_RULES.maximumSummaryCharacters
      ? stripped.slice(0, JEV_ISSUE_LANE_RULES.maximumSummaryCharacters).trim()
      : stripped;
  return bounded.length > 0 ? bounded : null;
}

/**
 * Summary that may be offered to the adapter. Synthetic registry entries win.
 * A real Paperclip issue (`PREFIX-NUMBER`) derives a summary from its title
 * only. Descriptions and comments are not inputs. The adapter still rejects a
 * result that fails the existing length and restricted-data checks, and a
 * failed derivation sends nothing.
 */
export function deriveJevIssueLaneSummary(input: {
  identifier: string;
  title?: string | null;
}): string | null {
  const registered = approvedJevIssueSummary(input.identifier);
  if (registered) return registered;
  if (!normalizeIssueIdentifier(input.identifier)) return null;
  if (typeof input.title !== "string") return null;
  return deriveRealIssueTitleSummary(input.title);
}
