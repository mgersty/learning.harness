// State mutations: validate LLM-supplied artifacts, apply deterministic rules.
// Pure — no pi imports (testable headless).

import type {
  ConceptLevel,
  Difficulty,
  DiagnosticQuestion,
  QuestionType,
  QuizItem,
  QuizKind,
  TopicState,
  Unit,
} from "./types.ts";
import {
  CHECKPOINT_QUIZ,
  DIAGNOSTIC_TOTAL,
  DIFFICULTIES,
  LEVELS,
  LESSON_QUIZ,
  PLAN_LESSONS,
  PLAN_UNITS,
  QUESTION_TYPES,
  REMEDIATION_QUIZ,
  REVIEW_QUIZ,
} from "./types.ts";
import { containerScore, conceptLevel, firstUnscored, pct, updateConceptAfterQuiz } from "./machine.ts";
import { nowIso } from "./store.ts";

export interface Result {
  ok: boolean;
  text: string;
  error?: string;
}

const ok = (text: string): Result => ({ ok: true, text });
const fail = (error: string): Result => ({ ok: false, text: "", error });

function isStr(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function pushHistory(state: TopicState, type: string, note: string, score?: number): void {
  state.history.push({ at: nowIso(), type, note, score });
}

// ── Diagnostic ──────────────────────────────────────────────────────────────

export function recordDiagnostic(state: TopicState, questions: unknown): Result {
  if (state.phase !== "diagnostic") return fail(`phase is "${state.phase}", not diagnostic`);
  if (state.diagnostic.questions.length) return fail("diagnostic already recorded");
  if (!Array.isArray(questions) || questions.length !== DIAGNOSTIC_TOTAL) {
    return fail(`exactly ${DIAGNOSTIC_TOTAL} questions required (got ${Array.isArray(questions) ? questions.length : 0})`);
  }
  const seen = new Set<string>();
  const out: DiagnosticQuestion[] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i] as Record<string, unknown>;
    if (!isStr(q?.concept) || !isStr(q?.prompt) || !isStr(q?.rubric)) {
      return fail(`question ${i + 1} needs non-empty concept, prompt, rubric`);
    }
    if (!QUESTION_TYPES.includes(q.type as QuestionType)) return fail(`question ${i + 1}: bad type "${String(q.type)}" (use ${QUESTION_TYPES.join("|")})`);
    if (!DIFFICULTIES.includes(q.difficulty as Difficulty)) return fail(`question ${i + 1}: bad difficulty "${String(q.difficulty)}"`);
    if (seen.has(q.concept.toLowerCase())) return fail(`duplicate concept in diagnostic: "${q.concept}" — probe 6 different concepts`);
    seen.add(q.concept.toLowerCase());
    out.push({
      id: isStr(q.id) ? q.id : `d${i + 1}`,
      concept: q.concept.trim(),
      type: q.type as QuestionType,
      difficulty: q.difficulty as Difficulty,
      prompt: q.prompt.trim(),
      rubric: q.rubric.trim(),
    });
  }
  state.diagnostic.questions = out;
  pushHistory(state, "diagnostic", `Diagnostic designed (${out.length} questions)`);
  return ok(`Diagnostic recorded (${out.length} questions). Now present question 1 — see NEXT below.`);
}

export function recordAnswer(state: TopicState, questionId: string, level: string, evidence: string): Result {
  if (state.phase !== "diagnostic" || !state.diagnostic.questions.length) {
    return fail("no diagnostic in progress");
  }
  const asked = state.diagnostic.answers.length;
  if (asked >= state.diagnostic.total) return fail("diagnostic already complete");
  const next = state.diagnostic.questions[asked];
  if (questionId !== next.id) return fail(`next question is ${next.id} (in order); got "${questionId}"`);
  if (!LEVELS.includes(level as ConceptLevel)) return fail(`bad level "${level}" (use ${LEVELS.join("|")})`);
  if (!isStr(evidence)) return fail("evidence required: 1-2 sentences on what the learner demonstrated");
  const lv = level as ConceptLevel;
  state.diagnostic.answers.push({ questionId: next.id, concept: next.concept, level: lv, evidence, at: nowIso() });
  const existing = state.conceptMap[next.concept];
  state.conceptMap[next.concept] = {
    level: lv,
    evidence: existing ? `${existing.evidence} | ${evidence}` : evidence,
    stats: existing?.stats ?? { correct: 0, total: 0 },
    diagnosticLevel: existing?.diagnosticLevel ?? lv,
    lastTested: nowIso(),
  };
  const done = state.diagnostic.answers.length === state.diagnostic.total;
  if (done) pushHistory(state, "diagnostic_done", "Diagnostic complete; concept map ready for planning");
  return ok(done
    ? `Answer recorded for ${next.id} (${next.concept}: ${lv}). Diagnostic complete — design the lesson plan (see NEXT).`
    : `Answer recorded for ${next.id} (${next.concept}: ${lv}). ${state.diagnostic.total - state.diagnostic.answers.length} question(s) left.`);
}

// ── Plan ────────────────────────────────────────────────────────────────────

export function recordPlan(state: TopicState, units: unknown): Result {
  if (state.phase !== "diagnostic") return fail(`phase is "${state.phase}", not diagnostic`);
  if (state.diagnostic.answers.length !== state.diagnostic.total) {
    return fail(`diagnostic not complete (${state.diagnostic.answers.length}/${state.diagnostic.total})`);
  }
  if (!Array.isArray(units) || units.length < PLAN_UNITS.min || units.length > PLAN_UNITS.max) {
    return fail(`need ${PLAN_UNITS.min}-${PLAN_UNITS.max} units (got ${Array.isArray(units) ? units.length : 0})`);
  }
  const built: Unit[] = [];
  for (let u = 0; u < units.length; u++) {
    const raw = units[u] as Record<string, unknown>;
    if (!isStr(raw?.title)) return fail(`unit ${u + 1}: title required`);
    if (!Array.isArray(raw?.concepts) || raw.concepts.length === 0) return fail(`unit ${u + 1}: concepts[] required`);
    if (!Array.isArray(raw?.lessons) || raw.lessons.length < PLAN_LESSONS.min || raw.lessons.length > PLAN_LESSONS.max) {
      return fail(`unit ${u + 1}: needs ${PLAN_LESSONS.min}-${PLAN_LESSONS.max} lessons (got ${Array.isArray(raw?.lessons) ? raw.lessons.length : 0})`);
    }
    const lessons: Unit["lessons"] = [];
    for (let li = 0; li < raw.lessons.length; li++) {
      const l = raw.lessons[li] as Record<string, unknown>;
      if (!isStr(l?.title)) return fail(`unit ${u + 1} lesson ${li + 1}: title required`);
      if (!Array.isArray(l?.objectives) || l.objectives.length < 1 || l.objectives.length > 3) {
        return fail(`unit ${u + 1} lesson ${li + 1}: 1-3 objectives required`);
      }
      if (!Array.isArray(l?.concepts) || l.concepts.length === 0) return fail(`unit ${u + 1} lesson ${li + 1}: concepts[] required`);
      const checkIns = typeof l.checkIns === "number" ? l.checkIns : 1;
      if (checkIns < 0 || checkIns > 2 || !Number.isInteger(checkIns)) return fail(`unit ${u + 1} lesson ${li + 1}: checkIns must be 0-2`);
      lessons.push({
        id: `u${u + 1}l${li + 1}`,
        title: l.title.trim(),
        objectives: l.objectives.map((o) => String(o).trim()),
        concepts: l.concepts.map((c) => String(c).trim()),
        checkIns,
        status: u === 0 && li === 0 ? "active" : "pending",
        quiz: [],
      });
    }
    built.push({
      id: `u${u + 1}`,
      title: raw.title.trim(),
      concepts: raw.concepts.map((c) => String(c).trim()),
      lessons,
      checkpoint: [],
      reviewDue: false,
      reviewConcepts: [],
      done: false,
    });
  }
  state.plan.units = built;
  state.plan.generatedAt = nowIso();
  state.phase = "learning";
  pushHistory(state, "plan", `Plan created: ${built.length} units, ${built.reduce((n, u) => n + u.lessons.length, 0)} lessons`);
  return ok(`Plan recorded: ${built.map((u) => `${u.id} "${u.title}" (${u.lessons.length} lessons)`).join(" → ")}. Time to teach ${built[0].lessons[0].id} — see NEXT.`);
}

// ── Quiz generation ─────────────────────────────────────────────────────────

function validateItems(items: unknown, min: number, max: number, prefix: string): QuizItem[] | string {
  if (!Array.isArray(items) || items.length < min || items.length > max) {
    return `need ${min}-${max} items (got ${Array.isArray(items) ? items.length : 0})`;
  }
  const out: QuizItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const q = items[i] as Record<string, unknown>;
    if (!isStr(q?.concept) || !isStr(q?.prompt) || !isStr(q?.rubric)) {
      return `item ${i + 1} needs non-empty concept, prompt, rubric`;
    }
    if (!QUESTION_TYPES.includes(q.type as QuestionType)) return `item ${i + 1}: bad type "${String(q.type)}"`;
    out.push({
      id: isStr(q.id) ? q.id : `${prefix}${i + 1}`,
      concept: q.concept.trim(),
      type: q.type as QuestionType,
      prompt: q.prompt.trim(),
      rubric: q.rubric.trim(),
    });
  }
  return out;
}

function currentLessonState(state: TopicState): { unit: Unit; lesson: Unit["lessons"][number] } | undefined {
  const unit = state.plan.units[state.progress.unitIndex];
  const lesson = unit?.lessons[state.progress.lessonIndex];
  return unit && lesson && lesson.status === "active" ? { unit, lesson } : undefined;
}

export function generateQuiz(state: TopicState, kind: QuizKind, items: unknown): Result {
  const cfg =
    kind === "lesson" ? LESSON_QUIZ : kind === "checkpoint" ? CHECKPOINT_QUIZ : kind === "remediation" ? REMEDIATION_QUIZ : REVIEW_QUIZ;
  const prefix = kind === "lesson" ? "l" : kind === "checkpoint" ? "c" : kind === "remediation" ? "r" : "v";
  const validated = validateItems(items, cfg.min, cfg.max, prefix);
  if (typeof validated === "string") return fail(validated);

  const cs = currentLessonState(state);
  const unit = state.plan.units[state.progress.unitIndex];
  const allLessonsDone = !!unit && !unit.lessons.some((l) => l.status === "active" || l.status === "pending");

  if (kind === "lesson") {
    if (!cs) return fail("no active lesson — call learning_status");
    if (cs.lesson.quiz.length) return fail("lesson quiz already generated");
    cs.lesson.quiz = validated;
    return ok(`Lesson quiz ready (${validated.length} items) for ${cs.lesson.id}. Present item 1 — see NEXT.`);
  }

  if (kind === "checkpoint") {
    if (state.phase !== "learning" || !unit) return fail("no unit in progress");
    if (!allLessonsDone) return fail("lessons remain in this unit — checkpoint not due yet");
    if (unit.checkpoint.length) return fail("checkpoint already generated");
    unit.checkpoint = validated;
    return ok(`Unit checkpoint ready (${validated.length} items) for ${unit.id}. Present item 1 — see NEXT.`);
  }

  if (kind === "remediation") {
    if (!unit) return fail("no unit in progress");
    if (cs) {
      const qs = containerScore(cs.lesson.quiz);
      if (qs === undefined) return fail("lesson quiz not complete");
      if (qs >= LESSON_QUIZ.pass) return fail(`lesson quiz passed (${qs}%) — no remediation due; call advance`);
      if (cs.lesson.remediation) return fail("lesson remediation already generated");
      cs.lesson.remediation = { items: validated };
      return ok(`Lesson remediation ready (${validated.length} items) for ${cs.lesson.id}. Present item 1 — see NEXT.`);
    }
    const cps = containerScore(unit.checkpoint);
    if (!allLessonsDone || !unit.checkpoint.length || cps === undefined) return fail("checkpoint not complete");
    if (cps >= CHECKPOINT_QUIZ.pass) return fail(`checkpoint passed (${cps}%) — no remediation due; call advance`);
    if (unit.remediation) return fail("checkpoint remediation already generated");
    unit.remediation = { items: validated };
    return ok(`Checkpoint remediation ready (${validated.length} items) for ${unit.id}. Present item 1 — see NEXT.`);
  }

  // review
  if (state.phase === "complete") {
    if (state.review) return fail("topic review already in progress/done");
    state.review = { items: validated };
    return ok(`Topic review ready (${validated.length} items). Present item 1 — see NEXT.`);
  }
  if (!unit || !unit.done) return fail("unit not finished — unit review not due");
  if (!unit.reviewDue) return fail(`no unit review due for ${unit.id} (no basic concepts)`);
  if (unit.review) return fail("unit review already generated");
  unit.review = { items: validated };
  return ok(`Unit review ready (${validated.length} items) for ${unit.id}. Present item 1 — see NEXT.`);
}

// ── Grading ─────────────────────────────────────────────────────────────────

export function gradeQuiz(
  state: TopicState,
  p: { kind: QuizKind; itemId: string; score: 0 | 1; feedback: string; answerNote?: string },
): Result {
  if (!isStr(p.feedback)) return fail("feedback required — it is shown to the learner and stored as the concept's latest evidence");
  if (p.score !== 0 && p.score !== 1) return fail("score must be 0 or 1");

  // Locate the active container of the requested kind (mirrors machine.findActiveQuiz).
  let items: QuizItem[] | undefined;
  let label = "";
  let finish: (s: number) => void = () => {};

  if (state.phase === "complete") {
    if (p.kind === "review" && state.review) {
      items = state.review.items;
      label = "topic review";
      finish = (s) => {
        state.review!.score = s;
      };
    }
  } else if (state.phase === "learning") {
    const unit = state.plan.units[state.progress.unitIndex];
    if (unit) {
      if (unit.done) {
        if (p.kind === "review" && unit.review) {
          items = unit.review.items;
          label = `unit review (${unit.id})`;
          finish = (s) => {
            unit.review!.score = s;
          };
        }
      } else {
        const lesson = unit.lessons[state.progress.lessonIndex];
        if (lesson && lesson.status === "active") {
          if (p.kind === "lesson" && lesson.quiz.length) {
            items = lesson.quiz;
            label = `lesson quiz (${lesson.id})`;
            finish = (s) => {
              lesson.quizScore = s;
            };
          } else if (p.kind === "remediation" && lesson.remediation) {
            items = lesson.remediation.items;
            label = `lesson remediation (${lesson.id})`;
            finish = (s) => {
              lesson.remediation!.score = s;
            };
          }
        }
        if (!items) {
          if (p.kind === "checkpoint" && unit.checkpoint.length) {
            items = unit.checkpoint;
            label = `unit checkpoint (${unit.id})`;
            finish = (s) => {
              unit.checkpointScore = s;
            };
          } else if (p.kind === "remediation" && unit.remediation) {
            items = unit.remediation.items;
            label = `checkpoint remediation (${unit.id})`;
            finish = (s) => {
              unit.remediation!.score = s;
            };
          }
        }
      }
    }
  }

  if (!items) return fail(`no ${p.kind} quiz is in progress — call learning_status to see the current step`);
  const idx = firstUnscored(items);
  if (idx === -1) return fail(`${label} is already complete — see NEXT (usually: call advance)`);
  const item = items[idx];
  if (item.id !== p.itemId) return fail(`next item is ${item.id} (in order); got "${p.itemId}"`);

  item.score = p.score;
  item.feedback = p.feedback;
  if (p.answerNote) item.answerNote = p.answerNote;
  updateConceptAfterQuiz(state, item.concept, p.score, p.feedback);
  state.stats.answered++;
  state.stats.correct += p.score;

  const complete = firstUnscored(items) === -1;
  let tail: string;
  if (complete) {
    const s = containerScore(items)!;
    finish(s);
    state.stats.quizzesTaken++;
    pushHistory(state, `quiz_${p.kind}`, `${label} scored ${s}%`, s);
    tail = `${label} COMPLETE: ${s}%. See NEXT for what happens.`;
  } else {
    tail = `item ${idx + 1}/${items.length} recorded (${item.concept} ${p.score === 1 ? "✓" : "✗"}). Next: item ${idx + 2}.`;
  }
  return ok(tail);
}

// ── Advancing the machine ───────────────────────────────────────────────────

function completeLesson(state: TopicState, note: string, score?: number): void {
  const unit = state.plan.units[state.progress.unitIndex]!;
  const lesson = unit.lessons[state.progress.lessonIndex]!;
  lesson.status = "done";
  lesson.quizScore = containerScore(lesson.quiz);
  lesson.completedAt = nowIso();
  if (note) lesson.note = note;
  state.progress.lessonIndex++;
  const next = unit.lessons[state.progress.lessonIndex];
  if (next && next.status === "pending") next.status = "active";
  pushHistory(state, "lesson_done", `${lesson.id} "${lesson.title}" (${score ?? "?"}%)${note ? " — " + note : ""}`, score);
}

function movePointer(state: TopicState): void {
  state.progress.lessonIndex = 0;
  state.progress.unitIndex++;
  const next = state.plan.units[state.progress.unitIndex];
  if (next) {
    next.lessons[0].status = "active";
    pushHistory(state, "unit_start", `Started unit ${next.id} "${next.title}"`);
  } else {
    state.phase = "complete";
    pushHistory(state, "topic_complete", `Topic complete — ${pct(state.stats.correct, state.stats.answered)}% overall`);
  }
}

function completeUnit(state: TopicState, note: string, score?: number): void {
  const unit = state.plan.units[state.progress.unitIndex]!;
  unit.done = true;
  unit.reviewConcepts = unit.concepts.filter((c) => conceptLevel(state, c) === "basic");
  unit.reviewDue = unit.reviewConcepts.length > 0;
  pushHistory(state, "unit_done", `${unit.id} "${unit.title}" (${score ?? "?"}%)${note ? " — " + note : ""}`, score);
  if (!unit.reviewDue) movePointer(state);
}

export function advance(state: TopicState, p: { force?: boolean; note?: string }): Result {
  if (state.phase === "diagnostic") return fail("nothing to advance in the diagnostic phase");

  if (state.phase === "complete") {
    if (state.review && containerScore(state.review.items) !== undefined) {
      pushHistory(state, "topic_review", `Topic review filed (${state.review.score}%)`, state.review.score);
      state.review = undefined;
      return ok("Topic review filed. The topic stays complete — see NEXT.");
    }
    return fail("topic is complete and nothing is pending — use NEXT (a new review or a new topic)");
  }

  const unit = state.plan.units[state.progress.unitIndex];
  if (!unit) return fail("state anomaly: no current unit");

  if (unit.done) {
    // Only reachable when a unit review was due.
    if (!unit.review || containerScore(unit.review.items) === undefined) {
      return fail(`unit review not complete yet (${unit.review ? "keep presenting items" : "generate it first"})`);
    }
    movePointer(state);
    const next = state.plan.units[state.progress.unitIndex];
    return ok(
      next
        ? `Unit ${unit.id} review filed. Now in unit ${next.id} "${next.title}" — see NEXT (teach ${next.lessons[0].id}).`
        : `Unit ${unit.id} review filed — and that was the last unit. Topic complete! See NEXT.`,
    );
  }

  const lesson = unit.lessons[state.progress.lessonIndex];
  const allLessonsDone = !lesson || lesson.status !== "active";

  if (!allLessonsDone) {
    const lqs = containerScore(lesson!.quiz);
    if (lqs === undefined) return fail("lesson quiz not complete — keep presenting items");
    if (lqs >= LESSON_QUIZ.pass) {
      completeLesson(state, p.note, lqs);
    } else {
      const rem = lesson!.remediation;
      const rqs = rem ? containerScore(rem.items) : undefined;
      if (!rem) return fail(`lesson quiz ${lqs}% < ${LESSON_QUIZ.pass}%: generate a remediation quiz first (or advance with force:true to skip it, flagging concepts weak)`);
      if (rqs === undefined) return fail("remediation not complete — keep presenting items");
      if (rqs >= REMEDIATION_QUIZ.pass) completeLesson(state, `passed remediation (${rqs}%)`, lqs);
      else if (p.force) completeLesson(state, `weak: lesson ${lqs}%, remediation ${rqs}% — concepts flagged`, lqs);
      else return fail(`remediation ${rqs}% < ${REMEDIATION_QUIZ.pass}%: call advance with force:true (concepts stay flagged weak and return in reviews)`);
    }
    const nu = state.plan.units[state.progress.unitIndex];
    const nl = nu.lessons[state.progress.lessonIndex];
    if (nl && nl.status === "active") return ok(`Lesson done. Next up: ${nl.id} "${nl.title}" — see NEXT (teach it).`);
    return ok(`Lesson done. All lessons in unit ${nu.id} complete — see NEXT (generate the unit checkpoint).`);
  }

  // All lessons done → checkpoint flow.
  if (!unit.checkpoint.length) return fail("checkpoint not generated yet — see NEXT");
  const cqs = containerScore(unit.checkpoint);
  if (cqs === undefined) return fail("checkpoint not complete — keep presenting items");
  if (cqs >= CHECKPOINT_QUIZ.pass) {
    completeUnit(state, p.note, cqs);
  } else {
    const rem = unit.remediation;
    const rqs = rem ? containerScore(rem.items) : undefined;
    if (!rem) return fail(`checkpoint ${cqs}% < ${CHECKPOINT_QUIZ.pass}%: generate a remediation quiz first (or advance with force:true, flagging unit concepts weak)`);
    if (rqs === undefined) return fail("remediation not complete — keep presenting items");
    if (rqs >= REMEDIATION_QUIZ.pass) completeUnit(state, `passed remediation (${rqs}%)`, cqs);
    else if (p.force) completeUnit(state, `weak: checkpoint ${cqs}%, remediation ${rqs}% — concepts flagged`, cqs);
    else return fail(`remediation ${rqs}% < ${REMEDIATION_QUIZ.pass}%: call advance with force:true (concepts stay flagged weak and return in reviews)`);
  }
  const nu = state.plan.units[state.progress.unitIndex];
  if (nu && !nu.done && nu.lessons[0]?.status === "active") {
    return ok(`Unit ${unit.id} complete. Now in unit ${nu.id} "${nu.title}" — see NEXT (teach ${nu.lessons[0].id}).`);
  }
  if (nu && nu.done && nu.reviewDue) {
    return ok(`Unit ${unit.id} complete. Unit review is due: ${nu.reviewConcepts.join(", ")} — see NEXT.`);
  }
  return ok(state.phase === "complete" ? `Unit ${unit.id} complete — and that was the last unit. Topic complete! See NEXT.` : `Unit ${unit.id} complete — see NEXT.`);
}

// ── Skipping ────────────────────────────────────────────────────────────────

export function skipLesson(state: TopicState, reason?: string): Result {
  if (state.phase !== "learning") return fail(`phase is "${state.phase}"`);
  const cs = currentLessonState(state);
  if (!cs) return fail("no active lesson to skip");
  if (cs.lesson.quiz.length || cs.lesson.remediation) return fail("quiz already in progress — finish it, or grade the rest and advance");
  cs.lesson.status = "skipped";
  cs.lesson.note = reason?.trim() || "skipped by learner";
  state.progress.lessonIndex++;
  pushHistory(state, "lesson_skipped", `${cs.lesson.id} "${cs.lesson.title}" — ${cs.lesson.note}`);
  const nl = state.plan.units[state.progress.unitIndex].lessons[state.progress.lessonIndex];
  if (nl && nl.status === "pending") nl.status = "active";
  return ok(
    nl && nl.status === "active"
      ? `Skipped ${cs.lesson.id}. Next up: ${nl.id} "${nl.title}" — see NEXT.`
      : `Skipped ${cs.lesson.id}. All lessons in this unit are done — see NEXT (checkpoint).`,
  );
}
