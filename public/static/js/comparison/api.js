/** comparison/api.js — 对比结果专用懒加载，不与主场景加载共用 AbortController。 */

export class ComparisonApiError extends Error {
  constructor(message, { status = null, url = null, payload = null } = {}) {
    super(message);
    this.name = 'ComparisonApiError';
    this.status = status;
    this.url = url;
    this.payload = payload;
  }
}

let requestSeq = 0;
let activeController = null;

async function parseJson(response) {
  try { return await response.json(); } catch { return null; }
}

/**
 * 当前场景对比结果。404 是预期业务状态，返回 {kind:'missing'} 而非抛出异常。
 */
export async function loadComparison(scenarioId) {
  const mySeq = ++requestSeq;
  if (activeController) activeController.abort();
  const controller = new AbortController();
  activeController = controller;
  const url = `/api/scenario/${encodeURIComponent(scenarioId)}/comparison`;
  try {
    const response = await fetch(url, { signal: controller.signal });
    const payload = await parseJson(response);
    if (mySeq !== requestSeq) return null;
    if (response.status === 404) {
      return { kind: 'missing', message: payload?.reason || '该场景尚未生成 comparison.json。' };
    }
    if (!response.ok) {
      throw new ComparisonApiError(`请求失败 ${response.status}: ${url}`, {
        status: response.status, url, payload,
      });
    }
    return { kind: 'ready', data: payload };
  } catch (error) {
    if (error.name === 'AbortError' || mySeq !== requestSeq) return null;
    throw error;
  } finally {
    if (activeController === controller) activeController = null;
  }
}

/** 多场景总览使用：不取消当前主对比请求，单独获取一个轻量/完整结果包。 */
export async function fetchComparisonSummary(scenarioId) {
  const url = `/api/scenario/${encodeURIComponent(scenarioId)}/comparison`;
  const response = await fetch(url);
  const payload = await parseJson(response);
  if (response.status === 404) return { kind: 'missing', scenarioId, message: payload?.reason || null };
  if (!response.ok) {
    return { kind: 'error', scenarioId, message: `请求失败 ${response.status}` };
  }
  return { kind: 'ready', scenarioId, data: payload };
}
