/**
 * api.js — fetch 封装：AbortController + 递增序号守卫 + 错误态（P4-20）
 *
 * 约定：loadScenarioBundle 若在完成前被更新请求取代（或被 abort），返回 null；
 * 调用方对 null 直接忽略即可，绝不会用陈旧数据覆盖新场景。
 */

export class ApiError extends Error {
  constructor(message, { status, url } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.url = url;
  }
}

let requestSeq = 0;
let activeController = null;

async function fetchJson(url, signal) {
  const resp = await fetch(url, { signal });
  if (!resp.ok) {
    throw new ApiError(`请求失败 ${resp.status}: ${url}`, { status: resp.status, url });
  }
  return resp.json();
}

/** 场景列表（一次性，启动时调用） */
export async function fetchScenarios() {
  return fetchJson('/api/scenarios');
}

/**
 * 并行加载一个场景的 meta / frames / reputation。
 * 自动取消上一次未完成的加载；若本次已过期返回 null。
 */
export async function loadScenarioBundle(scenarioId) {
  const mySeq = ++requestSeq;
  if (activeController) activeController.abort();
  const controller = new AbortController();
  activeController = controller;

  try {
    const [meta, frames, reputation] = await Promise.all([
      fetchJson(`/api/scenario/${scenarioId}/meta`, controller.signal),
      fetchJson(`/api/scenario/${scenarioId}/frames`, controller.signal),
      fetchJson(`/api/scenario/${scenarioId}/reputation`, controller.signal),
    ]);
    if (mySeq !== requestSeq) return null; // 已被更新请求取代
    return { meta, frames, reputation };
  } catch (err) {
    if (err.name === 'AbortError' || mySeq !== requestSeq) return null;
    throw err;
  } finally {
    if (activeController === controller) activeController = null;
  }
}

/** 可选道路底图（Tier2）：不存在时静默返回 null，road.js 退回 Tier0 */
export async function fetchRoadGeoJson(mapName) {
  try {
    const resp = await fetch(`/static/assets/roads/${String(mapName || '').toLowerCase()}.geojson`);
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}
