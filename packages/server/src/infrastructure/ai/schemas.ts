/**
 * AI 响应 schema 定义。
 *
 * 与原 server.ts 中的 responseSchema 逐字等价，保证行为零变化。
 */
import type { AIJsonSchema } from './provider.ts';

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
        metadataConfidence: { type: 'STRING' },
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
          errorType: { type: 'STRING' },
          aiAnalysis: { type: 'STRING' },
          evidence: { type: 'STRING' },
          confidence: { type: 'STRING' },
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
    teachingBehaviorUsed: { type: 'STRING' },
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
    errorType: { type: 'STRING' },
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
