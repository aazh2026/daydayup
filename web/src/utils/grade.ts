export interface GradeInfo {
  stage: '小学' | '初中' | '高中';
  grade: '初三' | '初二' | '初一' | '小学' | '高中';
  label: string;
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
