type IntakeIssue = {
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
};

type IntakeBlocker = { status: string };

/** JEV may advise only before an issue is assigned or admitted for execution. */
export function isJevIntakeEligible(
  issue: IntakeIssue,
  blockedBy: readonly IntakeBlocker[],
): boolean {
  if (issue.status !== "todo" && issue.status !== "backlog") return false;
  if (issue.assigneeAgentId || issue.assigneeUserId) return false;
  return blockedBy.every((blocker) => blocker.status === "done");
}
