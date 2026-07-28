/**
 * store.js — 中央状态 + 订阅（无框架）
 *
 * 渲染分层（原则 P4）：
 *  - 'scenario'  场景级重建（一次）：曲线 series、事件带块、道路层、列表 DOM、KPI 卡
 *  - 'frame'     帧级增量（每帧）：BEV 重绘、游标移动、文本就地更新
 *  - 'selection' 选中变化：样式增量更新、详情图重建
 *  - 'layers'    图层开关：BEV 重绘、真值标注显隐
 *  - 'view'      缩放/平移：BEV 重绘
 *  - 'play'      播放状态；'speed' 倍速；'tab' 列表/详情页签
 *
 * setFrame(t, cause)：cause='tick'（连续播放）| 'seek'（跳帧）——toast 只对 tick 触发。
 */

import { LAYER_DEFAULTS, PLAYBACK } from './config.js';

const state = {
  // 场景级（加载一次）
  scenarioId: null,
  meta: null,          // meta.json
  frames: [],          // frames.json
  reputation: null,    // reputation.json（vehicles 字段禁止用于逐帧显示）
  derived: null,       // events.js 派生：事件、KPI 前缀和、检测帧等

  // 播放
  frameIdx: 0,
  playing: false,
  speedIdx: PLAYBACK.DEFAULT_SPEED_IDX, // 索引到 PLAYBACK.SPEED_STEPS

  // 交互
  selectedId: null,
  hoveredId: null,
  tab: 'list',         // 'list' | 'detail'
  layers: { ...LAYER_DEFAULTS },
  view: { zoom: 1, panX: 0, panY: 0, follow: true }, // panX/panY 世界坐标偏移（米）

  // 离线算法对比：与实时回放 reputation 严格隔离，comparison.json 仅按需加载。
  comparison: {
    mode: 'theater', // 'theater' | 'comparison'
    data: null,
    loadStatus: 'idle', // idle | loading | ready | missing | invalid | error
    message: null,
    scenarioId: null,
    selectedMetric: 'detection_delay',
    resultScope: 'full', // 'full' | 'current'（由结果包能力决定是否可用）
    selectedVehicleId: null,
  },
};

const subscribers = new Map(); // topic -> Set<fn>

function emit(topic, payload) {
  const set = subscribers.get(topic);
  if (!set) return;
  for (const fn of set) {
    try { fn(payload, state); } catch (err) {
      console.error(`[store] subscriber error on '${topic}':`, err);
    }
  }
}

export function subscribe(topic, fn) {
  if (!subscribers.has(topic)) subscribers.set(topic, new Set());
  subscribers.get(topic).add(fn);
  return () => subscribers.get(topic).delete(fn);
}

export function getState() { return state; }

/**
 * 场景切换会直接重置选车与页签状态，因此必须强制广播这两个主题。
 * 若仅广播 scenario，DOM 仍会停留在旧详情页；此时 setTab('list') 又会
 * 因内存状态已经是 list 而提前返回，造成页签看似“卡死”。
 */
function emitScenarioReset(prevSelectedId) {
  emit('scenario', state);
  emit('selection', { id: null, prev: prevSelectedId });
  emit('tab', 'list');
}

function resetComparisonForScenario() {
  state.comparison.data = null;
  state.comparison.loadStatus = 'idle';
  state.comparison.message = null;
  state.comparison.scenarioId = state.scenarioId;
  state.comparison.selectedVehicleId = null;
}

function emitComparison(reason) {
  emit('comparison', { reason, comparison: state.comparison });
}

/** 场景加载完成后一次性写入（frames/reputation/derived 由调用方准备好） */
export function setScenario({ scenarioId, meta, frames, reputation, derived }) {
  const prevSelectedId = state.selectedId;
  state.scenarioId = scenarioId;
  state.meta = meta;
  state.frames = frames;
  state.reputation = reputation;
  state.derived = derived;
  state.frameIdx = 0;
  state.playing = false;
  state.selectedId = null;
  state.hoveredId = null;
  state.tab = 'list';
  state.view = { zoom: 1, panX: 0, panY: 0, follow: true };
  resetComparisonForScenario();
  emitScenarioReset(prevSelectedId);
  emitComparison('scenario');
  emit('frame', { idx: 0, cause: 'seek' });
}

export function clearScenario() {
  const prevSelectedId = state.selectedId;
  state.scenarioId = null;
  state.meta = null;
  state.frames = [];
  state.reputation = null;
  state.derived = null;
  state.frameIdx = 0;
  state.playing = false;
  state.selectedId = null;
  state.hoveredId = null;
  state.tab = 'list';
  resetComparisonForScenario();
  emitScenarioReset(prevSelectedId);
  emitComparison('scenario-clear');
}

export function setFrame(idx, cause = 'seek') {
  if (!state.frames.length) return;
  const clamped = Math.max(0, Math.min(idx, state.frames.length - 1));
  if (clamped === state.frameIdx && cause !== 'force') return;
  const prev = state.frameIdx;
  state.frameIdx = clamped;
  emit('frame', { idx: clamped, prev, cause });
}

export function setPlaying(playing) {
  if (state.playing === playing) return;
  state.playing = playing;
  emit('play', playing);
}

export function setSpeedIdx(idx) {
  const clamped = Math.max(0, Math.min(idx, PLAYBACK.SPEED_STEPS.length - 1));
  if (clamped === state.speedIdx) return;
  state.speedIdx = clamped;
  emit('speed', PLAYBACK.SPEED_STEPS[clamped]);
}

export function getSpeed() { return PLAYBACK.SPEED_STEPS[state.speedIdx]; }

export function setSelection(vid) {
  const id = vid == null ? null : String(vid);
  if (state.selectedId === id) return;
  const prev = state.selectedId;
  state.selectedId = id;
  emit('selection', { id, prev });
}

export function setHovered(vid) {
  const id = vid == null ? null : String(vid);
  if (state.hoveredId === id) return;
  state.hoveredId = id;
  emit('hover', id);
}

export function setTab(tab) {
  if (state.tab === tab) return;
  state.tab = tab;
  emit('tab', tab);
}

export function setLayers(patch) {
  Object.assign(state.layers, patch);
  emit('layers', state.layers);
}

export function setView(patch) {
  Object.assign(state.view, patch);
  emit('view', state.view);
}

export function setComparisonMode(mode) {
  const next = mode === 'comparison' ? 'comparison' : 'theater';
  if (state.comparison.mode === next) return;
  state.comparison.mode = next;
  emitComparison('mode');
}

export function setComparisonLoading(scenarioId) {
  if (scenarioId !== state.scenarioId) return;
  state.comparison.data = null;
  state.comparison.loadStatus = 'loading';
  state.comparison.message = null;
  state.comparison.scenarioId = scenarioId;
  emitComparison('loading');
}

export function setComparisonResult({ scenarioId, data = null, loadStatus, message = null }) {
  // 额外场景守卫：即使请求层发生竞态，也不能把旧场景结果写回当前场景。
  if (scenarioId !== state.scenarioId) return;
  state.comparison.data = data;
  state.comparison.loadStatus = loadStatus;
  state.comparison.message = message;
  state.comparison.scenarioId = scenarioId;
  emitComparison('result');
}

export function setComparisonMetric(metric) {
  if (!metric || state.comparison.selectedMetric === metric) return;
  state.comparison.selectedMetric = metric;
  emitComparison('metric');
}

export function setComparisonResultScope(scope) {
  const next = scope === 'current' ? 'current' : 'full';
  if (state.comparison.resultScope === next) return;
  state.comparison.resultScope = next;
  emitComparison('scope');
}

export function setComparisonSelectedVehicle(vehicleId) {
  const next = vehicleId == null ? null : String(vehicleId);
  if (state.comparison.selectedVehicleId === next) return;
  state.comparison.selectedVehicleId = next;
  emitComparison('vehicle');
}

/** 便捷：当前帧对象 / 当前帧信誉快照 / 当前帧指标（可能为 undefined，调用方需 ?? 处理） */
export function currentFrame() { return state.frames[state.frameIdx]; }
export function currentReputations() {
  return state.reputation?.timeline?.[state.frameIdx]?.reputations ?? {};
}
export function currentMetrics() {
  return state.reputation?.metrics_timeline?.[state.frameIdx] ?? null;
}
