/**
 * main.js — 引导与装配：加载、控件、键盘、图层工具条、图例、页签、overlay
 *
 * 各功能模块自行订阅 store；本文件只负责：
 *  1) 场景加载编排（api → deriveScenario → store.setScenario，含错误态/重试）
 *  2) 全局控件与键盘 → store 动作
 *  3) 场景级静态 UI（badge/图例/空态显隐）与每帧 overlay 文本
 */

import {
  COLORS, PLAYBACK, LAYER_DEFAULTS,
  formatAttackLabel, classifyAttackBadge, repColor,
} from './config.js';
import * as store from './store.js';
import { fetchScenarios, loadScenarioBundle } from './api.js';
import { deriveScenario } from './events.js';
import { loadComparison } from './comparison/api.js';
import { validateComparison } from './comparison/common.js';

import { initBev } from './bev/canvas.js';
import { initReputationChart } from './charts/reputationChart.js';
import { initDetailChart } from './charts/detailChart.js';
import { initKpiCards } from './panels/kpiCards.js';
import { initEventBand } from './panels/eventBand.js';
import { initVehicleList } from './panels/vehicleList.js';
import { initToast } from './panels/toast.js';
import { initPlayer } from './player.js';
import { initComparisonPanel } from './comparison/panel.js';

const $ = (id) => document.getElementById(id);
let scenarioCatalog = [];

// ---------- echarts 就绪守卫（vendor 失败时 CDN 回退是异步的） ----------
function waitForEcharts(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    (function poll() {
      if (window.echarts) return resolve();
      if (performance.now() - start > timeoutMs) {
        return reject(new Error('ECharts 加载失败（vendor 与 CDN 均不可用）'));
      }
      setTimeout(poll, 60);
    })();
  });
}

// ---------- 加载蒙层 ----------
let retryFn = null;
function showMask(text, isError = false) {
  $('loadingMask').classList.remove('hidden');
  const t = $('loadingText');
  t.textContent = text;
  t.classList.toggle('error', isError);
  $('retryBtn').hidden = !isError;
}
function hideMask() { $('loadingMask').classList.add('hidden'); }

// ---------- 场景加载 ----------
async function loadScenario(scenarioId) {
  if (!scenarioId) {
    store.clearScenario();
    applyEmptyState(true);
    return;
  }
  store.setPlaying(false);
  showMask('正在加载场景数据...');
  try {
    const bundle = await loadScenarioBundle(scenarioId);
    if (!bundle) return; // 已被更新请求取代（守卫生效），蒙层由后来的请求负责
    const { meta, frames, reputation } = bundle;
    const derived = deriveScenario(meta, frames, reputation);
    store.setScenario({ scenarioId, meta, frames, reputation, derived });
    applyEmptyState(false);
    applyScenarioStatics(meta);
    applyPresentationMode();
    if (store.getState().comparison.mode === 'comparison') {
      store.setComparisonSelectedVehicle(derived.adversaryId);
      void loadComparisonForScenario(scenarioId);
    }
    hideMask();
  } catch (err) {
    console.error('[main] loadScenario failed:', err);
    retryFn = () => loadScenario(scenarioId);
    showMask(`场景加载失败：${err.message}`, true);
  }
}

/** 对比数据独立于场景主请求：404 是可解释的未运行状态，不影响回放。 */
async function loadComparisonForScenario(scenarioId) {
  const state = store.getState();
  if (!scenarioId || state.comparison.mode !== 'comparison') return;
  if (state.comparison.scenarioId === scenarioId
      && state.comparison.loadStatus === 'ready'
      && state.comparison.data) return;
  store.setComparisonLoading(scenarioId);
  try {
    const response = await loadComparison(scenarioId);
    if (!response) return; // 已被新的对比请求取代
    if (response.kind === 'missing') {
      store.setComparisonResult({ scenarioId, loadStatus: 'missing', message: response.message });
      return;
    }
    const current = store.getState();
    const validation = validateComparison(response.data, scenarioId, current.frames.length);
    if (!validation.valid) {
      store.setComparisonResult({
        scenarioId, loadStatus: 'invalid',
        message: `结果结构校验失败：${validation.issues.join('；')}`,
      });
      return;
    }
    store.setComparisonResult({ scenarioId, data: response.data, loadStatus: 'ready' });
  } catch (err) {
    console.error('[main] loadComparison failed:', err);
    store.setComparisonResult({ scenarioId, loadStatus: 'error', message: err.message || '读取 comparison.json 失败' });
  }
}

function applyPresentationMode() {
  const state = store.getState();
  const comparisonActive = state.comparison.mode === 'comparison' && Boolean(state.meta);
  $('rightPanel').classList.toggle('comparison-active', comparisonActive);
  $('comparisonPanel').hidden = !comparisonActive;
  $('kpiRow').hidden = comparisonActive || !state.meta;
  document.querySelector('.chart-section').hidden = comparisonActive;
  document.querySelector('.detail-section').hidden = comparisonActive;
  $('theaterModeBtn').classList.toggle('active', !comparisonActive);
  $('comparisonModeBtn').classList.toggle('active', comparisonActive);
  $('theaterModeBtn').setAttribute('aria-pressed', comparisonActive ? 'false' : 'true');
  $('comparisonModeBtn').setAttribute('aria-pressed', comparisonActive ? 'true' : 'false');
  if (state.meta) {
    $('systemStatus').textContent = comparisonActive
      ? `${state.meta.map} · 离线算法对比`
      : `${state.meta.map} · ${state.meta.num_frames} 帧 · ${state.meta.num_vehicles} 车`;
  }
}

function setPresentationMode(mode) {
  const next = mode === 'comparison' ? 'comparison' : 'theater';
  if (next === 'comparison' && !store.getState().meta) return;
  store.setComparisonMode(next);
  if (next === 'comparison') {
    const state = store.getState();
    if (state.comparison.selectedVehicleId == null) {
      store.setComparisonSelectedVehicle(state.derived?.adversaryId ?? null);
    }
    void loadComparisonForScenario(state.scenarioId);
  }
}

function applyEmptyState(empty) {
  $('canvasEmpty').hidden = !empty;
  $('chartEmpty').hidden = !empty;
  $('overlayInfo').hidden = empty;
  $('mapLegend').hidden = empty;
  $('layerToolbar').hidden = empty;
  $('kpiRow').hidden = empty;
  $('frameSlider').disabled = empty;
  $('playBtn').disabled = empty;
  $('resetBtn').disabled = empty;
  $('comparisonModeBtn').disabled = empty;
  if (empty) {
    $('systemStatus').textContent = '未选择场景';
    $('frameInfo').textContent = '帧 -- / --';
    $('attackBadge').textContent = '--';
    $('attackBadge').className = 'attack-badge none';
  }
  applyPresentationMode();
}

function applyScenarioStatics(meta) {
  $('systemStatus').textContent =
    `${meta.map} · ${meta.num_frames} 帧 · ${meta.num_vehicles} 车`;
  $('frameSlider').max = Math.max(0, (meta.num_frames ?? 1) - 1);
  const badge = $('attackBadge');
  badge.textContent = formatAttackLabel(meta.attack_label);
  badge.className = `attack-badge ${classifyAttackBadge(meta.attack_label)}`;
}

// ---------- 每帧 overlay ----------
function updateOverlay() {
  const s = store.getState();
  const frame = store.currentFrame();
  if (!frame) return;
  const cavCount = (frame.vehicles || []).filter((v) => v.is_cav || v.is_injected).length;
  $('vehicleCount').textContent = cavCount;
  $('timeInfo').textContent = `${(frame.timestamp ?? 0).toFixed(2)}s`;
  $('frameInfo').textContent = `帧 ${s.frameIdx} / ${s.frames.length - 1}`;
  $('frameSlider').value = s.frameIdx;

  const summary = store.currentMetrics()?.summary;
  $('filterInfo').textContent = formatFilterSummary(summary);

  updateAttackState();
}

function formatFilterSummary(summary) {
  if (!summary) return '--';
  const before = Number(summary.num_boxes_before ?? 0);
  const after = Number(summary.num_boxes_after ?? 0);
  const filtered = Number(summary.num_filtered_cavs ?? 0);
  if (filtered > 0 || after < before) return `过滤 ${before}→${after} · CAV ${filtered}`;
  return '正常';
}

/** 攻击状态（真值，仅攻击视角行可见；行显隐由 layers 订阅控制） */
function updateAttackState() {
  const s = store.getState();
  const el = $('attackState');
  const d = s.derived;
  if (!d) { el.textContent = '--'; el.className = 'attack-state waiting'; return; }
  const t = s.frameIdx;
  let text, cls;
  if (t < d.onsetFrame) {
    text = `未触发 F${d.onsetFrame}`; cls = 'waiting';
  } else if (d.attackEndFrame == null) {
    text = '攻击中（持续）'; cls = 'active';
  } else if (t <= d.attackEndFrame) {
    text = '攻击中'; cls = 'active';
  } else {
    text = '已结束'; cls = 'done';
  }
  el.textContent = text;
  el.className = `attack-state ${cls}`;
}

// ---------- 图例（由色令牌生成，形状冗余同步展示） ----------
function buildLegend() {
  const items = [
    { color: COLORS.status.trust, label: '可信车辆 (信誉 > 0.7)', glyph: '▲' },
    { color: COLORS.status.warn, label: '可疑车辆 (0.4–0.7)', glyph: '◆', dashed: true },
    { color: COLORS.status.distrust, label: '失信车辆 (< 0.4)', glyph: '✕' },
    { color: COLORS.status.bgVeh, label: '背景交通' },
    { color: COLORS.status.ego, label: 'ego（本车 · 视野扇区）' },
    { color: COLORS.ui.coverage, label: '协同感知范围（自适应）', ring: true },
    { color: COLORS.status.fake, label: '注入虚假目标（攻击视角）', dashed: true, god: true },
    { color: COLORS.status.truth, label: '攻击车辆真值 ⚠（攻击视角）', dashed: true, god: true },
  ];
  const el = $('mapLegend');
  el.innerHTML = items.map((it) => `
    <div class="legend-item${it.god ? ' god-only' : ''}"${it.god ? ' data-god-only="1"' : ''}>
      <div class="swatch${it.dashed || it.ring ? ' dashed' : ''}"
           style="${it.dashed || it.ring ? `color:${it.color}` : `background:${it.color}`}">
        ${it.glyph ? `<span class="glyph" style="${it.dashed ? `color:${it.color}` : ''}">${it.glyph}</span>` : ''}
      </div>
      <span>${it.label}</span>
    </div>`).join('');
  syncGodOnlyRows();
}

function syncGodOnlyRows() {
  const god = store.getState().layers.godView;
  document.querySelectorAll('[data-god-only]').forEach((el) => { el.hidden = !god; });
  $('attackStateRow').hidden = !god;
}

// ---------- 控件绑定 ----------
function bindControls() {
  $('scenarioSelect').addEventListener('change', (e) => loadScenario(e.target.value));
  $('theaterModeBtn').addEventListener('click', () => setPresentationMode('theater'));
  $('comparisonModeBtn').addEventListener('click', () => setPresentationMode('comparison'));

  $('playBtn').addEventListener('click', () => {
    const s = store.getState();
    if (!s.frames.length) return;
    // 播放到结尾后再按播放 → 从头开始
    if (!s.playing && s.frameIdx >= s.frames.length - 1) store.setFrame(0, 'seek');
    store.setPlaying(!s.playing);
  });
  $('resetBtn').addEventListener('click', () => {
    store.setPlaying(false);
    store.setFrame(0, 'seek');
  });

  const speedSlider = $('speedSlider');
  speedSlider.max = PLAYBACK.SPEED_STEPS.length - 1;
  speedSlider.value = PLAYBACK.DEFAULT_SPEED_IDX;
  speedSlider.addEventListener('input', (e) => store.setSpeedIdx(Number(e.target.value)));

  $('frameSlider').addEventListener('input', (e) => store.setFrame(Number(e.target.value), 'seek'));

  $('retryBtn').addEventListener('click', () => { if (retryFn) retryFn(); });

  // 图层工具条
  document.querySelectorAll('.layer-btn[data-layer]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.layer;
      store.setLayers({ [key]: !store.getState().layers[key] });
    });
  });
  $('followBtn').addEventListener('click', () => {
    const v = store.getState().view;
    store.setView(v.follow ? { follow: false } : { follow: true, panX: 0, panY: 0 });
  });
  $('resetViewBtn').addEventListener('click', () =>
    store.setView({ zoom: 1, panX: 0, panY: 0, follow: true }));

  // 页签
  $('tabListBtn').addEventListener('click', () => store.setTab('list'));
  $('tabDetailBtn').addEventListener('click', () => {
    if (store.getState().selectedId) store.setTab('detail');
  });

  // 键盘（P3-18）
  window.addEventListener('keydown', (e) => {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
    const s = store.getState();
    if (!s.frames.length) return;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        if (!s.playing && s.frameIdx >= s.frames.length - 1) store.setFrame(0, 'seek');
        store.setPlaying(!s.playing);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        store.setPlaying(false);
        store.setFrame(s.frameIdx - (e.shiftKey ? 10 : 1), 'seek');
        break;
      case 'ArrowRight':
        e.preventDefault();
        store.setPlaying(false);
        store.setFrame(s.frameIdx + (e.shiftKey ? 10 : 1), 'seek');
        break;
      case 'Home':
        e.preventDefault();
        store.setPlaying(false);
        store.setFrame(0, 'seek');
        break;
      case 'g': case 'G':
        store.setLayers({ godView: !s.layers.godView });
        break;
    }
  });
}

// ---------- store 订阅（main 自身负责的 UI） ----------
function bindStore() {
  store.subscribe('frame', updateOverlay);

  store.subscribe('play', (playing) => {
    const btn = $('playBtn');
    btn.textContent = playing ? '⏸ 暂停' : '▶ 播放';
    btn.classList.toggle('active', playing);
  });

  store.subscribe('speed', (speed) => {
    $('speedLabel').textContent = `${speed}× 实时`;
  });

  store.subscribe('layers', (layers) => {
    document.querySelectorAll('.layer-btn[data-layer]').forEach((btn) => {
      btn.classList.toggle('on', Boolean(layers[btn.dataset.layer]));
    });
    syncGodOnlyRows();
    updateAttackState();
  });

  store.subscribe('view', (view) => {
    $('followBtn').classList.toggle('on', Boolean(view.follow));
    $('followBtn').textContent = view.follow ? '📌 跟随 ego' : '🖐 自由视角';
  });

  store.subscribe('selection', ({ id }) => {
    const btn = $('tabDetailBtn');
    btn.disabled = !id;
    $('tabDetailVid').textContent = id ? `V${id}` : '';
    if (!id && store.getState().tab === 'detail') store.setTab('list');
  });

  store.subscribe('tab', (tab) => {
    $('tabListBtn').classList.toggle('active', tab === 'list');
    $('tabDetailBtn').classList.toggle('active', tab === 'detail');
    $('vehicleList').hidden = tab !== 'list';
    $('detailPane').hidden = tab !== 'detail';
  });

  store.subscribe('comparison', ({ reason }) => {
    if (reason === 'mode' || reason === 'scenario' || reason === 'scenario-clear') {
      applyPresentationMode();
    }
  });
}

// ---------- 启动 ----------
async function boot() {
  showMask('正在初始化...');
  try {
    await waitForEcharts();
  } catch (err) {
    retryFn = () => location.reload();
    showMask(err.message, true);
    return;
  }

  buildLegend();
  bindControls();
  bindStore();

  // 初始化各功能模块（各自订阅 store）
  initBev();
  initReputationChart();
  initDetailChart();
  initKpiCards();
  initEventBand();
  initVehicleList();
  initToast();
  initPlayer();
  initComparisonPanel({ getScenarios: () => scenarioCatalog });

  // 初始 UI 状态
  applyEmptyState(true);
  applyPresentationMode();
  $('speedLabel').textContent = `${PLAYBACK.SPEED_STEPS[PLAYBACK.DEFAULT_SPEED_IDX]}× 实时`;
  document.querySelectorAll('.layer-btn[data-layer]').forEach((btn) => {
    btn.classList.toggle('on', Boolean(LAYER_DEFAULTS[btn.dataset.layer]));
  });
  $('followBtn').classList.add('on');

  try {
    const scenarios = await fetchScenarios();
    scenarioCatalog = scenarios;
    const select = $('scenarioSelect');
    scenarios.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${formatAttackLabel(s.attack_label)} - ${s.map}`;
      select.appendChild(opt);
    });
    hideMask();
  } catch (err) {
    console.error('[main] fetchScenarios failed:', err);
    retryFn = boot;
    showMask(`场景列表加载失败：${err.message}`, true);
  }
}

boot();
