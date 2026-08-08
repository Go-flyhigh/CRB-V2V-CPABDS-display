/**
 * comparison/panel.js — 右侧“算法对比”独立面板。
 *
 * 该面板只消费 comparison.json；默认推理回放完全不触发它的请求或图表构建。
 * score 轨道始终分行显示，跨算法结论仅由公共指标和完整结果状态生成。
 */

import * as store from '../store.js';
import { fetchComparisonSummary } from './api.js';
import { formatAttackLabel } from '../config.js';
import {
  ALGORITHMS, METRICS, algorithmData, algorithmStatus, comparisonComplete,
  finite, formatMetric, metricValue, nativeStateLabel, selectedComparisonVehicle,
  statusLabel, vehicleSnapshot,
} from './common.js';

const $ = (id) => document.getElementById(id);

function make(tag, className = '', text = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function frameLabel(value) {
  const frame = finite(value);
  return frame == null ? '—' : `F${frame}`;
}

function timestampFor(row, dt) {
  return finite(row?.timestamp_s) ?? finite(row?.timestamp) ?? ((finite(row?.frame_idx) ?? 0) * dt);
}

function nativeStateClass(state) {
  return ['trusted', 'suspicious', 'distrusted'].includes(state)
    ? `state-${state}`
    : 'state-unavailable';
}

function tolerance(data, metric) {
  const values = data?.evaluation?.tie_tolerance ?? {};
  return metric.unit === 'frames'
    ? (finite(values.frames) ?? 1)
    : (finite(values.ratio) ?? 0.005);
}

function ttdSpeedForAlgorithm(data, algorithmId) {
  const windows = algorithmData(data, algorithmId)?.summary?.per_window_ttd;
  if (!Array.isArray(windows) || !windows.length) return null;
  const values = windows.map((row) => {
    if (String(row?.ttd_status) !== 'detected') return 0;
    const delay = finite(row?.ttd_frames);
    const start = finite(row?.start_frame);
    const end = finite(row?.end_frame);
    if (delay == null || start == null || end == null) return 0;
    const length = end - start + 1;
    return Math.max(0, Math.min(1, (length - 1 - delay) / Math.max(1, length - 3)));
  });
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function numericComparison(data, metricId, scope, frameIdx) {
  const metric = METRICS[metricId];
  const entries = ALGORITHMS.map((algorithm) => ({
    algorithm,
    result: metricValue(data, algorithm.id, metricId, scope, frameIdx),
  }));
  const numericEntries = entries.filter(({ result }) => finite(result.value) != null);
  // “未检出/预存报警”是合法的 TTD 分类结果，不应阻止其他正常检出算法
  // 在数值子集中比较快慢；若三者均无数值 TTD，则该单元不设最佳。Recall/F1
  // 仍要求三算法数值齐全，避免把缺测结果排除后产生虚假的局部冠军。
  const canRank = metric?.unit === 'frames'
    ? numericEntries.length > 0
    : numericEntries.length === entries.length;
  if (!metric || !comparisonComplete(data) || !canRank || metric.direction === 'status') {
    return { entries, bestIds: new Set() };
  }
  const values = numericEntries.map(({ result }) => finite(result.value));
  const best = metric.direction === 'lower' ? Math.min(...values) : Math.max(...values);
  const near = tolerance(data, metric);
  const bestIds = new Set(numericEntries
    .filter(({ result }) => Math.abs(finite(result.value) - best) <= near)
    .map(({ algorithm }) => algorithm.id));

  return { entries, bestIds };
}

/**
 * @param {{getScenarios?: () => Array}} options
 */
export function initComparisonPanel({ getScenarios = () => [] } = {}) {
  const stateEl = $('comparisonDataState');
  const kpiGrid = $('comparisonKpiGrid');
  const lanesRoot = $('decisionLanes');
  const selectedVehicleEl = $('comparisonSelectedVehicle');
  const overviewContent = $('comparisonOverviewContent');

  let laneCharts = new Map();
  let overviewLoading = false;
  const overviewCache = new Map();

  function setDataState(kind, text) {
    stateEl.className = `comparison-data-state ${kind}`;
    stateEl.textContent = text;
    stateEl.hidden = !text;
  }

  function updateHeader(state) {
    const comparison = state.comparison;
    const data = comparison.data;
    if (comparison.loadStatus === 'loading') {
      setDataState('loading', '正在加载三算法离线评估结果…');
    } else if (comparison.loadStatus === 'missing' || comparison.loadStatus === 'idle') {
      setDataState('missing', comparison.message
        || '该场景尚未生成公平同口径结果。需按原始场景 CRB 频率完成三算法重跑与独立计分。');
    } else if (comparison.loadStatus === 'invalid') {
      setDataState('invalid', comparison.message || '结果文件结构或场景绑定不正确。');
    } else if (comparison.loadStatus === 'error') {
      setDataState('error', comparison.message || '读取 comparison.json 时发生错误。');
    } else if (data) {
      const complete = comparisonComplete(data);
      setDataState(complete ? 'ready' : 'partial', complete
        ? ''
        : `数据状态：${statusLabel(data.status || 'partial')}。缺数不会被写成 0。`);
    }
  }

  function buildKpis(state) {
    const data = state.comparison.data;
    const metricIds = ['detection_delay', 'attack_recall', 'f1'];
    kpiGrid.replaceChildren();

    for (const metricId of metricIds) {
      const metric = METRICS[metricId];
      const card = make('article', 'comparison-kpi-card');
      const title = make('div', 'comparison-kpi-title');
      title.append(make('span', '', metric.label));
      title.append(make('span', 'comparison-direction', metric.direction === 'higher'
        ? '越高越好' : (metric.direction === 'lower' ? '越低越好' : '结果状态')));
      card.append(title);

      const result = numericComparison(data, metricId, 'full', state.frameIdx);
      for (const { algorithm, result: metricResult } of result.entries) {
        const row = make('div', 'comparison-kpi-row');
        const name = make('span', 'comparison-kpi-algorithm', algorithm.shortName);
        name.title = algorithm.fullName;
        name.style.color = algorithm.color;
        const resultText = make('span', 'comparison-kpi-result');
        const value = make('strong', 'comparison-kpi-value', formatMetric(metricId, metricResult.value, metricResult.reason));
        resultText.append(value);
        const isBest = result.bestIds.has(algorithm.id);
        row.classList.toggle('best', isBest);
        if (isBest) {
          const badge = make('span', 'comparison-best-badge', '◈ 最佳');
          row.append(name, resultText, badge);
        } else {
          row.append(name, resultText);
        }
        card.append(row);
      }
      kpiGrid.append(card);
    }
  }

  function disposeLanes() {
    for (const { chart } of laneCharts.values()) chart.dispose();
    laneCharts = new Map();
  }

  function buildLaneChart(row, chartHost, algorithm, state) {
    const data = state.comparison.data;
    const algorithmEntry = algorithmData(data, algorithm.id);
    const timeline = algorithmEntry?.timeline ?? [];
    const vehicleId = selectedComparisonVehicle(state);
    const dt = Number(state.meta?.fixed_delta_seconds) || 0.05;
    const seriesData = timeline.map((snapshot) => ({
      value: [timestampFor(snapshot, dt), snapshot.vehicles?.[String(vehicleId)]?.score ?? null],
      frameIdx: snapshot.frame_idx,
      nativeState: snapshot.vehicles?.[String(vehicleId)]?.state ?? null,
    }));
    const thresholds = algorithmEntry?.thresholds ?? {};
    const distrust = finite(thresholds.distrust);
    const chart = echarts.init(chartHost);
    const timelineEndTimes = ALGORITHMS.map(({ id }) => {
      const candidate = algorithmData(data, id)?.timeline;
      const last = Array.isArray(candidate) ? candidate[candidate.length - 1] : null;
      return timestampFor(last, dt);
    }).map(finite).filter((value) => value != null);
    const lastTime = timelineEndTimes.length ? Math.max(...timelineEndTimes) : 1;
    const axisMax = Math.max(1, Math.ceil((lastTime - 1e-9) * 10) / 10);
    const showXAxis = algorithm.id === ALGORITHMS[ALGORITHMS.length - 1].id;
    chart.setOption({
      backgroundColor: 'transparent',
      animation: false,
      grid: { top: 8, right: 16, bottom: showXAxis ? 30 : 5, left: 32, containLabel: true },
      tooltip: {
        trigger: 'item',
        backgroundColor: '#FFFFFF',
        borderColor: '#E4E4E7',
        textStyle: { color: '#18181B', fontSize: 11 },
        formatter: (params) => {
          const item = params.data || {};
          const score = item.value?.[1];
          const frame = frameLabel(item.frameIdx);
          const stateText = nativeStateLabel(item.nativeState);
          return `${algorithm.fullName}<br/>${frame} · ${Number(item.value?.[0] ?? 0).toFixed(2)}s<br/>评分：${score == null ? '--' : Number(score).toFixed(3)}<br/>失信状态：${stateText}`;
        },
      },
      xAxis: {
        type: 'value', min: 0, max: axisMax, splitNumber: 5,
        show: showXAxis,
        name: showXAxis ? '时间 (s)' : '',
        nameLocation: 'middle',
        nameGap: 19,
        nameTextStyle: { color: '#71717A', fontSize: 10 },
        axisLine: { lineStyle: { color: '#D4D4D8' } },
        axisLabel: {
          color: '#71717A', fontSize: 9, hideOverlap: true,
          formatter: (value) => {
            const rounded = Math.round(Number(value) * 10) / 10;
            return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
          },
        },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value', min: 0, max: 1,
        axisLine: { lineStyle: { color: '#D4D4D8' } },
        axisLabel: { color: '#71717A', fontSize: 9 },
        splitLine: { lineStyle: { color: '#E4E4E7' } },
      },
      series: [{
        id: algorithm.id,
        name: algorithm.fullName,
        type: 'line',
        data: seriesData,
        smooth: false,
        connectNulls: false,
        symbol: 'none',
        lineStyle: { color: algorithm.color, width: algorithm.id === 'crb_v2v_cpabds' ? 2.8 : 2, type: algorithm.lineType },
        itemStyle: { color: algorithm.color },
        markLine: distrust == null ? undefined : {
          silent: true, symbol: 'none',
          data: [{
            yAxis: distrust,
            lineStyle: { color: algorithm.color, type: 'dashed', opacity: 0.65 },
            label: { show: true, formatter: `失信阈值 ${distrust}`, color: algorithm.color, fontSize: 9, position: 'insideStartTop' },
          }],
        },
      }],
    }, true);
    chart.on('click', (params) => {
      const frame = finite(params?.data?.frameIdx);
      if (frame == null) return;
      store.setPlaying(false);
      store.setFrame(frame, 'seek');
    });
    laneCharts.set(algorithm.id, { chart, row, chartHost, algorithm });
  }

  function buildLanes(state) {
    disposeLanes();
    lanesRoot.replaceChildren();
    const data = state.comparison.data;
    const vehicleId = selectedComparisonVehicle(state);
    selectedVehicleEl.textContent = vehicleId ? `V${vehicleId}` : 'V--';

    for (const algorithm of ALGORITHMS) {
      const lane = make('article', 'decision-lane');
      lane.dataset.algorithmId = algorithm.id;
      lane.style.setProperty('--algorithm-color', algorithm.color);
      const heading = make('div', 'decision-lane-meta');
      const identity = make('div', 'decision-lane-identity');
      identity.append(make('span', 'decision-lane-glyph', algorithm.glyph));
      identity.append(make('strong', '', algorithm.shortName));
      const status = make('span', 'decision-lane-status');
      heading.append(identity, status);
      lane.append(heading);

      const algorithmEntry = algorithmData(data, algorithm.id);
      const ready = algorithmStatus(data, algorithm.id) === 'complete'
        && Array.isArray(algorithmEntry?.timeline) && algorithmEntry.timeline.length > 0;
      if (ready && vehicleId) {
        const chartHost = make('div', 'decision-lane-chart');
        lane.append(chartHost);
        lanesRoot.append(lane);
        buildLaneChart(lane, chartHost, algorithm, state);
      } else {
        const unavailable = make('div', 'decision-lane-unavailable',
          ready ? '当前车辆没有可展示的评分曲线' : statusLabel(algorithmStatus(data, algorithm.id), algorithmEntry?.availability_reason));
        lane.append(unavailable);
        lanesRoot.append(lane);
      }
    }
    updateLaneFrame();
  }

  function updateLaneFrame() {
    const state = store.getState();
    const data = state.comparison.data;
    const vehicleId = selectedComparisonVehicle(state);
    for (const algorithm of ALGORITHMS) {
      const entry = laneCharts.get(algorithm.id);
      const lane = entry?.row ?? lanesRoot.querySelector(`[data-algorithm-id="${algorithm.id}"]`);
      if (!lane) continue;
      const statusEl = lane.querySelector('.decision-lane-status');
      const snapshot = vehicleId ? vehicleSnapshot(data, algorithm.id, vehicleId, state.frameIdx) : null;
      let nextStatus;
      let nextStateClass = 'state-unavailable';
      if (snapshot?.vehicle) {
        // 评分已由曲线承载。只在原生状态改变时更新文字，避免播放期间
        // 每帧改写 3 条 DOM 文本导致数字闪烁和无意义的布局工作。
        nextStatus = nativeStateLabel(snapshot.vehicle.state);
        nextStateClass = nativeStateClass(snapshot.vehicle.state);
      } else {
        const algorithmEntry = algorithmData(data, algorithm.id);
        nextStatus = statusLabel(algorithmStatus(data, algorithm.id), algorithmEntry?.availability_reason);
      }
      if (statusEl.textContent !== nextStatus) statusEl.textContent = nextStatus;
      const nextClassName = `decision-lane-status ${nextStateClass}`;
      if (statusEl.className !== nextClassName) statusEl.className = nextClassName;

      if (!entry) continue;
      const snap = snapshot?.row;
      const time = timestampFor(snap, Number(state.meta?.fixed_delta_seconds) || 0.05);
      const lower = entry.chart.convertToPixel({ xAxisIndex: 0, yAxisIndex: 0 }, [time, 0]);
      const upper = entry.chart.convertToPixel({ xAxisIndex: 0, yAxisIndex: 0 }, [time, 1]);
      if (Array.isArray(lower) && Number.isFinite(lower[0])) {
        entry.chart.setOption({
          graphic: [{
            id: 'comparison-frame-guide', type: 'line', silent: true, z: 30,
            shape: { x1: lower[0], y1: upper[1], x2: lower[0], y2: lower[1] },
            style: { stroke: '#2563EB', lineWidth: 1, opacity: 0.8 },
          }],
        });
      }
    }
  }

  function overviewMetricButtons(selected) {
    const bar = make('div', 'comparison-metric-switch', null);
    for (const metricId of ['detection_delay', 'attack_recall', 'f1']) {
      const button = make('button', `comparison-metric-btn${selected === metricId ? ' active' : ''}`, METRICS[metricId].label);
      button.type = 'button';
      button.dataset.comparisonMetric = metricId;
      button.setAttribute('aria-pressed', selected === metricId ? 'true' : 'false');
      bar.append(button);
    }
    return bar;
  }

  async function ensureOverview() {
    if (overviewLoading) return;
    const scenarios = getScenarios() || [];
    const pending = scenarios.filter((scenario) => !overviewCache.has(scenario.id));
    if (!pending.length) return;
    overviewLoading = true;
    renderTab();
    const results = await Promise.all(pending.map(async (scenario) => {
      try { return await fetchComparisonSummary(scenario.id); }
      catch (error) { return { kind: 'error', scenarioId: scenario.id, message: error.message }; }
    }));
    for (const result of results) overviewCache.set(result.scenarioId, result);
    overviewLoading = false;
    const state = store.getState();
    if (state.comparison.mode === 'comparison') renderTab();
  }

  function renderOverviewTab(state) {
    overviewContent.replaceChildren();
    overviewContent.append(overviewMetricButtons(state.comparison.selectedMetric));
    const scenarios = getScenarios() || [];
    if (!scenarios.length) {
      overviewContent.append(make('p', 'comparison-note', '场景目录尚未加载，无法建立多场景矩阵。'));
      return;
    }
    const tableWrap = make('div', 'comparison-matrix-wrap');
    const table = make('table', 'comparison-matrix');
    const thead = document.createElement('thead');
    const header = document.createElement('tr');
    header.append(make('th', '', '场景'));
    for (const algorithm of ALGORITHMS) {
      const th = make('th', algorithm.id === 'crb_v2v_cpabds' ? 'method-column' : '', algorithm.shortName);
      th.title = algorithm.fullName;
      header.append(th);
    }
    thead.append(header);
    table.append(thead);
    const tbody = document.createElement('tbody');
    const metricId = state.comparison.selectedMetric;
    for (const scenario of scenarios) {
      const row = document.createElement('tr');
      row.append(make('th', 'comparison-scene-name', formatAttackLabel(scenario.attack_label) || scenario.name || scenario.id));
      const cached = overviewCache.get(scenario.id);
      const data = cached?.kind === 'ready' ? cached.data : null;
      const comparison = numericComparison(data, metricId, 'full', 0);
      for (const algorithm of ALGORITHMS) {
        const td = make('td', algorithm.id === 'crb_v2v_cpabds' ? 'method-column' : '');
        const metricResult = comparison.entries.find(({ algorithm: candidate }) => candidate.id === algorithm.id)?.result;
        if (cached?.kind === 'ready') {
          td.textContent = formatMetric(metricId, metricResult?.value, metricResult?.reason);
          td.classList.toggle('best', comparison.bestIds.has(algorithm.id));
        } else if (cached?.kind === 'error') {
          td.textContent = '加载失败';
        } else {
          td.textContent = '待生成';
        }
        row.append(td);
      }
      tbody.append(row);
    }
    table.append(tbody);
    const readyRunIds = scenarios.map((scenario) => {
      const cached = overviewCache.get(scenario.id);
      return cached?.kind === 'ready' ? cached.data?.provenance?.run_id : null;
    });
    const uniqueRunIds = [...new Set(readyRunIds.filter(Boolean))];
    const runIdsConsistent = uniqueRunIds.length === 1
      && readyRunIds.every((runId) => runId === uniqueRunIds[0]);
    const allComplete = runIdsConsistent && scenarios.length > 0 && scenarios.every((scenario) => {
      const cached = overviewCache.get(scenario.id);
      return cached?.kind === 'ready' && comparisonComplete(cached.data);
    });
    // Recall/F1 使用场景等权宏平均；TTD 表底部复用六场景宏平均。
    if (allComplete) {
      if (metricId === 'detection_delay') {
        const macroTtdSpeed = ALGORITHMS.map((algorithm) => {
          const values = scenarios.map((scenario) => {
            const data = overviewCache.get(scenario.id)?.data;
            return ttdSpeedForAlgorithm(data, algorithm.id);
          });
          const numeric = values.map(finite);
          return {
            algorithm,
            value: numeric.every((value) => value != null)
              ? numeric.reduce((sum, value) => sum + value, 0) / numeric.length
              : null,
          };
        });
        const numeric = macroTtdSpeed.map((entry) => finite(entry.value));
        const best = numeric.every((value) => value != null) ? Math.max(...numeric) : null;
        const foot = document.createElement('tfoot');
        const row = document.createElement('tr');
        row.append(make('th', 'comparison-scene-name', '6 场景宏平均'));
        for (const entry of macroTtdSpeed) {
          const td = make(
            'td',
            entry.algorithm.id === 'crb_v2v_cpabds' ? 'method-column' : '',
            entry.value == null ? '不适用' : `${(entry.value * 100).toFixed(1)}%`,
          );
          if (best != null && finite(entry.value) != null && Math.abs(entry.value - best) <= 0.005) {
            td.classList.add('best');
          }
          row.append(td);
        }
        foot.append(row);
        table.append(foot);
      } else {
        const macro = ALGORITHMS.map((algorithm) => {
          const values = scenarios.map((scenario) => {
            const data = overviewCache.get(scenario.id)?.data;
            return metricValue(data, algorithm.id, metricId, 'full', 0).value;
          });
          const numeric = values.map(finite);
          return { algorithm, value: numeric.every((value) => value != null)
            ? numeric.reduce((sum, value) => sum + value, 0) / numeric.length : null };
        });
        const metric = METRICS[metricId];
        const numeric = macro.map((entry) => finite(entry.value));
        const canRank = numeric.every((value) => value != null);
        const best = canRank ? Math.max(...numeric) : null;
        const foot = document.createElement('tfoot');
        const row = document.createElement('tr');
        row.append(make('th', 'comparison-scene-name', `${scenarios.length} 场景宏平均`));
        for (const entry of macro) {
          const td = make('td', entry.algorithm.id === 'crb_v2v_cpabds' ? 'method-column' : '',
            entry.value == null ? '不适用' : formatMetric(metricId, entry.value));
          if (best != null && Math.abs(entry.value - best) <= tolerance(overviewCache.get(scenarios[0].id)?.data, metric)) {
            td.classList.add('best');
          }
          row.append(td);
        }
        foot.append(row);
        table.append(foot);
      }
    }
    tableWrap.append(table);
    overviewContent.append(tableWrap);
    if (allComplete) {
      const aggregateWrap = make('div', 'comparison-matrix-wrap comparison-aggregate-wrap');
      const aggregateTable = make('table', 'comparison-matrix comparison-aggregate');
      const aggregateHead = document.createElement('thead');
      const aggregateHeader = document.createElement('tr');
      aggregateHeader.append(make('th', '', '六场景综合'));
      for (const algorithm of ALGORITHMS) {
        aggregateHeader.append(make(
          'th',
          algorithm.id === 'crb_v2v_cpabds' ? 'method-column' : '',
          algorithm.shortName,
        ));
      }
      aggregateHead.append(aggregateHeader);
      aggregateTable.append(aggregateHead);
      const aggregateBody = document.createElement('tbody');
      const aggregateByAlgorithm = new Map(ALGORITHMS.map((algorithm) => {
        const rows = scenarios.map((scenario) => overviewCache.get(scenario.id)?.data);
        const f1 = rows.map((data) => finite(metricValue(data, algorithm.id, 'f1', 'full', 0).value));
        const recall = rows.map((data) => finite(metricValue(data, algorithm.id, 'attack_recall', 'full', 0).value));
        const speed = rows.map((data) => ttdSpeedForAlgorithm(data, algorithm.id));
        const mean = (values) => values.every((value) => value != null)
          ? values.reduce((sum, value) => sum + value, 0) / values.length
          : null;
        const macroF1 = mean(f1);
        const macroRecall = mean(recall);
        const macroTtdSpeed = mean(speed);
        return [algorithm.id, {
          macroTtdSpeed,
          composite: [macroF1, macroRecall, macroTtdSpeed].every((value) => value != null)
            ? (macroF1 + macroRecall + macroTtdSpeed) / 3
            : null,
        }];
      }));
      const aggregateRows = [
        {
          label: '三指标等权综合分',
          key: 'composite',
          format: (value) => value == null ? '不适用' : value.toFixed(3),
          tolerance: 0.005,
        },
      ];
      for (const definition of aggregateRows) {
        const row = document.createElement('tr');
        row.append(make('th', 'comparison-scene-name', definition.label));
        const values = ALGORITHMS.map(({ id }) => aggregateByAlgorithm.get(id)[definition.key]);
        const numeric = values.map(finite);
        const best = numeric.every((value) => value != null) ? Math.max(...numeric) : null;
        ALGORITHMS.forEach((algorithm, index) => {
          const value = values[index];
          const td = make(
            'td',
            algorithm.id === 'crb_v2v_cpabds' ? 'method-column' : '',
            definition.format(value),
          );
          if (best != null && finite(value) != null && Math.abs(value - best) <= definition.tolerance) {
            td.classList.add('best');
          }
          row.append(td);
        });
        aggregateBody.append(row);
      }
      aggregateTable.append(aggregateBody);
      aggregateWrap.append(aggregateTable);
      overviewContent.append(aggregateWrap);
    }
    if (!allComplete) {
      const message = uniqueRunIds.length > 1 || (uniqueRunIds.length === 1 && !runIdsConsistent)
        ? '六个场景的 run_id 不一致或缺失；为防止混跑结果，当前矩阵不生成总排名。'
        : `${scenarios.length} 场景总排名等待全部场景完成；当前矩阵不生成总冠军。`;
      overviewContent.append(make('p', 'comparison-note', message));
    }
    if (!overviewLoading) void ensureOverview();
    else overviewContent.append(make('p', 'comparison-note', `正在按需加载 ${scenarios.length} 场景轻量结果…`));
  }

  function renderTab() {
    const state = store.getState();
    renderOverviewTab(state);
  }

  function fullRender() {
    const state = store.getState();
    if (state.comparison.mode !== 'comparison') return;
    updateHeader(state);
    buildKpis(state);
    buildLanes(state);
    renderTab();
  }

  overviewContent.addEventListener('click', (event) => {
    const button = event.target.closest('[data-comparison-metric]');
    if (button) store.setComparisonMetric(button.dataset.comparisonMetric);
  });

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      for (const { chart } of laneCharts.values()) chart.resize();
      updateLaneFrame();
    }).observe(lanesRoot);
  } else {
    window.addEventListener('resize', () => {
      for (const { chart } of laneCharts.values()) chart.resize();
      updateLaneFrame();
    });
  }

  store.subscribe('scenario', fullRender);
  store.subscribe('comparison', ({ reason }) => {
    const state = store.getState();
    if (state.comparison.mode !== 'comparison') return;
    if (['mode', 'scenario', 'scenario-clear', 'loading', 'result', 'vehicle'].includes(reason)) {
      fullRender();
    } else if (reason === 'metric') {
      renderTab();
    }
  });
  store.subscribe('frame', () => {
    const state = store.getState();
    if (state.comparison.mode !== 'comparison') return;
    updateLaneFrame();
  });
}
