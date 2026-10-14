# @ros/evals

The AI evaluation runner (`docs/11-evaluation-framework.md`). Suites are synthetic fixtures plus assertions in `src/suites.ts`; the runner in `src/runner.ts` drives them through the same prompts the product uses and scores them against `thresholds.json`.

- `pnpm eval` from the repository root runs every suite on the fake provider: it proves the harness, the schemas and the code-side rules (quote grounding, the follow-up cap, the hand-off), not the prompts.
- `AI_PROVIDER=anthropic ANTHROPIC_API_KEY=<key> pnpm eval` runs the real models. The key is entered for the shell session on a trusted machine and never stored in the repository.
- `pnpm eval --suite screen.conversation` runs one suite.
- The scoring readings (`triage.assess`, `screen.assess`) are given their input exactly as the app builds it (`scoringInput` and `scorecardInput` in `@ros/agents`, founder decision D-04 = C), through `src/scoring-inputs.ts`: name, email, phone, street address and links hidden, earlier applications never sent. `triage.redaction` and `screen.redaction` check that a CV or a conversation full of personal details sends the model none of them, and the `earlier_rejection` twin pair checks that an earlier rejection at the same company leaves the model's input identical. `src/scoring-inputs.test.ts` runs these input checks with the unit tests, with no model.

Every run writes `results/<date>-<time>-<provider>.json`. Only a file named `-anthropic.json` is evidence; it is committed with the pull request that changes a prompt or a model, and a person's signature on the pull request promotes the prompt version. The full procedure, and what the screen personas assert, is in `docs/11-evaluation-framework.md` under "The real-model run".
