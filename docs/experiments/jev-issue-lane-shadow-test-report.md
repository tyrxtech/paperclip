# Jev issue-lane shadow isolated test report

Date: 2026-09-30

Scope: offline unit/contract tests only. No TypeSafe key was read and no live API
request was made. The routing baseline and current-vs-proposed map are in
[`jev-issue-lane-shadow.md`](./jev-issue-lane-shadow.md).

## Results

| Measure | Result | Qualification |
| --- | ---: | --- |
| Focused tests | 7/7 passed | Node 22.22.3; repository policy requests Node >=24.11.0 |
| Known-correct corpus accuracy | 7/7 (100%) | Injected deterministic SDK mock; not a live model-quality claim |
| False routes | 0 | Injected deterministic SDK mock |
| Explicit outcomes | `needs_review`, `no_match` | Both exercised |
| Workflow cases | engineering, provider, Studio, ambiguous, blocked, duplicate, already-running | All exercised |
| Adapter p50 | 0.000917 ms | 1,000 in-process mocked SDK calls |
| Adapter p95 | 0.001209 ms | 1,000 in-process mocked SDK calls |
| Adapter max | 0.0665 ms | 1,000 in-process mocked SDK calls |
| End-to-end Jev latency | Not measured | Live API prohibited until Marc installs and confirms the secret |
| Simulated API failures | 1 timeout; 1/1 failed open | No request/response body or key logged; no dispatch mutation |
| Cost incurred | $0.00 | No live API calls |
| Live cost estimate | Not reported | Requires an approved live trial and then-current vendor pricing |

The duplicate path returns before the observer. For new issues, the source-order
contract test proves the existing assignment wake appears exactly once and the
shadow observer is scheduled afterward. Separate blocked and already-running
cases prove that invoking the existing wake helper still produces exactly one
wake call; the observer has no heartbeat, issue-service, database, assignment,
status, priority, dependency, approval, or wake dependency.

## Commands

```text
pnpm --filter @paperclipai/server exec vitest run \
  src/services/jev-decision-adapter.test.ts --reporter=verbose
```

Focused result: one file passed, seven tests passed, six milliseconds of test
execution (177 milliseconds total runner duration).

The standard server typecheck wrapper reached the Rust runner build and then
stopped because this checkout does not have `cargo`. A direct `tsc --noEmit`
check reports one pre-existing unrelated implicit-`any` error in
`chat-publication-text-parts.test.ts`; it reports no error in the Jev service,
tests, or route integration. This environment uses Node 22.22.3, while the
repository policy requires Node 24.11 or newer.
