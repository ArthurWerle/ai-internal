---
description: Turn an approved intent.md into docs/sdlc/<slug>/spec.md
argument-hint: <slug>
allowed-tools: Read, Grep, Glob, Bash(git log:*), Bash(git show:*), Edit(docs/sdlc/**), Write(docs/sdlc/**)
---

Write the spec for `docs/sdlc/$ARGUMENTS/`.

1. Read `docs/sdlc/$ARGUMENTS/intent.md`. If it is missing or its status is not `approved`, stop and tell me.
2. Read `CLAUDE.md` and the code the change touches. Find existing functions, types, endpoints and tests to reuse, with file paths.
3. Write `docs/sdlc/$ARGUMENTS/spec.md` following `docs/sdlc/_templates/spec.md`, `Status: draft`:
   - Requirements numbered R1..Rn, each testable, each traceable to the intent. Nothing the intent puts out of scope.
   - Design grounded in the actual code, naming the files and functions involved.
   - Points of attention: be specific to this codebase (edge cases, migrations, API contract with other services, money and date handling, privacy of financial data). This section is mandatory and must not be generic.
4. If the intent has open questions that block the design, ask me before writing; otherwise record your assumption next to the requirement it affects.
5. End with the file path, a 3-line summary, and a request to review and set `Status: approved`.

Do not edit any file outside `docs/sdlc/$ARGUMENTS/`.
