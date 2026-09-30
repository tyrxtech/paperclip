import { performance } from "node:perf_hooks";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { logger } from "../middleware/logger.js";
import {
  JEV_ISSUE_LANES,
  JEV_ISSUE_LANE_MODEL,
  JEV_ISSUE_LANE_QUESTIONS,
  type JevIssueLane,
} from "./jev-issue-lane-rules.js";

const SUMMARY_MIN_LENGTH = 12;
const SUMMARY_MAX_LENGTH = 280;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;
const LONG_IDENTIFIER_PATTERN = /\b(?:[a-f0-9]{20,}|[A-Za-z0-9+/_=-]{32,}|\d{5,})\b/;
const EMAIL_PATTERN = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/;
const URL_PATTERN = /\b(?:https?|ssh):\/\//i;
const FORBIDDEN_CONTEXT_PATTERN =
  /\b(?:api[-_ ]?key|bearer|credential|password|private[-_ ]?key|secret|customer[-_ ]?(?:id|number)|vendor[-_ ]?(?:id|number)|shipment|tracking|container[-_ ]?(?:id|number)|bill of lading|air waybill|awb|contract|commercial exposure|financial exposure|raw logs?|stack trace|restricted(?: data)?|tyr-x restricted)\b/i;
const STRUCTURED_DUMP_PATTERN = /(?:^|\s)[{[]\s*["']?[A-Za-z0-9_-]+["']?\s*:/;

export type JevDecisionErrorCategory =
  | "authentication"
  | "configuration"
  | "data_boundary_rejected"
  | "invalid_response"
  | "rate_limit"
  | "timeout"
  | "transport"
  | "unknown";

export interface JevDecisionObservation {
  suggestedLane: JevIssueLane | null;
  probabilities: Partial<Record<JevIssueLane, number>>;
  modelVersion: string;
  elapsedMs: number;
  tokens: { input: number; output: number } | null;
  errorCategory: JevDecisionErrorCategory | null;
}

type JevClient = Pick<TypeSafeClient, "systemOne">;

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function classifyError(error: unknown): JevDecisionErrorCategory {
  const name =
    error && typeof error === "object" && "name" in error
      ? String(error.name).toLowerCase()
      : "";
  if (name.includes("timeout") || name.includes("abort")) return "timeout";
  if (name.includes("authentication")) return "authentication";
  if (name.includes("ratelimit") || name.includes("rate_limit"))
    return "rate_limit";
  if (name.includes("connection") || name.includes("network"))
    return "transport";
  return "unknown";
}

function normalizeProbabilities(
  value: unknown,
): Partial<Record<JevIssueLane, number>> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const result: Partial<Record<JevIssueLane, number>> = {};
  let total = 0;
  for (const lane of JEV_ISSUE_LANES) {
    const probability = finiteNonNegative(input[lane]);
    if (probability === null || probability > 1) return null;
    result[lane] = probability;
    total += probability;
  }
  return total >= 0.98 && total <= 1.02 ? result : null;
}

export function approvedSanitizedIssueSummary(
  value: unknown,
): string | null {
  if (typeof value !== "string") return null;
  const summary = value.trim().replace(/\s+/g, " ");
  if (
    summary.length < SUMMARY_MIN_LENGTH ||
    summary.length > SUMMARY_MAX_LENGTH ||
    UUID_PATTERN.test(summary) ||
    LONG_IDENTIFIER_PATTERN.test(summary) ||
    EMAIL_PATTERN.test(summary) ||
    URL_PATTERN.test(summary) ||
    FORBIDDEN_CONTEXT_PATTERN.test(summary) ||
    STRUCTURED_DUMP_PATTERN.test(summary)
  ) {
    return null;
  }
  return summary;
}

export class JevDecisionAdapter {
  readonly #client: JevClient;

  constructor(client?: JevClient) {
    this.#client =
      client ??
      new TypeSafeClient({
        defaultModel: JEV_ISSUE_LANE_MODEL,
        logLevel: "off",
        timeout: 1_500,
        retry: {
          maxRetries: 1,
          backoffInitialMs: 100,
          backoffMaxMs: 100,
        },
      });
  }

  async suggest(summary: string): Promise<JevDecisionObservation> {
    const started = performance.now();
    try {
      const result = await this.#client.systemOne(
        {
          state: summary,
          questions: JEV_ISSUE_LANE_QUESTIONS,
          model: JEV_ISSUE_LANE_MODEL,
        },
        {
          timeout: 1_500,
          retry: {
            maxRetries: 1,
            backoffInitialMs: 100,
            backoffMaxMs: 100,
          },
        },
      );
      const lane = result.answers.lane.choice;
      const probabilities = normalizeProbabilities(
        result.answers.lane.probabilities,
      );
      const inputTokens = finiteNonNegative(result.usage.input_tokens);
      const outputTokens = finiteNonNegative(result.usage.output_tokens);
      if (
        !JEV_ISSUE_LANES.includes(lane) ||
        !probabilities ||
        inputTokens === null ||
        outputTokens === null ||
        result.model !== JEV_ISSUE_LANE_MODEL
      ) {
        return {
          suggestedLane: null,
          probabilities: {},
          modelVersion: JEV_ISSUE_LANE_MODEL,
          elapsedMs: performance.now() - started,
          tokens: null,
          errorCategory: "invalid_response",
        };
      }
      return {
        suggestedLane: lane,
        probabilities,
        modelVersion: result.model,
        elapsedMs: performance.now() - started,
        tokens: { input: inputTokens, output: outputTokens },
        errorCategory: null,
      };
    } catch (error) {
      return {
        suggestedLane: null,
        probabilities: {},
        modelVersion: JEV_ISSUE_LANE_MODEL,
        elapsedMs: performance.now() - started,
        tokens: null,
        errorCategory: classifyError(error),
      };
    }
  }
}

interface ShadowEnvironment {
  PAPERCLIP_JEV_SHADOW_ENABLED?: string;
  PAPERCLIP_JEV_SHADOW_APPROVED_COMPANY_IDS?: string;
  PAPERCLIP_JEV_SHADOW_APPROVED_PROJECT_IDS?: string;
  TYPESAFE_API_KEY?: string;
}

interface JevShadowIssue {
  companyId: string;
  projectId: string | null;
  title: string;
}

interface ShadowLogger {
  info(fields: Record<string, unknown>, message: string): void;
}

function allowlist(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function recordObservation(
  output: ShadowLogger,
  observation: JevDecisionObservation,
) {
  output.info(
    {
      suggestedLane: observation.suggestedLane,
      probabilities: observation.probabilities,
      modelVersion: observation.modelVersion,
      elapsedMs: Math.round(observation.elapsedMs * 100) / 100,
      tokens: observation.tokens,
      errorCategory: observation.errorCategory,
    },
    "jev issue-lane shadow observation",
  );
}

export async function observeJevIssueLaneShadow(
  issue: JevShadowIssue,
  options: {
    env?: ShadowEnvironment;
    logger?: ShadowLogger;
    adapter?: JevDecisionAdapter;
  } = {},
): Promise<void> {
  const env = options.env ?? process.env;
  if (env.PAPERCLIP_JEV_SHADOW_ENABLED !== "true") return;
  if (!allowlist(env.PAPERCLIP_JEV_SHADOW_APPROVED_COMPANY_IDS).has(issue.companyId))
    return;
  if (
    !issue.projectId ||
    !allowlist(env.PAPERCLIP_JEV_SHADOW_APPROVED_PROJECT_IDS).has(issue.projectId)
  )
    return;

  const output = options.logger ?? logger;
  const summary = approvedSanitizedIssueSummary(issue.title);
  if (!summary) {
    recordObservation(output, {
      suggestedLane: null,
      probabilities: {},
      modelVersion: JEV_ISSUE_LANE_MODEL,
      elapsedMs: 0,
      tokens: null,
      errorCategory: "data_boundary_rejected",
    });
    return;
  }
  if (!env.TYPESAFE_API_KEY?.trim()) {
    recordObservation(output, {
      suggestedLane: null,
      probabilities: {},
      modelVersion: JEV_ISSUE_LANE_MODEL,
      elapsedMs: 0,
      tokens: null,
      errorCategory: "configuration",
    });
    return;
  }

  const adapter = options.adapter ?? new JevDecisionAdapter();
  recordObservation(output, await adapter.suggest(summary));
}
