// Human-readable views of state (plan.md, diagnostics.md, dashboard).
// Pure — no pi imports.

import type { TopicState, Unit } from "./types.ts";
import { LESSON_QUIZ, CHECKPOINT_QUIZ } from "./types.ts";
import { pct, shortProgress } from "./machine.ts";

function mark(u: Unit, i: number, state: TopicState): string {
  if (u.done) return "✓";
  if (i === state.progress.unitIndex) return "▸";
  return "○";
}

export function renderPlanMd(state: TopicState): string {
  const lines: string[] = [];
  lines.push(`# Learning plan: ${state.title}`);
  lines.push("");
  lines.push(`- **Kind:** ${state.kind}${state.language ? ` (${state.language})` : ""}`);
  lines.push(`- **Created:** ${state.createdAt.slice(0, 10)}`);
  lines.push(`- **Phase:** ${state.phase}`);
  lines.push(`- **Progress:** ${shortProgress(state)}`);
  if (state.stats.answered > 0) {
    lines.push(`- **Quiz accuracy:** ${pct(state.stats.correct, state.stats.answered)}% (${state.stats.correct}/${state.stats.answered})`);
  }
  lines.push("");

  const entries = Object.entries(state.conceptMap).sort((a, b) => a[0].localeCompare(b[0]));
  if (entries.length) {
    lines.push("## Concept map");
    lines.push("");
    lines.push("| Concept | Level | Quizzes | Evidence |");
    lines.push("|---|---|---|---|");
    for (const [c, e] of entries) {
      const ev = e.evidence.replace(/\|/g, "/").replace(/\n/g, " ").slice(0, 160);
      lines.push(`| ${c} | ${e.level} | ${e.stats.correct}/${e.stats.total} | ${ev} |`);
    }
    lines.push("");
  }

  state.plan.units.forEach((u, i) => {
    lines.push(`## ${mark(u, i, state)} Unit ${i + 1}: ${u.title} ${u.done ? "(done)" : i === state.progress.unitIndex && state.phase === "learning" ? "(in progress)" : ""}`);
    lines.push("");
    lines.push(`Concepts: ${u.concepts.join(", ")}`);
    lines.push("");
    for (const l of u.lessons) {
      const sym = l.status === "done" ? "[x]" : l.status === "skipped" ? "[-]" : "[ ]";
      const score = l.quizScore !== undefined ? ` — quiz ${l.quizScore}%` : "";
      const note = l.note ? ` _(${l.note})_` : "";
      lines.push(`- ${sym} **${l.id} ${l.title}**${score}${note}`);
      for (const o of l.objectives) lines.push(`    - ${o}`);
    }
    lines.push("");
    if (state.phase === "learning" || u.done || u.checkpoint.length) {
      const cs =
        u.checkpointScore !== undefined
          ? `${u.checkpointScore}% (${u.checkpointScore >= CHECKPOINT_QUIZ.pass ? "passed" : "failed"})`
          : u.checkpoint.length
            ? `in progress (${u.checkpoint.filter((q) => q.score !== undefined).length}/${u.checkpoint.length})`
            : "pending";
      lines.push(`**Checkpoint:** ${cs}`);
      if (u.remediation) {
        const rs = u.remediation.score !== undefined ? ` — ${u.remediation.score}%` : "";
        lines.push(`**Remediation:** ${u.remediation.items.length} items${rs}`);
      }
      if (u.reviewDue) {
        const rv = u.review
          ? u.review.score !== undefined
            ? `${u.review.score}%`
            : `in progress (${u.review.items.filter((q) => q.score !== undefined).length}/${u.review.items.length})`
          : "due";
        lines.push(`**Review:** ${rv} — ${u.reviewConcepts.join(", ")}`);
      }
    }
    lines.push("");
  });

  if (state.phase === "complete") {
    lines.push("## ✅ Complete");
    lines.push("");
    lines.push(`Finished. Overall quiz accuracy: ${pct(state.stats.correct, state.stats.answered)}%.`);
  }
  return lines.join("\n");
}

export function renderDiagnosticsMd(state: TopicState): string {
  const lines: string[] = [];
  lines.push(`# Diagnostic: ${state.title}`);
  lines.push("");
  if (!state.diagnostic.questions.length) {
    lines.push("Diagnostic not designed yet.");
    return lines.join("\n");
  }
  lines.push("| # | Concept | Type | Difficulty | Level | Evidence |");
  lines.push("|---|---|---|---|---|---|");
  state.diagnostic.questions.forEach((q, i) => {
    const a = state.diagnostic.answers.find((x) => x.questionId === q.id);
    const ev = (a?.evidence ?? "(not asked yet)").replace(/\|/g, "/").replace(/\n/g, " ");
    lines.push(`| ${i + 1} | ${q.concept} | ${q.type} | ${q.difficulty} | ${a?.level ?? "—"} | ${ev} |`);
  });
  lines.push("");
  lines.push("## Questions");
  lines.push("");
  for (const q of state.diagnostic.questions) {
    lines.push(`**${q.id}.** (${q.concept}, ${q.difficulty}) ${q.prompt}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function dashboardText(topics: TopicState[]): string {
  const lines: string[] = ["Learning topics:"];
  for (const t of topics) {
    const status =
      t.phase === "diagnostic"
        ? `diagnostic ${t.diagnostic.answers.length}/${t.diagnostic.total}`
        : t.phase === "complete"
          ? "complete ✓"
          : shortProgress(t);
    const acc = t.stats.answered ? ` · ${pct(t.stats.correct, t.stats.answered)}%` : "";
    lines.push(`• ${t.title} (${t.topic}) — ${status}${acc}`);
  }
  return lines.join("\n");
}

export { LESSON_QUIZ };
