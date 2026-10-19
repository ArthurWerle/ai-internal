---
description: Read intent + spec and write docs/sdlc/<slug>/plan.md (no code changes)
argument-hint: <slug>
allowed-tools: Read, Grep, Glob, Bash(git log:*), Bash(git show:*), Bash(git diff:*), Edit(docs/sdlc/**), Write(docs/sdlc/**)
---

Write the implementation plan for `docs/sdlc/$ARGUMENTS/`. This command only writes `plan.md`: do not edit, create or delete any other file, and do not run builds or tests.

1. Read `docs/sdlc/$ARGUMENTS/spec.md` and `intent.md`. If the spec exists and is not `approved`, stop and tell me. If neither exists, this is a small change: ask me for the problem in 3 lines and put it at the top of the plan.
2. Read `CLAUDE.md` and every file you expect to change. Do not plan changes to files you have not read.
3. Write `docs/sdlc/$ARGUMENTS/plan.md` following `docs/sdlc/_templates/plan.md`, `Status: draft`:
   - Files that change: every file, with the requirement it serves. A file with no requirement is out of scope.
   - Work order: small steps, each verifiable; tests written alongside the code they cover.
   - Risks: concrete, with mitigation or detection.
   - Proof: the exact verify command from CLAUDE.md, the test files that cover each requirement, and any manual check with expected results. Every requirement appears here.
4. End with the file path and a request to review and set `Status: approved`. Implementation starts only after that.
