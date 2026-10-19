# SDLC artifacts

Each non-trivial change gets a folder `docs/sdlc/<slug>/` (slug: short kebab-case, e.g. `recurring-amount-history`).

```
/sdlc-intent <slug>  ->  intent.md   what and why (you approve it)
/sdlc-spec <slug>    ->  spec.md     requirements + design + points of attention (you approve it)
/sdlc-plan <slug>    ->  plan.md     files, order, risks, proof (you approve it)
implementation       ->  code + tests, following plan.md
/sdlc-review <slug>  ->  findings against REVIEW.md, spec.md and plan.md
verifier agent       ->  optional independent pass/fail report
commit               ->  code and docs/sdlc/<slug>/ in the same commit or PR
```

Approval is a one-line edit: set `Status: approved` at the top of the file. The next command refuses to run on a draft.

## How much process a change needs

| Change | Artifacts |
|---|---|
| Trivial (typo, copy, config value, dependency-free one-liner) | none |
| Small (local bugfix, no new contract, under a day) | `plan.md` only, with the problem in 3 lines at the top |
| Anything else (new feature, API or schema change, cross-repo work) | intent, spec, plan |

Templates live in `_templates/`. Do not copy sections that do not apply; delete them.
