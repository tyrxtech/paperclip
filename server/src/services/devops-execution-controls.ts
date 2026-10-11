/**
 * DevOps execution authority. JEV never reads or writes this module.
 * A recommendation cannot add a host, grant an operation, or waive approval.
 */

export const RESPONSIBLE_AGENTS = ["devops", "engineering", "security"] as const;
export type ResponsibleAgent = (typeof RESPONSIBLE_AGENTS)[number];

export const DEVOPS_OPERATIONS = ["read", "mutate", "destroy"] as const;
export type DevopsOperation = (typeof DEVOPS_OPERATIONS)[number];

export type DevopsExecutionPolicy = {
  allowedHosts: readonly string[];
  allowedServices: readonly string[];
  /** Destroy is never granted, even if this list is non-empty. */
  operationGrants: Record<DevopsOperation, readonly ResponsibleAgent[]>;
  /** Mutating operations require this flag on the request. JEV cannot set it. */
  mutateRequiresApproval: boolean;
};

export const DEFAULT_DEVOPS_EXECUTION_POLICY: DevopsExecutionPolicy = {
  allowedHosts: [],
  allowedServices: [],
  operationGrants: {
    read: ["devops"],
    mutate: ["devops"],
    destroy: [],
  },
  mutateRequiresApproval: true,
};

export type ExecutionControlInput = {
  operation: DevopsOperation;
  targetHost: string;
  targetService: string;
  approvalSatisfied: boolean;
  actingAgent: ResponsibleAgent | null;
};

export type ExecutionControlDecision = {
  hostAllowed: boolean;
  serviceAllowed: boolean;
  operationPermitted: boolean;
  approvalRequired: boolean;
  approvalSatisfied: boolean;
  allowed: boolean;
  reason: string;
};

function listed(values: readonly string[], candidate: string): boolean {
  const normalized = candidate.trim().toLowerCase();
  if (!normalized) return false;
  return values.some((value) => value.trim().toLowerCase() === normalized);
}

export function evaluateExecutionControls(
  policy: DevopsExecutionPolicy,
  input: ExecutionControlInput,
): ExecutionControlDecision {
  const hostAllowed = listed(policy.allowedHosts, input.targetHost);
  const serviceAllowed = listed(policy.allowedServices, input.targetService);
  const destroyBlocked = input.operation === "destroy";
  const granted = policy.operationGrants[input.operation] ?? [];
  const operationPermitted =
    !destroyBlocked &&
    input.actingAgent !== null &&
    granted.includes(input.actingAgent);
  const approvalRequired = input.operation === "mutate" && policy.mutateRequiresApproval;
  const approvalSatisfied = !approvalRequired || input.approvalSatisfied;

  let reason = "allowed";
  if (destroyBlocked) reason = "destructive_operation_blocked";
  else if (!hostAllowed) reason = "host_not_allowlisted";
  else if (!serviceAllowed) reason = "service_not_allowlisted";
  else if (!operationPermitted) reason = "operation_not_permitted";
  else if (!approvalSatisfied) reason = "approval_required";

  return {
    hostAllowed,
    serviceAllowed,
    operationPermitted,
    approvalRequired,
    approvalSatisfied,
    allowed: reason === "allowed",
    reason,
  };
}
