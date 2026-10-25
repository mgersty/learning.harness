// Core types for the learning harness. Pure — no pi imports (testable headless).

export const QUESTION_TYPES = ["free", "choice", "code", "teachback"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const DIFFICULTIES = ["novice", "intermediate", "advanced"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export const LEVELS = ["none", "basic", "solid", "mastery"] as const;
export type ConceptLevel = (typeof LEVELS)[number];

export const LEVEL_RANK: Record<ConceptLevel, number> = {
  none: 0,
  basic: 1,
  solid: 2,
  mastery: 3,
};

export type Phase = "diagnostic" | "learning" | "complete";
export type TopicKind = "code" | "general" | "mixed";
export type QuizKind = "lesson" | "checkpoint" | "remediation" | "review";

export interface ConceptEntry {
  level: ConceptLevel;
  /** Latest assessment note (diagnostic evidence or last quiz feedback). */
  evidence: string;
  /** Graded quiz attempts on this concept. */
  stats: { correct: number; total: number };
  /** Initial LLM-judged level from the diagnostic (a prior until quiz evidence accumulates). */
  diagnosticLevel?: ConceptLevel;
  lastTested?: string;
}

export interface DiagnosticQuestion {
  id: string; // d1..d6
  concept: string;
  type: QuestionType;
  difficulty: Difficulty;
  prompt: string;
  rubric: string;
}

export interface DiagnosticAnswer {
  questionId: string;
  concept: string;
  level: ConceptLevel;
  evidence: string;
  at: string;
}

export interface QuizItem {
  id: string;
  concept: string;
  type: QuestionType;
  prompt: string;
  rubric: string;
  score?: 0 | 1;
  feedback?: string;
  answerNote?: string;
}

export interface Lesson {
  id: string; // uXlY
  title: string;
  objectives: string[];
  concepts: string[];
  checkIns: number; // formative check-ins during the lesson (unscored)
  status: "pending" | "active" | "done" | "skipped";
  quiz: QuizItem[];
  quizScore?: number;
  remediation?: { items: QuizItem[]; score?: number };
  completedAt?: string;
  note?: string;
}

export interface Unit {
  id: string; // u1..
  title: string;
  concepts: string[];
  lessons: Lesson[];
  checkpoint: QuizItem[];
  checkpointScore?: number;
  remediation?: { items: QuizItem[]; score?: number };
  reviewDue: boolean;
  reviewConcepts: string[];
  review?: { items: QuizItem[]; score?: number };
  done: boolean;
}

export interface HistoryEntry {
  at: string;
  type: string;
  note: string;
  score?: number;
}

export interface TopicState {
  topic: string; // slug
  title: string;
  kind: TopicKind;
  language?: string;
  phase: Phase;
  createdAt: string;
  updatedAt: string;
  diagnostic: {
    total: number;
    questions: DiagnosticQuestion[];
    answers: DiagnosticAnswer[];
  };
  conceptMap: Record<string, ConceptEntry>;
  plan: {
    units: Unit[];
    generatedAt?: string;
  };
  progress: {
    unitIndex: number;
    lessonIndex: number;
  };
  /** Post-completion review of weakest concepts. */
  review?: { items: QuizItem[]; score?: number };
  history: HistoryEntry[];
  stats: { quizzesTaken: number; correct: number; answered: number };
}

// ── Tunables ────────────────────────────────────────────────────────────────

export const DIAGNOSTIC_TOTAL = 6;
export const PLAN_UNITS = { min: 1, max: 6 };
export const PLAN_LESSONS = { min: 2, max: 4 };
export const LESSON_QUIZ = { min: 3, max: 5, pass: 70 };
export const CHECKPOINT_QUIZ = { min: 5, max: 8, pass: 80 };
export const REMEDIATION_QUIZ = { min: 2, max: 4, pass: 50 };
export const REVIEW_QUIZ = { min: 3, max: 5 };
