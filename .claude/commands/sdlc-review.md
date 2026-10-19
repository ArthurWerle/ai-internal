---
description: Review the current diff against REVIEW.md, spec.md and plan.md
argument-hint: [slug] [base-branch]
allowed-tools: Read, Grep, Glob, Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(git show:*), Bash(git merge-base:*), Bash(git branch:*)
---

Review the current change. Arguments: `$ARGUMENTS` (optional slug, optional base branch; default base is `main`).

1. Collect the diff: `git diff <base>...HEAD`, plus `git diff --staged` and `git diff` for uncommitted work. Read the full changed files where the diff alone is not enough context.
2. Read `REVIEW.md` and follow it exactly: the three passes, the severity definitions and the nit limit.
3. If a slug is given (or exactly one `docs/sdlc/<slug>/` folder is touched by the diff), read its `spec.md` and `plan.md` for the conformance pass. Otherwise say the conformance pass was limited to CLAUDE.md conventions.
4. Do not modify files. Do not run the verify command; say whether its output was shown in this session, and if not, list it as Important.

Output format:

```
## Verdict: ready | changes needed

## Important
1. [pass] file:line - what is wrong. Failure path: concrete input or state -> wrong result. Fix: one line.

## Nits (max 5)
1. file:line - suggestion.

## Conformance
| Requirement | Covered by | Status |
```

If there are no findings in a section, write "None". Do not pad.
