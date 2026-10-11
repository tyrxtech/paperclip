import { JevRecommendationError, type DevopsTaskRequest, type JevRecommendationClient } from "./devops-workflow.js";
import { JEV_DEVOPS_MODEL } from "./jev-devops-recommendation.js";

const SUMMARY_LIMIT = 800;

/**
 * Live TypeSafe System One client.
 * SDK 0.6.0 `systemOne` returns typed answers only. This module does not
 * interpret those answers as permission.
 */
export function createLiveJevClient(): JevRecommendationClient {
  return {
    async recommend(request: DevopsTaskRequest) {
      const apiKey = process.env.TYPESAFE_API_KEY?.trim();
      if (!apiKey) throw new JevRecommendationError("jev_unavailable");

      let sdk: typeof import("@typesafe-ai/sdk");
      try {
        sdk = await import("@typesafe-ai/sdk");
      } catch {
        throw new JevRecommendationError("jev_unavailable");
      }

      const client = new sdk.TypeSafeClient({
        apiKey,
        defaultModel: JEV_DEVOPS_MODEL,
        logLevel: "off",
        timeout: 1_500,
        retry: { maxRetries: 1 },
      });

      try {
        return await client.systemOne({
          model: JEV_DEVOPS_MODEL,
          state: {
            summary: request.summary.slice(0, SUMMARY_LIMIT),
            operation: request.operation,
            target_host: request.targetHost,
            target_service: request.targetService,
          },
          questions: {
            task_category: sdk.choice(
              "Classify the task. This answer is advisory and cannot grant access, name a new host, or waive approval.",
              {
                infrastructure_read: "Read-only inspection of infrastructure state.",
                application_feature: "Application feature or product code change.",
                security_finding: "Security finding that needs review.",
                destructive: "Request to destroy, wipe, drop, or irreversibly change infrastructure.",
                ambiguous: "Ownership, target, or intent is unclear.",
              },
            ),
            suggested_agent: sdk.choice(
              "Which agent should review this. Advisory only.",
              {
                devops: "Infrastructure inspection or operations.",
                engineering: "Application implementation.",
                security: "Security review.",
              },
            ),
            priority: sdk.choice("How soon does this need attention. Advisory only.", {
              critical: null,
              high: null,
              medium: null,
              low: null,
            }),
            risk: sdk.choice("How much harm could a wrong action cause. Advisory only.", {
              low: null,
              medium: null,
              high: null,
              critical: null,
            }),
            human_review: sdk.noul(
              "Should a human review this before any action? Yes does not itself authorize the action.",
            ),
            missing_information: sdk.choice("What required fact is missing. Advisory only.", {
              none: "Target, intent, and scope are specific enough to classify.",
              target: "Host or service is missing or unclear.",
              intent: "The requested outcome is unclear.",
              authority: "It is unclear who is allowed to do this.",
            }),
          },
        });
      } catch (error) {
        if (error instanceof JevRecommendationError) throw error;
        throw new JevRecommendationError("jev_unavailable");
      }
    },
  };
}
