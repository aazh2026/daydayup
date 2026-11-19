/**
 * 题庄（tizhuang）在线真题服务客户端。
 *
 * ── 服务定位 ──────────────────────────────────────────────────────────────
 *
 * 项目自带题库（`data/questions/`）是**教材配套题**，颗粒度按知识点走；
 * 题庄是**真实中考真题**，按「知识点树」组织，是同一批知识点的一次考试化重述。
 * 两者互补：本地题库保证离线可用，题庄提供真题与真题难度。
 *
 * ── 鉴权优先级（与题庄 Skill 的 Python 实现保持一致）──────────────────────
 *
 * 1. 配置了 `QUESTION_SERVICE_LICENSE`（或 `opts.license`）→ 请求头 `X-API-Key`，
 *    走已注册接口 `GET /v1/questions`（每日 150 题起）；
 * 2. 否则走匿名试用：先 `POST /v1/trials`（请求头 `X-Anonymous-Client-ID`）
 *    拿 `trial_token`，再带 `X-Trial-Token` 调 `GET /v1/trial/questions`（每日 50 题）。
 *
 * 试用令牌**必须本地缓存复用**（`data/tizhuang/trial.json`）：
 * 每天重新申请会浪费试用额度且被服务端视为滥用。
 * 缓存里记录 `expires_at`，过期才重新申请；`anonymous_client_id` 也复用
 * （题庄文档明确要求「不要轮换 ID 规避限额」）。
 *
 * ── 配额纪律 ──────────────────────────────────────────────────────────────
 *
 * 匿名试用一天只有 50 题，是**稀缺资源**。因此：
 * - 客户端不做自动重试（重试只会再烧配额）；
 * - 任何失败都抛**带 code 的错误**，绝不静默返回空数组（空数组会让上层
 *   误以为「题库里没有这道题」，从而放弃降级策略）。
 * - 取题结果必须落本地缓存（见 `tizhuang-cache.ts`），默认「缓存优先」。
 *
 * ── 单测友好 ──────────────────────────────────────────────────────────────
 *
 * `opts.fetchImpl` 可注入假 fetch，测试全程不联网。
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from '../knowledge/asset-dirs.ts';

// ---------------------------------------------------------------------------
// 错误类型
// ---------------------------------------------------------------------------

export type TizhuangErrorCode =
  /** 鉴权失败（401/403、令牌无效、license 无效） */
  | 'TIZHUANG_AUTH_FAILED'
  /** 配额耗尽（超出配额 / quota_remaining_today <= 0） */
  | 'TIZHUANG_QUOTA_EXCEEDED'
  /** 服务不可达（网络异常、超时、非 2xx 且非鉴权/配额） */
  | 'TIZHUANG_UNAVAILABLE'
  /** 响应不是预期形状（JSON 解析失败、缺少 items） */
  | 'TIZHUANG_BAD_RESPONSE';

export interface TizhuangErrorOptions {
  /** HTTP 状态码（网络异常时没有） */
  status?: number;
  /** 服务端返回的 detail 原文 */
  detail?: string;
  /** 今日剩余配额（配额类错误时给出） */
  quotaRemaining?: number | null;
}

export class TizhuangError extends Error {
  readonly code: TizhuangErrorCode;
  readonly status?: number;
  readonly detail?: string;
  readonly quotaRemaining: number | null;

  constructor(
    code: TizhuangErrorCode,
    message: string,
    options: TizhuangErrorOptions = {}
  ) {
    super(message);
    this.name = 'TizhuangError';
    this.code = code;
    this.status = options.status;
    this.detail = options.detail;
    this.quotaRemaining =
      options.quotaRemaining === undefined ? null : options.quotaRemaining;
  }
}

// ---------------------------------------------------------------------------
// 配置与常量
// ---------------------------------------------------------------------------

export const TIZHUANG_DEFAULT_BASE_URL = 'https://tizhuang.qcscience.cc/api';
export const TIZHUANG_DEFAULT_TIMEOUT_MS = 15_000;
/** 题庄题目列表单页上限 */
export const TIZHUANG_MAX_LIMIT = 100;

/** 项目学科 → 题庄 subject_id */
export const TIZHUANG_SUBJECT_IDS: Record<string, number> = {
  语文: 1,
  数学: 2,
  英语: 3,
  物理: 8,
  化学: 9,
};

/** 最小可注入的 fetch 形状（避免依赖 DOM lib） */
export interface TizhuangResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  }
) => Promise<TizhuangResponseLike>;

export interface TizhuangConfig {
  /** 题庄 API 根地址，默认 `https://tizhuang.qcscience.cc/api` */
  baseUrl?: string;
  /** 已注册 license（优先级高于匿名试用）；默认取环境变量 QUESTION_SERVICE_LICENSE */
  license?: string;
  /** 试用令牌缓存文件路径，默认 `<DATA_DIR>/tizhuang/trial.json` */
  trialTokenFile?: string;
  /** 单次请求超时（毫秒），默认 15000 */
  timeoutMs?: number;
  /** 注入的 fetch 实现（测试用，不联网） */
  fetchImpl?: FetchLike;
  /** 匿名 client id（默认复用缓存里的，其次随机生成） */
  clientId?: string;
  /** 当前时间（测试用，便于构造过期场景） */
  now?: () => Date;
}

export interface TizhuangQuestion {
  /** 题庄侧的数字 id（唯一键） */
  externalId: number;
  /** 题干（已去标签、解实体） */
  stem: string;
  /**
   * 选项，按 A/B/C… 排序，保留字母标签，形如 `['A. Both，and', 'B. Either，or']`。
   *
   * 选择「带标签的字符串数组」而不是 `{label,text}` 对象数组：
   * contracts 的 `Question.options` 就是 `string[]`，映射时零损耗。
   */
  options?: string[];
  /** 标准答案（原文，可能是字母 'B' 或一段文本） */
  answer: string;
  /** 解析（已去标签、解实体） */
  analysis?: string;
  /** 题庄题型名（中文，如 '选择题'、'阅读理解'） */
  questionType: string;
  /** 难度 0-5（题庄口径，可能是小数） */
  difficulty: number;
  year?: number;
  source?: string;
  paperType?: string;
  /** 题庄知识点名（逗号分隔拆开） */
  knowledgeNames: string[];
  /** 是否可自动判分 */
  autoGradable: boolean;
  hasImages: boolean;
  imageUrls: string[];
}

export interface TizhuangKnowledgePoint {
  /** 知识点树节点 id（用于 knowledge_tree_id 过滤） */
  id: number;
  /** 精确知识点 id（用于 knowledge_id 过滤） */
  knowledgeId: number;
  name: string;
  parentId: number;
  level: number;
  hasChildren: boolean;
}

export interface TizhuangQuestionParams {
  subjectId?: number;
  gradeId?: number;
  knowledgeId?: number;
  questionType?: number;
  keyword?: string;
  year?: number;
  limit?: number;
  offset?: number;
  randomOrder?: boolean;
}

export interface TizhuangFetchResult {
  items: TizhuangQuestion[];
  /** 今日剩余配额；服务端未给则为 null */
  quotaRemaining: number | null;
  /** 实际使用的鉴权模式 */
  mode: 'license' | 'trial';
}

// ---------------------------------------------------------------------------
// HTML 处理（不引依赖）
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  middot: '·',
  bull: '•',
  laquo: '«',
  raquo: '»',
  deg: '°',
  times: '×',
  divide: '÷',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  shy: '',
  copy: '©',
  reg: '®',
  trade: '™',
};

/**
 * 解码 HTML 实体（最小实现，不引依赖）。
 *
 * 支持 `&name;`、`&#123;`、`&#x1F600;` 三种写法。
 */
export function decodeHtmlEntities(input: string): string {
  if (!input) return '';
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? safeFromCodePoint(code, m) : m;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? safeFromCodePoint(code, m) : m;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? m : named;
  });
}

function safeFromCodePoint(code: number, fallback: string): string {
  if (code < 0 || code > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

/**
 * 把题庄的富文本（带 `<U>` / `<br />` / `&nbsp;`）转成可读纯文本。
 *
 * 步骤：换行标签 → 段落结束 → 去其余标签 → 解实体 → 规整空白。
 */
export function htmlToText(input: string): string {
  if (!input) return '';
  let text = input.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/p>/gi, '\n');
  text = text.replace(/<[^>]*>/g, '');
  text = decodeHtmlEntities(text);
  // 行内多余空白（含不换行空格）压成单个空格
  text = text.replace(/[ \t ]+/g, ' ');
  // 去掉行首尾空格，但保留换行结构
  text = text
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

/** options 对象 → 有序字符串数组（`A. xxx`） */
export function normalizeOptions(options: unknown): string[] | undefined {
  if (!options || typeof options !== 'object') return undefined;
  const entries = Object.entries(options as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '')
    .map(([label, value]) => ({
      label: label.trim(),
      text: htmlToText(String(value)),
    }));
  if (entries.length === 0) return undefined;
  entries.sort((a, b) => a.label.localeCompare(b.label, 'en'));
  return entries.map((e) => `${e.label}. ${e.text}`);
}

// ---------------------------------------------------------------------------
// 试用令牌缓存
// ---------------------------------------------------------------------------

interface TrialCacheFile {
  base_url?: string;
  trial_token?: string;
  expires_at?: string;
  anonymous_client_id?: string;
  question_limit?: number;
}

function defaultTrialTokenFile(): string {
  return path.join(resolveDataDir(), 'tizhuang', 'trial.json');
}

function readTrialCache(file: string): TrialCacheFile | null {
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as TrialCacheFile;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeTrialCache(file: string, data: TrialCacheFile): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch {
    // 缓存写失败不应阻断取题（下次会重新申请试用）
  }
}

function randomClientId(): string {
  const bytes = new Uint8Array(18);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return `ddu-${Buffer.from(bytes).toString('base64url')}`;
}

function isExpired(expiresAt: string | undefined, now: Date): boolean {
  if (!expiresAt) return true;
  const ts = Date.parse(expiresAt);
  if (!Number.isFinite(ts)) return true;
  return ts <= now.getTime();
}

/**
 * 取到可用的试用令牌：命中缓存且未过期则复用，否则重新申请。
 *
 * 重新申请时**复用**缓存里的 `anonymous_client_id`（题庄明确要求不要轮换身份）。
 */
async function ensureTrialToken(config: TizhuangConfig): Promise<string> {
  const file = config.trialTokenFile ?? defaultTrialTokenFile();
  const now = config.now ? config.now() : new Date();
  const cached = readTrialCache(file);

  if (
    cached?.trial_token &&
    cached.base_url === resolveBaseUrl(config) &&
    !isExpired(cached.expires_at, now)
  ) {
    return cached.trial_token;
  }

  const clientId =
    config.clientId ?? cached?.anonymous_client_id ?? randomClientId();

  const data = await requestJson(
    `${resolveBaseUrl(config)}/v1/trials`,
    {
      method: 'POST',
      headers: { 'X-Anonymous-Client-ID': clientId },
    },
    config
  );

  if (!data.ok) {
    throw data.error;
  }

  const body = (data.body ?? {}) as {
    trial_token?: string;
    expires_at?: string;
    question_limit?: number;
  };
  if (!body.trial_token) {
    throw new TizhuangError(
      'TIZHUANG_BAD_RESPONSE',
      '题庄试用申请未返回 trial_token',
      { detail: JSON.stringify(body).slice(0, 200) }
    );
  }

  writeTrialCache(file, {
    base_url: resolveBaseUrl(config),
    trial_token: body.trial_token,
    expires_at: body.expires_at,
    anonymous_client_id: clientId,
    question_limit: body.question_limit,
  });

  return body.trial_token;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function resolveBaseUrl(config: TizhuangConfig): string {
  const raw =
    config.baseUrl ?? process.env.QUESTION_SERVICE_URL ?? TIZHUANG_DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, '');
}

function resolveFetch(config: TizhuangConfig): FetchLike {
  const impl = config.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (typeof impl !== 'function') {
    throw new TizhuangError(
      'TIZHUANG_UNAVAILABLE',
      '当前运行时没有可用的 fetch 实现'
    );
  }
  return impl;
}

function resolveLicense(config: TizhuangConfig): string | undefined {
  const raw = config.license ?? process.env.QUESTION_SERVICE_LICENSE;
  return raw && raw.trim() ? raw.trim() : undefined;
}

interface HttpResult {
  ok: boolean;
  body: unknown;
  error?: TizhuangError;
}

/**
 * 统一的请求入口：超时、网络异常、非 2xx、JSON 解析失败都转成 TizhuangError。
 */
async function requestJson(
  url: string,
  init: { method?: string; headers?: Record<string, string> },
  config: TizhuangConfig
): Promise<HttpResult> {
  const doFetch = resolveFetch(config);
  const timeoutMs = config.timeoutMs ?? TIZHUANG_DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: TizhuangResponseLike;
  try {
    response = await doFetch(url, {
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = controller.signal.aborted;
    throw new TizhuangError(
      'TIZHUANG_UNAVAILABLE',
      aborted
        ? `题庄请求超时（${timeoutMs}ms）: ${url}`
        : `题庄请求失败: ${err instanceof Error ? err.message : String(err)}`,
      { detail: err instanceof Error ? err.message : String(err) }
    );
  } finally {
    clearTimeout(timer);
  }

  let text = '';
  try {
    text = await response.text();
  } catch (err) {
    throw new TizhuangError(
      'TIZHUANG_UNAVAILABLE',
      `题庄响应读取失败: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  let body: unknown = undefined;
  let parseFailed = false;
  if (text && text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      parseFailed = true;
    }
  }

  if (!response.ok) {
    const detail = extractDetail(body) ?? text.slice(0, 300);
    if (response.status === 401 || response.status === 403) {
      throw new TizhuangError(
        'TIZHUANG_AUTH_FAILED',
        `题庄鉴权失败（HTTP ${response.status}）`,
        { status: response.status, detail }
      );
    }
    if (isQuotaDetail(detail) || response.status === 429) {
      throw new TizhuangError(
        'TIZHUANG_QUOTA_EXCEEDED',
        `题庄配额不足（HTTP ${response.status}）`,
        { status: response.status, detail }
      );
    }
    throw new TizhuangError(
      'TIZHUANG_UNAVAILABLE',
      `题庄返回 HTTP ${response.status}`,
      { status: response.status, detail }
    );
  }

  if (parseFailed) {
    throw new TizhuangError(
      'TIZHUANG_BAD_RESPONSE',
      '题庄响应不是合法 JSON',
      { status: response.status, detail: text.slice(0, 200) }
    );
  }

  return { ok: true, body };
}

function extractDetail(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const detail = (body as { detail?: unknown }).detail;
  if (typeof detail === 'string') return detail;
  if (detail !== undefined) return JSON.stringify(detail).slice(0, 300);
  return undefined;
}

function isQuotaDetail(detail: string | undefined): boolean {
  if (!detail) return false;
  return /配额|quota|超出|limit exceeded|too many/i.test(detail);
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

/**
 * 拉取题庄题目。
 *
 * @param params 过滤参数（见题庄 API：`subject_id` / `knowledge_id` / ... ）
 * @param opts   配置与依赖注入（测试注入假 fetch）
 */
export async function fetchTizhuangQuestions(
  params: TizhuangQuestionParams,
  opts?: TizhuangConfig
): Promise<TizhuangFetchResult> {
  const config: TizhuangConfig = opts ?? {};
  const license = resolveLicense(config);
  const mode: 'license' | 'trial' = license ? 'license' : 'trial';

  const headers: Record<string, string> = {};
  let path: string;

  if (license) {
    headers['X-API-Key'] = license;
    path = '/v1/questions';
  } else {
    headers['X-Trial-Token'] = await ensureTrialToken(config);
    path = '/v1/trial/questions';
  }

  const query = new URLSearchParams();
  if (params.subjectId !== undefined) query.set('subject_id', String(params.subjectId));
  if (params.gradeId !== undefined) query.set('grade_id', String(params.gradeId));
  if (params.knowledgeId !== undefined) query.set('knowledge_id', String(params.knowledgeId));
  if (params.questionType !== undefined) query.set('question_type', String(params.questionType));
  if (params.keyword !== undefined) query.set('keyword', params.keyword);
  if (params.year !== undefined) query.set('year', String(params.year));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.offset !== undefined) query.set('offset', String(params.offset));
  if (params.randomOrder !== undefined) query.set('random_order', String(params.randomOrder));

  const qs = query.toString();
  const url = `${resolveBaseUrl(config)}${path}${qs ? `?${qs}` : ''}`;

  const result = await requestJson(url, { method: 'GET', headers }, config);
  const body = (result.body ?? {}) as {
    items?: unknown[];
    count?: number;
    quota_remaining_today?: number;
    quota_used_today?: number;
  };

  if (!Array.isArray(body.items)) {
    throw new TizhuangError(
      'TIZHUANG_BAD_RESPONSE',
      '题庄题目响应缺少 items 数组',
      { detail: JSON.stringify(body).slice(0, 200) }
    );
  }

  const quotaRemaining =
    typeof body.quota_remaining_today === 'number'
      ? body.quota_remaining_today
      : null;

  const items = body.items
    .map((raw) => normalizeQuestion(raw))
    .filter((q): q is TizhuangQuestion => q !== null);

  // 配额耗尽：没有取到任何题且明确告知配额为 0 → 抛配额错误（不是「没命中」）。
  // 注意：**取到了题就不抛** —— 配额刚好用完时题已经拿到，丢掉才是真浪费。
  if (items.length === 0 && quotaRemaining !== null && quotaRemaining <= 0) {
    throw new TizhuangError('TIZHUANG_QUOTA_EXCEEDED', '题庄今日配额已用尽', {
      quotaRemaining,
    });
  }

  return { items, quotaRemaining, mode };
}

/**
 * 拉取题庄知识点树（公开元数据，不需要鉴权，也不消耗配额）。
 */
export async function fetchTizhuangKnowledgePoints(
  subjectId: number,
  opts?: TizhuangConfig & { limit?: number }
): Promise<TizhuangKnowledgePoint[]> {
  const config: TizhuangConfig = opts ?? {};
  const limit = opts?.limit ?? 1000;
  const query = new URLSearchParams({
    subject_id: String(subjectId),
    limit: String(limit),
  });

  const result = await requestJson(
    `${resolveBaseUrl(config)}/v1/meta/knowledge-points?${query.toString()}`,
    { method: 'GET', headers: {} },
    config
  );

  const raw = Array.isArray(result.body)
    ? result.body
    : ((result.body as { items?: unknown[] })?.items ?? null);
  if (!Array.isArray(raw)) {
    throw new TizhuangError(
      'TIZHUANG_BAD_RESPONSE',
      '题庄知识点响应不是数组',
      { detail: JSON.stringify(result.body).slice(0, 200) }
    );
  }

  const out: TizhuangKnowledgePoint[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const id = Number(rec.id);
    const knowledgeId = Number(rec.knowledge_id);
    if (!Number.isFinite(id) || !Number.isFinite(knowledgeId)) continue;
    out.push({
      id,
      knowledgeId,
      name: String(rec.name ?? '').trim(),
      parentId: Number(rec.parent_id ?? 0),
      level: Number(rec.level ?? 0),
      hasChildren: Boolean(rec.has_children),
    });
  }
  return out;
}

/** 把题庄原始 item 规整为 TizhuangQuestion */
export function normalizeQuestion(raw: unknown): TizhuangQuestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const externalId = Number(rec.id);
  if (!Number.isFinite(externalId)) return null;

  const knowledges = String(rec.knowledges ?? '')
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);

  const options = normalizeOptions(rec.options);

  return {
    externalId,
    stem: htmlToText(String(rec.title ?? '')),
    options,
    answer: htmlToText(String(rec.answer ?? '')),
    analysis: rec.analysis ? htmlToText(String(rec.analysis)) : undefined,
    questionType: String(rec.question_type ?? '').trim(),
    difficulty: Number(rec.difficulty ?? 0),
    year: Number.isFinite(Number(rec.year)) ? Number(rec.year) : undefined,
    source: rec.source ? String(rec.source).trim() : undefined,
    paperType: rec.paper_type ? String(rec.paper_type).trim() : undefined,
    knowledgeNames: knowledges,
    autoGradable: Boolean(rec.is_auto_gradable),
    hasImages: Boolean(rec.has_images),
    imageUrls: Array.isArray(rec.image_urls)
      ? (rec.image_urls as unknown[]).map((u) => String(u)).filter(Boolean)
      : [],
  };
}
