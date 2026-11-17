/**
 * AI 响应 schema 定义。
 *
 * 与原 server.ts 中的 responseSchema 逐字等价，保证行为零变化。
 */
import type { AIJsonSchema } from './provider.ts';

/**
 * 受控词表（规格 §模块01 §2 / §三）。
 *
 * 这些是**规格定义的枚举**，不允许模型自由发挥：
 * - 五维错因（§模块01 §2）
 * - 置信度（§模块01 §2：确定 / 较可能 / 待验证）
 * - 教学行为（§模块04）
 *
 * 之前它们只靠 prompt 文字约束，schema 层没有约束，
 * 于是模型返回别的值时服务端照样落库 —— 规格 §7.1「证据与置信度完整率 100%」
 * 与「错因五维受控」都无法保证。
 */
const ERROR_TYPE_VALUES = [
  '知识问题',
  '方法问题',
  '计算问题',
  '熟练度问题',
  '审题问题',
];

const CONFIDENCE_VALUES = ['确定', '较可能', '待验证'];

const TEACHING_BEHAVIOR_VALUES = ['诊断', '讲解', '示范', '引导', '评测'];

export const DIAGNOSIS_SCHEMA: AIJsonSchema = {
  type: 'OBJECT',
  properties: {
    detectedMetadata: {
      type: 'OBJECT',
      properties: {
        subject: { type: 'STRING' },
        examTitle: { type: 'STRING' },
        examType: { type: 'STRING' },
        examDate: { type: 'STRING' },
        score: { type: 'NUMBER' },
        fullScore: { type: 'NUMBER' },
        metadataConfidence: { type: 'STRING', enum: CONFIDENCE_VALUES },
      },
      required: [
        'subject',
        'examTitle',
        'examType',
        'examDate',
        'score',
        'fullScore',
        'metadataConfidence',
      ],
    },
    paperSummary: { type: 'STRING' },
    questionsDetectedCount: { type: 'NUMBER' },
    totalLostScore: { type: 'NUMBER' },
    diagnosedItems: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          questionNumber: { type: 'STRING' },
          stem: { type: 'STRING' },
          studentAnswer: { type: 'STRING' },
          correctAnswer: { type: 'STRING' },
          scoreLost: { type: 'NUMBER' },
          knowledgeId: { type: 'STRING' },
          errorType: { type: 'STRING', enum: ERROR_TYPE_VALUES },
          aiAnalysis: { type: 'STRING' },
          evidence: { type: 'STRING' },
          confidence: { type: 'STRING', enum: CONFIDENCE_VALUES },
          verificationMethod: { type: 'STRING' },
        },
        required: [
          'questionNumber',
          'stem',
          'studentAnswer',
          'correctAnswer',
          'scoreLost',
          'knowledgeId',
          'errorType',
          'aiAnalysis',
          'evidence',
          'confidence',
          'verificationMethod',
        ],
      },
    },
  },
  required: [
    'detectedMetadata',
    'paperSummary',
    'questionsDetectedCount',
    'totalLostScore',
    'diagnosedItems',
  ],
};

export const COACH_SCHEMA: AIJsonSchema = {
  type: 'OBJECT',
  properties: {
    reply: { type: 'STRING' },
    teachingBehaviorUsed: { type: 'STRING', enum: TEACHING_BEHAVIOR_VALUES },
    nextStage: { type: 'NUMBER' },
    detectedUnderstanding: { type: 'STRING' },
    suggestedQuickReplies: {
      type: 'ARRAY',
      items: { type: 'STRING' },
    },
  },
  required: [
    'reply',
    'teachingBehaviorUsed',
    'nextStage',
    'detectedUnderstanding',
    'suggestedQuickReplies',
  ],
};

export const PRACTICE_GENERATE_SCHEMA: AIJsonSchema = {
  type: 'OBJECT',
  properties: {
    stem: { type: 'STRING' },
    questionType: { type: 'STRING' },
    options: {
      type: 'ARRAY',
      items: { type: 'STRING' },
    },
    standardAnswer: { type: 'STRING' },
    solutionSteps: {
      type: 'ARRAY',
      items: { type: 'STRING' },
    },
    commonTrap: { type: 'STRING' },
  },
  required: [
    'stem',
    'questionType',
    'options',
    'standardAnswer',
    'solutionSteps',
    'commonTrap',
  ],
};

export const PRACTICE_VERIFY_SCHEMA: AIJsonSchema = {
  type: 'OBJECT',
  properties: {
    independentAnswer: { type: 'STRING' },
    isConsistent: { type: 'BOOLEAN' },
    verificationCheck: { type: 'STRING' },
  },
  required: ['independentAnswer', 'isConsistent', 'verificationCheck'],
};

export const PRACTICE_EVALUATE_SCHEMA: AIJsonSchema = {
  type: 'OBJECT',
  properties: {
    isCorrect: { type: 'BOOLEAN' },
    errorType: { type: 'STRING', enum: ERROR_TYPE_VALUES },
    feedback: { type: 'STRING' },
    stepHint: { type: 'STRING' },
    nextRecommendation: { type: 'STRING' },
  },
  required: ['isCorrect', 'errorType', 'feedback', 'stepHint', 'nextRecommendation'],
};

export const MICROQUIZ_SCHEMA: AIJsonSchema = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      knowledgeId: { type: 'STRING' },
      subject: { type: 'STRING' },
      question: { type: 'STRING' },
      options: {
        type: 'ARRAY',
        items: { type: 'STRING' },
      },
      correctIndex: { type: 'NUMBER' },
      explanation: { type: 'STRING' },
    },
    required: [
      'knowledgeId',
      'subject',
      'question',
      'options',
      'correctIndex',
      'explanation',
    ],
  },
};
