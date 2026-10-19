---
description: Interview me and write docs/sdlc/<slug>/intent.md
argument-hint: <slug> [one-line idea]
allowed-tools: Read, Grep, Glob, Edit(docs/sdlc/**), Write(docs/sdlc/**)
---

Write the intent for the change `$ARGUMENTS`. The first word is the slug; the rest, if any, is my initial idea.

1. If the slug is missing, propose one from the idea and ask me to confirm. If `docs/sdlc/<slug>/intent.md` already exists, read it and continue from it instead of starting over.
2. Skim the code areas the idea touches (Grep/Glob, a few files at most) so your questions are informed. Do not read secrets or `.env` files.
3. Interview me one question at a time, at most 6 questions. Ask only what you cannot infer from the code or from what I already said. Cover: the concrete problem, the desired outcome, constraints, what is explicitly out of scope. Challenge vague answers.
4. Write `docs/sdlc/<slug>/intent.md` following `docs/sdlc/_templates/intent.md`, with `Status: draft` and today's date. Unknowns go under "Open questions", never invented.
5. If the change looks small (see the table in `docs/sdlc/README.md`), say so and suggest skipping straight to `/sdlc-plan`.
6. End by showing the file path and asking me to review it and set `Status: approved`.

Do not edit any file outside `docs/sdlc/<slug>/`.
