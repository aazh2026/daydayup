import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Check,
  CheckCircle2,
  Edit3,
  Eye,
  EyeOff,
  FileImage,
  FileText,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useCurriculum } from '../store/curriculum.tsx';
import { MathText } from './MathText.tsx';
import { SAMPLE_EXAM_IMAGE_URL } from '../data/initialStore.ts';
import { api } from '../api/client.ts';
import {
  subscribeJob,
  type EnqueueDiagnosisResponse,
} from '../api/jobs.ts';
import { ALL_SUBJECTS } from '../types.ts';
import { Pagination } from './Pagination.tsx';
import { AdaptiveDiagnosisPanel } from './AdaptiveDiagnosisPanel.tsx';
import { paginateList } from '../utils/pagination.ts';
import type {
  DetectedMetadata,
  DiagnosedItem,
  DiagnoseExamResponse,
} from '@daydayup/contracts';
import type {
  AppPage,
  ConfidenceLevel,
  ErrorRecord,
  ErrorType,
  Exam,
  ExamPaper,
  ExamResult,
  MasteryRecord,
  Subject,
} from '../types.ts';

export type DraftReviewAction = 'pending' | 'accepted' | 'fixed' | 'ignored';

interface DiagnosedDraftItem {
  questionNumber: string;
  stem: string;
  studentAnswer: string;
  correctAnswer: string;
  scoreLost: number;
  knowledgeId: string;
  errorType: ErrorType;
  aiAnalysis: string;
  evidence: string;
  confidence: ConfidenceLevel;
  verificationMethod: string;
  reviewAction?: DraftReviewAction;
}

interface PendingDiagnosisDraft {
  subject: Subject;
  examTitle: string;
  existingExamId?: string;
  examType: Exam['type'];
  examDate: string;
  score?: number;
  fullScore?: number;
  targetScore?: number;
  syncScoreToBaseline: boolean;
  metadataConfidence: ConfidenceLevel;
  paperSummary: string;
  questionsCount: number;
  totalLostScore: number;
  imageUrl?: string;
  rawText?: string;
  sourceFormat?: '试卷拍照' | '文本试卷' | '单题录入';
  items: DiagnosedDraftItem[];
}

interface DiagnosisPageProps {
  /** 当前学生 ID（用于服务端鉴权与数据隔离） */
  studentId: string;
  /** 当前考试 ID（诊断归属的考试） */
  examId: string;

  exams: Exam[];
  examResults: ExamResult[];
  examPapers: ExamPaper[];
  errorRecords: ErrorRecord[];
  masteryRecords: Record<string, MasteryRecord>;
  onAddExamResult: (
    result: Omit<ExamResult, 'id' | 'examId'> & {
      existingExamId?: string;
      examType?: Exam['type'];
    }
  ) => void;
  onDiagnosisCompleted: (payload: PendingDiagnosisDraft) => void;
  onVerifyKnowledge: (
    knowledgeId: string,
    isCorrect: boolean,
    evidenceNote: string
  ) => void;
  onLaunchCoach: (knowledgeId: string) => void;
  /** 自适应诊断 finalize 后，刷新服务端权威掌握度 */
  onMasteryUpdated?: () => void | Promise<void>;
  onNavigate?: (page: AppPage) => void;
}

type InputTab = 'paper' | 'wrong' | 'score' | 'quiz';

const ERROR_TYPES: ErrorType[] = [
  '知识问题',
  '方法问题',
  '计算问题',
  '熟练度问题',
  '审题问题',
];

const CONFIDENCE_LEVELS: ConfidenceLevel[] = ['确定', '较可能', '待验证'];

const EXAM_TYPES: Exam['type'][] = ['期中考试', '月考', '一模', '二模', '随堂诊断'];

/**
 * Blob → data URL。
 *
 * 用于把示例试卷图片转成与用户上传照片**同构**的数据，
 * 从而复用同一条上传链路。
 */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('读取失败'));
    reader.readAsDataURL(blob);
  });
}

export const DiagnosisPage: React.FC<DiagnosisPageProps> = ({
  exams,
  examResults,
  examPapers,
  errorRecords,
  masteryRecords,
  onAddExamResult,
  onDiagnosisCompleted,
  studentId,
  examId,
  onVerifyKnowledge,
  onLaunchCoach,
  onMasteryUpdated,
  onNavigate,
}) => {
  /** 知识体系（服务端资产） */
  const {
    knowledgeMap: KNOWLEDGE_MAP,
    knowledgePoints: SHANGHAI_CURRICULUM,
  } = useCurriculum();

  const [selectedSubject, setSelectedSubject] = useState<Subject>('数学');
  const [selectedExamFilter, setSelectedExamFilter] = useState<string>('all');
  const [expandedPaperId, setExpandedPaperId] = useState<string | null>(null);
  const [inputTab, setInputTab] = useState<InputTab>('paper');

  // Multi-image & Paper OCR / Parsed Text State
  const [uploadSubject, setUploadSubject] = useState<'自动识别' | Subject>('自动识别');
  const [uploadExamMode, setUploadExamMode] = useState<'auto' | 'existing' | 'new'>('auto');
  const [uploadExistingExamId, setUploadExistingExamId] = useState<string>(
    exams[0]?.id ?? ''
  );
  const [examTitleInput, setExamTitleInput] = useState('');
  const [uploadExamType, setUploadExamType] = useState<Exam['type']>('期中考试');
  const [uploadExamDate, setUploadExamDate] = useState(new Date().toISOString().slice(0, 10));
  const [rawTextInput, setRawTextInput] = useState('');
  const [parsedTextName, setParsedTextName] = useState<string | null>(null);
  const [uploadedImages, setUploadedImages] = useState<Array<{ dataUrl: string; mimeType: string; name: string }>>([]);
  const [usingSampleImage, setUsingSampleImage] = useState(false);
  const [sampleImageFailed, setSampleImageFailed] = useState(false);
  const [isDiagnosing, setIsDiagnosing] = useState(false);
  const [diagnoseError, setDiagnoseError] = useState<string | null>(null);
  /** 异步诊断进度（分离后诊断走 Job + SSE） */
  const [diagnoseProgress, setDiagnoseProgress] = useState<{
    stage: string;
    pct: number;
  } | null>(null);
  const [diagnoseSuccessMsg, setDiagnoseSuccessMsg] = useState<string | null>(null);
  const [pendingDraft, setPendingDraft] = useState<PendingDiagnosisDraft | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textFileInputRef = useRef<HTMLInputElement | null>(null);

  // Score entry state
  const [scoreSubject, setScoreSubject] = useState<Subject>('数学');
  const [scoreExamMode, setScoreExamMode] = useState<'existing' | 'new'>('new');
  const [scoreExistingExamId, setScoreExistingExamId] = useState<string>(exams[0]?.id ?? '');
  const [scoreExamName, setScoreExamName] = useState('11月阶段测验');
  const [scoreExamType, setScoreExamType] = useState<Exam['type']>('月考');
  const [scoreVal, setScoreVal] = useState('82');
  const [fullScoreVal, setFullScoreVal] = useState('100');
  const [targetScoreVal, setTargetScoreVal] = useState('90');
  const [scoreDate, setScoreDate] = useState(new Date().toISOString().slice(0, 10));

  // Pagination states
  const [errorPage, setErrorPage] = useState(1);
  const [errorPageSize, setErrorPageSize] = useState(5);

  const [paperPage, setPaperPage] = useState(1);
  const [paperPageSize, setPaperPageSize] = useState(5);

  const [draftItemPage, setDraftItemPage] = useState(1);
  const [draftItemPageSize, setDraftItemPageSize] = useState(5);

  // 智能核对工作台状态（双栏对照、置信度分级、内联编辑、可操作工作流）
  const [selectedDraftItemIdx, setSelectedDraftItemIdx] = useState<number>(0);
  const [draftFilter, setDraftFilter] = useState<'all' | 'unverified' | 'accepted' | 'ignored'>('all');
  const [editingDraftItemIdx, setEditingDraftItemIdx] = useState<number | null>(null);
  const [imageZoom, setImageZoom] = useState<number>(100);
  const [currentImagePageIdx, setCurrentImagePageIdx] = useState<number>(0);

  useEffect(() => {
    setErrorPage(1);
    setPaperPage(1);
  }, [selectedSubject]);

  useEffect(() => {
    setErrorPage(1);
    setPaperPage(1);
  }, [selectedExamFilter]);

  useEffect(() => {
    setDraftItemPage(1);
  }, [pendingDraft?.items.length]);

  const sortedExams = [...exams].sort((a, b) => b.date.localeCompare(a.date));
  const activeExamObj =
    selectedExamFilter === 'all'
      ? undefined
      : sortedExams.find((ex) => ex.id === selectedExamFilter);

  const subjectResults = examResults
    .filter((r) => r.subject === selectedSubject)
    .sort((a, b) => b.date.localeCompare(a.date));

  const displayedResult =
    selectedExamFilter === 'all'
      ? subjectResults[0]
      : subjectResults.find((r) => r.examId === selectedExamFilter);

  const displayedResultIndex = displayedResult
    ? subjectResults.findIndex((r) => r.id === displayedResult.id)
    : -1;
  const previousResult =
    displayedResultIndex >= 0 && displayedResultIndex + 1 < subjectResults.length
      ? subjectResults[displayedResultIndex + 1]
      : undefined;
  const scoreDeltaVsPrev =
    displayedResult && previousResult ? displayedResult.score - previousResult.score : null;

  const currentScore = displayedResult?.score ?? 0;
  const fullScore = displayedResult?.fullScore ?? subjectResults[0]?.fullScore ?? 100;
  const targetScore = displayedResult?.targetScore ?? subjectResults[0]?.targetScore ?? 90;
  const scoreGap = displayedResult ? Math.max(0, targetScore - currentScore) : 0;

  const subjectErrors = errorRecords.filter((e) => {
    if (e.subject !== selectedSubject) return false;
    if (selectedExamFilter === 'all') return true;
    return (
      e.examId === selectedExamFilter ||
      (activeExamObj ? e.examTitle === activeExamObj.title : false)
    );
  });
  const subjectPapersForView = examPapers.filter((p) => {
    if (p.subject !== selectedSubject) return false;
    if (selectedExamFilter === 'all') return true;
    return p.examId === selectedExamFilter;
  });

  const { pageItems: paginatedSubjectErrors, pagination: errorPagination } = paginateList(
    subjectErrors,
    errorPage,
    errorPageSize
  );

  const { pageItems: paginatedSubjectPapers, pagination: paperPagination } = paginateList(
    subjectPapersForView,
    paperPage,
    paperPageSize
  );

  const pendingItems = pendingDraft?.items ?? [];
  const pendingItemsWithIndex = pendingItems.map((item, originalIndex) => ({
    item,
    originalIndex,
  }));

  const filteredDraftItems = pendingItemsWithIndex.filter(({ item }) => {
    if (draftFilter === 'unverified') {
      return item.confidence === '待验证' || (!item.reviewAction || item.reviewAction === 'pending');
    }
    if (draftFilter === 'accepted') {
      return item.reviewAction === 'accepted' || item.reviewAction === 'fixed';
    }
    if (draftFilter === 'ignored') {
      return item.reviewAction === 'ignored';
    }
    return true;
  });

  const { pageItems: paginatedDraftItems, pagination: draftPagination } = paginateList(
    filteredDraftItems,
    draftItemPage,
    draftItemPageSize
  );

  const draftAcceptedCount = pendingItems.filter(
    (it) => it.reviewAction === 'accepted' || it.reviewAction === 'fixed'
  ).length;
  const draftUnverifiedCount = pendingItems.filter(
    (it) => it.confidence === '待验证' || !it.reviewAction || it.reviewAction === 'pending'
  ).length;
  const draftIgnoredCount = pendingItems.filter(
    (it) => it.reviewAction === 'ignored'
  ).length;
  const draftActiveLostScore = pendingItems
    .filter((it) => it.reviewAction !== 'ignored')
    .reduce((sum, it) => sum + Number(it.scoreLost || 0), 0);

  // Unverified or low-confidence knowledge points across all subjects
  const unverifiedKps = SHANGHAI_CURRICULUM.filter((kp) => {
    const rec = masteryRecords[kp.id];
    return !rec || rec.confidence !== '确定' || rec.state === '未诊断';
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []).slice(0, 4);
    if (files.length === 0) return;
    setDiagnoseError(null);
    setDiagnoseSuccessMsg(null);
    setUsingSampleImage(false);

    Promise.all(
      files.map(
        (file) =>
          new Promise<{ dataUrl: string; mimeType: string; name: string }>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => {
              resolve({
                dataUrl: typeof reader.result === 'string' ? reader.result : '',
                mimeType: file.type || 'image/jpeg',
                name: file.name,
              });
            };
            reader.readAsDataURL(file);
          })
      )
    ).then((loaded) => {
      setUploadedImages(loaded.filter((item) => Boolean(item.dataUrl)));
    });
  };

  const handleTextFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setDiagnoseError(null);
    setDiagnoseSuccessMsg(null);
    const reader = new FileReader();
    reader.onload = () => {
      const content = typeof reader.result === 'string' ? reader.result : '';
      if (content.trim()) {
        setRawTextInput(content);
        setParsedTextName(file.name);
        setUsingSampleImage(false);
        setUploadedImages([]);
      }
    };
    reader.readAsText(file, 'utf-8');
    e.target.value = '';
  };

  /**
   * 载入示例数学试卷。
   *
   * 规格 TC-01：「进入「考试诊断」→ 点击载入示例数学试卷 → 点击「启动 AI 试卷诊断」
   * → 成功识别题目与失分」。
   *
   * 关键：示例图必须真正进入**上传链路**。
   * 此前这里只置 `usingSampleImage=true` 并清空 `uploadedImages`，
   * 于是诊断时 `fileIds=[]`、`rawText=''`，服务端
   * （upload.routes.ts 的 `VALIDATION_FAILED`）必然拒绝 ——
   * 界面看起来「载入成功」，实际一发诊断就报错。
   *
   * 现在把示例图读成 data URL 放进 `uploadedImages`，
   * 走与用户上传照片**完全相同**的路径。
   */
  const handleLoadSamplePaper = () => {
    setUploadSubject('自动识别');
    setUploadExamMode('auto');
    setUsingSampleImage(true);
    setParsedTextName(null);
    setRawTextInput('');
    setSampleImageFailed(false);
    setDiagnoseError(null);
    setDiagnoseSuccessMsg(null);
    setPendingDraft(null);

    void (async () => {
      try {
        const res = await fetch(SAMPLE_EXAM_IMAGE_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const dataUrl = await blobToDataUrl(blob);
        setUploadedImages([
          {
            dataUrl,
            mimeType: blob.type || 'image/jpeg',
            name: 'sample_math_exam_paper.jpg',
          },
        ]);
      } catch (err) {
        /**
         * 读取失败不阻断界面 —— 用户仍可手动上传。
         * 但必须让用户知道示例卷没能载入，
         * 否则会重演「界面显示已载入、一发诊断就报错」。
         */
        console.warn('示例试卷图片载入失败:', err);
        setSampleImageFailed(true);
        setUploadedImages([]);
        setDiagnoseError('示例试卷图片载入失败，请手动上传试卷照片。');
      }
    })();
  };

  const handleLoadSampleParsedText = () => {
    setUploadSubject('自动识别');
    setUploadExamMode('auto');
    setUsingSampleImage(false);
    setUploadedImages([]);
    setParsedTextName('初三物理11月月考_AI已识别解析稿.md');
    setRawTextInput(`# 上海初三物理11月阶段月考测试卷（AI OCR 识别与初步解读稿）
考试日期：2026-11-14 | 门类：月考 | 总题数：15题 | 卷面满分：70分 | 实得：56分

### 第4题（2分）【教师批改：✓ 得2分】
题干：下列家用电器正常工作时电功率最接近 1000W 的是（ ）
学生作答：电热水壶（正确）

### 第11题（3分）【教师批改：✗ 扣3分】
题干：如图所示，电源电压保持不变，定值电阻 R₁ 与滑动变阻器 R₂ 串联，电压表 V₁ 测 R₁ 两端电压，V₂ 测 R₂ 两端电压。闭合开关后，将滑片 P 向右移动使 R₂ 接入阻值变大，判断电流表 A 与电压表 V₂ 的示数变化情况。
学生作答：A 变小，V₂ 因通过 R₂ 的电流变小而判断 V₂ 示数也变小。
标准答案：A 变小，V₁ = I·R₁ 变小，故 V₂ = U - V₁ 示数变大。
前序AI初步解读：学生知道用欧姆定律判断总电流减小，但直接套用 U₂ = I·R₂ 时遇到 I 减 R 增两个变量同时变化发生误判，未采用“先定值电阻再串联分压”的转换方法。

### 第14题（4分）【教师批改：△ 扣2分，得2分】
题干：在“用电流表、电压表测小灯泡电功率”实验中，小灯泡额定电压为 2.5V。闭合开关后发现小灯泡不亮，电流表无示数，电压表示数接近电源电压，故障原因是什么？第(2)问要求在表格数据中剔除坏点计算额定功率。
学生作答：第(1)问写“小灯泡断路”（正确）；第(2)问将 U=1.5V、2.0V、2.5V 三次功率取平均值作为额定功率。
标准答案：第(2)问额定功率不能对不同电压下的电功率求平均值，应直接取 U=2.5V 时对应的 U·I 值。
前序AI初步解读：学生误把“伏安法测电阻求平均值减小误差”的方法机械迁移到“测小灯泡电功率”中，未理解灯丝电阻随温度变化且额定功率对应唯一额定电压。`);
    setDiagnoseError(null);
    setDiagnoseSuccessMsg(null);
    setPendingDraft(null);
  };

  const resolvedUploadExam =
    uploadExamMode === 'existing'
      ? exams.find((e) => e.id === uploadExistingExamId)
      : undefined;
  const resolvedUploadTitle =
    uploadExamMode === 'existing' && resolvedUploadExam
      ? resolvedUploadExam.title
      : uploadExamMode === 'new'
      ? examTitleInput.trim() || ''
      : '';

  const hasImageSource = usingSampleImage || uploadedImages.length > 0;
  const isTextOnlyMode = !hasImageSource && rawTextInput.trim().length > 0;

  const handleRunPaperDiagnosis = async () => {
    if (!hasImageSource && !rawTextInput.trim()) {
      setDiagnoseError('请上传试卷图片（最多4页）、导入文本/MD文件，或粘贴 AI 已识别/解析的试卷文本内容。');
      return;
    }

    setIsDiagnosing(true);
    setDiagnoseError(null);
    setDiagnoseSuccessMsg(null);
    setPendingDraft(null);

    const detectedSourceFormat: '试卷拍照' | '文本试卷' | '单题录入' =
      inputTab === 'wrong'
        ? '单题录入'
        : hasImageSource
        ? '试卷拍照'
        : '文本试卷';

    try {
      /**
       * 分离后诊断走异步 Job：
       * 1. 上传试卷图片 → 得到 fileId
       * 2. 创建诊断任务 → 得到 jobId
       * 3. 订阅 SSE 接收进度
       *
       * 大试卷诊断可能超过 2 分钟，同步请求会超时。
       */
      let fileIds: string[] = [];

      if (uploadedImages.length > 0) {
        setDiagnoseProgress({ stage: '上传试卷图片', pct: 5 });
        for (const img of uploadedImages.slice(0, 4)) {
          const uploaded = await api.post<{ fileId: string }>(
            '/api/v1/uploads/papers',
            {
              studentId,
              base64: img.dataUrl,
              mimeType: img.mimeType,
              originalName: 'paper.jpg',
            }
          );
          fileIds.push(uploaded.fileId);
        }
      } else if (usingSampleImage) {
        /**
         * 示例卷仍在读取中（或读取失败）。
         *
         * 此时 fileIds 为空、rawText 也为空，服务端会以
         * `VALIDATION_FAILED` 拒绝 —— 但那个报错对用户毫无意义。
         * 这里给出明确提示，而不是让用户对着一个技术错误码发呆。
         */
        throw new Error(
          sampleImageFailed
            ? '示例试卷图片载入失败，请手动上传试卷照片后重试。'
            : '示例试卷图片正在载入，请稍候再启动诊断。'
        );
      }

      setDiagnoseProgress({ stage: '创建诊断任务', pct: 15 });

      const enqueued = await api.post<EnqueueDiagnosisResponse>(
        `/api/v1/exams/${examId}/diagnosis`,
        {
          studentId,
          paperId: `paper-${Date.now()}`,
          subject: uploadSubject,
          examTitle: resolvedUploadTitle,
          rawText: rawTextInput.trim(),
          parsedTextName: parsedTextName ?? undefined,
          inputFormat:
            inputTab === 'wrong'
              ? 'wrong_item'
              : hasImageSource && rawTextInput.trim()
              ? 'mixed'
              : hasImageSource
              ? 'image'
              : 'parsed_text',
          fileIds,
        }
      );

      setDiagnoseProgress({ stage: 'AI 识别试卷结构', pct: 30 });

      // 订阅 SSE 进度
      const data = await new Promise<DiagnoseExamResponse>((resolve, reject) => {
        let unsubscribe: (() => void) | null = null;

        unsubscribe = subscribeJob(enqueued.jobId, {
          onProgress: (progress) => {
            setDiagnoseProgress({ stage: progress.stage, pct: progress.pct });
          },
          onDone: (job) => {
            unsubscribe?.();
            resolve(job.output as DiagnoseExamResponse);
          },
          onError: (message) => {
            unsubscribe?.();
            reject(new Error(message));
          },
          onCancelled: () => {
            unsubscribe?.();
            reject(new Error('诊断已取消'));
          },
        });
      });

      const meta = data.detectedMetadata ?? ({} as DetectedMetadata);
      const aiSubject = ALL_SUBJECTS.includes(String(meta.subject) as Subject)
        ? (String(meta.subject) as Subject)
        : uploadSubject === '自动识别'
        ? '数学'
        : uploadSubject;
      const finalSubject: Subject = uploadSubject === '自动识别' ? aiSubject : uploadSubject;

      const aiExamType = EXAM_TYPES.includes(String(meta.examType) as Exam['type'])
        ? (String(meta.examType) as Exam['type'])
        : '随堂诊断';
      const aiExamTitle = String(meta.examTitle ?? '').trim() || `${finalSubject}${aiExamType}`;
      const rawAiDate = String(meta.examDate ?? '').trim();
      const validAiDate = /^\d{4}-\d{2}-\d{2}$/.test(rawAiDate)
        ? rawAiDate
        : new Date().toISOString().slice(0, 10);

      const rawScoreNum = Number(meta.score);
      const rawFullNum = Number(meta.fullScore);
      const detectedScore = !Number.isNaN(rawScoreNum) && rawScoreNum >= 0 ? rawScoreNum : undefined;
      const detectedFull = !Number.isNaN(rawFullNum) && rawFullNum > 0 ? rawFullNum : undefined;
      const rawMetaConf = String(meta.metadataConfidence ?? '较可能') as ConfidenceLevel;
      const metadataConfidence: ConfidenceLevel = CONFIDENCE_LEVELS.includes(rawMetaConf)
        ? rawMetaConf
        : '较可能';

      // Auto-match existing exam if in auto mode and title/date matches
      const autoMatchedExam =
        uploadExamMode === 'existing'
          ? resolvedUploadExam
          : uploadExamMode === 'auto'
          ? exams.find(
              (ex) =>
                ex.title === aiExamTitle ||
                (ex.date === validAiDate && ex.type === aiExamType)
            )
          : undefined;

      const finalExamTitle = autoMatchedExam
        ? autoMatchedExam.title
        : uploadExamMode === 'new' && examTitleInput.trim()
        ? examTitleInput.trim()
        : aiExamTitle;
      const finalExamType = autoMatchedExam
        ? autoMatchedExam.type
        : uploadExamMode === 'new'
        ? uploadExamType
        : aiExamType;
      const finalExamDate = autoMatchedExam
        ? autoMatchedExam.date
        : uploadExamMode === 'new'
        ? uploadExamDate
        : validAiDate;

      const items = Array.isArray(data.diagnosedItems) ? data.diagnosedItems : [];
      const sanitizedItems: DiagnosedDraftItem[] = items.map(
        (item: DiagnosedItem) => {
          const kpId = String(item.knowledgeId ?? '');
          const validKp = KNOWLEDGE_MAP[kpId]
            ? kpId
            : SHANGHAI_CURRICULUM.find((k) => k.subject === finalSubject)?.id ?? SHANGHAI_CURRICULUM[0]?.id ?? '';
          const rawErr = String(item.errorType ?? '知识问题') as ErrorType;
          const rawConf = String(item.confidence ?? '较可能') as ConfidenceLevel;

          return {
            questionNumber: String(item.questionNumber ?? '未知题号'),
            stem: String(item.stem ?? ''),
            studentAnswer: String(item.studentAnswer ?? '未识别作答'),
            correctAnswer: String(item.correctAnswer ?? ''),
            scoreLost: Number(item.scoreLost ?? 2) || 2,
            knowledgeId: validKp,
            errorType: ERROR_TYPES.includes(rawErr) ? rawErr : '知识问题',
            aiAnalysis: String(item.aiAnalysis ?? ''),
            evidence: String(item.evidence ?? finalExamTitle),
            confidence: CONFIDENCE_LEVELS.includes(rawConf) ? rawConf : '较可能',
            verificationMethod: String(item.verificationMethod ?? '完成同类基础微测验证'),
          };
        }
      );

      const calculatedLost = sanitizedItems.reduce((s, it) => s + Number(it.scoreLost || 0), 0);

      // Stage in human-in-the-loop review draft instead of blindly committing
      setPendingDraft({
        subject: finalSubject,
        examTitle: finalExamTitle,
        existingExamId: autoMatchedExam?.id,
        examType: finalExamType,
        examDate: finalExamDate,
        score: detectedScore,
        fullScore: detectedFull,
        targetScore: detectedFull ? Math.round(detectedFull * 0.9) : undefined,
        syncScoreToBaseline: detectedScore !== undefined && detectedFull !== undefined,
        metadataConfidence,
        paperSummary: String(data.paperSummary ?? '已完成试卷逐题识别与错因归因。'),
        questionsCount: Number(data.questionsDetectedCount ?? sanitizedItems.length),
        totalLostScore: Number(data.totalLostScore ?? calculatedLost),
        imageUrl: usingSampleImage
          ? SAMPLE_EXAM_IMAGE_URL
          : uploadedImages[0]?.dataUrl ?? undefined,
        rawText: rawTextInput.trim() || undefined,
        sourceFormat: detectedSourceFormat,
        items: sanitizedItems,
      });
    } catch (err) {
      setDiagnoseError(err instanceof Error ? err.message : '试卷识别失败，请稍后重试。');
      setDiagnoseProgress(null);
    } finally {
      setIsDiagnosing(false);
      setDiagnoseProgress(null);
    }
  };

  const handleUpdateDraftItem = (
    idx: number,
    patch: Partial<DiagnosedDraftItem>
  ) => {
    setPendingDraft((prev) => {
      if (!prev) return prev;
      const nextItems = prev.items.map((it, i) => (i === idx ? { ...it, ...patch } : it));
      return {
        ...prev,
        items: nextItems,
        totalLostScore: nextItems
          .filter((it) => it.reviewAction !== 'ignored')
          .reduce((s, it) => s + Number(it.scoreLost || 0), 0),
      };
    });
  };

  const handleSetItemAction = (idx: number, action: DraftReviewAction) => {
    handleUpdateDraftItem(idx, { reviewAction: action });
    if (action === 'fixed') {
      setEditingDraftItemIdx(null);
    }
  };

  const handleAcceptAllVerified = () => {
    setPendingDraft((prev) => {
      if (!prev) return prev;
      const nextItems = prev.items.map((it) =>
        it.reviewAction === 'ignored' ? it : { ...it, reviewAction: 'accepted' as DraftReviewAction }
      );
      return {
        ...prev,
        items: nextItems,
      };
    });
  };

  const handleConfirmDraft = () => {
    if (!pendingDraft) return;
    const activeItems = pendingDraft.items.filter((it) => it.reviewAction !== 'ignored');
    const finalDraft: PendingDiagnosisDraft = {
      ...pendingDraft,
      items: activeItems,
      questionsCount: activeItems.length,
      totalLostScore: activeItems.reduce((s, it) => s + Number(it.scoreLost || 0), 0),
    };
    onDiagnosisCompleted(finalDraft);
    setSelectedSubject(pendingDraft.subject);
    if (pendingDraft.existingExamId) {
      setSelectedExamFilter(pendingDraft.existingExamId);
    } else {
      setSelectedExamFilter('all');
    }
    const scoreNotice =
      pendingDraft.syncScoreToBaseline &&
      pendingDraft.score !== undefined &&
      pendingDraft.fullScore !== undefined
        ? `并同步写入成绩基线（${pendingDraft.score}/${pendingDraft.fullScore}）`
        : '';
    const ignoredNotice =
      pendingDraft.items.length > activeItems.length
        ? `（已排除 ${pendingDraft.items.length - activeItems.length} 道无需干预题目）`
        : '';
    setDiagnoseSuccessMsg(
      `已存档「${pendingDraft.examTitle}（${pendingDraft.subject}试卷）」分析记录${scoreNotice}，写入 ${activeItems.length} 条错题归因${ignoredNotice}并重排未来7天计划。`
    );
    setPendingDraft(null);
    setRawTextInput('');
    setParsedTextName(null);
    setEditingDraftItemIdx(null);
  };

  const handleScoreSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const s = Number(scoreVal);
    const full = Number(fullScoreVal);
    const target = Number(targetScoreVal);
    if (Number.isNaN(s) || Number.isNaN(full) || full <= 0) return;

    const existingExam =
      scoreExamMode === 'existing'
        ? exams.find((ex) => ex.id === scoreExistingExamId)
        : undefined;

    onAddExamResult({
      existingExamId: existingExam?.id,
      examType: existingExam ? existingExam.type : scoreExamType,
      examTitle: existingExam ? existingExam.title : (scoreExamName.trim() || '阶段测验'),
      subject: scoreSubject,
      score: s,
      fullScore: full,
      targetScore: target,
      date: existingExam ? existingExam.date : scoreDate,
    });
    setSelectedSubject(scoreSubject);
    if (existingExam) {
      setSelectedExamFilter(existingExam.id);
    } else {
      setSelectedExamFilter('all');
    }
    setDiagnoseSuccessMsg(
      `已录入「${existingExam ? existingExam.title : scoreExamName}」${scoreSubject}成绩（${s}/${full}），诊断基线与提分差距已同步更新。`
    );
  };

  const subjectKpsForUpload = SHANGHAI_CURRICULUM.filter(
    (k) => k.subject === (pendingDraft?.subject ?? uploadSubject)
  );

  return (
    <div className="space-y-8">
      {/* Section 1: Four Data Entry Modes */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-slate-900">
              01. 考试诊断中心
            </h1>
            <p className="text-xs text-slate-500 mt-1">
              区分“不会哪个知识点”与“分数是怎么丢的”，所有识别结果均经人工核对关键字段后再入库规划
            </p>
          </div>

          <div
            role="tablist"
            aria-label="数据录入方式"
            className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg self-start"
          >
            {[
              { id: 'paper' as InputTab, label: '试卷拍照 / 文本导入' },
              { id: 'wrong' as InputTab, label: '单道错题录入' },
              { id: 'score' as InputTab, label: '成绩基线录入' },
              { id: 'quiz' as InputTab, label: '主动诊断微测' },
            ].map((tab) => (
              <button
                key={tab.id}
                role="tab"
                aria-selected={inputTab === tab.id}
                type="button"
                onClick={() => {
                  setInputTab(tab.id);
                  setDiagnoseError(null);
                  setDiagnoseSuccessMsg(null);
                }}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  inputTab === tab.id
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {diagnoseError && (
          <div className="p-3.5 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2.5 text-xs text-red-800">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-600" />
            <span>{diagnoseError}</span>
          </div>
        )}

        {diagnoseSuccessMsg && (
          <div className="p-3.5 bg-emerald-50 border border-emerald-200 rounded-lg flex items-start gap-2.5 text-xs text-emerald-900">
            <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-600" />
            <span>{diagnoseSuccessMsg}</span>
          </div>
        )}

        {/* Tab 1 & Tab 2: Paper OCR / Parsed Text Paper or Single Wrong Problem */}
        {(inputTab === 'paper' || inputTab === 'wrong') && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              <div className="lg:col-span-5 space-y-3">
                <div className="border border-dashed border-slate-300 rounded-xl p-4 bg-slate-50/70">
                  {hasImageSource ? (
                    <div className="space-y-3">
                      <div className="relative aspect-[3/4] max-h-72 mx-auto overflow-hidden rounded-lg border border-slate-200 bg-white flex items-center justify-center">
                        {!sampleImageFailed ? (
                          <img
                            src={usingSampleImage ? SAMPLE_EXAM_IMAGE_URL : uploadedImages[0].dataUrl}
                            alt="待诊断试卷预览图"
                            referrerPolicy="no-referrer"
                            onError={() => setSampleImageFailed(true)}
                            className="w-full h-full object-contain"
                          />
                        ) : (
                          <div className="p-6 text-center space-y-2">
                            <FileImage className="w-8 h-8 text-slate-400 mx-auto" />
                            <div className="text-xs text-slate-600">{resolvedUploadTitle}</div>
                          </div>
                        )}
                      </div>
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="text-slate-600 truncate max-w-[200px]">
                          {usingSampleImage
                            ? '已载入：上海九年级数学期中示例卷'
                            : `已载入 ${uploadedImages.length} 页试卷照片`}
                        </span>
                        <div className="flex items-center gap-3 shrink-0">
                          <button
                            type="button"
                            onClick={() => fileInputRef.current?.click()}
                            className="text-blue-700 hover:text-blue-800 font-medium whitespace-nowrap"
                          >
                            更换图片
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setUsingSampleImage(false);
                              setUploadedImages([]);
                            }}
                            className="text-slate-500 hover:text-slate-800 whitespace-nowrap"
                          >
                            清除图片
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : isTextOnlyMode ? (
                    <div className="py-5 px-2 space-y-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 text-xs font-semibold text-slate-900">
                          <FileText className="w-4 h-4 text-blue-700 shrink-0" />
                          <span className="truncate max-w-[220px]">
                            {parsedTextName ?? '已识别文本 / AI 解析试卷稿'}
                          </span>
                        </div>
                        <span className="text-xs font-mono tabular-nums text-slate-500">
                          {rawTextInput.trim().length} 字
                        </span>
                      </div>
                      <div className="p-3 bg-white border border-slate-200 rounded-lg text-xs text-slate-600 max-h-44 overflow-y-auto whitespace-pre-wrap leading-relaxed font-mono">
                        {rawTextInput.trim().slice(0, 460)}
                        {rawTextInput.trim().length > 460 ? '\n...' : ''}
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                        <span className="text-emerald-700 font-medium">
                          纯文本试卷模式（无需上传图片）
                        </span>
                        <div className="flex items-center gap-3">
                          <button
                            type="button"
                            onClick={() => textFileInputRef.current?.click()}
                            className="text-blue-700 hover:text-blue-800 font-medium"
                          >
                            更换文本文件
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setRawTextInput('');
                              setParsedTextName(null);
                            }}
                            className="text-slate-500 hover:text-slate-800"
                          >
                            清空内容
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="py-7 text-center space-y-3">
                      <Upload className="w-7 h-7 text-slate-400 mx-auto" />
                      <div className="space-y-1">
                        <p className="text-sm font-medium text-slate-800">
                          {inputTab === 'paper'
                            ? '上传试卷照片（最多4页）或导入已识别文本试卷'
                            : '上传错题拍照或直接输入错题文本'}
                        </p>
                        <p className="text-xs text-slate-500 leading-relaxed">
                          支持 JPG / PNG 拍照识别，也支持 .txt / .md / .json 格式的 AI 解析稿、OCR 转录文本或右侧直接粘贴
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          className="px-3.5 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors"
                        >
                          选择试卷照片
                        </button>
                        {inputTab === 'paper' && (
                          <button
                            type="button"
                            onClick={() => textFileInputRef.current?.click()}
                            className="px-3.5 py-2 text-xs font-medium text-slate-800 bg-white hover:bg-slate-100 border border-slate-300 rounded-lg transition-colors"
                          >
                            导入文本 / MD 文件
                          </button>
                        )}
                      </div>
                      {inputTab === 'paper' && (
                        <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                          <button
                            type="button"
                            onClick={handleLoadSamplePaper}
                            className="px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors"
                          >
                            载入数学图片示例卷
                          </button>
                          <button
                            type="button"
                            onClick={handleLoadSampleParsedText}
                            className="px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors"
                          >
                            载入AI解析文本示例
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple={inputTab === 'paper'}
                    onChange={handleFileChange}
                    className="hidden"
                  />
                  <input
                    ref={textFileInputRef}
                    type="file"
                    accept=".txt,.md,.json,text/plain,text/markdown,application/json"
                    onChange={handleTextFileChange}
                    className="hidden"
                  />
                </div>
              </div>

              <div className="lg:col-span-7 space-y-4">
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1.5">
                      诊断学科（默认由 AI 自动识别，也可手动指定）
                    </label>
                    <div className="grid grid-cols-6 gap-1 p-1 bg-slate-100 rounded-lg">
                      {(['自动识别', ...ALL_SUBJECTS] as const).map((sub) => (
                        <button
                          key={sub}
                          type="button"
                          onClick={() => setUploadSubject(sub)}
                          className={`py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                            uploadSubject === sub
                              ? 'bg-white text-slate-900 shadow-sm'
                              : 'text-slate-600 hover:text-slate-900'
                          }`}
                        >
                          {sub}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <label className="text-xs font-medium text-slate-700">
                        考试场次与分数识别方式
                      </label>
                      <div className="inline-flex items-center gap-1 p-0.5 bg-slate-200/70 rounded-md">
                        {[
                          { id: 'auto' as const, label: 'AI自动识别' },
                          { id: 'existing' as const, label: '关联已有考试' },
                          { id: 'new' as const, label: '手动指定新场次' },
                        ].map((modeOpt) => (
                          <button
                            key={modeOpt.id}
                            type="button"
                            onClick={() => setUploadExamMode(modeOpt.id)}
                            className={`px-2.5 py-1 text-xs rounded transition-colors ${
                              uploadExamMode === modeOpt.id
                                ? 'bg-white text-slate-900 font-medium shadow-sm'
                                : 'text-slate-600 hover:text-slate-900'
                            }`}
                          >
                            {modeOpt.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {uploadExamMode === 'auto' ? (
                      <p className="text-xs text-slate-600 leading-relaxed">
                        AI 将自动从试卷或解析文本中提取考试名称、门类（期中/月考/模考/随堂）、日期与卷面分数，并在下方校验台供你核对后同步存档。
                      </p>
                    ) : uploadExamMode === 'existing' && sortedExams.length > 0 ? (
                      <select
                        value={uploadExistingExamId}
                        onChange={(e) => setUploadExistingExamId(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:border-blue-600"
                      >
                        {sortedExams.map((ex) => (
                          <option key={ex.id} value={ex.id}>
                            {ex.date} · {ex.type} · {ex.title}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5">
                        <input
                          type="text"
                          value={examTitleInput}
                          onChange={(e) => setExamTitleInput(e.target.value)}
                          placeholder="例如：11月阶段月考"
                          className="sm:col-span-2 px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:border-blue-600"
                        />
                        <select
                          value={uploadExamType}
                          onChange={(e) => setUploadExamType(e.target.value as Exam['type'])}
                          className="px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:border-blue-600"
                        >
                          {EXAM_TYPES.map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </select>
                        <input
                          type="date"
                          value={uploadExamDate}
                          onChange={(e) => setUploadExamDate(e.target.value)}
                          className="px-3 py-2 text-sm font-mono tabular-nums border border-slate-200 rounded-lg bg-white focus:outline-none focus:border-blue-600"
                        />
                      </div>
                    )}
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    {inputTab === 'paper'
                      ? '粘贴 AI 已识别文本、OCR 转录稿或解析后的文本试卷（纯文本亦可直接解析，无需传图）'
                      : '输入错题题干、学生作答过程及扣分情况'}
                  </label>
                  <textarea
                    rows={6}
                    value={rawTextInput}
                    onChange={(e) => {
                      setRawTextInput(e.target.value);
                      if (!e.target.value.trim()) setParsedTextName(null);
                    }}
                    placeholder={
                      inputTab === 'paper'
                        ? '支持粘贴整张试卷 OCR 文本、Markdown/JSON 逐题解析或已有 AI 初步解读（系统会自动跳过全对题目，提取失分题并映射到上海考纲知识点与五维错因）...'
                        : '例如：已知一次函数 y=kx+b 过 (0,2) 和 (-3,0)，向下平移4个单位我算成了 y=2/3x+6，扣了6分。'
                    }
                    className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600 leading-relaxed"
                  />
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                  <span className="text-xs text-slate-500">
                    流程：{isTextOnlyMode ? '文本解析切分' : 'OCR/文本切分'} → 人工核对关键字段 → 状态机与7天计划更新
                  </span>
                  <button
                    type="button"
                    disabled={isDiagnosing}
                    onClick={handleRunPaperDiagnosis}
                    className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap shrink-0"
                  >
                    {isDiagnosing ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>
                          {diagnoseProgress
                            ? `${diagnoseProgress.stage}（${diagnoseProgress.pct}%）`
                            : isTextOnlyMode
                              ? '正在解析文本试卷并归因...'
                              : '正在进行视觉识别与归因...'}
                        </span>
                        {/* 进度条：SSE 实时推送 */}
                        {diagnoseProgress && (
                          <span
                            className="inline-block w-16 h-1 bg-blue-200 rounded-full overflow-hidden"
                            role="progressbar"
                            aria-valuenow={diagnoseProgress.pct}
                            aria-valuemin={0}
                            aria-valuemax={100}
                          >
                            <span
                              className="block h-full bg-blue-600 transition-all duration-300"
                              style={{ width: `${diagnoseProgress.pct}%` }}
                            />
                          </span>
                        )}
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-3.5 h-3.5" />
                        <span>
                          {isTextOnlyMode ? '启动 AI 文本试卷解析与诊断' : '启动 AI 试卷诊断'}
                        </span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>

            {/* Human-in-the-loop Verification Workbench */}
            {pendingDraft && (() => {
              const previewImages =
                uploadedImages.length > 0
                  ? uploadedImages
                  : pendingDraft.imageUrl
                  ? [{ dataUrl: pendingDraft.imageUrl, mimeType: 'image/jpeg', name: 'exam_paper.jpg' }]
                  : [];
              const safeImagePageIdx =
                currentImagePageIdx >= previewImages.length ? 0 : currentImagePageIdx;
              const safeSelectedIdx =
                selectedDraftItemIdx >= pendingDraft.items.length ? 0 : selectedDraftItemIdx;
              const selectedItem = pendingDraft.items[safeSelectedIdx];

              return (
                <div className="p-5 border-2 border-blue-400 bg-slate-50/70 rounded-2xl space-y-5 shadow-sm">
                  {/* Workbench Header */}
                  <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 bg-white p-4 rounded-xl border border-blue-100 shadow-sm">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="px-2 py-0.5 text-[11px] font-bold tracking-wider text-blue-700 bg-blue-100 rounded">
                          HUMAN-IN-THE-LOOP
                        </span>
                        <h2 className="text-base font-bold text-slate-900">
                          试卷诊断智能核对工作台
                        </h2>
                        <span className="text-xs text-slate-500 font-mono">
                          （共识别 {pendingDraft.items.length} 题 · 有效应扣 {draftActiveLostScore} 分）
                        </span>
                      </div>
                      <p className="text-xs text-slate-600">
                        双栏对照原卷与归因：左侧支持多页与缩放查证，右侧支持就地内联修改、风险条目筛选与一键接受/忽略
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setPendingDraft(null);
                          setEditingDraftItemIdx(null);
                        }}
                        className="px-3 py-1.5 text-xs text-slate-600 hover:text-slate-900 border border-slate-200 bg-white rounded-lg transition-colors"
                      >
                        丢弃草稿
                      </button>
                      <button
                        type="button"
                        onClick={handleAcceptAllVerified}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg transition-colors"
                      >
                        <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                        <span>核准全部有效项</span>
                      </button>
                      <button
                        type="button"
                        onClick={handleConfirmDraft}
                        className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg shadow-sm transition-colors"
                      >
                        <Check className="w-4 h-4" />
                        <span>确认无误，存档并重排提分日程</span>
                      </button>
                    </div>
                  </div>

                  {/* Detected Exam Metadata & Score Verification Panel */}
                  <div
                    className={`p-4 rounded-xl border bg-white space-y-3 text-xs ${
                      pendingDraft.metadataConfidence === '待验证'
                        ? 'border-amber-300'
                        : 'border-slate-200'
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-slate-900">
                        自动识别考试元信息与卷面分数核对
                      </span>
                      <span className="text-slate-500">
                        识别置信度：{pendingDraft.metadataConfidence} · 来源格式：{pendingDraft.sourceFormat ?? '试卷拍照'}
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
                      <div>
                        <label className="block text-slate-500 mb-1">识别学科</label>
                        <select
                          value={pendingDraft.subject}
                          onChange={(e) => {
                            const nextSub = e.target.value as Subject;
                            const fallbackKp =
                              SHANGHAI_CURRICULUM.find((k) => k.subject === nextSub)?.id ??
                              SHANGHAI_CURRICULUM[0]?.id ??
                              '';
                            setPendingDraft((prev) =>
                              prev
                               ? {
                                    ...prev,
                                    subject: nextSub,
                                    items: prev.items.map((it) =>
                                      KNOWLEDGE_MAP[it.knowledgeId]?.subject === nextSub
                                        ? it
                                        : { ...it, knowledgeId: fallbackKp }
                                    ),
                                  }
                                : prev
                            );
                          }}
                          className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md bg-white"
                        >
                          {ALL_SUBJECTS.map((sub) => (
                            <option key={sub} value={sub}>
                              {sub}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="lg:col-span-2">
                        <label className="block text-slate-500 mb-1">考试场次归属（新建或关联已有）</label>
                        <select
                          value={pendingDraft.existingExamId ?? '__new__'}
                          onChange={(e) => {
                            const val = e.target.value;
                            if (val === '__new__') {
                              setPendingDraft((prev) =>
                                prev ? { ...prev, existingExamId: undefined } : prev
                              );
                            } else {
                              const matched = exams.find((ex) => ex.id === val);
                              if (matched) {
                                setPendingDraft((prev) =>
                                  prev
                                    ? {
                                        ...prev,
                                        existingExamId: matched.id,
                                        examTitle: matched.title,
                                        examType: matched.type,
                                        examDate: matched.date,
                                      }
                                    : prev
                                );
                              }
                            }
                          }}
                          className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md bg-white"
                        >
                          <option value="__new__">新建考试场次：{pendingDraft.examTitle}</option>
                          {sortedExams.map((ex) => (
                            <option key={ex.id} value={ex.id}>
                              关联已有：{ex.date} · {ex.title}
                            </option>
                          ))}
                        </select>
                      </div>

                      {!pendingDraft.existingExamId && (
                        <>
                          <div>
                            <label className="block text-slate-500 mb-1">考试名称</label>
                            <input
                              type="text"
                              value={pendingDraft.examTitle}
                              onChange={(e) =>
                                setPendingDraft((prev) =>
                                  prev ? { ...prev, examTitle: e.target.value } : prev
                                )
                              }
                              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md"
                            />
                          </div>
                          <div>
                            <label className="block text-slate-500 mb-1">考试门类</label>
                            <select
                              value={pendingDraft.examType}
                              onChange={(e) =>
                                setPendingDraft((prev) =>
                                  prev
                                    ? { ...prev, examType: e.target.value as Exam['type'] }
                                    : prev
                                )
                              }
                              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md bg-white"
                            >
                              {EXAM_TYPES.map((t) => (
                                <option key={t} value={t}>
                                  {t}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className="block text-slate-500 mb-1">考试日期</label>
                            <input
                              type="date"
                              value={pendingDraft.examDate}
                              onChange={(e) =>
                                setPendingDraft((prev) =>
                                  prev ? { ...prev, examDate: e.target.value } : prev
                                )
                              }
                              className="w-full px-2.5 py-1.5 font-mono tabular-nums border border-slate-200 rounded-md"
                            />
                          </div>
                        </>
                      )}
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end pt-1">
                      <div>
                        <label className="block text-slate-500 mb-1">卷面实得分（留空不录分）</label>
                        <input
                          type="number"
                          value={pendingDraft.score ?? ''}
                          placeholder="未识别"
                          onChange={(e) => {
                            const v = e.target.value === '' ? undefined : Number(e.target.value);
                            setPendingDraft((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    score: v,
                                    syncScoreToBaseline:
                                      v !== undefined && prev.fullScore !== undefined,
                                  }
                                : prev
                            );
                          }}
                          className="w-full px-2.5 py-1.5 font-mono tabular-nums border border-slate-200 rounded-md"
                        />
                      </div>
                      <div>
                        <label className="block text-slate-500 mb-1">卷面满分</label>
                        <input
                          type="number"
                          value={pendingDraft.fullScore ?? ''}
                          placeholder="例如 100 / 70"
                          onChange={(e) => {
                            const v = e.target.value === '' ? undefined : Number(e.target.value);
                            setPendingDraft((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    fullScore: v,
                                    targetScore:
                                      v !== undefined ? Math.round(v * 0.9) : prev.targetScore,
                                    syncScoreToBaseline:
                                      prev.score !== undefined && v !== undefined,
                                  }
                                : prev
                            );
                          }}
                          className="w-full px-2.5 py-1.5 font-mono tabular-nums border border-slate-200 rounded-md"
                        />
                      </div>
                      <div>
                        <label className="block text-slate-500 mb-1">阶段目标分</label>
                        <input
                          type="number"
                          value={pendingDraft.targetScore ?? ''}
                          placeholder="默认90%"
                          onChange={(e) => {
                            const v = e.target.value === '' ? undefined : Number(e.target.value);
                            setPendingDraft((prev) =>
                              prev ? { ...prev, targetScore: v } : prev
                            );
                          }}
                          className="w-full px-2.5 py-1.5 font-mono tabular-nums border border-slate-200 rounded-md"
                        />
                      </div>
                      <div className="lg:col-span-2 flex items-center gap-2 py-1.5">
                        <input
                          id="sync-score-checkbox"
                          type="checkbox"
                          checked={pendingDraft.syncScoreToBaseline}
                          disabled={
                            pendingDraft.score === undefined ||
                            pendingDraft.fullScore === undefined
                          }
                          onChange={(e) =>
                            setPendingDraft((prev) =>
                              prev
                                ? { ...prev, syncScoreToBaseline: e.target.checked }
                                : prev
                            )
                          }
                          className="rounded border-slate-300 text-blue-700"
                        />
                        <label
                          htmlFor="sync-score-checkbox"
                          className="text-slate-700 cursor-pointer"
                        >
                          同步写入「{pendingDraft.subject}」成绩基线与历次趋势矩阵
                        </label>
                      </div>
                    </div>

                    <div>
                      <label className="block text-slate-500 mb-1">整卷分析摘要（将随试卷一同存档）</label>
                      <input
                        type="text"
                        value={pendingDraft.paperSummary}
                        onChange={(e) =>
                          setPendingDraft((prev) =>
                            prev ? { ...prev, paperSummary: e.target.value } : prev
                          )
                        }
                        className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md"
                      />
                    </div>
                  </div>

                  {/* Split Pane: High-Fidelity Preview & Evidence Traceability (Left) vs Structured Extraction & Risk Workflows (Right) */}
                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
                    {/* Left Pane: High-Fidelity Document & Evidence Preview */}
                    <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-4 space-y-3 flex flex-col">
                      <div className="flex items-center justify-between gap-2 border-b border-slate-100 pb-2.5">
                        <div className="flex items-center gap-2">
                          <FileImage className="w-4 h-4 text-blue-600" />
                          <span className="text-xs font-semibold text-slate-800">
                            {previewImages.length > 0 ? '原卷高清证据视图' : '试卷文本/解析源文件'}
                          </span>
                          {previewImages.length > 1 && (
                            <span className="text-[11px] text-slate-500">
                              ({safeImagePageIdx + 1}/{previewImages.length} 页)
                            </span>
                          )}
                        </div>

                        {/* Zoom controls */}
                        <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg text-slate-700">
                          <button
                            type="button"
                            title="缩小"
                            onClick={() => setImageZoom((z) => Math.max(50, z - 20))}
                            className="p-1 hover:bg-white rounded transition-colors"
                          >
                            <ZoomOut className="w-3.5 h-3.5" />
                          </button>
                          <span className="text-[11px] font-mono px-1 min-w-[36px] text-center select-none">
                            {imageZoom}%
                          </span>
                          <button
                            type="button"
                            title="放大"
                            onClick={() => setImageZoom((z) => Math.min(250, z + 20))}
                            className="p-1 hover:bg-white rounded transition-colors"
                          >
                            <ZoomIn className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            title="重置缩放"
                            onClick={() => setImageZoom(100)}
                            className="p-1 hover:bg-white rounded transition-colors"
                          >
                            <RotateCcw className="w-3 h-3" />
                          </button>
                        </div>
                      </div>

                      {/* Multi-page switcher */}
                      {previewImages.length > 1 && (
                        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 text-xs">
                          {previewImages.map((_, pIdx) => (
                            <button
                              key={pIdx}
                              type="button"
                              onClick={() => setCurrentImagePageIdx(pIdx)}
                              className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                                safeImagePageIdx === pIdx
                                  ? 'bg-blue-600 text-white shadow-sm'
                                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                              }`}
                            >
                              第 {pIdx + 1} 页
                            </button>
                          ))}
                        </div>
                      )}

                      {/* Visual Traceability Ribbon */}
                      {selectedItem && (
                        <div className="px-3 py-2 bg-blue-50 border border-blue-200 rounded-lg flex items-center justify-between text-xs text-blue-900">
                          <span className="font-medium flex items-center gap-1.5 truncate">
                            <Sparkles className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                            <span>
                              原卷定位：第 {selectedItem.questionNumber} 题 · {KNOWLEDGE_MAP[selectedItem.knowledgeId]?.name ?? selectedItem.knowledgeId}
                            </span>
                          </span>
                          <span className="font-mono text-rose-600 font-semibold shrink-0 ml-2">
                            扣 {selectedItem.scoreLost} 分
                          </span>
                        </div>
                      )}

                      {/* Canvas or Document Content */}
                      <div className="overflow-auto max-h-[580px] bg-slate-900/5 rounded-lg border border-slate-200 relative p-3 flex justify-center">
                        {previewImages.length > 0 ? (
                          <div
                            className="transition-transform duration-150 origin-top shadow bg-white rounded flex justify-center"
                            style={{ transform: `scale(${imageZoom / 100})` }}
                          >
                            <img
                              src={previewImages[safeImagePageIdx]?.dataUrl}
                              alt="原卷证据"
                              className="max-w-none block select-none pointer-events-none"
                              style={{ maxHeight: '780px', width: 'auto' }}
                            />
                          </div>
                        ) : (
                          <div className="w-full font-mono text-xs text-slate-800 bg-white p-4 rounded shadow-sm whitespace-pre-wrap leading-relaxed select-text">
                            {pendingDraft.rawText || '暂无原卷图片或文本源'}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Right Pane: Structured Extraction, Risk Grading & Inline Workflows */}
                    <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-4 space-y-4">
                      {/* Risk & Workflow Filter Tabs */}
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
                        <div className="flex flex-wrap items-center gap-1">
                          {[
                            { key: 'all' as const, label: `全部 (${pendingDraft.items.length})` },
                            {
                              key: 'unverified' as const,
                              label: `待核实风险 (${draftUnverifiedCount})`,
                              alert: draftUnverifiedCount > 0,
                            },
                            { key: 'accepted' as const, label: `已核准 (${draftAcceptedCount})` },
                            { key: 'ignored' as const, label: `已排除 (${draftIgnoredCount})` },
                          ].map((tab) => (
                            <button
                              key={tab.key}
                              type="button"
                              onClick={() => {
                                setDraftFilter(tab.key);
                                setDraftItemPage(1);
                              }}
                              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors flex items-center gap-1.5 ${
                                draftFilter === tab.key
                                  ? 'bg-blue-50 text-blue-700 border border-blue-200 shadow-sm'
                                  : 'text-slate-600 hover:bg-slate-50'
                              }`}
                            >
                              {tab.alert && <AlertCircle className="w-3.5 h-3.5 text-amber-500" />}
                              <span>{tab.label}</span>
                            </button>
                          ))}
                        </div>

                        <span className="text-xs text-slate-500 font-mono">
                          核对进度: {draftAcceptedCount}/{pendingDraft.items.length} 题
                        </span>
                      </div>

                      {/* Items List */}
                      <div className="space-y-3">
                        {filteredDraftItems.length === 0 ? (
                          <div className="py-12 text-center text-xs text-slate-500 space-y-1">
                            <CheckCircle2 className="w-8 h-8 text-slate-300 mx-auto" />
                            <p>当前筛选条件下暂无题目</p>
                          </div>
                        ) : (
                          paginatedDraftItems.map(({ item, originalIndex }) => {
                            const isSelected = safeSelectedIdx === originalIndex;
                            const isEditing = editingDraftItemIdx === originalIndex;
                            const isIgnored = item.reviewAction === 'ignored';
                            const isAccepted =
                              item.reviewAction === 'accepted' || item.reviewAction === 'fixed';
                            const isUnverifiedRisk =
                              item.confidence === '待验证' && !isAccepted && !isIgnored;

                            return (
                              <div
                                key={originalIndex}
                                onClick={() => setSelectedDraftItemIdx(originalIndex)}
                                className={`p-4 rounded-xl border transition-all cursor-pointer ${
                                  isSelected ? 'ring-2 ring-blue-500' : ''
                                } ${
                                  isIgnored
                                    ? 'bg-slate-50/80 border-slate-200 opacity-60'
                                    : isAccepted
                                    ? 'bg-emerald-50/20 border-emerald-300'
                                    : isUnverifiedRisk
                                    ? 'bg-amber-50/30 border-amber-300'
                                    : 'bg-white border-slate-200'
                                }`}
                              >
                                {/* Card Header */}
                                <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-slate-100">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="font-bold text-sm text-slate-900">
                                      第 {item.questionNumber} 题
                                    </span>
                                    <span className="font-mono text-xs font-semibold px-2 py-0.5 rounded bg-rose-50 text-rose-700 border border-rose-200">
                                      扣 {item.scoreLost} 分
                                    </span>
                                    <span className="text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-700 font-medium border border-blue-100">
                                      {KNOWLEDGE_MAP[item.knowledgeId]?.name ?? item.knowledgeId}
                                    </span>
                                    <span className="text-xs px-2 py-0.5 rounded bg-purple-50 text-purple-700 font-medium border border-purple-100">
                                      {item.errorType}
                                    </span>

                                    {/* Confidence Grade Badge */}
                                    {item.confidence === '确定' && (
                                      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded">
                                        <ShieldCheck className="w-3 h-3 text-emerald-600" />
                                        高置信度
                                      </span>
                                    )}
                                    {item.confidence === '较可能' && (
                                      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-600 bg-slate-100 border border-slate-200 px-2 py-0.5 rounded">
                                        中置信度
                                      </span>
                                    )}
                                    {item.confidence === '待验证' && (
                                      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-800 bg-amber-50 border border-amber-300 px-2 py-0.5 rounded animate-pulse">
                                        <AlertCircle className="w-3 h-3 text-amber-600" />
                                        待核实风险
                                      </span>
                                    )}
                                  </div>

                                  {/* Action Buttons: Accept / Fix / Ignore */}
                                  <div
                                    className="flex items-center gap-1.5"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    {/* Accept Button */}
                                    <button
                                      type="button"
                                      onClick={() => handleSetItemAction(originalIndex, 'accepted')}
                                      className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg border transition-colors ${
                                        isAccepted
                                          ? 'bg-emerald-600 text-white border-emerald-600'
                                          : 'bg-white text-emerald-700 border-emerald-200 hover:bg-emerald-50'
                                      }`}
                                    >
                                      <Check className="w-3.5 h-3.5" />
                                      <span>{isAccepted ? '已核准' : '核准通过'}</span>
                                    </button>

                                    {/* Fix / Edit Button */}
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setEditingDraftItemIdx(isEditing ? null : originalIndex)
                                      }
                                      className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg border transition-colors ${
                                        isEditing
                                          ? 'bg-blue-600 text-white border-blue-600'
                                          : 'bg-white text-blue-700 border-blue-200 hover:bg-blue-50'
                                      }`}
                                    >
                                      <Edit3 className="w-3.5 h-3.5" />
                                      <span>{isEditing ? '收起编辑' : '修正'}</span>
                                    </button>

                                    {/* Ignore Button */}
                                    <button
                                      type="button"
                                      onClick={() =>
                                        handleSetItemAction(
                                          originalIndex,
                                          isIgnored ? 'pending' : 'ignored'
                                        )
                                      }
                                      className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg border transition-colors ${
                                        isIgnored
                                          ? 'bg-slate-700 text-white border-slate-700'
                                          : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                                      }`}
                                    >
                                      <EyeOff className="w-3.5 h-3.5" />
                                      <span>{isIgnored ? '已排除' : '忽略'}</span>
                                    </button>
                                  </div>
                                </div>

                                {/* Card Body: Normal view vs Inline Editing View */}
                                {isEditing ? (
                                  <div
                                    className="pt-3 space-y-3 text-xs"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5">
                                      <div>
                                        <label className="block text-slate-500 mb-1">题号</label>
                                        <input
                                          type="text"
                                          value={item.questionNumber}
                                          onChange={(e) =>
                                            handleUpdateDraftItem(originalIndex, { questionNumber: e.target.value })
                                          }
                                          className="w-full px-2 py-1.5 border border-slate-200 rounded-md"
                                        />
                                      </div>
                                      <div>
                                        <label className="block text-slate-500 mb-1">扣分</label>
                                        <input
                                          type="number"
                                          value={item.scoreLost}
                                          onChange={(e) =>
                                            handleUpdateDraftItem(originalIndex, { scoreLost: Number(e.target.value) })
                                          }
                                          className="w-full px-2 py-1.5 font-mono border border-slate-200 rounded-md"
                                        />
                                      </div>
                                      <div>
                                        <label className="block text-slate-500 mb-1">考点归属</label>
                                        <select
                                          value={item.knowledgeId}
                                          onChange={(e) =>
                                            handleUpdateDraftItem(originalIndex, { knowledgeId: e.target.value })
                                          }
                                          className="w-full px-2 py-1.5 border border-slate-200 rounded-md bg-white"
                                        >
                                          {subjectKpsForUpload.map((kp) => (
                                            <option key={kp.id} value={kp.id}>
                                              {kp.name}
                                            </option>
                                          ))}
                                        </select>
                                      </div>
                                      <div>
                                        <label className="block text-slate-500 mb-1">五维错因</label>
                                        <select
                                          value={item.errorType}
                                          onChange={(e) =>
                                            handleUpdateDraftItem(originalIndex, { errorType: e.target.value as ErrorType })
                                          }
                                          className="w-full px-2 py-1.5 border border-slate-200 rounded-md bg-white"
                                        >
                                          {ERROR_TYPES.map((et) => (
                                            <option key={et} value={et}>
                                              {et}
                                            </option>
                                          ))}
                                        </select>
                                      </div>
                                      <div>
                                        <label className="block text-slate-500 mb-1">置信度评级</label>
                                        <select
                                          value={item.confidence}
                                          onChange={(e) =>
                                            handleUpdateDraftItem(originalIndex, { confidence: e.target.value as ConfidenceLevel })
                                          }
                                          className="w-full px-2 py-1.5 border border-slate-200 rounded-md bg-white"
                                        >
                                          {CONFIDENCE_LEVELS.map((cl) => (
                                            <option key={cl} value={cl}>
                                              {cl}
                                            </option>
                                          ))}
                                        </select>
                                      </div>
                                    </div>

                                    <div>
                                      <label className="block text-slate-500 mb-1">题干识别文本</label>
                                      <input
                                        type="text"
                                        value={item.stem}
                                        onChange={(e) =>
                                          handleUpdateDraftItem(originalIndex, { stem: e.target.value })
                                        }
                                        className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md"
                                      />
                                    </div>

                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                                      <div>
                                        <label className="block text-slate-500 mb-1">学生作答</label>
                                        <input
                                          type="text"
                                          value={item.studentAnswer}
                                          onChange={(e) =>
                                            handleUpdateDraftItem(originalIndex, { studentAnswer: e.target.value })
                                          }
                                          className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md"
                                        />
                                      </div>
                                      <div>
                                        <label className="block text-slate-500 mb-1">AI 诊断归因</label>
                                        <input
                                          type="text"
                                          value={item.aiAnalysis}
                                          onChange={(e) =>
                                            handleUpdateDraftItem(originalIndex, { aiAnalysis: e.target.value })
                                          }
                                          className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md"
                                        />
                                      </div>
                                    </div>

                                    <div className="flex items-center justify-end gap-2 pt-1">
                                      <button
                                        type="button"
                                        onClick={() => setEditingDraftItemIdx(null)}
                                        className="px-3 py-1 text-xs text-slate-600 hover:text-slate-900 border border-slate-200 rounded-md"
                                      >
                                        取消
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => handleSetItemAction(originalIndex, 'fixed')}
                                        className="px-3 py-1 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md"
                                      >
                                        保存修改并标记已修正
                                      </button>
                                    </div>
                                  </div>
                                ) : (
                                  <div className="pt-2.5 text-xs text-slate-700 space-y-1.5">
                                    <div className="font-medium text-slate-900 flex items-start gap-1.5">
                                      <span className="text-slate-500 shrink-0">题干：</span>
                                      <span><MathText text={item.stem || '（未识别题干）'} /></span>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-slate-600">
                                      <div>
                                        <span className="text-slate-500">学生作答：</span>
                                        <span className="text-rose-600 font-medium">
                                          <MathText text={item.studentAnswer || '未作答/空白'} />
                                        </span>
                                      </div>
                                      {item.correctAnswer && (
                                        <div>
                                          <span className="text-slate-500">标准答案：</span>
                                          <span className="text-emerald-700 font-medium">
                                            <MathText text={item.correctAnswer} />
                                          </span>
                                        </div>
                                      )}
                                    </div>
                                    <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-100 text-slate-600">
                                      <span className="text-blue-700 font-semibold">AI 根因分析：</span>
                                      <span><MathText text={item.aiAnalysis || '知识点掌握不牢固，做题时缺乏清晰解题逻辑。'} /></span>
                                      {item.verificationMethod && (
                                        <div className="mt-1 text-[11px] text-slate-500">
                                          💡 建议验证方式：<MathText text={item.verificationMethod} />
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })
                        )}

                        {/* Pagination */}
                        <div className="p-3 bg-white border border-slate-200 rounded-lg">
                          <Pagination
                            currentPage={draftPagination.currentPage}
                            totalPages={draftPagination.totalPages}
                            totalItems={draftPagination.totalItems}
                            pageSize={draftPagination.pageSize}
                            onPageChange={setDraftItemPage}
                            onPageSizeChange={(newSize) => {
                              setDraftItemPageSize(newSize);
                              setDraftItemPage(1);
                            }}
                            pageSizeOptions={[3, 5, 10, 20]}
                            itemName="道题目"
                            compact
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {/* Tab 3: Score Baseline Entry */}
        {inputTab === 'score' && (
          <form onSubmit={handleScoreSubmit} className="space-y-4 pt-1">
            <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-medium text-slate-700">
                  选择成绩归属考试场次（同一次考试可分科录入五科成绩）
                </span>
                <div className="inline-flex items-center gap-1 p-0.5 bg-slate-200/70 rounded-md">
                  <button
                    type="button"
                    onClick={() => setScoreExamMode('existing')}
                    className={`px-2.5 py-1 text-xs rounded transition-colors ${
                      scoreExamMode === 'existing'
                        ? 'bg-white text-slate-900 font-medium shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    追加至已有考试
                  </button>
                  <button
                    type="button"
                    onClick={() => setScoreExamMode('new')}
                    className={`px-2.5 py-1 text-xs rounded transition-colors ${
                      scoreExamMode === 'new'
                        ? 'bg-white text-slate-900 font-medium shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    新建考试场次
                  </button>
                </div>
              </div>

              {scoreExamMode === 'existing' && sortedExams.length > 0 ? (
                <select
                  value={scoreExistingExamId}
                  onChange={(e) => setScoreExistingExamId(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:border-blue-600"
                >
                  {sortedExams.map((ex) => (
                    <option key={ex.id} value={ex.id}>
                      {ex.date} · {ex.type} · {ex.title}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">新考试名称</label>
                    <input
                      type="text"
                      value={scoreExamName}
                      onChange={(e) => setScoreExamName(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:border-blue-600"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">考试类型</label>
                    <select
                      value={scoreExamType}
                      onChange={(e) => setScoreExamType(e.target.value as Exam['type'])}
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:border-blue-600"
                    >
                      {EXAM_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">考试日期</label>
                    <input
                      type="date"
                      value={scoreDate}
                      onChange={(e) => setScoreDate(e.target.value)}
                      className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-200 rounded-lg bg-white focus:outline-none focus:border-blue-600"
                      required
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 items-end">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">学科</label>
                <select
                  value={scoreSubject}
                  onChange={(e) => setScoreSubject(e.target.value as Subject)}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:border-blue-600"
                >
                  {ALL_SUBJECTS.map((sub) => (
                    <option key={sub} value={sub}>
                      {sub}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">实得分数</label>
                <input
                  type="number"
                  value={scoreVal}
                  onChange={(e) => setScoreVal(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">卷面满分</label>
                <input
                  type="number"
                  value={fullScoreVal}
                  onChange={(e) => setFullScoreVal(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">阶段目标</label>
                <input
                  type="number"
                  value={targetScoreVal}
                  onChange={(e) => setTargetScoreVal(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
                  required
                />
              </div>
              <div>
                <button
                  type="submit"
                  className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>保存成绩基线</span>
                </button>
              </div>
            </div>
          </form>
        )}

        {/* Tab 4: Server-authoritative three-state adaptive diagnosis */}
        {inputTab === 'quiz' && (
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <p className="text-xs text-slate-600">
                当前共有{' '}
                <span className="font-semibold text-slate-900">
                  {unverifiedKps.length}
                </span>{' '}
                个置信度为「待验证/较可能」的考点，由服务端三态诊断引擎出题、判题与落库：
              </p>
            </div>

            <AdaptiveDiagnosisPanel
              studentId={studentId}
              targetKnowledgeIds={unverifiedKps.map((kp) => kp.id)}
              knowledgeNames={Object.fromEntries(
                SHANGHAI_CURRICULUM.map((kp) => [kp.id, kp.name])
              )}
              onMasteryUpdated={onMasteryUpdated}
              onLaunchCoach={onLaunchCoach}
            />
          </div>
        )}
      </section>

      {/* Section 2: Subject Diagnostic Report + Multi-Exam Archive */}
      <section className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">
              02. {selectedSubject}学科诊断报告与历次考试档案
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              支持按考试场次切换查看试卷诊断记录与成绩变化；知识掌握状态由多次独立作答证据更新
            </p>
          </div>

          <div className="inline-flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg self-start overflow-x-auto">
            {ALL_SUBJECTS.map((sub) => (
              <button
                key={sub}
                type="button"
                onClick={() => {
                  setSelectedSubject(sub);
                }}
                className={`px-4 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  selectedSubject === sub
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {sub}
              </button>
            ))}
          </div>
        </div>

        {/* Multi-Exam Diagnostic Archive Switcher */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-semibold text-slate-800">
              历次考试诊断记录（共 {sortedExams.length} 场考试 · 点击切换场次对比）
            </h3>
            <span className="text-xs text-slate-500 font-mono tabular-nums">
              当前视角：{activeExamObj ? `${activeExamObj.date} ${activeExamObj.title}` : '全部考试累计'}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <button
              type="button"
              onClick={() => {
                setSelectedExamFilter('all');
              }}
              className={`text-left p-3.5 rounded-lg border transition-colors ${
                selectedExamFilter === 'all'
                  ? 'border-blue-600 bg-blue-50/60'
                  : 'border-slate-200 bg-slate-50/40 hover:bg-slate-50'
              }`}
            >
              <div className="text-xs font-semibold text-slate-900">全部考试累计视图</div>
              <div className="text-xs text-slate-500 mt-1 font-mono tabular-nums">
                {selectedSubject}成绩 {subjectResults.length} 次 · 错题 {errorRecords.filter((e) => e.subject === selectedSubject).length} 道
              </div>
            </button>

            {sortedExams.map((ex) => {
              const exResultForSubject = examResults.find(
                (r) => r.examId === ex.id && r.subject === selectedSubject
              );
              const matchedPapers = examPapers.filter(
                (p) => p.examId === ex.id && p.subject === selectedSubject
              );
              const exPapersCount = matchedPapers.length;
              const exErrors = errorRecords.filter(
                (e) =>
                  e.subject === selectedSubject &&
                  (e.examId === ex.id || e.examTitle === ex.title)
              );
              const exLostTotal = exErrors.reduce((s, e) => s + e.scoreLost, 0);
              const isSelected = selectedExamFilter === ex.id;

              return (
                <button
                  key={ex.id}
                  type="button"
                  onClick={() => {
                    setSelectedExamFilter(ex.id);
                  }}
                  className={`text-left p-3.5 rounded-lg border transition-colors ${
                    isSelected
                      ? 'border-blue-600 bg-blue-50/60'
                      : 'border-slate-200 bg-white hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 text-xs text-slate-500 font-mono tabular-nums">
                    <span>{ex.date}</span>
                    <span>{ex.type}</span>
                  </div>
                  <div className="text-xs font-semibold text-slate-900 mt-1 truncate">
                    {ex.title}
                  </div>
                  <div className="text-xs text-slate-600 mt-1 font-mono tabular-nums">
                    {exResultForSubject
                      ? `${exResultForSubject.score}/${exResultForSubject.fullScore}分`
                      : '未录分'}{' '}
                    · {exPapersCount}卷 · {exErrors.length}错题(-{exLostTotal}分)
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* 3 Score Baseline Metrics */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <div className="text-xs text-slate-500">
              {selectedExamFilter === 'all' ? '最近成绩' : '该场成绩'}（
              {displayedResult?.examTitle ?? activeExamObj?.title ?? '暂无该科成绩记录'}）
            </div>
            <div className="mt-2 flex items-baseline gap-2.5">
              <div className="text-3xl font-bold font-mono tabular-nums text-slate-900">
                {displayedResult ? currentScore : '--'}
                <span className="text-sm font-normal text-slate-400 ml-1">/ {fullScore}</span>
              </div>
              {scoreDeltaVsPrev !== null && scoreDeltaVsPrev !== 0 && (
                <span
                  className={`text-xs font-semibold font-mono tabular-nums ${
                    scoreDeltaVsPrev > 0 ? 'text-emerald-700' : 'text-red-700'
                  }`}
                >
                  {scoreDeltaVsPrev > 0 ? `较上次 +${scoreDeltaVsPrev}分` : `较上次 ${scoreDeltaVsPrev}分`}
                </span>
              )}
            </div>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <div className="text-xs text-slate-500">阶段目标</div>
            <div className="mt-2 text-3xl font-bold font-mono tabular-nums text-blue-700">
              {targetScore}
              <span className="text-sm font-normal text-slate-400 ml-1">/ {fullScore}</span>
            </div>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <div className="text-xs text-slate-500">目标差距</div>
            <div className="mt-2 text-3xl font-bold font-mono tabular-nums text-slate-900">
              {displayedResult ? scoreGap : '--'}
              <span className="text-sm font-normal text-slate-500 ml-1">分</span>
            </div>
          </div>
        </div>

        {/* Linked ExamPaper Analysis Archives */}
        {subjectPapersForView.length > 0 && (
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-slate-800">
                关联试卷分析存档（{subjectPapersForView.length} 份 · 支持展开追溯原始文本/错因构成/掌握进展）
              </h3>
            </div>
            <div className="space-y-3">
              {paginatedSubjectPapers.map((paper) => {
                const isExpanded = expandedPaperId === paper.id;
                const linkedPaperErrors = errorRecords.filter(
                  (err) =>
                    err.examPaperId === paper.id ||
                    (err.examId === paper.examId && err.subject === paper.subject)
                );
                const paperKnowledgeIds =
                  paper.knowledgeIds && paper.knowledgeIds.length > 0
                    ? paper.knowledgeIds
                    : Array.from(new Set(linkedPaperErrors.map((e) => e.knowledgeId)));

                return (
                  <div
                    key={paper.id}
                    className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-3 text-xs"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                      <div>
                        <div className="font-semibold text-slate-900 text-sm">
                          {paper.title}
                        </div>
                        <div className="text-slate-500 mt-0.5 font-mono tabular-nums">
                          {paper.date}
                          {paper.examType ? ` · ${paper.examType}` : ''}
                          {' · '}
                          {paper.sourceFormat ?? (paper.imageUrl ? '试卷拍照' : '文本试卷')}
                          {paper.score !== undefined && paper.fullScore !== undefined
                            ? ` · 得分 ${paper.score}/${paper.fullScore}`
                            : ''}
                          {` · 识别 ${paper.questionsCount} 题 · 累计失分 -${paper.totalLostScore}分`}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">
                        {onNavigate && (
                          <button
                            type="button"
                            onClick={() => onNavigate('knowledge')}
                            className="px-3 py-1.5 text-xs font-medium text-slate-800 bg-white hover:bg-slate-100 border border-slate-200 rounded-lg transition-colors whitespace-nowrap"
                          >
                            在知识图谱定位问题
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedPaperId(isExpanded ? null : paper.id)
                          }
                          className="px-3 py-1.5 text-xs font-medium text-blue-700 bg-white hover:bg-blue-50 border border-slate-200 rounded-lg transition-colors whitespace-nowrap"
                        >
                          {isExpanded ? '收起存档详情' : '查看完整分析存档'}
                        </button>
                      </div>
                    </div>

                    <p className="text-slate-700 leading-relaxed"><MathText text={paper.summary} /></p>

                    {isExpanded && (
                      <div className="pt-3 border-t border-slate-200 space-y-3">
                        {paperKnowledgeIds.length > 0 && (
                          <div className="space-y-1.5">
                            <div className="font-semibold text-slate-800">
                              本卷诊断涉及知识点及当前巩固进展：
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                              {paperKnowledgeIds.map((kpId) => {
                                const kp = KNOWLEDGE_MAP[kpId];
                                const rec = masteryRecords[kpId];
                                if (!kp) return null;
                                return (
                                  <div
                                    key={kpId}
                                    className="p-2.5 bg-white border border-slate-200 rounded-md flex items-center justify-between gap-2"
                                  >
                                    <div>
                                      <div className="font-medium text-slate-900">{kp.name}</div>
                                      <div className="text-slate-500">
                                        当前状态：{rec?.state ?? '未诊断'}
                                      </div>
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() => onLaunchCoach(kpId)}
                                      className="text-blue-700 hover:underline shrink-0"
                                    >
                                      去训练
                                    </button>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {linkedPaperErrors.length > 0 && (
                          <div className="space-y-1.5">
                            <div className="font-semibold text-slate-800">
                              本卷归因错题记录（{linkedPaperErrors.length} 道）：
                            </div>
                            <div className="space-y-1.5">
                              {linkedPaperErrors.map((err) => (
                                <div
                                  key={err.id}
                                  className="p-2.5 bg-white border border-slate-200 rounded-md flex items-center justify-between gap-2"
                                >
                                  <span className="text-slate-800 truncate">
                                    {err.questionNumber} · {err.knowledgeName} · {err.errorType}（-{err.scoreLost}分）
                                  </span>
                                  <span
                                    className={`shrink-0 font-medium ${
                                      err.status === '已闭环' || err.status === '已订正'
                                        ? 'text-emerald-700'
                                        : 'text-amber-700'
                                    }`}
                                  >
                                    {err.status}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {paper.rawText && (
                          <div className="space-y-1">
                            <div className="font-semibold text-slate-800">
                              已存档原始解析文本：
                            </div>
                            <pre className="p-3 bg-white border border-slate-200 rounded-md text-xs text-slate-600 whitespace-pre-wrap max-h-44 overflow-y-auto font-mono leading-relaxed">
                              {paper.rawText}
                            </pre>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="pt-2">
              <Pagination
                currentPage={paperPagination.currentPage}
                totalPages={paperPagination.totalPages}
                totalItems={paperPagination.totalItems}
                pageSize={paperPagination.pageSize}
                onPageChange={setPaperPage}
                onPageSizeChange={(newSize) => {
                  setPaperPageSize(newSize);
                  setPaperPage(1);
                }}
                pageSizeOptions={[3, 5, 10]}
                itemName="份试卷"
                compact
              />
            </div>
          </div>
        )}

        {/* Knowledge Graph & Matrix Link Banner */}
        {onNavigate && (
          <div className="bg-gradient-to-r from-blue-50/80 via-indigo-50/50 to-white border border-blue-200/80 rounded-xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 shadow-xs">
            <div className="flex items-start sm:items-center gap-3">
              <span className="p-2.5 bg-blue-600 text-white rounded-xl shadow-xs shrink-0">
                <Sparkles className="w-5 h-5" />
              </span>
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  知识点与学科知识图谱已作为独立页面运行
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  已将考点脉络、知识图谱思维导图、全量掌握度状态机及先修链阻断溯源从试卷诊断中独立分离，支持全屏沉浸式探索。
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('knowledge')}
              className="px-4 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors whitespace-nowrap self-start sm:self-auto flex items-center gap-1.5 shadow-xs"
            >
              前往知识图谱
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Structured Error Attribution List */}
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                结构化失分归因与证据链（{activeExamObj ? activeExamObj.title : '全部考试'} · 共 {subjectErrors.length} 条记录）
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                明确区分知识问题、方法问题、计算问题、熟练度问题与审题问题
              </p>
            </div>
            {subjectPapersForView.length > 0 && (
              <span className="text-xs text-slate-500">
                关联试卷：{subjectPapersForView[0].title}
              </span>
            )}
          </div>

          {subjectErrors.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-500">
              当前学科暂无错题诊断记录，可在上方上传试卷或录入错题。
            </div>
          ) : (
            <div>
              <div className="divide-y divide-slate-100">
                {paginatedSubjectErrors.map((err) => (
                  <div key={err.id} className="p-6 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-slate-900">
                          {err.examTitle} · {err.questionNumber}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>归属知识点：{err.knowledgeName}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-semibold text-red-700">
                          错因类型：{err.errorType}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 font-mono tabular-nums">
                        <span>失分 -{err.scoreLost} 分</span>
                        <span aria-hidden="true">|</span>
                        <span
                          className={
                            err.confidence === '确定'
                              ? 'text-slate-900 font-medium'
                              : 'text-amber-700 font-medium'
                          }
                        >
                          置信度：{err.confidence}
                        </span>
                      </div>
                    </div>

                    <div className="text-sm text-slate-900 bg-slate-50 border border-slate-100 rounded-lg p-3.5 leading-relaxed">
                      <MathText text={err.stem} />
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                      <div className="p-3 border border-slate-100 rounded-lg">
                        <span className="text-slate-500">学生作答：</span>
                        <span className="text-slate-800"><MathText text={err.studentAnswer} /></span>
                      </div>
                      <div className="p-3 border border-slate-100 rounded-lg">
                        <span className="text-slate-500">规范参考：</span>
                        <span className="text-emerald-800 font-medium"><MathText text={err.correctAnswer} /></span>
                      </div>
                    </div>

                    <div className="text-xs text-slate-700 space-y-1 leading-relaxed">
                      <div>
                        <span className="font-semibold text-slate-900">证据：</span>
                        <MathText text={err.evidence} />
                      </div>
                      <div>
                        <span className="font-semibold text-slate-900">判断：</span>
                        <MathText text={err.aiAnalysis} />
                      </div>
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pt-1">
                        <div>
                          <span className="font-semibold text-slate-900">建议验证方式：</span>
                          <MathText text={err.verificationMethod} />
                        </div>
                        <div className="flex items-center gap-2 self-start sm:self-auto flex-wrap">
                          {onNavigate && (
                            <button
                              type="button"
                              onClick={() => onNavigate('knowledge')}
                              className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap"
                            >
                              在知识图谱查看
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => onLaunchCoach(err.knowledgeId)}
                            className="px-3.5 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors whitespace-nowrap"
                          >
                            进入 AI 教练针对性攻克
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="px-6 py-3 border-t border-slate-100 bg-slate-50/50">
                <Pagination
                  currentPage={errorPagination.currentPage}
                  totalPages={errorPagination.totalPages}
                  totalItems={errorPagination.totalItems}
                  pageSize={errorPagination.pageSize}
                  onPageChange={setErrorPage}
                  onPageSizeChange={(newSize) => {
                    setErrorPageSize(newSize);
                    setErrorPage(1);
                  }}
                  pageSizeOptions={[5, 10, 20]}
                  itemName="道错题"
                />
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
