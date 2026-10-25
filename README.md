# learning-harness

A pi extension that turns any pi session into a personalized tutor. You say
"learn about X" (or `/learn X`), the AI **diagnoses** what you already know,
builds a **lesson plan** around your gaps, teaches you with **check-ins**, and
**evaluates** you with scored quizzes, immediate feedback, remediation, and
reviews — with all progress persisted on disk so you can stop and resume any
time, even across pi sessions.

## Quick start

```
/learn Closures in JavaScript     # start a new topic
/learn                            # resume your (single) in-progress topic
/learning                         # dashboard of all topics
```

Or just tell it naturally: *"I want to learn how composting works"* — the
tools are described in the system prompt, so the agent knows when to use them.
To forget a topic: ask to delete it (the `learning_forget` tool refuses
without an explicit user confirmation).

## The flow

```
diagnostic (6 adaptive questions)
   └─► concept map: each core concept → none / basic / solid / mastery
        └─► lesson plan: 1-6 units × 2-4 lessons, targeted at your gaps
             └─► per lesson: teaching + formative check-ins (unscored)
                  └─► lesson quiz (3-5 items, graded, per-question feedback)
                       ├─ ≥70% → next lesson
                       └─ <70% → re-teach the gaps + remediation (one shot)
                            └─ still weak → flagged, returns in reviews
             └─► per unit: checkpoint quiz (5-8 items, 80% gate, same retry rule)
                  └─► unit review of concepts still at "basic"
             └─► topic complete → optional review of your 5 weakest concepts
```

**Tools own the structure, the LLM owns the content.** The extension is a
deterministic state machine on disk (phases, question counts, pass thresholds,
concept-map math); the tutor LLM writes the questions, teaches, and grades
against rubrics. Every `learning_status` call returns exactly what to do next,
so the loop can't drift.

## Tools

| Tool | Purpose |
|---|---|
| `learning_status` | Read any topic's state + the exact **NEXT** step (call this first) |
| `learning_start` | Start a new topic (`title`, `kind: code\|general\|mixed`, `language?`) |
| `learning_record` | Write state: `record_diagnostic`, `record_answer`, `record_plan`, `generate_quiz`, `grade_quiz`, `advance`, `skip_lesson` |
| `learning_forget` | Delete a topic (requires `confirm:true`) |

## State

Everything lives in `~/.pi/learning/<topic-slug>/` (override the root with
`LEARNING_HARNESS_HOME`):

```
state.json       # source of truth: phase, concept map, plan, quiz history
plan.md          # rendered plan (progress, checkpoints, reviews)
diagnostics.md   # rendered diagnostic Q&A + evidence
```

Resuming is just reading `state.json` — the next step is always deterministic.

## Grading & levels

- Diagnostic answers are LLM-judged levels (the prior).
- Every graded quiz item updates the concept's stats; levels are then derived:
  `mastery` ≥80% over ≥4 attempts · `solid` ≥70% over ≥2 · else `basic`.
  The diagnostic prior holds until 2 quiz data points exist, then evidence wins
  (including downgrades).
- Pass gates: lesson quiz 70%, checkpoint 80%, remediation 50% (one retry,
  then `force` to move on with the concepts flagged weak for reviews).

## Code topics

Quizzes can be `code` type. **v1 grades code by inspection** — the rubric tells
the tutor to verify actual correctness (would it run? edge cases? complexity),
not vibes. Real execution (`run_code`) is on the v2 roadmap.

## Development

```
node test/flow.ts    # 141-check end-to-end state machine test (temp dir)
node test/load.ts    # loads index.ts via jiti with pi's aliases, mocks the API
```

- `index.ts` — pi glue: tools, commands, session note, TUI dashboard
- `src/types.ts` — state schema + tunables (question counts, pass thresholds)
- `src/store.ts` — file persistence (`~/.pi/learning/...`)
- `src/machine.ts` — scoring, concept-map updates, and the NEXT-step generator
- `src/record.ts` — validated mutations + the deterministic advance logic
- `src/render.ts` — `plan.md` / `diagnostics.md` / dashboard views

Installed via symlink: `~/.pi/agent/extensions/learning-harness` → this repo,
so `/reload` in pi picks up changes immediately.

## v2 candidates

- `run_code` quiz type: execute learner code against stored test cases (node/python)
- Time-based spaced repetition (the concept map already records what's weak and when)
- Plan editing actions (replan, reorder, insert lessons)
- Web research to source lesson material
- TUI progress dashboard upgrades
