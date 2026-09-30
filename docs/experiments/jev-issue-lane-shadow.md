# Jev issue-lane shadow experiment

Status: implementation experiment; disabled by default; automatic assignment is not supported.

## Pre-change routing baseline

Observed on 2026-09-30 before implementation, at `server/src/routes/issues.ts` in
`POST /api/companies/:companyId/issues`:

1. Paperclip validates authority, dependencies, assignment and execution policy.
2. Paperclip creates the issue, synchronizes references/external objects, and
   records `issue.created`.
3. For non-onboarding issues, Paperclip invokes
   `void queueIssueAssignmentWakeup(...)` with reason `issue_assigned`.
4. The response is returned without awaiting the wake. Ambiguous and strategic
   routing remains an XO/local decision outside this route.

The baseline path contains zero external classification/model calls, so model
latency added to the dispatch-critical path is **0 ms**. The proposed observer
must preserve that property: it is scheduled independently, cannot update an
issue, assignment, status, priority, dependency, approval, or wake, and every
failure must resolve locally.

The adapter uses the official `@typesafe-ai/sdk` package at version `0.6.0`.
The server requires Node 24.11 or newer, while this SDK requires Node 20 or
newer. The pinned `jev-1.13.0` model is the current versioned model ID in the
TypeSafe model reference. The moving `jev-latest` alias is not used.

## Current and proposed routing map

| State | Current authority/route | Jev shadow observation | Dispatch effect |
| --- | --- | --- | --- |
| Assigned, runnable issue | Paperclip validates and queues one assignment wake | Optional lane suggestion | None |
| Blocked/dependency-bound issue | Paperclip retains status and dependency authority | Observation may be recorded | None |
| Duplicate create | Paperclip returns the existing issue before the observation seam | No observation | None |
| Already-running assignee | Paperclip wake queue/coalescing owns the outcome | Optional lane suggestion | None |
| Ambiguous/strategic issue | XO/local route | `needs_review` may be suggested | None |
| No matching lane | XO/local route | `no_match` may be suggested | None |

## Data boundary

Only a title-sized, explicitly approved sanitized summary may leave the server.
The feature requires all of the following before constructing an SDK client:

- the shadow feature flag is enabled;
- the company is on the explicit approved-company allowlist;
- the project is on the explicit approved-project allowlist;
- the summary passes the deny-by-default sanitizer.

The sanitizer rejects credentials, personal contact details, URLs, customer or
vendor identifiers, shipment data, contract text, exposure data, raw logs,
structured dumps, and restricted TYR-X markers. It never sends descriptions,
comments, attachments, logs, identifiers, assignment data, or dependency data.

## Configuration and secret installation (not a rollout authorization)

The approved target for the current deployment is the **Paperclip server
container** process environment loaded from the persistent instance file
`/paperclip/instances/default/.env` (`PAPERCLIP_HOME=/paperclip`, instance
`default`). This is server configuration, not an
agent/project company-secret binding: agent/project bindings inject into worker
runs and would expose the value to workers rather than the server-side adapter.

Marc installation steps after approving a separate rollout gate:

1. On the Paperclip host, open Proton Pass locally and reveal **TYR-X JEV Development**.
2. Open an interactive shell/editor in the Paperclip server container and edit
   `/paperclip/instances/default/.env` in place. Do not pass the value on the
   `docker exec` command line. Preserve owner-only permissions (`0600`).
3. Add `TYPESAFE_API_KEY` directly in that file without copying it into chat,
   Paperclip, GitHub, a shell transcript, or a command argument.
4. Add `PAPERCLIP_JEV_SHADOW_ENABLED=false`,
   `PAPERCLIP_JEV_SHADOW_APPROVED_COMPANY_IDS=<TYR-X company UUID>`, and
   `PAPERCLIP_JEV_SHADOW_APPROVED_PROJECT_IDS=<approved trial project UUIDs>`.
   Do not use `*` or include unrelated projects.
5. Restart only under a separate authorized deployment gate, verify the server
   sees the variable name (never its value), then enable the shadow flag.

No live TypeSafe call is authorized by this change. Offline tests use an injected
mock client, and automatic assignment remains off because no such code path or
flag exists in the adapter.
