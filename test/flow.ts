// Headless end-to-end test of the learning harness state machine.
// Run: node test/flow.ts   (uses a temp state dir via LEARNING_HARNESS_HOME)

import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.LEARNING_HARNESS_HOME = mkdtempSync(join(tmpdir(), "learning-harness-test-"));

import { newTopicState, saveTopic, listTopics, deleteTopic } from "../src/store.ts";
import * as rec from "../src/record.ts";
import { topicSummary, nextStep, findActiveQuiz } from "../src/machine.ts";
import type { TopicState } from "../src/types.ts";

let passed = 0;
function step(desc: string, res: rec.Result): void {
  assert.ok(res.ok, `${desc}: BLOCKED — ${res.error}`);
  passed++;
}
function expectBlock(desc: string, res: rec.Result): void {
  assert.ok(!res.ok, `${desc}: expected a block but it succeeded: ${res.text}`);
  passed++;
}

const q = (concept: string, prompt: string, rubric: string, type: "free" | "choice" | "code" | "teachback" = "free", difficulty: "novice" | "intermediate" | "advanced" = "novice") => ({ concept, type, difficulty, prompt, rubric });

// ═══ Topic 1: code topic — happy path + fail/remediation/force paths ═══════

const st: TopicState = newTopicState("Closures in JavaScript", "code", "javascript");
saveTopic(st);
assert.ok(nextStep(st).includes("design the diagnostic"));
passed++;

// Validation: wrong diagnostic size rejected.
expectBlock(
  "5-question diagnostic rejected",
  rec.recordDiagnostic(
    st,
    [1, 2, 3, 4, 5].map((i) => q(`c${i}`, `p${i}`, `r${i}`)),
  ),
);

step(
  "diagnostic recorded",
  rec.recordDiagnostic(st, [
    { concept: "closures", type: "teachback", difficulty: "novice", prompt: "Explain what a closure is.", rubric: "Function + bundled environment / access to outer variables" },
    { concept: "scope", type: "free", difficulty: "novice", prompt: "What is scope?", rubric: "Where variables are accessible; local vs global" },
    { concept: "hoisting", type: "choice", difficulty: "novice", prompt: "A. var hoisted B. let hoisted C. both D. neither", rubric: "A (var hoisted; let has TDZ)" },
    { concept: "lexical-environment", type: "free", difficulty: "intermediate", prompt: "What is a lexical environment?", rubric: "Chain of variable environments created with function scope" },
    { concept: "iife", type: "code", difficulty: "intermediate", prompt: "Write an IIFE that returns a counter.", rubric: "Runs immediately; private counter; returns function" },
    { concept: "event-loop", type: "code", difficulty: "advanced", prompt: "Predict: console.log(1); setTimeout(()=>console.log(2),0); Promise.resolve().then(()=>console.log(3)); console.log(4);", rubric: "1,4,3,2 — microtasks before macrotasks" },
  ]),
);

const diagAnswers: Array<[string, string, string]> = [
  ["d1", "solid", "Defined closures correctly, mentioned captured environment."],
  ["d2", "basic", "Knew local vs global vaguely; missed block scope nuance."],
  ["d3", "none", "Thought nothing is hoisted."],
  ["d4", "basic", "Could not name it; described 'variables live somewhere'."],
  ["d5", "solid", "Wrote a working IIFE counter after one hint."],
  ["d6", "none", "Guessed 1,2,3,4 with no reasoning."],
];
for (const [qid, level, ev] of diagAnswers) step(`answer ${qid}`, rec.recordAnswer(st, qid, level, ev));
assert.ok(nextStep(st).includes("design the lesson plan"));
passed++;

step(
  "plan recorded",
  rec.recordPlan(st, [
    {
      title: "Core closure mechanics",
      concepts: ["closures", "scope", "lexical-environment"],
      lessons: [
        { title: "What closures capture", objectives: ["Explain what a closure captures", "Predict which variables a function closes over"], concepts: ["closures", "scope"], checkIns: 1 },
        { title: "Closures in loops", objectives: ["Fix the classic loop-capture bug", "Explain per-iteration binding"], concepts: ["closures", "lexical-environment"], checkIns: 2 },
      ],
    },
    {
      title: "Runtime behavior",
      concepts: ["hoisting", "event-loop", "iife"],
      lessons: [
        { title: "Execution order & hoisting", objectives: ["Predict order with var/let/function declarations"], concepts: ["hoisting"], checkIns: 1 },
        { title: "Async, callbacks & the event loop", objectives: ["Explain microtasks vs macrotasks", "Use IIFEs for private state"], concepts: ["event-loop", "iife"], checkIns: 1 },
      ],
    },
  ]),
);
assert.equal(st.phase, "learning");
passed++;

// ── u1l1: lesson quiz pass (75%) ──
assert.ok(nextStep(st).includes("teach lesson u1l1"));
passed++;
step("u1l1 quiz generated", rec.generateQuiz(st, "lesson", [
  q("closures", "What does the inner function capture? fn(){let x=1;return()=>x}", "The binding of x from the outer scope"),
  q("scope", "Which vars can f see? outer a,b; inner c. A. a,b B. c C. a,b,c D. none", "C", "choice"),
  q("closures", "Write makeAdder(n) returning a function adding n.", "Correct; uses closure; works across calls", "code"),
  q("scope", "Why is y undefined? function g(){if(true){let y=1} console.log(y)}", "Block scope; y only exists inside the block"),
]));
assert.equal(findActiveQuiz(st)?.kind, "lesson");
passed++;
step("u1l1 q1 ✓", rec.gradeQuiz(st, { kind: "lesson", itemId: "l1", score: 1, feedback: "Nailed the capture binding." }));
step("u1l1 q2 ✗", rec.gradeQuiz(st, { kind: "lesson", itemId: "l2", score: 0, feedback: "Missed the inner-scope variable." }));
step("u1l1 q3 ✓", rec.gradeQuiz(st, { kind: "lesson", itemId: "l3", score: 1, feedback: "Working makeAdder." }));
step("u1l1 q4 ✓", rec.gradeQuiz(st, { kind: "lesson", itemId: "l4", score: 1, feedback: "Explained block scope correctly." }));
assert.equal(st.plan.units[0].lessons[0].quizScore, 75);
passed++;
step("u1l1 advance (75% ≥ 70)", rec.advance(st, {}));
assert.equal(st.progress.lessonIndex, 1);
passed++;

// ── u1l2: lesson quiz fail (50%) → remediation pass (100%) ──
step("u1l2 quiz generated", rec.generateQuiz(st, "lesson", [
  q("closures", "Why does this loop print 5 five times? for(var i=0;i<5;i++){setTimeout(()=>console.log(i))}", "Shared i binding; i is 5 when callbacks run", "code"),
  q("lexical-environment", "What is created for each function invocation?", "A new environment object linked to the enclosing one"),
  q("scope", "Fix the loop so it prints 0..4.", "let, or IIFE, or index param", "code"),
  q("lexical-environment", "The chain of environments is called? A. prototype B. scope chain C. call stack D. heap", "B", "choice"),
]));
expectBlock("grading out of order blocked (l2 before l1)", rec.gradeQuiz(st, { kind: "lesson", itemId: "l2", score: 1, feedback: "x" }));
step("u1l2 q1 ✓", rec.gradeQuiz(st, { kind: "lesson", itemId: "l1", score: 1, feedback: "Explained the shared binding well." }));
step("u1l2 q2 ✗", rec.gradeQuiz(st, { kind: "lesson", itemId: "l2", score: 0, feedback: "No idea what an environment object is." }));
step("u1l2 q3 ✓", rec.gradeQuiz(st, { kind: "lesson", itemId: "l3", score: 1, feedback: "Fixed with let correctly." }));
step("u1l2 q4 ✗", rec.gradeQuiz(st, { kind: "lesson", itemId: "l4", score: 0, feedback: "Guessed A." }));
assert.equal(st.plan.units[0].lessons[1].quizScore, 50);
passed++;
expectBlock("grading a complete quiz blocked", rec.gradeQuiz(st, { kind: "lesson", itemId: "l1", score: 1, feedback: "x" }));
expectBlock("advance blocked: remediation required", rec.advance(st, {}));

step("u1l2 remediation generated", rec.generateQuiz(st, "remediation", [
  q("lexical-environment", "Describe what happens in memory when a function is called.", "New environment object, outer link, variable bindings"),
  q("lexical-environment", "True/false: every call gets a FRESH environment. A. true B. false", "A", "choice"),
]));
step("u1l2 rem q1 ✓", rec.gradeQuiz(st, { kind: "remediation", itemId: "r1", score: 1, feedback: "Now describes the environment object." }));
step("u1l2 rem q2 ✓", rec.gradeQuiz(st, { kind: "remediation", itemId: "r2", score: 1, feedback: "True — fresh each call." }));
step("u1l2 advance (remediation 100%)", rec.advance(st, {}));
assert.equal(st.plan.units[0].lessons[1].status, "done");
passed++;

// ── u1 checkpoint: fail (67%) → remediation fail (33%) → FORCE advance ──
assert.ok(nextStep(st).includes("unit checkpoint"));
passed++;
step("u1 checkpoint generated", rec.generateQuiz(st, "checkpoint", [
  q("closures", "Explain closures to a 12-year-old.", "Outer function + remembered variables; no jargon needed"),
  q("scope", "Where can this variable be read? (block-scoped)", "Only within its block", "choice"),
  q("lexical-environment", "Draw the environment chain for a() calling b() calling c().", "Three linked environment objects in correct order"),
  q("closures", "Write an object with private state using closures.", "Getter/setter over closed-over variable; state not exposed directly", "code"),
  q("scope", "var vs let vs const in a loop — which leak? Explain.", "var leaks to function/global; let/const are block-scoped"),
  q("lexical-environment", "Why can a closure read a variable that changed after the outer function returned?", "It holds a reference to the binding, not a copy", "teachback"),
]));
step("u1 ckpt q1 ✓", rec.gradeQuiz(st, { kind: "checkpoint", itemId: "c1", score: 1, feedback: "Great analogy." }));
step("u1 ckpt q2 ✓", rec.gradeQuiz(st, { kind: "checkpoint", itemId: "c2", score: 1, feedback: "Correct." }));
step("u1 ckpt q3 ✗", rec.gradeQuiz(st, { kind: "checkpoint", itemId: "c3", score: 0, feedback: "Drew the chain in the wrong order." }));
step("u1 ckpt q4 ✓", rec.gradeQuiz(st, { kind: "checkpoint", itemId: "c4", score: 1, feedback: "Clean private-state pattern." }));
step("u1 ckpt q5 ✗", rec.gradeQuiz(st, { kind: "checkpoint", itemId: "c5", score: 0, feedback: "Thought const leaks too." }));
step("u1 ckpt q6 ✓", rec.gradeQuiz(st, { kind: "checkpoint", itemId: "c6", score: 1, feedback: "Binding vs copy — got it." }));
assert.equal(st.plan.units[0].checkpointScore, 67);
passed++;
expectBlock("advance blocked: checkpoint remediation required", rec.advance(st, {}));

step("u1 checkpoint remediation generated", rec.generateQuiz(st, "remediation", [
  q("scope", "Which of these are block-scoped? A. var B. let C. const D. both B and C", "D", "choice"),
  q("scope", "Why does this print undefined? for(var i=0;i<1;i++){if(i<1){let j=2}} console.log(typeof j)", "j never existed in this scope; typeof of undeclared is 'undefined'", "code"),
  q("lexical-environment", "In one sentence: what does 'lexical' mean here?", "Environment is determined by where code is WRITTEN, not called"),
]));
step("u1 ckpt rem q1 ✓", rec.gradeQuiz(st, { kind: "remediation", itemId: "r1", score: 1, feedback: "D — both let and const." }));
step("u1 ckpt rem q2 ✗", rec.gradeQuiz(st, { kind: "remediation", itemId: "r2", score: 0, feedback: "Said ReferenceError." }));
step("u1 ckpt rem q3 ✗", rec.gradeQuiz(st, { kind: "remediation", itemId: "r3", score: 0, feedback: "Still fuzzy on lexical vs dynamic." }));
assert.equal(st.plan.units[0].remediation?.score, 33);
passed++;
expectBlock("advance without force blocked (remediation 33% < 50%)", rec.advance(st, {}));
step("u1 advance with FORCE", rec.advance(st, { force: true, note: "scope stays flagged" }));
assert.equal(st.plan.units[0].done, true);
passed++;

// ── u1 unit review (scope was left basic) ──
assert.ok(nextStep(st).includes("unit review"));
passed++;
const u1 = st.plan.units[0];
assert.deepEqual(u1.reviewConcepts, ["scope", "lexical-environment"]);
passed++;
step("u1 review generated", rec.generateQuiz(st, "review", [
  q("scope", "Block scope: where is this variable alive? (with example)", "Identifies the block correctly"),
  q("lexical-environment", "Trace the environment chain for outer() calling inner().", "Two linked environment objects, correct order and bindings"),
  q("scope", "var/let/const: which can be redeclared in the same block? A. none B. var only C. let D. const", "B", "choice"),
]));
step("u1 rev q1 ✓", rec.gradeQuiz(st, { kind: "review", itemId: "v1", score: 1, feedback: "Correct." }));
step("u1 rev q2 ✓", rec.gradeQuiz(st, { kind: "review", itemId: "v2", score: 1, feedback: "Traced it correctly now." }));
step("u1 rev q3 ✓", rec.gradeQuiz(st, { kind: "review", itemId: "v3", score: 1, feedback: "B." }));
step("u1 review advance → unit 2", rec.advance(st, {}));
assert.equal(st.progress.unitIndex, 1);
assert.equal(st.plan.units[1].lessons[0].status, "active");
passed++;

// ── u2l1: fail (67%) → remediation pass (100%) ──
step("u2l1 quiz generated", rec.generateQuiz(st, "lesson", [
  q("hoisting", "Predict: console.log(a); var a=1; — and explain.", "'undefined' (not ReferenceError): declaration hoisted, init not", "code"),
  q("hoisting", "Order these: function f(){}, console.log(f()), var x. What runs?", "f is hoisted with its body; call works before the var line"),
  q("hoisting", "let has hoisting — why does accessing it early throw?", "TDZ: hoisted but uninitialized until declaration"),
]));
step("u2l1 q1 ✓", rec.gradeQuiz(st, { kind: "lesson", itemId: "l1", score: 1, feedback: "undefined + explanation." }));
step("u2l1 q2 ✓", rec.gradeQuiz(st, { kind: "lesson", itemId: "l2", score: 1, feedback: "Got the function hoist." }));
step("u2l1 q3 ✗", rec.gradeQuiz(st, { kind: "lesson", itemId: "l3", score: 0, feedback: "Said let just becomes undefined." }));
assert.equal(st.plan.units[1].lessons[0].quizScore, 67);
passed++;
step("u2l1 remediation generated", rec.generateQuiz(st, "remediation", [
  q("hoisting", "What is the TDZ and when does it end?", "From start of scope to the let/const declaration; ends at declaration (still before init semantics)", "free"),
  q("hoisting", "Predict + explain: console.log(b); let b = 2;", "ReferenceError: Cannot access 'b' before initialization", "code"),
]));
step("u2l1 rem q1 ✓", rec.gradeQuiz(st, { kind: "remediation", itemId: "r1", score: 1, feedback: "TDZ explained properly." }));
step("u2l1 rem q2 ✓", rec.gradeQuiz(st, { kind: "remediation", itemId: "r2", score: 1, feedback: "ReferenceError — correct." }));
step("u2l1 advance (rem 100%)", rec.advance(st, {}));
passed++;

// ── u2l2: fail (50%) → remediation pass (50%, exactly at bar) ──
step("u2l2 quiz generated", rec.generateQuiz(st, "lesson", [
  q("event-loop", "Predict: 1; setTimeout 2; Promise 3; 4", "1,4,3,2 — sync, microtasks, then macrotasks", "code"),
  q("event-loop", "Why does a 0ms setTimeout still wait for the current script?", "Macrotasks run only after the current execution context + microtask queue drain"),
  q("iife", "Write a private counter with an IIFE.", "Returns increment/decrement over a closed-over n", "code"),
  q("event-loop", "Where do .then callbacks run relative to setTimeout?", "Microtask queue — before any macrotask", "choice"),
]));
step("u2l2 q1 ✗", rec.gradeQuiz(st, { kind: "lesson", itemId: "l1", score: 0, feedback: "Said 1,2,3,4." }));
step("u2l2 q2 ✓", rec.gradeQuiz(st, { kind: "lesson", itemId: "l2", score: 1, feedback: "Understood the drain order now." }));
step("u2l2 q3 ✓", rec.gradeQuiz(st, { kind: "lesson", itemId: "l3", score: 1, feedback: "Solid IIFE counter." }));
step("u2l2 q4 ✗", rec.gradeQuiz(st, { kind: "lesson", itemId: "l4", score: 0, feedback: "Thought .then is a macrotask." }));
assert.equal(st.plan.units[1].lessons[1].quizScore, 50);
passed++;
step("u2l2 remediation generated", rec.generateQuiz(st, "remediation", [
  q("event-loop", "Order: sync A, .then B, setTimeout C, .then D (chained after B).", "A,B,D,C", "choice"),
  q("event-loop", "In one sentence: microtask vs macrotask.", "Microtasks (promises) drain fully after each task; macrotasks (timers) wait their turn"),
]));
step("u2l2 rem q1 ✗", rec.gradeQuiz(st, { kind: "remediation", itemId: "r1", score: 0, feedback: "Put C before D." }));
step("u2l2 rem q2 ✓", rec.gradeQuiz(st, { kind: "remediation", itemId: "r2", score: 1, feedback: "Clean definition." }));
step("u2l2 advance (rem 50% — exactly at bar)", rec.advance(st, {}));
passed++;

// ── u2 checkpoint: pass (100%) → unit complete → topic complete ──
assert.ok(nextStep(st).includes("unit checkpoint"));
passed++;
step("u2 checkpoint generated", rec.generateQuiz(st, "checkpoint", [
  q("hoisting", "Predict the output (var/let/function mix) + why.", "All three hoisting rules applied correctly", "code"),
  q("hoisting", "Can you call a function before its declaration? When?", "Function declarations: yes; function expressions / let: no"),
  q("iife", "Two uses of IIFEs beyond counters.", "e.g. module pattern, avoiding global pollution, one-time setup", "free"),
  q("event-loop", "Predict: console.log('a'); queueMicrotask(b); setTimeout(c,0);", "a, b, c", "code"),
  q("event-loop", "Explain to a peer why the browser stays responsive.", "Task queue + non-blocking I/O; timers are macrotasks", "teachback"),
  q("iife", "Spot the bug: (function(){ let count = 0; return { get(){return count++} } })() — does it work?", "Works; each get() sees the same closed-over count"),
]));
step("u2 ckpt q1 ✓", rec.gradeQuiz(st, { kind: "checkpoint", itemId: "c1", score: 1, feedback: "Perfect." }));
step("u2 ckpt q2 ✓", rec.gradeQuiz(st, { kind: "checkpoint", itemId: "c2", score: 1, feedback: "Distinguished declarations from expressions." }));
step("u2 ckpt q3 ✓", rec.gradeQuiz(st, { kind: "checkpoint", itemId: "c3", score: 1, feedback: "Two solid uses." }));
step("u2 ckpt q4 ✓", rec.gradeQuiz(st, { kind: "checkpoint", itemId: "c4", score: 1, feedback: "a,b,c." }));
step("u2 ckpt q5 ✓", rec.gradeQuiz(st, { kind: "checkpoint", itemId: "c5", score: 1, feedback: "Great peer explanation." }));
step("u2 ckpt q6 ✓", rec.gradeQuiz(st, { kind: "checkpoint", itemId: "c6", score: 1, feedback: "Spotted it works; explained the shared binding." }));
assert.equal(st.plan.units[1].checkpointScore, 100);
passed++;
step("u2 advance", rec.advance(st, {}));
// event-loop still basic → unit review is due before the topic can finish
assert.equal(st.plan.units[1].reviewDue, true);
assert.deepEqual(st.plan.units[1].reviewConcepts, ["event-loop"]);
passed++;
step("u2 review generated", rec.generateQuiz(st, "review", [
  q("event-loop", "Predict: console.log(1); queueMicrotask(()=>console.log(2)); setTimeout(()=>console.log(3),0);", "1,2,3", "code"),
  q("event-loop", "What runs first: .then or setTimeout(0)?", ".then — the microtask queue fully drains after each task"),
  q("event-loop", "Why does the UI not freeze during a setTimeout callback? One sentence.", "Macrotasks run one per turn; the loop yields between tasks", "teachback"),
]));
step("u2 rev q1 ✓", rec.gradeQuiz(st, { kind: "review", itemId: "v1", score: 1, feedback: "1,2,3." }));
step("u2 rev q2 ✓", rec.gradeQuiz(st, { kind: "review", itemId: "v2", score: 1, feedback: ".then first — got it." }));
step("u2 rev q3 ✓", rec.gradeQuiz(st, { kind: "review", itemId: "v3", score: 1, feedback: "One per turn — nice." }));
step("u2 review advance → topic complete", rec.advance(st, {}));
assert.equal(st.phase, "complete");
passed++;
assert.ok(nextStep(st).includes("COMPLETE"));
passed++;

// ── Post-completion topic review ──
step("topic review generated", rec.generateQuiz(st, "review", [
  q("event-loop", "Predict: sync, Promise.then, setTimeout, Promise chained from first.", "Sync, microtasks in order, then timer", "code"),
  q("iife", "Convert this global-polluting snippet to an IIFE.", "Wraps in IIFE, exports via return", "code"),
  q("hoisting", "Predict: console.log(x); function x(){}, x = 5; then x().", "Function is callable before assignment line", "code"),
  q("event-loop", "One sentence: why does Promise.resolve().then() beat setTimeout(...,0)?", "Microtask queue drains before the next macrotask", "teachback"),
  q("iife", "When would you NOT use an IIFE in modern JS?", "When modules/let-blocks already provide the scope", "free"),
]));
step("topic rev q1 ✓", rec.gradeQuiz(st, { kind: "review", itemId: "v1", score: 1, feedback: "Correct order." }));
step("topic rev q2 ✓", rec.gradeQuiz(st, { kind: "review", itemId: "v2", score: 1, feedback: "Clean refactor." }));
step("topic rev q3 ✓", rec.gradeQuiz(st, { kind: "review", itemId: "v3", score: 1, feedback: "Callable — right." }));
step("topic rev q4 ✓", rec.gradeQuiz(st, { kind: "review", itemId: "v4", score: 1, feedback: "Microtask drain." }));
step("topic rev q5 ✗", rec.gradeQuiz(st, { kind: "review", itemId: "v5", score: 0, feedback: "Said never — overcorrected." }));
step("topic review filed", rec.advance(st, {}));
assert.equal(st.phase, "complete");
assert.equal(st.review, undefined);
passed++;

// ── Final invariants ──
{
  const lessons = st.plan.units.flatMap((u) => u.lessons);
  assert.ok(lessons.every((l) => l.status === "done"), "all lessons done");
  assert.ok(st.plan.units.every((u) => u.done), "all units done");
  assert.equal(st.stats.answered, 4 + 4 + 2 + 6 + 3 + 3 + 3 + 2 + 4 + 2 + 6 + 3 + 5, "total answered");
  assert.equal(st.stats.quizzesTaken, 13, "13 quizzes");
  const levels = Object.fromEntries(Object.entries(st.conceptMap).map(([k, v]) => [k, v.level]));
  assert.equal(levels["closures"], "mastery");
  assert.equal(levels["lexical-environment"], "basic"); // still weak — will surface in topic review
  assert.equal(levels["event-loop"], "solid");
  assert.equal(levels["hoisting"], "mastery");
  console.log("\nTopic 1 concept map:", levels);
  console.log("Topic 1 stats:", st.stats);
  console.log("\n--- topic summary (final) ---\n");
  console.log(topicSummary(st).slice(0, 1500));
}

// ═══ Topic 2: general topic, small plan, skip_lesson, forget ════════════════

const g = newTopicState("Gardening 101", "general");
saveTopic(g);
step("t2 diagnostic", rec.recordDiagnostic(g, [
  q("soil", "What makes good potting soil?", "Drainage + aeration + nutrition; mentions components"),
  q("watering", "How do you know when to water?", "Soil moisture check, not a fixed schedule"),
  q("pruning", "Why prune?", "Health, shape, fruit; timing"),
  q("sunlight", "Full sun vs partial shade?", "6+ hours vs 3-6"),
  q("compost", "What does compost do?", "Feeds soil biology; structure + nutrients"),
  q("hardiness", "What is a hardiness zone?", "Winter temperature range; plant selection"),
]));
for (const [qid, level, ev] of [
  ["d1", "basic", "Knew 'soil' vaguely."],
  ["d2", "basic", "Watered on a timer."],
  ["d3", "none", "No idea."],
  ["d4", "solid", "Knew 6+ hours."],
  ["d5", "basic", "Heard of compost."],
  ["d6", "none", "Never heard of zones."],
] as Array<[string, string, string]>) step(`t2 answer ${qid}`, rec.recordAnswer(g, qid, level, ev));
step(
  "t2 plan (1 unit)",
  rec.recordPlan(g, [
    {
      title: "Getting plants to survive",
      concepts: ["soil", "watering", "pruning"],
      lessons: [
        { title: "Soil & watering basics", objectives: ["Test soil moisture correctly", "Mix a basic potting soil"], concepts: ["soil", "watering"] },
        { title: "Pruning & care rhythm", objectives: ["Prune a houseplant safely", "Set a seasonal care routine"], concepts: ["pruning", "soil"] },
      ],
    },
  ]),
);
step("t2 skip lesson 1 (learner already knows it)", rec.skipLesson(g, "already know this"));
assert.equal(g.plan.units[0].lessons[0].status, "skipped");
passed++;
step("t2 lesson 2 quiz", rec.generateQuiz(g, "lesson", [
  q("pruning", "When do you prune a dormant rose?", "Late winter / early spring, before bud break", "choice"),
  q("soil", "Finger-test for watering: how deep and what signal?", "2-3 cm down; damp = wait, dry = water"),
  q("watering", "Signs of overwatering?", "Yellow leaves, soggy soil, root rot risk"),
]));
step("t2 l2 q1 ✓", rec.gradeQuiz(g, { kind: "lesson", itemId: "l1", score: 1, feedback: "Late winter." }));
step("t2 l2 q2 ✓", rec.gradeQuiz(g, { kind: "lesson", itemId: "l2", score: 1, feedback: "2-3 cm, damp = wait." }));
step("t2 l2 q3 ✓", rec.gradeQuiz(g, { kind: "lesson", itemId: "l3", score: 1, feedback: "Yellowing + soggy." }));
step("t2 l2 advance (100%)", rec.advance(g, {}));
step("t2 checkpoint", rec.generateQuiz(g, "checkpoint", [
  q("pruning", "Prune a houseplant: what do you cut?", "Dead/damaged/crossing growth; cut above a node", "free"),
  q("soil", "Your mix drains too fast — what do you add?", "More moisture-retentive material (peat/coir/compot)", "choice"),
  q("watering", "Plant in a clay pot vs plastic — watering difference?", "Clay dries faster; water more often"),
  q("pruning", "Why cut just above a node?", "New growth emerges from nodes; clean cut heals well", "teachback"),
  q("soil", "One reason to repot?", "Root bound; refresh soil; bigger root room"),
]));
step("t2 ck q1 ✓", rec.gradeQuiz(g, { kind: "checkpoint", itemId: "c1", score: 1, feedback: "Correct." }));
step("t2 ck q2 ✓", rec.gradeQuiz(g, { kind: "checkpoint", itemId: "c2", score: 1, feedback: "Coir." }));
step("t2 ck q3 ✓", rec.gradeQuiz(g, { kind: "checkpoint", itemId: "c3", score: 1, feedback: "Clay dries faster." }));
step("t2 ck q4 ✗", rec.gradeQuiz(g, { kind: "checkpoint", itemId: "c4", score: 0, feedback: "Said below the node." }));
step("t2 ck q5 ✓", rec.gradeQuiz(g, { kind: "checkpoint", itemId: "c5", score: 1, feedback: "Root bound." }));
assert.equal(g.plan.units[0].checkpointScore, 80);
passed++;
step("t2 ckpt advance (80% exactly)", rec.advance(g, {}));
assert.equal(g.plan.units[0].done, true);
// pruning left basic (diagnostic none + 1 wrong + ... check) → review likely due
if (g.plan.units[0].reviewDue) {
  console.log("\n(t2 unit review due for:", g.plan.units[0].reviewConcepts.join(", "), ")");
  step("t2 unit review", rec.generateQuiz(g, "review", [
    q("pruning", "Cut above or below a node?", "Above", "choice"),
    q("soil", "Repotting signs?", "Roots circling / poking out drainage"),
    q("watering", "Bottom watering: when useful?", "Even uptake; avoids wetting foliage; for dry-thirsty plants", "free"),
  ]));
  step("t2 rev q1 ✓", rec.gradeQuiz(g, { kind: "review", itemId: "v1", score: 1, feedback: "Above." }));
  step("t2 rev q2 ✓", rec.gradeQuiz(g, { kind: "review", itemId: "v2", score: 1, feedback: "Roots circling." }));
  step("t2 rev q3 ✓", rec.gradeQuiz(g, { kind: "review", itemId: "v3", score: 1, feedback: "Good reasons." }));
  step("t2 review advance → complete", rec.advance(g, {}));
}
assert.equal(g.phase, "complete");
passed++;

// ── Topic lookup + delete ──
assert.ok(listTopics().length >= 2);
passed++;
deleteTopic(g.topic);
assert.equal(listTopics().length, 1);
passed++;

// ── Render sanity ──
{
  const { renderPlanMd, renderDiagnosticsMd, dashboardText } = await import("../src/render.ts");
  const plan = renderPlanMd(st);
  const diag = renderDiagnosticsMd(st);
  const dash = dashboardText(listTopics());
  assert.ok(plan.includes("# Learning plan: Closures in JavaScript"));
  assert.ok(diag.includes("| 1 | closures |"));
  assert.ok(dash.includes("Closures in JavaScript"));
  passed++;
  console.log("\n--- plan.md (topic 1, first 40 lines) ---\n");
  console.log(plan.split("\n").slice(0, 40).join("\n"));
}

console.log(`\n✅ ALL ${passed} CHECKS PASSED`);
