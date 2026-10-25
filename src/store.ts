// File storage for topic state. Pure — no pi imports (testable headless).
// State root: $LEARNING_HARNESS_HOME or ~/.pi/learning/<topic-slug>/

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TopicKind, TopicState } from "./types.ts";
import { DIAGNOSTIC_TOTAL } from "./types.ts";
import { renderDiagnosticsMd, renderPlanMd } from "./render.ts";

export function nowIso(): string {
  return new Date().toISOString();
}

export function learningRoot(): string {
  return process.env.LEARNING_HARNESS_HOME ?? join(homedir(), ".pi", "learning");
}

export function slugify(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return s || "topic";
}

export function topicDir(slug: string): string {
  return join(learningRoot(), slug);
}

export function newTopicState(title: string, kind: TopicKind, language?: string): TopicState {
  const t = nowIso();
  return {
    topic: slugify(title),
    title: title.trim(),
    kind,
    language,
    phase: "diagnostic",
    createdAt: t,
    updatedAt: t,
    diagnostic: { total: DIAGNOSTIC_TOTAL, questions: [], answers: [] },
    conceptMap: {},
    plan: { units: [] },
    progress: { unitIndex: 0, lessonIndex: 0 },
    history: [{ at: t, type: "start", note: `Topic started (${kind}${language ? ", " + language : ""})` }],
    stats: { quizzesTaken: 0, correct: 0, answered: 0 },
  };
}

export function loadTopicBySlug(slug: string): TopicState | undefined {
  const p = join(topicDir(slug), "state.json");
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as TopicState;
  } catch {
    return undefined;
  }
}

export function listTopics(): TopicState[] {
  const root = learningRoot();
  if (!existsSync(root)) return [];
  const out: TopicState[] = [];
  for (const name of readdirSync(root)) {
    const t = loadTopicBySlug(name);
    if (t) out.push(t);
  }
  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return out;
}

/** Find a topic by slug, title, or substring of either (case-insensitive). */
export function findTopic(ref: string): TopicState | undefined {
  const q = ref.trim().toLowerCase();
  if (!q) return undefined;
  const topics = listTopics();
  return (
    topics.find((t) => t.topic === q) ??
    topics.find((t) => t.title.toLowerCase() === q) ??
    topics.find((t) => t.topic.includes(q) || t.title.toLowerCase().includes(q))
  );
}

export function saveTopic(state: TopicState): void {
  const dir = topicDir(state.topic);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, "state.json.tmp");
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, join(dir, "state.json"));
  // Keep human-readable views in sync (best-effort; state.json is the truth).
  try {
    writeFileSync(join(dir, "plan.md"), renderPlanMd(state));
    writeFileSync(join(dir, "diagnostics.md"), renderDiagnosticsMd(state));
  } catch {
    // rendering is cosmetic
  }
}

export function deleteTopic(slug: string): void {
  rmSync(topicDir(slug), { recursive: true, force: true });
}
