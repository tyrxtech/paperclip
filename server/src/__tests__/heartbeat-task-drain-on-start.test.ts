import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  armTaskDrainOnStartFromEnv,
  heartbeatService,
  stopTaskDrain,
} from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres startup task-drain tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("startup task drain holds dispatch until release", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-task-drain-on-start-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  function isHeartbeatRunDependentFkError(error: unknown) {
    const message = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error);
    return (
      message.includes("heartbeat_run_events_run_id_heartbeat_runs_id_fk") ||
      message.includes("activity_log_run_id_heartbeat_runs_id_fk")
    );
  }

  async function deleteHeartbeatRunsWithDependents() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(heartbeatRunEvents);
      await db.delete(activityLog);
      try {
        await db.delete(heartbeatRuns);
        return;
      } catch (error) {
        if (!isHeartbeatRunDependentFkError(error) || attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  afterEach(async () => {
    stopTaskDrain();
    await deleteHeartbeatRunsWithDependents();
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAgentIssue() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Held Agent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
          wakeOnDemand: true,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Queued across a startup hold",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });
    return { companyId, agentId, issueId };
  }

  async function runRow(runId: string) {
    return db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        startedAt: heartbeatRuns.startedAt,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  async function allRuns() {
    return db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        startedAt: heartbeatRuns.startedAt,
        retryOfRunId: heartbeatRuns.retryOfRunId,
        invocationSource: heartbeatRuns.invocationSource,
      })
      .from(heartbeatRuns);
  }

  it("keeps a queued run unexecuted through cold startup and runs it once after release", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });

    expect(armTaskDrainOnStartFromEnv({ PAPERCLIP_TASK_DRAIN_ON_START: "true" })).toEqual({
      armed: true,
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.reapOrphanedRuns();
    expect(await heartbeat.promoteDueScheduledRetries()).toEqual({ promoted: 0, runIds: [] });
    await heartbeat.resumeQueuedRuns();

    expect(await runRow(runId)).toMatchObject({ status: "queued", startedAt: null });
    const issue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBeNull();
    expect(await allRuns()).toEqual([
      expect.objectContaining({ id: runId, status: "queued", startedAt: null }),
    ]);

    stopTaskDrain();
    await heartbeat.resumeHeldAdmission();
    await heartbeat.drainActiveRunExecutions();

    const afterRelease = await allRuns();
    const original = afterRelease.find((run) => run.id === runId);
    expect(original).toMatchObject({ status: "succeeded" });
    const duplicates = afterRelease.filter(
      (run) => run.id !== runId && run.retryOfRunId !== runId,
    );
    expect(duplicates).toEqual([]);

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    const afterSecondResume = await allRuns();
    expect(afterSecondResume.filter((run) => run.retryOfRunId !== runId && run.id !== runId)).toEqual([]);
    expect(afterSecondResume.find((run) => run.id === runId)?.status).toBe("succeeded");
  }, 20_000);

  it("keeps a due scheduled retry unpromoted until release, then runs it once", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const dueAt = new Date(Date.now() - 1_000);
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "scheduled_retry",
      wakeupRequestId,
      scheduledRetryAt: dueAt,
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "transient_failure",
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });

    armTaskDrainOnStartFromEnv({ PAPERCLIP_TASK_DRAIN_ON_START: "yes" });
    const heartbeat = heartbeatService(db);
    expect(await heartbeat.promoteDueScheduledRetries(new Date())).toEqual({ promoted: 0, runIds: [] });
    await heartbeat.resumeQueuedRuns();
    expect(await runRow(runId)).toMatchObject({ status: "scheduled_retry", startedAt: null });
    expect((await allRuns()).map((run) => run.id)).toEqual([runId]);

    stopTaskDrain();
    await heartbeat.resumeHeldAdmission();
    await heartbeat.drainActiveRunExecutions();

    const afterRelease = await allRuns();
    expect(afterRelease.find((run) => run.id === runId)).toMatchObject({ status: "succeeded" });
    expect(afterRelease.filter((run) => run.id !== runId && run.retryOfRunId !== runId)).toEqual([]);
  }, 20_000);
});
