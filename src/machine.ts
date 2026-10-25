// The harness state machine: scoring, concept-map updates, and the
// "what to do NEXT" instructions shown to the tutor LLM. Pure — no pi imports.

import type { ConceptLevel, QuizItem, TopicState, Unit } from "./types.ts";
import { CHECKPOINT_QUIZ, DIAGNOSTIC_TOTAL, LESSON_QUIZ, LEVEL_RANK, REVIEW_QUIZ } from "./types.ts";

// ── Scoring ─────────────────────────────────────────────────────────────────

export function firstUnscored(items: QuizItem[]): number {
  return items.findIndex((i) => i.score === undefined);
}

/** 0-100, or undefined if any item is unscored. */
export function containerScore(items: QuizItem[]): number | undefined {
  if (!items.length) return undefined;
  const i = firstUnscored(items);
  if (i !== -1) return undefined;
  const correct = items.filter((x) => x.score === 1).length;
  return Math.round((100 * correct) / items.length);
}

/** Derive a concept level from graded quiz attempts. */
export function levelFromStats(correct: number, total: number): ConceptLevel {
  if (total === 0) return "none";
  const pct = correct / total;
  if (pct >= 0.8 && total >= 4) return "mastery";
  if (pct >= 0.7 && total >= 2) return "solid";
  return "basic";
}

/**
 * Update a concept's map entry after a graded quiz item.
 * The diagnostic judgment acts as a prior: it holds until 2 quiz data points
 * exist, after which stats take over (including downgrades — evidence wins).
 */
export function updateConceptAfterQuiz(state: TopicState, concept: string, score: 0 | 1, feedback: string): void {
  const existing = state.conceptMap[concept];
  const stats = {
    correct: (existing?.stats.correct ?? 0) + score,
    total: (existing?.stats.total ?? 0) + 1,
  };
  const statsLevel = levelFromStats(stats.correct, stats.total);
  let level: ConceptLevel;
  if (existing?.diagnosticLevel && stats.total < 2) {
    level = LEVEL_RANK[statsLevel] >= LEVEL_RANK[existing.diagnosticLevel] ? statsLevel : existing.diagnosticLevel;
  } else {
    level = statsLevel;
  }
  state.conceptMap[concept] = {
    level,
    evidence: feedback,
    stats,
    diagnosticLevel: existing?.diagnosticLevel,
    lastTested: new Date().toISOString(),
  };
}

export function conceptLevel(state: TopicState, concept: string): ConceptLevel {
  return state.conceptMap[concept]?.level ?? "none";
}

export function pct(correct: number, total: number): string {
  if (!total) return "0";
  return String(Math.round((100 * correct) / total));
}

// ── Position ────────────────────────────────────────────────────────────────

export function currentUnit(state: TopicState): Unit | undefined {
  return state.plan.units[state.progress.unitIndex];
}

export function currentLesson(state: TopicState) {
  const unit = currentUnit(state);
  return unit?.lessons[state.progress.lessonIndex];
}

export function lessonsDone(state: TopicState): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const u of state.plan.units) {
    for (const l of u.lessons) {
      total++;
      if (l.status === "done" || l.status === "skipped") done++;
    }
  }
  return { done, total };
}

export interface ActiveQuiz {
  kind: "lesson" | "checkpoint" | "remediation" | "review";
  items: QuizItem[];
  label: string;
  name: string; // lesson or unit title
  firstUnscored: number;
}

/** The one quiz that is currently in progress, or undefined. */
export function findActiveQuiz(state: TopicState): ActiveQuiz | undefined {
  if (state.phase === "complete") {
    if (state.review?.items.length) {
      const i = firstUnscored(state.review.items);
      if (i !== -1) return { kind: "review", items: state.review.items, label: "topic review", name: state.title, firstUnscored: i };
    }
    return undefined;
  }
  if (state.phase !== "learning") return undefined;
  const unit = currentUnit(state);
  if (!unit) return undefined;

  if (unit.done) {
    if (unit.review?.items.length) {
      const i = firstUnscored(unit.review.items);
      if (i !== -1)
        return { kind: "review", items: unit.review.items, label: `unit review (${unit.id})`, name: unit.title, firstUnscored: i };
    }
    return undefined;
  }

  const lesson = unit.lessons[state.progress.lessonIndex];
  if (lesson && lesson.status === "active") {
    if (lesson.quiz.length) {
      const i = firstUnscored(lesson.quiz);
      if (i !== -1)
        return { kind: "lesson", items: lesson.quiz, label: `lesson quiz (${lesson.id})`, name: lesson.title, firstUnscored: i };
    }
    if (lesson.remediation?.items.length) {
      const i = firstUnscored(lesson.remediation.items);
      if (i !== -1)
        return {
          kind: "remediation",
          items: lesson.remediation.items,
          label: `lesson remediation (${lesson.id})`,
          name: lesson.title,
          firstUnscored: i,
        };
    }
  }

  if (!lesson || lesson.status !== "active") {
    if (unit.checkpoint.length) {
      const i = firstUnscored(unit.checkpoint);
      if (i !== -1)
        return { kind: "checkpoint", items: unit.checkpoint, label: `unit checkpoint (${unit.id})`, name: unit.title, firstUnscored: i };
    }
    if (unit.remediation?.items.length) {
      const i = firstUnscored(unit.remediation.items);
      if (i !== -1)
        return {
          kind: "remediation",
          items: unit.remediation.items,
          label: `checkpoint remediation (${unit.id})`,
          name: unit.title,
          firstUnscored: i,
        };
    }
  }
  return undefined;
}

// ── NEXT-step instructions (the tutor prompt) ───────────────────────────────

function presentQuizText(aq: ActiveQuiz): string {
  const item = aq.items[aq.firstUnscored];
  return [
    `NEXT — present quiz item ${aq.firstUnscored + 1}/${aq.items.length} of the ${aq.label} for "${aq.name}".`,
    `Concept: ${item.concept} | type: ${item.type}`,
    `Prompt: ${JSON.stringify(item.prompt)}`,
    `Grading rubric (do not quote verbatim to the learner): ${item.rubric}`,
    `Ask it, wait for the answer, then grade strictly against the rubric — score 1 only if it meets the rubric (for code: would it actually work, edge cases included — not vibes).`,
    `Call learning_record {action:"grade_quiz", topic:"${state_topic_hint}", kind:"${aq.kind}", itemId:"${item.id}", score:0|1, feedback:"..."} and give the learner that feedback in the moment — right: why it's right; wrong: why not + the correct idea.`,
    `Then call learning_status for the next step.`,
  ].join("\n");
}

// state_topic_hint is filled by nextStep via closure below.
let state_topic_hint = "";

export function nextStep(state: TopicState): string {
  state_topic_hint = state.topic;

  // ── Diagnostic phase ──
  if (state.phase === "diagnostic") {
    const d = state.diagnostic;
    if (!d.questions.length) {
      return [
        `NEXT — design the diagnostic (before asking anything):`,
        `Create exactly ${DIAGNOSTIC_TOTAL} questions probing ${DIAGNOSTIC_TOTAL} DIFFERENT core concepts of "${state.title}".`,
        `- Mix types: use "teachback" or "free" for at least 2 (they reveal the most); "choice" only where it sharpens the signal; for code topics include "code" where it fits.`,
        `- Vary difficulty (novice → advanced) so we locate WHAT the learner knows, not just their level.`,
        `- Each question: concept (short name), type, difficulty, prompt (fully self-contained; for choice, include the lettered options inside the prompt), rubric (what a strong answer contains; for code: exactly what to check — correctness, edge cases, complexity).`,
        `Do NOT ask the questions yet. First call learning_record {action:"record_diagnostic", topic:"${state.topic}", questions:[...]}`,
        `then follow the next learning_status output.`,
      ].join("\n");
    }
    const asked = d.answers.length;
    if (asked < d.total) {
      const q = d.questions[asked];
      return [
        `NEXT — diagnostic question ${asked + 1}/${d.total} for "${state.title}".`,
        `Concept: ${q.concept} | type: ${q.type} | difficulty: ${q.difficulty}`,
        `Prompt: ${JSON.stringify(q.prompt)}`,
        `Grading rubric (do not quote verbatim): ${q.rubric}`,
        `Present this question to the learner and wait for their answer. Do not reveal the rubric or the remaining questions.`,
        `Grade honestly against the rubric — be skeptical of vague or hand-wavy answers. Then call`,
        `learning_record {action:"record_answer", topic:"${state.topic}", questionId:"${q.id}", level:"none|basic|solid|mastery", evidence:"1-2 sentences: what they demonstrated"}.`,
        `Give the learner brief feedback (confirm what's right; correct misconceptions gently but specifically), then call learning_status.`,
      ].join("\n");
    }
    const lines = [
      "NEXT — design the lesson plan.",
      "Concept map from the diagnostic:",
      ...conceptLines(state),
      `Build ${state.kind === "general" ? "1-4" : "1-6"} units (scale to topic size), each with 2-4 lessons:`,
      `- Target the gaps: none/basic concepts get real lessons; solid concepts get short refresher lessons; mastery concepts are skipped (weave them in when useful).`,
      `- Every lesson: title; 1-3 concrete objectives; the concepts it targets; checkIns 0-2 (2 for weak concepts).`,
      state.kind === "code" || state.kind === "mixed"
        ? `- For code: objectives should end in something the learner can DO (write / debug / explain / predict code).`
        : "",
      `- Keep lessons ~15-30 min of content.`,
      `Call learning_record {action:"record_plan", topic:"${state.topic}", units:[{title, concepts:[...], lessons:[{title, objectives:[...], concepts:[...], checkIns}]}]}.`,
      `After the tool confirms, start teaching unit 1 lesson 1 (the next status will tell you how).`,
    ].filter(Boolean);
    return lines.join("\n");
  }

  // ── Complete ──
  if (state.phase === "complete") {
    if (state.review) {
      const i = firstUnscored(state.review.items);
      if (i !== -1) {
        return presentQuizText({
          kind: "review",
          items: state.review.items,
          label: "topic review",
          name: state.title,
          firstUnscored: i,
        });
      }
      return `Topic review complete: ${state.review.score}%. Concept map updated (see above). Call learning_record {action:"advance", topic:"${state.topic}"} to file it. (The topic stays complete.)`;
    }
    const weak = weakConcepts(state, 5);
    return [
      `NEXT — topic "${state.title}" is COMPLETE.`,
      `Stats: ${state.stats.quizzesTaken} quizzes, ${pct(state.stats.correct, state.stats.answered)}% overall accuracy (${state.stats.correct}/${state.stats.answered}).`,
      weak.length ? `Weakest concepts: ${weak.map((w) => w.concept).join(", ")}.` : `No weak concepts remain — strong finish.`,
      `Congratulate the learner and give a short summary of what they now know.`,
      `If they want to keep going, offer a review of the weakest concepts (${REVIEW_QUIZ.min}-${REVIEW_QUIZ.max} items): learning_record {action:"generate_quiz", topic:"${state.topic}", kind:"review", items:[...]} — then follow the status.`,
      `Otherwise suggest /learn for a new topic.`,
    ].join("\n");
  }

  // ── Learning phase ──
  const unit = currentUnit(state);
  if (!unit) {
    return "State anomaly: no current unit. Call learning_status to inspect.";
  }

  // Unit finished but unit-review still pending / in progress.
  if (unit.done) {
    if (!unit.reviewDue) {
      return `State: unit ${unit.id} is done. Call learning_record {action:"advance", topic:"${state.topic}"} to continue.`;
    }
    if (!unit.review || !unit.review.items.length) {
      return [
        `Unit "${unit.title}" passed its checkpoint (${unit.checkpointScore}%).`,
        `Before moving on: unit review of the concepts still at "basic": ${unit.reviewConcepts.join(", ")}.`,
        `Generate ${REVIEW_QUIZ.min}-${REVIEW_QUIZ.max} items: learning_record {action:"generate_quiz", topic:"${state.topic}", kind:"review", items:[...]}. Target exactly those concepts.`,
      ].join("\n");
    }
    const i = firstUnscored(unit.review.items);
    if (i !== -1) {
      return presentQuizText({
        kind: "review",
        items: unit.review.items,
        label: `unit review (${unit.id})`,
        name: unit.title,
        firstUnscored: i,
      });
    }
    const hasNext = state.progress.unitIndex + 1 < state.plan.units.length;
    return `Unit review complete: ${unit.review?.score}%. Call learning_record {action:"advance", topic:"${state.topic}"} to ${hasNext ? `start unit ${state.progress.unitIndex + 2}` : "finish the topic"}.`;
  }

  const lesson = unit.lessons[state.progress.lessonIndex];

  // All lessons in this unit done → checkpoint flow.
  if (!lesson || lesson.status !== "active") {
    if (!unit.checkpoint.length) {
      const weak = unit.concepts.filter((c) => conceptLevel(state, c) === "basic");
      return [
        `All lessons in unit ${unit.id} "${unit.title}" are done.`,
        `NEXT — generate the unit checkpoint: ${CHECKPOINT_QUIZ.min}-${CHECKPOINT_QUIZ.max} items covering the unit's concepts.`,
        weak.length
          ? `Weigh the weak ones: ${weak.join(", ")} (basic) get 2 items each; solid/mastery concepts get 1.`
          : `Concepts are all solid/mastery — spread items evenly.`,
        `Call learning_record {action:"generate_quiz", topic:"${state.topic}", kind:"checkpoint", items:[...]}.`,
      ].join("\n");
    }
    const i = firstUnscored(unit.checkpoint);
    if (i !== -1) {
      return presentQuizText({
        kind: "checkpoint",
        items: unit.checkpoint,
        label: `unit checkpoint (${unit.id})`,
        name: unit.title,
        firstUnscored: i,
      });
    }
    const cs = containerScore(unit.checkpoint)!;
    if (cs >= CHECKPOINT_QUIZ.pass) {
      return `Unit checkpoint PASSED: ${cs}% for "${unit.title}". Congratulate the learner briefly, then call learning_record {action:"advance", topic:"${state.topic}"}.`;
    }
    if (!unit.remediation) {
      const missed = unit.checkpoint.filter((q) => q.score === 0).map((q) => q.concept);
      return [
        `Unit checkpoint FAILED: ${cs}% (needs ${CHECKPOINT_QUIZ.pass}%) for "${unit.title}".`,
        `Missed concepts: ${[...new Set(missed)].join(", ") || "n/a"}.`,
        `Tell the learner the score honestly. Re-teach just the gaps briefly, then generate ${2}-4 remediation items on those concepts: learning_record {action:"generate_quiz", topic:"${state.topic}", kind:"remediation", items:[...]}.`,
      ].join("\n");
    }
    const ri = firstUnscored(unit.remediation.items);
    if (ri !== -1) {
      return presentQuizText({
        kind: "remediation",
        items: unit.remediation.items,
        label: `checkpoint remediation (${unit.id})`,
        name: unit.title,
        firstUnscored: ri,
      });
    }
    const rs = containerScore(unit.remediation.items)!;
    if (rs >= 50) {
      return `Checkpoint remediation: ${rs}% — enough. Summarize to the learner, then call learning_record {action:"advance", topic:"${state.topic}"}.`;
    }
    return `Checkpoint remediation: ${rs}% — the unit moves on with weak concepts flagged (they will return in reviews). Explain that, then call learning_record {action:"advance", topic:"${state.topic}", force:true, note:"..."}.`;
  }

  // Active lesson.
  if (!lesson.quiz.length) {
    return [
      `NEXT — teach lesson ${lesson.id} "${lesson.title}" (unit ${unit.id} "${unit.title}").`,
      `Objectives:`,
      ...lesson.objectives.map((o) => `  - ${o}`),
      `Concepts: ${lesson.concepts.join(", ")}`,
      `How to teach:`,
      `- Deliver the lesson now, in chat: concrete and examples-first. For code topics show real, correct code — don't just describe it.`,
      `- Keep it tight: ~15-30 min of reading. No filler.`,
      `- Work in ${lesson.checkIns} formative check-in question${lesson.checkIns === 1 ? "" : "s"} during the lesson: ask, wait for the answer, correct in the moment. Check-ins are UNscored — do NOT call any tool for them.`,
      `- Do NOT reveal the end-lesson quiz or its questions.`,
      `When the lesson content is fully delivered, call`,
      `learning_record {action:"generate_quiz", topic:"${state.topic}", kind:"lesson", items:[...]} with ${LESSON_QUIZ.min}-${LESSON_QUIZ.max} items covering this lesson's concepts (each: concept, type, prompt, rubric). Then call learning_status.`,
    ].join("\n");
  }
  const i = firstUnscored(lesson.quiz);
  if (i !== -1) {
    return presentQuizText({
      kind: "lesson",
      items: lesson.quiz,
      label: `lesson quiz (${lesson.id})`,
      name: lesson.title,
      firstUnscored: i,
    });
  }
  const s = containerScore(lesson.quiz)!;
  if (s >= LESSON_QUIZ.pass) {
    return `Lesson quiz PASSED for "${lesson.title}": ${s}%. Give the learner the score with a one-line summary (what was solid, what slipped), then call learning_record {action:"advance", topic:"${state.topic}"}.`;
  }
  if (!lesson.remediation) {
    const missed = lesson.quiz.filter((q) => q.score === 0).map((q) => q.concept);
    return [
      `Lesson quiz FAILED for "${lesson.title}": ${s}% (needs ${LESSON_QUIZ.pass}%).`,
      `Missed concepts: ${[...new Set(missed)].join(", ") || "n/a"}.`,
      `Tell the learner the score honestly. Re-teach just the gaps briefly (not the whole lesson), then generate ${2}-4 remediation items on those concepts: learning_record {action:"generate_quiz", topic:"${state.topic}", kind:"remediation", items:[...]}.`,
    ].join("\n");
  }
  const ri = firstUnscored(lesson.remediation.items);
  if (ri !== -1) {
    return presentQuizText({
      kind: "remediation",
      items: lesson.remediation.items,
      label: `lesson remediation (${lesson.id})`,
      name: lesson.title,
      firstUnscored: ri,
    });
  }
  const rs = containerScore(lesson.remediation.items)!;
  if (rs >= 50) {
    return `Remediation: ${rs}% — good enough. Summarize to the learner, then call learning_record {action:"advance", topic:"${state.topic}"}.`;
  }
  return `Remediation: ${rs}% — the lesson moves on with its concepts flagged weak (they will return in unit review and topic review). Explain that to the learner, then call learning_record {action:"advance", topic:"${state.topic}", force:true, note:"..."}.`;
}

export function weakConcepts(state: TopicState, limit = 5): { concept: string; level: ConceptLevel; stats: { correct: number; total: number } }[] {
  return Object.entries(state.conceptMap)
    .map(([concept, e]) => ({ concept, level: e.level, stats: e.stats }))
    .filter((e) => e.level === "basic")
    .sort((a, b) => {
      const pa = a.stats.total ? a.stats.correct / a.stats.total : 0;
      const pb = b.stats.total ? b.stats.correct / b.stats.total : 0;
      return pa - pb;
    })
    .slice(0, limit);
}

function conceptLines(state: TopicState): string[] {
  const entries = Object.entries(state.conceptMap).sort(
    (a, b) => LEVEL_RANK[a[1].level] - LEVEL_RANK[b[1].level] || a[0].localeCompare(b[0]),
  );
  return entries.map(([c, e]) => `  - ${c}: ${e.level} (${e.stats.correct}/${e.stats.total}) — ${e.evidence.slice(0, 140)}`);
}

// ── Summary (shown in tool output) ──────────────────────────────────────────

export function shortProgress(state: TopicState): string {
  if (state.phase === "diagnostic") {
    return `Diagnostic: ${state.diagnostic.answers.length}/${state.diagnostic.total} asked`;
  }
  if (state.phase === "complete") {
    return `Complete ✓`;
  }
  const marks = state.plan.units.map((u, i) => {
    if (u.done) return "✓";
    if (i === state.progress.unitIndex) return "▸";
    return "○";
  });
  const { done, total } = lessonsDone(state);
  const unit = currentUnit(state);
  const lesson = unit ? unit.lessons[state.progress.lessonIndex] : undefined;
  const pos = unit
    ? lesson
      ? `unit ${unit.id} · lesson ${state.progress.lessonIndex + 1}/${unit.lessons.length}`
      : `unit ${unit.id} · checkpoint`
    : "";
  return `Units: ${marks.join(" ")} | lessons ${done}/${total} | ${pos}`;
}

export function topicSummary(state: TopicState): string {
  const lines: string[] = [];
  lines.push(`Topic "${state.title}" (${state.topic}) — kind: ${state.kind}${state.language ? ` (${state.language})` : ""}`);
  lines.push(`Phase: ${state.phase} | created ${state.createdAt.slice(0, 10)} | updated ${state.updatedAt.slice(0, 10)}`);
  lines.push(shortProgress(state));
  if (state.stats.answered > 0) {
    lines.push(`Overall quiz accuracy: ${pct(state.stats.correct, state.stats.answered)}% (${state.stats.correct}/${state.stats.answered} across ${state.stats.quizzesTaken} quizzes)`);
  }
  if (Object.keys(state.conceptMap).length) {
    lines.push(`Concept map (weakest first):`);
    lines.push(...conceptLines(state));
  }
  lines.push("");
  lines.push(nextStep(state));
  return lines.join("\n");
}
