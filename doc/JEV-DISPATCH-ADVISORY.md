# JEV intake advisory

JEV can suggest a lane before Dispatch assigns an issue. It has no authority to
change status, dependencies, priority, assignee, approvals, or wakes.

For an unassigned `todo` or `backlog` issue with no unresolved blockers, a board
user or the company agent named `Dispatch` may call:

```text
POST /api/companies/:companyId/issues/:issueId/jev-advisory
```

The response contains `available`, a bounded `receipt` when available, and
`reused` when the previously recorded suggestion is returned. The only durable
write is an `issue.jev_lane_advisory` activity record. It contains the lane,
probabilities, model version, timing, token counts, and error category; it does
not contain the issue title or the external request body. The existing JEV
policy derives a sanitized summary from the issue title. Descriptions and
comments are never sent. A missing key, disabled shadow flag, or provider error
does not change the issue or prevent Dispatch from using the existing route.

Dispatch should inspect the receipt and current issue context, then make its
own assignment decision. `needs_review` and `no_match` go to a human or the
accountable lead. A JEV suggestion never overrides a blocker or reviewer gate.

The run-start `jev.shadow.issue_lane` receipt remains a separate observation
for comparison after Paperclip admits a worker. The intake endpoint is for
decisions before that point. Automatic assignment remains off.
