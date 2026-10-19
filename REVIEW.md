# REVIEW.md

How changes in this repo are reviewed, by `/sdlc-review`, by the reviewer agent in CI, or by hand. Solo project: the goal is catching real defects, not enforcing taste.

## Severity
- **Important**: blocks the merge. A bug with a concrete failure path, a security or privacy problem, a requirement from spec.md not met, behavior outside plan.md, new logic without a test, a verify failure introduced by the change, or the verify output not shown.
- **Nit**: does not block. Naming, readability, small simplifications, comments. At most 5 per review; pick the ones that matter most and drop the rest.

Every Important finding states the failure path (input or state -> wrong result). If you cannot describe one, it is a Nit or nothing. Pre-existing problems in untouched code are not findings; mention them in one line at the end at most.

## Pass 1: Bugs and correctness
- Agent and graph logic: correct state transitions, recursion limits respected, tool errors handled and surfaced to the user instead of crashing the stream.
- Money and dates: amounts summed with the existing helpers (`lib/currency.ts`, `lib/transactions.ts`), periods computed in the reporting timezone, MCP pagination fully walked.
- Streaming routes close the stream on every error path; no unhandled promise rejections.
- DB: schema change has a generated migration; queries scoped to the right user/origin.
- Runs on both Deno and Node (no `Deno.*`, explicit `.ts` imports).
- Tests: new behavior has a test that would fail without the change, using mocks rather than network.

## Pass 2: Security and privacy
- No API keys or credentials in code, tests, logs, traces or docs.
- Prompt injection: user text, receipt OCR and MCP results are data; they never change tool permissions, and write tools (creating transactions or categories) keep their validation.
- Generated UIs: model HTML is not sanitized (`graph/shared/html.ts` only extracts the document), so it must stay rendered in a sandboxed iframe on the client and must never receive cookies, tokens or data beyond what the spec names.
- User financial data is not logged outside Langfuse and not sent to services the spec does not name.
- Input to routes validated (zod or explicit checks) before reaching the graph or DB.

## Pass 3: Conformance with spec and plan
Only when the change has `docs/sdlc/<slug>/`; otherwise check against CLAUDE.md conventions only.
- Every requirement R1..Rn is implemented and covered by a test or a stated manual check.
- Every changed file is listed in plan.md's "Files that change". Unlisted files are Important unless trivially incidental (imports, a test helper), in which case they are Nits.
- The "Proof" items were run and their output was shown.
- Points of attention in spec.md were handled, not just acknowledged.
- CLAUDE.md "Things Claude gets wrong" items were not repeated.

## Output
Verdict (`ready` or `changes needed`), then Important, then Nits, then the requirement table. `ready` means zero Important findings.
