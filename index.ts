// learning-harness — pi extension entrypoint.
// Registers the learning tools, /learn + /learning commands, and a session note.
// All state logic lives in ./src (pure, testable headless).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { matchesKey } from "@earendil-works/pi-tui";
import {
  deleteTopic,
  findTopic,
  listTopics,
  loadTopicBySlug,
  newTopicState,
  saveTopic,
} from "./src/store.ts";
import { shortProgress, topicSummary } from "./src/machine.ts";
import * as rec from "./src/record.ts";
import { dashboardText } from "./src/render.ts";

// ── Schemas ─────────────────────────────────────────────────────────────────

const QType = Type.Union([
  Type.Literal("free"),
  Type.Literal("choice"),
  Type.Literal("code"),
  Type.Literal("teachback"),
]);
const Difficulty = Type.Union([
  Type.Literal("novice"),
  Type.Literal("intermediate"),
  Type.Literal("advanced"),
]);
const Level = Type.Union([
  Type.Literal("none"),
  Type.Literal("basic"),
  Type.Literal("solid"),
  Type.Literal("mastery"),
]);
const QuizKind = Type.Union([
  Type.Literal("lesson"),
  Type.Literal("checkpoint"),
  Type.Literal("remediation"),
  Type.Literal("review"),
]);

const DiagnosticQuestionSchema = Type.Object({
  concept: Type.String({ description: "Short name of the concept this question probes (6 different concepts)" }),
  type: QType,
  difficulty: Difficulty,
  prompt: Type.String({ description: "Full question text (include lettered options for choice)" }),
  rubric: Type.String({ description: "What a strong answer contains / what to check" }),
  id: Type.Optional(Type.String()),
});

const QuizItemSchema = Type.Object({
  concept: Type.String(),
  type: QType,
  prompt: Type.String({ description: "Full question text (include lettered options for choice)" }),
  rubric: Type.String({ description: "What a correct answer must show" }),
  id: Type.Optional(Type.String()),
});

const LessonSchema = Type.Object({
  title: Type.String(),
  objectives: Type.Array(Type.String(), { minItems: 1, maxItems: 3 }),
  concepts: Type.Array(Type.String(), { minItems: 1 }),
  checkIns: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
});

const UnitSchema = Type.Object({
  title: Type.String(),
  concepts: Type.Array(Type.String(), { minItems: 1 }),
  lessons: Type.Array(LessonSchema, { minItems: 2, maxItems: 4 }),
});

const RecordAction = Type.Union([
  Type.Literal("record_diagnostic"),
  Type.Literal("record_answer"),
  Type.Literal("record_plan"),
  Type.Literal("generate_quiz"),
  Type.Literal("grade_quiz"),
  Type.Literal("advance"),
  Type.Literal("skip_lesson"),
]);

// ── Tool logic ──────────────────────────────────────────────────────────────

function runStatus(p: { topic?: string }): string {
  const topics = listTopics();
  if (!p.topic) {
    if (!topics.length) {
      return 'No learning topics yet. When the user says what they want to learn, call learning_start {title, kind, language?} (kind: "code" | "general" | "mixed").';
    }
    return (
      dashboardText(topics) +
      '\n\nCall learning_status {topic:"<slug or title>"} for full state + the exact NEXT step of one topic.'
    );
  }
  const st = findTopic(p.topic);
  if (!st) {
    const names = topics.map((t) => `"${t.title}" (${t.topic})`).join(", ") || "none";
    return `No topic matching "${p.topic}". Existing topics: ${names}. If this is a new topic, call learning_start.`;
  }
  return topicSummary(st);
}

function runStart(p: { title: string; kind: string; language?: string }): string {
  if (!p.title?.trim()) return "Error: title required.";
  if (!["code", "general", "mixed"].includes(p.kind)) return 'Error: kind must be "code", "general", or "mixed".';
  const st = newTopicState(p.title, p.kind as "code" | "general" | "mixed", p.language?.trim() || undefined);
  const existing = loadTopicBySlug(st.topic);
  if (existing) {
    return `Topic already exists: "${existing.title}" (${existing.topic}). Resuming.\n\n${topicSummary(existing)}`;
  }
  saveTopic(st);
  return `Started new topic "${st.title}" (${st.topic}).\n\n${topicSummary(st)}`;
}

function runRecord(p: {
  topic: string;
  action: string;
  questions?: unknown;
  questionId?: string;
  level?: string;
  evidence?: string;
  units?: unknown;
  kind?: string;
  items?: unknown;
  itemId?: string;
  score?: 0 | 1;
  feedback?: string;
  answerNote?: string;
  force?: boolean;
  note?: string;
  reason?: string;
}): string {
  const st = findTopic(p.topic);
  if (!st) {
    const names = listTopics()
      .map((t) => `"${t.title}" (${t.topic})`)
      .join(", ") || "none";
    return `No topic matching "${p.topic}". Existing: ${names}.`;
  }
  let res: rec.Result;
  switch (p.action) {
    case "record_diagnostic":
      res = rec.recordDiagnostic(st, p.questions);
      break;
    case "record_answer":
      res = rec.recordAnswer(st, p.questionId ?? "", p.level ?? "", p.evidence ?? "");
      break;
    case "record_plan":
      res = rec.recordPlan(st, p.units);
      break;
    case "generate_quiz":
      if (!p.kind || !["lesson", "checkpoint", "remediation", "review"].includes(p.kind)) {
        res = { ok: false, text: "", error: `generate_quiz needs kind: lesson|checkpoint|remediation|review` };
      } else {
        res = rec.generateQuiz(st, p.kind as "lesson" | "checkpoint" | "remediation" | "review", p.items);
      }
      break;
    case "grade_quiz":
      if (!p.kind || !["lesson", "checkpoint", "remediation", "review"].includes(p.kind)) {
        res = { ok: false, text: "", error: `grade_quiz needs kind: lesson|checkpoint|remediation|review` };
      } else {
        res = rec.gradeQuiz(st, {
          kind: p.kind as "lesson" | "checkpoint" | "remediation" | "review",
          itemId: p.itemId ?? "",
          score: p.score ?? 0,
          feedback: p.feedback ?? "",
          answerNote: p.answerNote,
        });
      }
      break;
    case "advance":
      res = rec.advance(st, { force: !!p.force, note: p.note });
      break;
    case "skip_lesson":
      res = rec.skipLesson(st, p.reason);
      break;
    default:
      return `Unknown action "${p.action}". Valid: record_diagnostic, record_answer, record_plan, generate_quiz, grade_quiz, advance, skip_lesson.`;
  }
  if (res.ok) {
    st.updatedAt = new Date().toISOString();
    saveTopic(st);
    return `${res.text}\n\n${topicSummary(st)}`;
  }
  return `BLOCKED — ${res.error}\n\n${topicSummary(st)}`;
}

function runForget(p: { topic: string; confirm: boolean }): string {
  if (!p.confirm) {
    return 'Refusing: pass confirm:true. First ask the user explicitly — deleting removes ALL progress for the topic (diagnostic, plan, quiz history).';
  }
  const st = findTopic(p.topic);
  if (!st) return `No topic matching "${p.topic}" to delete.`;
  deleteTopic(st.topic);
  return `Deleted topic "${st.title}" (${st.topic}). All of its data is gone.`;
}

// ── Tool result helper ──────────────────────────────────────────────────────

function toolResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    details: {},
    ...(isError ? { isError: true } : {}),
  };
}

function guard(fn: () => string) {
  try {
    return toolResult(fn());
  } catch (e) {
    return toolResult(`learning harness error: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

// ── Extension ───────────────────────────────────────────────────────────────

export default function learningHarness(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    try {
      const active = listTopics().filter((t) => t.phase !== "complete");
      if (active.length) {
        ctx.ui.notify(
          `Learning in progress: ${active.map((t) => `${t.title} — ${shortProgress(t)}`).join(" · ")}. Use /learn <topic> to continue.`,
          "info",
        );
      }
    } catch {
      // never break session start
    }
  });

  pi.registerTool({
    name: "learning_status",
    label: "Learning Status",
    description:
      "Learning harness — READ state and get the exact next step. ALWAYS call this first when the user wants to learn, continue, or resume a topic: it returns the topic's phase, concept map, and a NEXT instruction telling you precisely what to do (design the diagnostic, present a specific question, teach a lesson, generate a quiz, grade, or advance). Without a topic argument, lists all topics.",
    parameters: Type.Object({
      topic: Type.Optional(Type.String({ description: "Topic slug or title. Omit to list all topics." })),
    }),
    execute: (_id, params) => guard(() => runStatus(params)),
  });

  pi.registerTool({
    name: "learning_start",
    label: "Learning Start",
    description:
      "Learning harness — start a NEW learning topic (or resume an existing one). Call when the user wants to learn something. Returns the full state + the first NEXT instruction (design the diagnostic). kind: 'code' for programming topics (set language, e.g. 'typescript'), 'general', or 'mixed'.",
    parameters: Type.Object({
      title: Type.String({ description: "Human name of the topic, e.g. 'Closures in JavaScript'" }),
      kind: Type.Union([Type.Literal("code"), Type.Literal("general"), Type.Literal("mixed")]),
      language: Type.Optional(Type.String({ description: "For code topics: the language, e.g. 'python'" })),
    }),
    execute: (_id, params) => guard(() => runStart(params)),
  });

  pi.registerTool({
    name: "learning_record",
    label: "Learning Record",
    description:
      "Learning harness — WRITE state. Only call with the action learning_status's NEXT instruction names. Actions: record_diagnostic (6 questions, once), record_answer (grade ONE diagnostic answer, in order), record_plan (units/lessons, once), generate_quiz (items for lesson|checkpoint|remediation|review), grade_quiz (score ONE quiz item 0/1 + feedback, in order), advance (move on after a finished quiz or review; force:true only when NEXT says so), skip_lesson (learner skips the current lesson).",
    parameters: Type.Object({
      topic: Type.String({ description: "Topic slug or title" }),
      action: RecordAction,
      questions: Type.Optional(Type.Array(DiagnosticQuestionSchema, { minItems: 6, maxItems: 6 }), {
        description: "for record_diagnostic",
      }),
      questionId: Type.Optional(Type.String({ description: "for record_answer" })),
      level: Type.Optional(Level, { description: "for record_answer" }),
      evidence: Type.Optional(Type.String({ description: "for record_answer: 1-2 sentences on what the learner demonstrated" })),
      units: Type.Optional(Type.Array(UnitSchema, { minItems: 1, maxItems: 6 }), { description: "for record_plan" }),
      kind: Type.Optional(QuizKind, { description: "for generate_quiz / grade_quiz" }),
      items: Type.Optional(Type.Array(QuizItemSchema), { description: "for generate_quiz" }),
      itemId: Type.Optional(Type.String({ description: "for grade_quiz" })),
      score: Type.Optional(Type.Union([Type.Literal(0), Type.Literal(1)]), { description: "for grade_quiz" }),
      feedback: Type.Optional(Type.String({ description: "for grade_quiz: feedback shown to the learner" })),
      answerNote: Type.Optional(Type.String({ description: "for grade_quiz: brief note of what they answered" })),
      force: Type.Optional(Type.Boolean({ description: "for advance: only when NEXT explicitly says force:true" })),
      note: Type.Optional(Type.String({ description: "for advance: short note stored with the transition" })),
      reason: Type.Optional(Type.String({ description: "for skip_lesson" })),
    }),
    execute: (_id, params) => guard(() => runRecord(params as Parameters<typeof runRecord>[0])),
  });

  pi.registerTool({
    name: "learning_forget",
    label: "Learning Forget",
    description:
      "Learning harness — DELETE a topic and all its data (diagnostic, plan, quiz history). Only call after the user explicitly agrees to delete. Requires confirm:true.",
    parameters: Type.Object({
      topic: Type.String({ description: "Topic slug or title" }),
      confirm: Type.Boolean({ description: "Must be true; implies the user explicitly agreed" }),
    }),
    execute: (_id, params) => guard(() => runForget(params)),
  });

  // ── Commands ──

  const kickoff = (slug: string, resuming: boolean): void => {
    const st = loadTopicBySlug(slug);
    if (!st) return;
    pi.sendUserMessage(
      `Learning harness: ${resuming ? "resuming" : "starting"} topic "${st.title}" (${st.topic}). ` +
        `Call learning_status {topic:"${st.topic}"} and follow its NEXT instructions exactly. ` +
        `Be the tutor: teach in chat, ask questions ONE at a time and wait for answers, grade honestly against rubrics, give immediate feedback, and keep the harness state updated with learning_record as instructed.`,
    );
  };

  pi.registerCommand("learn", {
    description: "Start or resume a learning topic: /learn [topic]",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim();
      if (!arg) {
        const active = listTopics().filter((t) => t.phase !== "complete");
        if (active.length === 1) {
          kickoff(active[0].topic, true);
          return;
        }
        if (active.length > 1) {
          ctx.ui.notify(
            `Active topics: ${active.map((t) => `"${t.title}" (${t.topic})`).join(", ")} — use /learn <topic>`,
            "warning",
          );
          return;
        }
        ctx.ui.notify("Usage: /learn <what you want to learn> — e.g. /learn closures", "info");
        return;
      }
      const st = findTopic(arg);
      if (st) {
        kickoff(st.topic, true);
        return;
      }
      pi.sendUserMessage(
        `The user wants to learn: "${arg}". This is a NEW learning topic. ` +
          `If it is clearly a programming topic, call learning_start {title:"${arg}", kind:"code", language:"<language>"} now; for non-code use kind:"general" (or "mixed"). ` +
          `If code-vs-general is genuinely ambiguous, ask ONE quick clarifying question first. ` +
          `Then follow the learning_status NEXT instructions.`,
      );
      ctx.ui.notify("Starting learning session — setting up the diagnostic.", "info");
    },
  });

  pi.registerCommand("learning", {
    description: "Show all learning topics and progress",
    handler: async (_args, ctx) => {
      const topics = listTopics();
      const text = topics.length
        ? dashboardText(topics) + "\n\n/learn <topic> to start or resume."
        : "No learning topics yet. Start one with: /learn <topic>";
      if (ctx.mode === "tui") {
        await ctx.ui.custom<void>((_tui, _theme, _kb, done) => new DashboardComponent(text, () => done()));
      } else {
        ctx.ui.notify(text, "info");
      }
    },
  });
}

// Minimal read-only TUI panel for /learning.
class DashboardComponent {
  private lines: string[];
  private onClose: () => void;
  private cached?: string[];
  private cachedWidth = -1;

  constructor(text: string, onClose: () => void) {
    this.lines = text.split("\n");
    this.onClose = onClose;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "enter")) this.onClose();
  }

  render(width: number): string[] {
    if (this.cached && this.cachedWidth === width) return this.cached;
    const out: string[] = [];
    out.push(`┌ ${"Learning".padEnd(Math.max(0, width - 4))} ┐`.slice(0, width));
    for (const line of this.lines) {
      out.push(`│ ${line.padEnd(Math.max(0, width - 4))}`.slice(0, width));
    }
    out.push(`│ ${"Esc to close".padEnd(Math.max(0, width - 4))}`.slice(0, width));
    out.push(`└${"─".repeat(Math.max(0, width - 2))}┘`);
    this.cached = out;
    this.cachedWidth = width;
    return out;
  }

  invalidate(): void {
    this.cached = undefined;
  }
}
