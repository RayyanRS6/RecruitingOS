# 11. AI evaluation suites

Every AI task that reads a candidate, talks to one or writes a job has an evaluation suite. The runner is `packages/evals/src/runner.ts`. It drives the same prompts the app uses and scores each suite against `packages/evals/thresholds.json`. Every resume, chat and job in the suites is made up.

The AI writes findings and quotes only. Every number a suite compares (the resume score, the interview score, their bands) is worked out by the app's own code from those findings. The two readings that score are given their input exactly as the app builds it, and each is read three times with the middle answer kept, as in the app.

## The suites

| Family | Suite | What it checks |
|---|---|---|
| Job builder | `intake.golden` | From what an owner types, the builder reads the facts, asks whether the job is on site, hybrid or remote instead of assuming it, asks for the state when the owner names a city alone, asks nothing twice, brings back a card the owner left alone until it is answered, and writes a whole job with the owner's pay and must-haves |
| | `intake.illegal_criteria` | An unlawful wish (people under 30, no gaps, a native speaker, no children, one zip code) is declined and is in no job written afterwards |
| | `intake.job_ad` | A pasted ad is read for its job and its pay, the pay card comes back until the owner confirms the pay, and an instruction hidden in the ad is ignored |
| | `intake.proxy_refusal` | Wording that stands in for age or another protected trait is refused wherever it comes from |
| The two posts | `job.posts` | The LinkedIn post and the Indeed post each carry their own Apply link once and no other link, show the pay when the job page shows it and no other pay figure, have no wording the fairness guard would take out, and stay inside their length |
| Reading a resume | `resume.extraction` | Jobs, licences and skills are picked up correctly |
| | `resume.hallucination` | Every quote taken from a resume is really in it |
| Scoring a resume | `triage.bias_pairs` | Two resumes that differ only in the name, the graduation year, the zip code or an earlier rejection at the same company get the same findings and the same resume score |
| | `triage.consistency` | The same resume read three times gets the same findings and the same score |
| | `triage.credentials` | A licence is "not met" only when the resume says plainly the person does not hold it; lapsed, expired or pending is not known |
| | `triage.edge_cases` | A career gap, a career change or no degree is never read as a must-have not met |
| | `triage.hallucination` | Every quote in the reading is in the resume or in the candidate's answers on the form |
| | `triage.redaction` | The scoring is never sent the name, email, phone, street address, links or earlier applications |
| | `triage.fairness_rules` | No model: showing more never lowers the score, and the score moves only with the findings |
| The score | `score.rules` | No model: a must-have weighs 4 and a skill 3, 2 or 1; shown earns all and partly shown half; a must-have shown not met holds the number at 54; 100 never stands beside a must-have that is not shown |
| The AI interview | `screen.conversation` | A whole interview, turn by turn: one question at a time, one push for an example, every answer kept in the candidate's words, a person offered when asked for, pay answered from the posted range, a fair close |
| | `screen.assess` | The scorecard: a finding for every question asked, a skipped question never held against the candidate, the licence rule, only the candidate's own words quoted |
| | `screen.consistency` | The same interview scored twice gets the same findings and the same interview score |
| | `screen.question_fairness` | Questions about crime, health, children, age, origin, religion or past pay never reach a candidate |
| | `screen.redaction` | The scorecard is never sent the name, email, phone, street address or links |
| One turn of the chat | `chat.shape`, `chat.ladder`, `chat.no_inference`, `chat.no_reask`, `chat.private_note`, `chat.fairness`, `chat.close` | One restatement and one question; one push, then move on; no guesses; nothing asked twice; the company's private note never said; a protected detail left alone; a close with no promise |
| The company's intro | `company.about` | The few sentences a person approves in Settings before a candidate reads them |

`score.rules` and `triage.fairness_rules` also run with the unit tests (`packages/evals/src/score-suite.test.ts`), and so do the checks of what is sent to the model (`scoring-inputs.test.ts`).

## Running

- `pnpm eval` runs every suite on the stand-in AI. It proves the harness, the schemas and the rules the code holds (quote checks, the licence rule, the scores), not the prompts. CI runs it on every pull request.
- `pnpm eval --suite screen.conversation` runs one suite; `--suite resume,triage` runs every suite of each family.
- A run fails when a suite is under its threshold, or when a name given to `--suite` chooses no suite. A whole run also fails when a suite has no entry in `thresholds.json`, or an entry there names no suite. So a suite added or renamed goes into `thresholds.json`, and into the fairness button's choices, in the same change (`tests/policy/fairness-choices.test.ts`).
- Every run writes `packages/evals/results/<date>-<time>-<provider>.json`, in a folder git ignores, with each case's failures, the models, the calls and the cost.

### The real-model run

Only the real models prove the prompts. The usual way is the "Run fairness tests" button in GitHub: [runbooks/fairness-tests.md](runbooks/fairness-tests.md). Its choices are families of the suites above:

| Choice | Suites |
|---|---|
| `resume,triage` | Reading and scoring a resume |
| `screen,chat` | The AI interview, its scorecard and one turn of the chat |
| `resume,triage,screen,chat` | Both |
| `intake,job` | The job builder and the two posts |

From a trusted machine: `AI_PROVIDER=anthropic ANTHROPIC_API_KEY=<key> pnpm eval`, with the key entered for that shell session and stored nowhere. The models are the ones `packages/ai/src/routing.ts` names for each task.

Run it after any change of prompt, model or scoring rule that the real models have not seen, and before real candidates are ranked on it. Which prompts still wait for a run is in [DECISIONS.md](DECISIONS.md), "Fairness".
