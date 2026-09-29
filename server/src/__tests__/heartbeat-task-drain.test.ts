import { afterEach, describe, expect, it, vi } from "vitest";
import {
  armTaskDrainOnStartFromEnv,
  consumeTaskDrainExpiryResume,
  getTaskDrainStatus,
  resolveHeartbeatSchedulingSuppression,
  resolveStartupHeartbeatRecoveryPlan,
  startTaskDrain,
  stopTaskDrain,
} from "../services/heartbeat.ts";

describe("heartbeat task drain", () => {
  afterEach(() => {
    stopTaskDrain();
    consumeTaskDrainExpiryResume();
    vi.useRealTimers();
  });

  it("start_task_drain_suppresses_admission", () => {
    startTaskDrain({});
    expect(resolveHeartbeatSchedulingSuppression({})).toEqual({
      suppressed: true,
      reason: "task_drain",
    });
  });

  it("stop_task_drain_restores_admission", () => {
    startTaskDrain({});
    expect(stopTaskDrain()).toEqual({ wasActive: true });
    expect(resolveHeartbeatSchedulingSuppression({})).toEqual({
      suppressed: false,
      reason: null,
    });
    expect(consumeTaskDrainExpiryResume()).toBe(false);
    expect(stopTaskDrain()).toEqual({ wasActive: false });
  });

  it("null_ttl_produces_no_expiry", () => {
    const { expiresAt } = startTaskDrain({ ttlMs: null });
    expect(expiresAt).toBeNull();
    expect(getTaskDrainStatus().expiresAt).toBeNull();
  });

  it("an_expired_ttl_ends_the_drain_and_restores_admission", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    startTaskDrain({ ttlMs: 1000 });
    expect(resolveHeartbeatSchedulingSuppression({})).toEqual({
      suppressed: true,
      reason: "task_drain",
    });

    vi.setSystemTime(new Date("2026-01-01T00:00:01.001Z"));
    expect(resolveHeartbeatSchedulingSuppression({})).toEqual({
      suppressed: false,
      reason: null,
    });
    expect(getTaskDrainStatus().draining).toBe(false);
    expect(consumeTaskDrainExpiryResume()).toBe(true);
    expect(consumeTaskDrainExpiryResume()).toBe(false);
  });

  it("explicit stop clears a pending ttl resume", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    startTaskDrain({ ttlMs: 1000 });
    vi.setSystemTime(new Date("2026-01-01T00:00:01.001Z"));
    expect(getTaskDrainStatus().draining).toBe(false);
    startTaskDrain({});
    expect(stopTaskDrain()).toEqual({ wasActive: true });
    expect(consumeTaskDrainExpiryResume()).toBe(false);
  });

  it("does not arm a startup hold unless the env is truthy", () => {
    expect(armTaskDrainOnStartFromEnv({})).toEqual({ armed: false });
    expect(armTaskDrainOnStartFromEnv({ PAPERCLIP_TASK_DRAIN_ON_START: "false" })).toEqual({
      armed: false,
    });
    expect(resolveHeartbeatSchedulingSuppression({})).toEqual({
      suppressed: false,
      reason: null,
    });
    expect(resolveStartupHeartbeatRecoveryPlan({ suppressed: false, reason: null })).toEqual({
      runBookkeeping: true,
      runDispatch: true,
    });
  });

  it("arms an indefinite startup hold before dispatch and keeps orphan recovery", () => {
    expect(armTaskDrainOnStartFromEnv({ PAPERCLIP_TASK_DRAIN_ON_START: "true" })).toEqual({
      armed: true,
    });
    const status = getTaskDrainStatus();
    expect(status.draining).toBe(true);
    expect(status.expiresAt).toBeNull();
    expect(status.source).toBe("startup_env");
    expect(resolveHeartbeatSchedulingSuppression({})).toEqual({
      suppressed: true,
      reason: "task_drain",
    });
    expect(
      resolveStartupHeartbeatRecoveryPlan({ suppressed: true, reason: "task_drain" }),
    ).toEqual({ runBookkeeping: true, runDispatch: false });
    expect(
      resolveStartupHeartbeatRecoveryPlan({
        suppressed: true,
        reason: "database_restore_in_progress",
      }),
    ).toEqual({ runBookkeeping: false, runDispatch: false });
  });

  it("a second arm does not replace an active drain", () => {
    startTaskDrain({ ttlMs: 5_000 });
    expect(getTaskDrainStatus().source).toBe("operator");
    expect(armTaskDrainOnStartFromEnv({ PAPERCLIP_TASK_DRAIN_ON_START: "1" })).toEqual({
      armed: true,
    });
    expect(getTaskDrainStatus().source).toBe("operator");
    expect(getTaskDrainStatus().expiresAt).not.toBeNull();
  });

  it("status_reports_quiescent_when_both_promise_sets_are_empty", () => {
    startTaskDrain({});
    const status = getTaskDrainStatus();
    expect(status.draining).toBe(true);
    expect(status.activeRuns).toBe(0);
    expect(status.pendingWakes).toBe(0);
    expect(status.quiescent).toBe(true);
  });

});
