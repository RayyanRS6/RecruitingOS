# @ros/evals

The AI evaluation runner (`docs/11-evaluation-framework.md`). Suites are synthetic fixtures plus assertions in `src/suites.ts`; the runner in `src/runner.ts` drives them through the same prompts the product uses and scores them against `thresholds.json`.

- `pnpm eval` from the repository root runs every suite on the fake provider: it proves the harness, the schemas and the code-side rules (quote grounding, the follow-up cap, the hand-off), not the prompts.
- `AI_PROVIDER=anthropic ANTHROPIC_API_KEY=<key> pnpm eval` runs the real models. The key is entered for the shell session on a trusted machine and never stored in the repository.
- `pnpm eval --suite screen.conversation` runs one suite.

Every run writes `results/<date>-<time>-<provider>.json`. Only a file named `-anthropic.json` is evidence; it is committed with the pull request that changes a prompt or a model, and a person's signature on the pull request promotes the prompt version. The full procedure, and what the screen personas assert, is in `docs/11-evaluation-framework.md` under "The real-model run".
