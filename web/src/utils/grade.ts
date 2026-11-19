export interface GradeInfo {
  stage: '小学' | '初中' | '高中';
  grade: '初三' | '初二' | '初一' | '小学' | '高中';
  label: string;
}

/** 年级/学段筛选项，id 可直接用于过滤（'all' 表示不限制） */
export interface GradeOption {
  id: string;
  label: string;
  count: number;
}

/** 仅依赖章节字段即可解析年级的最小结构 */
export interface GradeResolveInput {
  chapter?: string;
}

export function resolveGradeInfo(chapter: string): GradeInfo {
  const ch = chapter || '';
  if (/九年级|初三|九上|九下|九全/.test(ch)) {
    return { stage: '初中', grade: '初三', label: '初三（九年级）' };
  }
  if (/八年级|初二|八上|八下|八全/.test(ch)) {
    return { stage: '初中', grade: '初二', label: '初二（八年级）' };
  }
  if (/七年级|初一|七上|七下/.test(ch)) {
    return { stage: '初中', grade: '初一', label: '初一（七年级）' };
  }
  if (
    /六年级|六上|六下|五年级|五上|五下|四年级|四上|四下|三年级|三上|三下|二年级|二上|二下|一年级|一上|一下/.test(
      ch
    )
  ) {
    return { stage: '小学', grade: '小学', label: '小学阶段' };
  }
  if (/高一|高二|高三|必修|选择性必修|选必/.test(ch)) {
    return { stage: '高中', grade: '高中', label: '高中阶段' };
  }
  return { stage: '初中', grade: '初三', label: '初三（九年级）' };
}

/**
 * 依据知识点集合统计可用的年级/学段筛选项。
 * 仅当某个选项确有考点时才产出，避免出现空筛选项。
 */
export function buildGradeOptions(kps: GradeResolveInput[]): GradeOption[] {
  const counts = {
    all: kps.length,
    初三: 0,
    初二: 0,
    初一: 0,
    junior: 0,
    primary: 0,
    senior: 0,
  };

  for (const kp of kps) {
    const info = resolveGradeInfo(kp.chapter ?? '');
    if (info.grade === '初三') counts['初三']++;
    if (info.grade === '初二') counts['初二']++;
    if (info.grade === '初一') counts['初一']++;
    if (info.stage === '初中') counts.junior++;
    if (info.stage === '小学') counts.primary++;
    if (info.stage === '高中') counts.senior++;
  }

  const options: GradeOption[] = [{ id: 'all', label: '全部年级', count: counts.all }];

  if (counts['初三'] > 0) {
    options.push({ id: '初三', label: '初三（九年级）', count: counts['初三'] });
  }
  if (counts['初二'] > 0) {
    options.push({ id: '初二', label: '初二（八年级）', count: counts['初二'] });
  }
  if (counts['初一'] > 0) {
    options.push({ id: '初一', label: '初一（七年级）', count: counts['初一'] });
  }

  const juniorGradeCount =
    (counts['初三'] > 0 ? 1 : 0) +
    (counts['初二'] > 0 ? 1 : 0) +
    (counts['初一'] > 0 ? 1 : 0);
  if (juniorGradeCount > 1 && counts.junior > counts['初三']) {
    options.push({
      id: 'junior',
      label: '初中全学段（七~九年级）',
      count: counts.junior,
    });
  }
  if (counts.primary > 0) {
    options.push({
      id: 'primary',
      label: '小学阶段（先修回溯）',
      count: counts.primary,
    });
  }
  if (counts.senior > 0) {
    options.push({
      id: 'senior',
      label: '高中阶段（衔接拓展）',
      count: counts.senior,
    });
  }

  return options;
}

/** 按年级/学段筛选项过滤知识点集合，'all' 表示不限制 */
export function filterByGrade<T extends GradeResolveInput>(
  kps: T[],
  gradeId: string
): T[] {
  if (!gradeId || gradeId === 'all') return kps;
  return kps.filter((kp) => {
    const info = resolveGradeInfo(kp.chapter ?? '');
    if (gradeId === 'junior') return info.stage === '初中';
    if (gradeId === 'primary') return info.stage === '小学';
    if (gradeId === 'senior') return info.stage === '高中';
    return info.grade === gradeId;
  });
}
