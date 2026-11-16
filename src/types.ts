export type Subject = '数学' | '英语' | '物理' | '化学' | '语文';

export const ALL_SUBJECTS: Subject[] = ['数学', '英语', '物理', '化学', '语文'];

export type HomeworkLoad = '轻松' | '适中' | '较重';
export type FatigueLevel = '低' | '中' | '高';

export type ErrorType =
  | '知识问题'
  | '方法问题'
  | '计算问题'
  | '熟练度问题'
  | '审题问题';

export type ConfidenceLevel = '确定' | '较可能' | '待验证';

export type MasteryState =
  | '未诊断'
  | '待学习'
  | '学习中'
  | '初步掌握'
  | '掌握'
  | '稳定掌握';

export type TeachingBehavior = '诊断' | '讲解' | '示范' | '引导' | '评测';

export type PracticeMode =
  | '诊断微测'
  | '基础练习'
  | '变式训练'
  | '迁移应用'
  | '延迟复测';

export type QuestionLevel = '基础题' | '变式题' | '迁移题' | '延迟复测';

export interface Student {
  id: string;
  name: string;
  grade: '初三';
  region: '上海';
  targetExamDate: string; // YYYY-MM-DD
  targetSchool: string;
  dailyBudgetMinutes: number;
  homeworkLoad: HomeworkLoad;
  fatigueLevel: FatigueLevel;
}

export interface Exam {
  id: string;
  title: string;
  type: '期中考试' | '月考' | '一模' | '二模' | '随堂诊断';
  date: string;
}

export interface ExamResult {
  id: string;
  examId: string;
  examTitle: string;
  subject: Subject;
  score: number;
  fullScore: number;
  targetScore: number;
  date: string;
}

export interface ExamPaper {
  id: string;
  examId: string;
  subject: Subject;
  title: string;
  date: string;
  imageUrl?: string;
  sourceFormat?: '试卷拍照' | '文本试卷' | '单题录入';
  status: '已识别' | '待校验';
  totalLostScore: number;
  questionsCount: number;
  summary: string;
}

export interface KnowledgePoint {
  id: string;
  subject: Subject;
  chapter: string;
  domain: string;
  name: string;
  subSkills: string[];
  definition: string;
  prerequisites: string[]; // knowledgeId[]
  commonExamForms: string[];
  commonTraps: string[];
  examWeight: number; // 0.6 - 1.5 exam frequency & weight
  learningCostHours: number; // estimated hours to close gap
}

export interface Question {
  id: string;
  region: '上海';
  grade: '初三';
  subject: Subject;
  questionType: '选择' | '填空' | '解答' | '实验' | '词汇语法';
  level: QuestionLevel;
  stem: string;
  options?: string[];
  standardAnswer: string;
  scoreValue: number;
  difficulty: 1 | 2 | 3 | 4 | 5;
  solutionSteps: string[];
  commonErrors: string[];
  knowledgeIds: string[];
}

export interface QuestionKnowledge {
  questionId: string;
  knowledgeId: string;
  weight: number;
}

export interface ErrorRecord {
  id: string;
  examId?: string;
  examPaperId?: string;
  examTitle: string;
  questionNumber: string;
  subject: Subject;
  stem: string;
  studentAnswer: string;
  correctAnswer: string;
  scoreLost: number;
  errorType: ErrorType;
  knowledgeId: string;
  knowledgeName: string;
  aiAnalysis: string;
  evidence: string;
  confidence: ConfidenceLevel;
  verificationMethod: string;
  status: '未订正' | '已订正' | '待复测' | '已闭环';
  correctionNote?: string;
  createdAt: string;
}

export interface MasteryRecord {
  knowledgeId: string;
  state: MasteryState;
  confidence: ConfidenceLevel;
  lostScoreEvidence: number;
  recoveryProbability: number; // 0.1 - 0.95
  evidenceLogs: string[];
  consecutiveErrors: number;
  practiceCorrect: number;
  practiceTotal: number;
  variantPassed: boolean;
  delayedRetestPassed: boolean;
  preliminaryMasteredAt?: string;
  nextRetestAvailableAt?: string;
  updatedAt: string;
}

export interface PriorityOpportunity {
  knowledgeId: string;
  subject: Subject;
  knowledgeName: string;
  domain: string;
  lostScore: number;
  recoveryProbability: number;
  expectedGain: number;
  learningCostHours: number;
  confidenceScore: number;
  confidenceLabel: ConfidenceLevel;
  examWeight: number;
  priorityScore: number;
  priorityTier: '高' | '中' | '低';
  blockedByPrerequisite?: string;
  rationale: string;
}

export interface TaskStep {
  label: string;
  minutes: number;
  done: boolean;
}

export interface LearningTask {
  id: string;
  dayIndex: number; // 0 = Today, 1..6 = Next 6 days
  dayLabel: string;
  subject: Subject;
  knowledgeId: string;
  knowledgeName: string;
  title: string;
  objective: string;
  verifiableOutcome: string;
  estimatedMinutes: number;
  steps: TaskStep[];
  status: '待开始' | '进行中' | '已完成' | '已重排';
  priorityRank: number;
  difficultyAdjusted?: boolean;
  carriedOverFromToday?: boolean;
}

export interface DailySchedule {
  dayIndex: number;
  dayLabel: string;
  totalMinutes: number;
  tasks: LearningTask[];
}

export interface LearningPlan {
  id: string;
  weekLabel: string;
  effectiveDailyBudget: number;
  generatedAt: string;
  priorities: PriorityOpportunity[];
  days: DailySchedule[];
}

export interface LearningAttempt {
  id: string;
  taskId?: string;
  knowledgeId: string;
  subject: Subject;
  mode: PracticeMode;
  questionStem: string;
  userAnswer: string;
  isCorrect: boolean;
  hintsUsed: number;
  timeSpentSeconds: number;
  independent: boolean;
  aiFeedback: string;
  timestamp: string;
}

export interface VariantQuestion {
  id: string;
  sourceErrorId?: string;
  knowledgeId: string;
  subject: Subject;
  level: QuestionLevel;
  stem: string;
  options?: string[];
  standardAnswer: string;
  solutionSteps: string[];
  commonTrap: string;
  source?: '教研题库' | 'AI变式';
  dualVerified?: boolean;
  verificationCheck?: string;
  completed?: boolean;
  passed?: boolean;
}

export interface CoachMessage {
  id: string;
  role: 'coach' | 'user';
  text: string;
  behavior?: TeachingBehavior;
}

export interface MasteryTransitionEvent {
  id: string;
  knowledgeId: string;
  subject: Subject;
  fromState: MasteryState;
  toState: MasteryState;
  trigger: string;
  timestamp: string;
}

export type AppPage = 'today' | 'diagnosis' | 'planning' | 'coach' | 'report';

export interface AppState {
  student: Student;
  exams: Exam[];
  examResults: ExamResult[];
  examPapers: ExamPaper[];
  errorRecords: ErrorRecord[];
  masteryRecords: Record<string, MasteryRecord>;
  masteryHistory: MasteryTransitionEvent[];
  learningAttempts: LearningAttempt[];
  variantQuestions: VariantQuestion[];
  completedTaskIds: string[];
  deferredKnowledgeIds: string[];
  coachHistoryByKnowledge: Record<string, CoachMessage[]>;
  taskProgressByKnowledge: Record<string, {
    reviewedConcept?: boolean;
    viewedExample?: boolean;
    practiceSolvedCount: number;
    reviewedFeedback?: boolean;
  }>;
}
