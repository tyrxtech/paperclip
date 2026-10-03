# JEV issue-lane shadow decision service

JEV is an optional observer for TYR-X issue-lane suggestions. It has no
authority over Paperclip. Paperclip continues to own status, dependencies,
capacity, assignment, and wakes; XO continues to own ambiguous or strategic
decisions.

## Current and proposed route

The pre-change route is:

```text
issue/wake input
  -> Paperclip wake admission and dependency/pause/budget gates
  -> queued-run staleness and ownership checks
  -> Paperclip selects and claims the assigned agent run
  -> adapter execution
```

The shadow route adds one fire-and-forget observation after Paperclip has
selected and claimed the run:

```text
Paperclip-selected run -> adapter execution (unchanged)
                       -> JEV shadow suggestion -> run-log receipt
```

The JEV promise is deliberately not awaited by dispatch. A timeout, retry,
invalid response, missing credential, or receipt-write failure leaves the
existing route intact. No auto-assignment flag or mutation path is present.

The observation point is in `server/src/services/heartbeat.ts`, after current
issue and dependency facts are loaded and before provider adapter execution.
The existing gates remain the only dispatch authority.

## Data boundary

Raw titles, descriptions, comments, attachments, logs, credentials, customer or
vendor identifiers, shipment data, contract text, exposure data, and restricted
TYR-X data are never sent as raw fields. Descriptions, comments, attachments,
and logs are not inputs to the observer.

The adapter accepts one summary from `server/src/services/jev-issue-lane-policy.ts`.
Policy version `tyr-issue-lanes-v2` has two sources:

1. **Synthetic trial registry.** An exact identifier match uses the reviewed
   sentence in `JEV_APPROVED_ISSUE_SUMMARIES` and ignores any issue title.
   Adding a registry entry is a code-reviewed change. The registry still holds
   only the five synthetic `JEV-TRIAL-*` cases.
2. **Real queue issue.** The identifier must match a Paperclip issue identifier
   (`PREFIX-NUMBER`, the same shape as `normalizeIssueIdentifier`). The policy
   derives the summary from the issue title only. Derivation removes issue
   identifiers, UUIDs, URLs, email addresses, and long tokens, then applies the
   existing character limit. The outbound value is that derived summary. When
   the title already satisfies the checks, the summary can keep the title's
   ordinary words. It still cannot include an identifier, a URL, an email
   address, a long token, or a restricted-data term. If derivation produces no
   text, Paperclip does not call TypeSafe.

The adapter applies a second validation layer: summaries are length-bounded and
rejected if they contain credential markers, identifier-like strings (including
issue identifiers), URLs, email addresses, or restricted-data terms. A derived
summary that fails these checks does not leave Paperclip. The issue identifier
itself is not part of the request.

The run log records only:

- suggested lane and lane probabilities;
- actual model version;
- elapsed milliseconds;
- input, output, and total token counts;
- a bounded error category.

Request/response bodies, error bodies, issue identifiers, and key values are not
logged. This is the local run-log path (`heartbeat_run_events`), not Paperclip
telemetry and not OpenTelemetry.

## Runtime policy

- Feature flag: `PAPERCLIP_JEV_SHADOW_ENABLED` must be exactly `true` (default `false`). Any other value leaves the observer off.
- Credential: `TYPESAFE_API_KEY`.
- Official SDK: `@typesafe-ai/sdk@0.6.0`.
- Pinned model: `jev-1.13.0`.
- Per-attempt timeout: 1.5 seconds.
- Retries: at most one retry, using the SDK's bounded retry policy.
- Low confidence: suggestions below 0.60 become `needs_review`.
- Eligible input: an exact synthetic registry summary, or a summary derived from
  a real `PREFIX-NUMBER` issue title under the data-boundary rules above. A
  summary that fails the existing checks makes no call.
- Blocked/dependency-blocked/duplicate run: no call.
- Repeated observation of the same running run: no second call.

Compatibility was checked against the official
[`typesafe-ai/typesafe-sdk-js`](https://github.com/typesafe-ai/typesafe-sdk-js)
package and its `v0.6.0` release. The integration uses its public
`TypeSafeClient`, `choice`, typed `systemOne` result, timeout, and retry APIs.
TypeSafe's [model documentation](https://docs.typesafe.ai/models.md) lists the
pinned `jev-1.13.0` model. The adapter rejects a response that claims a
different model or has malformed probabilities, confidence, or usage; it never
copies an invalid provider model field into the run log.

## Secret installation for Marc

The approved target is the **Paperclip server process environment**, specifically
`process.env.TYPESAFE_API_KEY`. It is not an agent, project, or company-secret
binding: those bindings inject into agent workloads, while this integration runs
inside the control-plane server. The repository's concrete container paths are:

- `docker/docker-compose.yml` -> `services.server.environment.TYPESAFE_API_KEY`
- `docker/docker-compose.quickstart.yml` ->
  `services.paperclip.environment.TYPESAFE_API_KEY`

The live TYR-X deployment's host-side secret store is not defined in this
checkout, so this document does not invent one. Use the deployment's existing
operator-only secret mechanism to populate that exact container environment
key.

1. On the deployment host, open Proton Pass interactively and locate **TYR-X JEV
   Development**. Do not copy the value into chat, an issue, a shell command,
   shell history, source control, or Paperclip's agent environment UI.
2. Add the value to the existing operator-only container secret mechanism under
   the exact key `TYPESAFE_API_KEY`, targeting the Paperclip server container.
3. Keep `PAPERCLIP_JEV_SHADOW_ENABLED=false`; restart/recreate only the server
   container through the normal deployment procedure, then verify from inside
   the container that the variable is present without printing its value (for
   example, test only whether its length is nonzero).
4. Do not add raw issue content to `jev-issue-lane-policy.ts`. The five
   synthetic trial summaries stay in the registry. A real queue issue does not
   need a registry entry: its summary is derived from the title under the
   data-boundary rules above.
5. After Marc explicitly confirms the secret and corpus, set
   `PAPERCLIP_JEV_SHADOW_ENABLED=true` and recreate only the Paperclip server
   container. This flag change is the explicit live-call gate.
6. Verify new `jev.shadow.issue_lane` run-log events contain only the allowlisted
   receipt fields above. Leave automatic assignment off.

No live TypeSafe request is part of repository tests or this implementation
task. Tests use an injected SDK-compatible mock.
