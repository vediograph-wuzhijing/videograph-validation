import type { ProjectJob, VideoProject } from './api';

export const sourceLabel = (source: string) => source === 'mcp-authored' ? 'MCP 编写源码' : source === 'human-authored' ? '人工编辑源码' : '导入原工程源码';
export const statusLabel: Record<string, string> = { imported: '参考导入 · 待验证', ready: '已验证', 'needs-generation': '待 AI 改写', 'needs-validation': '待验证' };
export const analysisSourceLabel = (project: VideoProject) => {
  const source = project.analysis.source;
  return source === 'fingerprint-cache' ? '音频指纹命中参考分析 · 未重新识别'
    : source === 'analyzer' ? `音频分析器${project.analysis.cached ? ' · 缓存命中' : ' · 重新分析'}`
    : source === 'pending' ? '等待后台音频分析' : `分析来源：${source || '未知'}`;
};
const missLabel: Record<string, string> = { new: '首次渲染', code: '源码', shot: '参数/后期', assets: '素材', dependency: '入场转场', engine: '引擎', host: '渲染器', browser: '浏览器版本', fps: '帧率', samples: '采样', encoder: '编码' };
/** 导出复用/重渲摘要：让人看出“只改一镜为什么重渲了很多镜”。 */
export function cacheSummaryText(job: ProjectJob): string | null {
  const summary = job.result?.cacheSummary;
  if (!summary) return null;
  const reasons = Object.entries(summary.reasons ?? {}).filter(([, count]) => count > 0).map(([reason, count]) => `${missLabel[reason] ?? reason} ${count}`);
  return `复用 ${summary.reused} 镜 / 重渲 ${summary.rendered} 镜${reasons.length ? `（原因：${reasons.join('、')}）` : ''}`;
}
