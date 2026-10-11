/**
 * Schema for a JEV DevOps recommendation.
 *
 * JEV System One (SDK 0.6.0, model jev-1.13.0) returns choice, score, and noul
 * answers. It cannot emit a hostname or an authorization grant. Target
 * host/service are copied from the caller-supplied request after this schema
 * accepts the typed answers. Extra fields are ignored and cannot grant access.
 */

import type { ResponsibleAgent } from "./devops-execution-controls.js";

export const JEV_DEVOPS_MODEL = "jev-1.13.0";
export const JEV_DEVOPS_MIN_CONFIDENCE = 0.6;

export const TASK_CATEGORIES = [
  "infrastructure_read",
  "application_feature",
  "security_finding",
  "destructive",
  "ambiguous",
] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];

export const PRIORITIES = ["critical", "high", "medium", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const MISSING_INFORMATION = ["none", "target", "intent", "authority"] as const;
export type MissingInformation = (typeof MISSING_INFORMATION)[number];

export type JevDevopsRecommendation = {
  taskCategory: TaskCategory;
  suggestedAgent: ResponsibleAgent;
  priority: Priority;
  targetHost: string;
  targetService: string;
  risk: RiskLevel;
  humanReviewRecommended: boolean;
  confidence: number;
  missingInformation: Exclude<MissingInformation, "none">[];
  model: string;
};

export type RecommendationValidation =
  | { ok: true; value: JevDevopsRecommendation }
  | { ok: false; reason: string };

function isEnum<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function confidenceOf(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return null;
  return value;
}

export function recommendationFromAnswers(
  answers: unknown,
  request: { targetHost: string; targetService: string },
  model: unknown,
): RecommendationValidation {
  if (!answers || typeof answers !== "object") return { ok: false, reason: "answers_not_object" };
  const record = answers as Record<string, unknown>;
  const category = record.task_category;
  const agent = record.suggested_agent;
  const priority = record.priority;
  const risk = record.risk;
  const review = record.human_review;
  const missing = record.missing_information;

  if (!category || typeof category !== "object") return { ok: false, reason: "task_category_missing" };
  if (!agent || typeof agent !== "object") return { ok: false, reason: "suggested_agent_missing" };
  if (!priority || typeof priority !== "object") return { ok: false, reason: "priority_missing" };
  if (!risk || typeof risk !== "object") return { ok: false, reason: "risk_missing" };
  if (!review || typeof review !== "object") return { ok: false, reason: "human_review_missing" };
  if (!missing || typeof missing !== "object") return { ok: false, reason: "missing_information_missing" };

  const categoryRecord = category as Record<string, unknown>;
  const agentRecord = agent as Record<string, unknown>;
  const priorityRecord = priority as Record<string, unknown>;
  const riskRecord = risk as Record<string, unknown>;
  const reviewRecord = review as Record<string, unknown>;
  const missingRecord = missing as Record<string, unknown>;

  if (categoryRecord.type !== "choice" || !isEnum(TASK_CATEGORIES, categoryRecord.choice)) {
    return { ok: false, reason: "task_category_invalid" };
  }
  const confidence = confidenceOf(categoryRecord.confidence);
  if (confidence === null) return { ok: false, reason: "confidence_invalid" };
  if (agentRecord.type !== "choice" || !isEnum(["devops", "engineering", "security"] as const, agentRecord.choice)) {
    return { ok: false, reason: "suggested_agent_invalid" };
  }
  if (priorityRecord.type !== "choice" || !isEnum(PRIORITIES, priorityRecord.choice)) {
    return { ok: false, reason: "priority_invalid" };
  }
  if (riskRecord.type !== "choice" || !isEnum(RISK_LEVELS, riskRecord.choice)) {
    return { ok: false, reason: "risk_invalid" };
  }
  if (reviewRecord.type !== "noul" || confidenceOf(reviewRecord.noul) === null) {
    return { ok: false, reason: "human_review_invalid" };
  }
  if (missingRecord.type !== "choice" || !isEnum(MISSING_INFORMATION, missingRecord.choice)) {
    return { ok: false, reason: "missing_information_invalid" };
  }
  if (model !== JEV_DEVOPS_MODEL) return { ok: false, reason: "model_not_pinned" };

  const missingInformation =
    missingRecord.choice === "none" ? [] : [missingRecord.choice];
  if (!request.targetHost.trim() || !request.targetService.trim()) {
    if (!missingInformation.includes("target")) missingInformation.push("target");
  }

  return {
    ok: true,
    value: {
      taskCategory: categoryRecord.choice,
      suggestedAgent: agentRecord.choice,
      priority: priorityRecord.choice,
      targetHost: request.targetHost.trim(),
      targetService: request.targetService.trim(),
      risk: riskRecord.choice,
      humanReviewRecommended: (reviewRecord.noul as number) >= 0.5,
      confidence,
      missingInformation,
      model: JEV_DEVOPS_MODEL,
    },
  };
}
