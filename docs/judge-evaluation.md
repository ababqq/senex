# Evaluating project judges

Protocol tests prove the mechanics of judging. They do not establish that a model agrees with
people about project quality. Use this procedure before claiming a judge, prompt or learned
instruction improves projects. Keep captures, labels and reports in ignored evidence directories;
publish only an independently reviewed dataset with established redistribution rights.

## Fixed comparisons

Use owned disposable projects. Freeze each project's starting commit, seed, camera, viewport, device
pixel ratio, action sequence and evidence budget. Record the provider, model, prompt version,
runtime context, permission mode, source revision and build identity. Change one variable per
comparison. Start with these authored tasks; use the same inputs for every candidate:

| Task | Candidate difference | Required observations |
| --- | --- | --- |
| Starts | A valid page versus an intentional startup error | Startup result and console evidence; a broken build cannot win for appearance |
| Input | Working controls versus a disconnected input handler | Identical input replay, the visible state change and a usable preview |
| Layout | A contained layout versus text overflowing its container | Identical narrow and wide views, with overflow evidence kept separate |
| Readability | Legible text versus clipped/low-contrast text | Fixed viewport, keyboard traversal and screenshot; appearance alone is insufficient |
| Regressions | A prettier screen that breaks a previously passing control | Before/after behavioral checks plus the matched visual pair |
| No change | Identical builds with shuffled A/B placement | Equal bytes/settings; a genuine tie is a valid outcome |
| Missing evidence | An absent camera, malformed judge response or unavailable WebGPU measurement | Missing/invalid evidence remains distinguishable from a measured pass |
| Scope | The requested change versus an unrelated attractive addition | Frozen task brief and evidence of the requested behavior |

These are test cases, not human-labelled quality results. Begin without model calls by checking
capture reproducibility, malformed responses, budget limits and blind-label handling through the
existing conformance and harness suites. A real-model campaign requires its own authorized
provider and spend limit.

Captures, judge verdicts and human labels stay in ignored evidence directories; only metrics-only
baselines and per-release ledger exports under `evals/` are committed ([evals](evals.md)).

## Human review and metrics

Have at least two reviewers label each pair independently before seeing the model's answer.
Shuffle left/right placement independently for humans and judges. Hide engine, author and
incumbent identity; retain an internal mapping to the exact commits. Reviewers record A, B,
tie or insufficient evidence, plus the decisive defect and whether the request was satisfied.
Preserve disagreements and adjudicate them separately; do not manufacture a consensus label.
For eval campaigns, `npm run eval -- review` serves this blind pair review and a grader-validation
sample locally, and its labels stay in the local eval ledger ([evals](evals.md#human-review)).

Report sample size and counts, human agreement, judge agreement with adjudicated labels,
the full A/B/tie/insufficient confusion table, invalid/abstained responses, false acceptance of
broken or regressed builds, and requested-change satisfaction. Reversing A/B must not alter
the semantic choice. Show each task's result alongside the aggregate; report unlabelled pairs
as unlabelled. Include calls, tokens, recorded spend, latency, cancellations and failures.

Run a candidate in shadow mode on the frozen set before letting its decisions change projects or
automatically apply learning. Set acceptance thresholds and the campaign's budget before
running it; retain the baseline and every failure. Wider acceptance needs fresh tasks and
independent reviewers, not repeated tuning on the same examples. Keep automatic learning off
until its own measured acceptance is established.
