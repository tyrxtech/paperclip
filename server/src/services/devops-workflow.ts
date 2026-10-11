import {
  DEFAULT_DEVOPS_EXECUTION_POLICY,
  evaluateExecutionControls,
  type DevopsExecutionPolicy,
  type DevopsOperation,
  type ExecutionControlDecision,
  type ResponsibleAgent,
} from "./devops-execution-controls.js";
import {
  JEV_DEVOPS_MIN_CONFIDENCE,
  recommendationFromAnswers,
  type JevDevopsRecommendation,
  type TaskCategory,
} from "./jev-devops-recommendation.js";

export type DevopsTaskRequest = {
  taskId: string;
  summary: string;
  operation: DevopsOperation;
  targetHost: string;
  targetService: string;
  /** Set only by Paperclip authorization, never by JEV. */
  approvalSatisfied: boolean;
  /**
   * Explicit assignment plus an existing authorization skips JEV and uses the
   * already validated execution path.
   */
  explicitAssignment: { agent: ResponsibleAgent; authorized: boolean } | null;
};

export type ExecutionDisposition =
  | "route_devops"
  | "route_engineering"
  | "review_security"
  | "review_escalated"
  | "blocked"
  | "failed"
  | "bypass_existing_path";

export type DevopsExecutionDecision = {
  disposition: ExecutionDisposition;
  responsibleAgent: ResponsibleAgent | "human_review" | null;
  mutationAllowed: boolean;
  readAllowed: boolean;
  reason: string;
  controls: ExecutionControlDecision | null;
  failure: string | null;
};

export type PaperclipTaskRecord = {
  taskId: string;
  recommendation: JevDevopsRecommendation | null;
  executionDecision: DevopsExecutionDecision;
  jevCalled: boolean;
};

export type AcceptanceReport = {
  devopsExecution: "accepted" | "not_accepted";
  jevIntegration: "operational" | "not_operational";
};

export class JevRecommendationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JevRecommendationError";
  }
}

export type JevRecommendationClient = {
  recommend(request: DevopsTaskRequest): Promise<unknown>;
};

export type DevopsWorkflowDependencies = {
  policy?: DevopsExecutionPolicy;
  jev: JevRecommendationClient;
  record(entry: PaperclipTaskRecord): Promise<void> | void;
  /** Read-only DevOps work. Never used for mutation. */
  executeRead?(request: DevopsTaskRequest, decision: DevopsExecutionDecision): Promise<void> | void;
  /** Mutation entry. The gate calls it only after local controls allow it. */
  executeMutation?(request: DevopsTaskRequest, decision: DevopsExecutionDecision): Promise<void> | void;
  existingValidatedPath?(request: DevopsTaskRequest): Promise<void> | void;
};

function routeForCategory(category: TaskCategory): Pick<
  DevopsExecutionDecision,
  "disposition" | "responsibleAgent" | "reason"
> | null {
  switch (category) {
    case "infrastructure_read":
      return { disposition: "route_devops", responsibleAgent: "devops", reason: "infrastructure_read" };
    case "application_feature":
      return { disposition: "route_engineering", responsibleAgent: "engineering", reason: "application_feature" };
    case "security_finding":
      return { disposition: "review_security", responsibleAgent: "security", reason: "security_review" };
    case "ambiguous":
      return { disposition: "review_escalated", responsibleAgent: "human_review", reason: "ambiguous" };
    case "destructive":
      return null;
    default:
      return null;
  }
}

function failed(reason: string): DevopsExecutionDecision {
  return {
    disposition: "failed",
    responsibleAgent: null,
    mutationAllowed: false,
    readAllowed: false,
    reason,
    controls: null,
    failure: reason,
  };
}

/**
 * DevOps execution acceptance and JEV acceptance are independent.
 * JEV is operational only after a real successful call and passing routing tests.
 * A mock or a recommendation cannot set that status.
 */
export function acceptanceReport(evidence: {
  controlTestsPassed: boolean;
  routingTestsPassed: boolean;
  liveCallsSucceeded: boolean;
}): AcceptanceReport {
  return {
    devopsExecution: evidence.controlTestsPassed ? "accepted" : "not_accepted",
    jevIntegration:
      evidence.routingTestsPassed && evidence.liveCallsSucceeded
        ? "operational"
        : "not_operational",
  };
}

export async function runDevopsWorkflow(
  request: DevopsTaskRequest,
  deps: DevopsWorkflowDependencies,
): Promise<DevopsExecutionDecision> {
  const policy = deps.policy ?? DEFAULT_DEVOPS_EXECUTION_POLICY;

  if (request.explicitAssignment?.authorized) {
    const decision: DevopsExecutionDecision = {
      disposition: "bypass_existing_path",
      responsibleAgent: request.explicitAssignment.agent,
      mutationAllowed: false,
      readAllowed: false,
      reason: "explicit_assignment_uses_existing_validated_path",
      controls: null,
      failure: null,
    };
    await deps.record({
      taskId: request.taskId,
      recommendation: null,
      executionDecision: decision,
      jevCalled: false,
    });
    await deps.existingValidatedPath?.(request);
    return decision;
  }

  let recommendation: JevDevopsRecommendation | null = null;
  try {
    const raw = await deps.jev.recommend(request);
    const validated = recommendationFromAnswers(
      raw && typeof raw === "object" && "answers" in raw ? (raw as { answers: unknown }).answers : raw,
      request,
      raw && typeof raw === "object" && "model" in raw ? (raw as { model: unknown }).model : undefined,
    );
    if (!validated.ok) {
      const decision = failed(`invalid_jev_output:${validated.reason}`);
      await deps.record({
        taskId: request.taskId,
        recommendation: null,
        executionDecision: decision,
        jevCalled: true,
      });
      return decision;
    }
    recommendation = validated.value;
  } catch (error) {
    const decision = failed(
      error instanceof JevRecommendationError ? error.message : "jev_unavailable",
    );
    await deps.record({
      taskId: request.taskId,
      recommendation: null,
      executionDecision: decision,
      jevCalled: true,
    });
    return decision;
  }

  const controls = evaluateExecutionControls(policy, {
    operation: request.operation,
    targetHost: request.targetHost,
    targetService: request.targetService,
    approvalSatisfied: request.approvalSatisfied,
    actingAgent: "devops",
  });

  let decision: DevopsExecutionDecision;
  if (
    request.operation === "destroy" ||
    recommendation.taskCategory === "destructive" ||
    controls.reason === "destructive_operation_blocked"
  ) {
    decision = {
      disposition: "blocked",
      responsibleAgent: null,
      mutationAllowed: false,
      readAllowed: false,
      reason: "destructive_operation_blocked",
      controls,
      failure: null,
    };
  } else if (
    recommendation.confidence < JEV_DEVOPS_MIN_CONFIDENCE ||
    recommendation.missingInformation.length > 0 ||
    recommendation.taskCategory === "ambiguous"
  ) {
    decision = {
      disposition: "review_escalated",
      responsibleAgent: "human_review",
      mutationAllowed: false,
      readAllowed: false,
      reason:
        recommendation.taskCategory === "ambiguous"
          ? "ambiguous"
          : recommendation.missingInformation.length > 0
            ? "missing_information"
            : "low_confidence",
      controls,
      failure: null,
    };
  } else if (recommendation.taskCategory === "security_finding" || recommendation.humanReviewRecommended) {
    const routed = routeForCategory(recommendation.taskCategory);
    decision = {
      disposition: recommendation.taskCategory === "security_finding" ? "review_security" : "review_escalated",
      responsibleAgent: recommendation.taskCategory === "security_finding" ? "security" : "human_review",
      mutationAllowed: false,
      readAllowed: false,
      reason: routed?.reason ?? "human_review",
      controls,
      failure: null,
    };
  } else {
    const routed = routeForCategory(recommendation.taskCategory);
    if (!routed) {
      decision = failed("unroutable_category");
    } else if (routed.disposition === "route_devops") {
      if (!controls.allowed) {
        decision = {
          disposition: controls.reason === "approval_required" ? "review_escalated" : "blocked",
          responsibleAgent: controls.reason === "approval_required" ? "human_review" : null,
          mutationAllowed: false,
          readAllowed: false,
          reason: controls.reason,
          controls,
          failure: null,
        };
      } else if (request.operation === "read") {
        decision = {
          ...routed,
          mutationAllowed: false,
          readAllowed: true,
          controls,
          failure: null,
        };
      } else {
        decision = {
          ...routed,
          disposition: "route_devops",
          mutationAllowed: true,
          readAllowed: false,
          controls,
          failure: null,
        };
      }
    } else {
      decision = {
        ...routed,
        mutationAllowed: false,
        readAllowed: false,
        controls,
        failure: null,
      };
    }
  }

  await deps.record({
    taskId: request.taskId,
    recommendation,
    executionDecision: decision,
    jevCalled: true,
  });

  if (decision.readAllowed) await deps.executeRead?.(request, decision);
  if (decision.mutationAllowed) await deps.executeMutation?.(request, decision);
  return decision;
}
