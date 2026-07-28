/**
 * detailChart.js — 选中车辆多指标详情图（P0-4 / P2-T7）
 *
 * 上 grid：信誉 / 证据分 / 投票一致性 / 物理分 四条线（算法内部机理）；
 * 下 grid：该 CAV 每帧被过滤框数（before−after）条形。
 * 检测帧 markLine 仅当 检测帧≤当前帧 或攻击视角（内部 godView，无未来泄露）；
 * 攻击窗口 markArea 仅攻击视角。帧级只移动游标 graphic。
 */

import { COLORS, seriesColor } from '../config.js';
import * as store from '../store.js';

export function initDetailChart() {
  const el = document.getElementById('detailChart');
  let chart = null;
  let builtFor = null;      // 已构建的 vid
  let markerState = '';     // 检测线/攻击区显隐签名

  function ensureChart() {
    if (!chart) {
      chart = echarts.init(el, 'dark');
      const onResize = () => { if (chart && isActive()) { chart.resize(); updateCursor(); } };
      if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(onResize).observe(el);
      } else {
        window.addEventListener('resize', onResize);
      }
    }
    return chart;
  }

  function isActive() {
    const s = store.getState();
    return s.tab === 'detail' && s.selectedId != null;
  }

  function maybeBuild() {
    const s = store.getState();
    if (!isActive() || !s.reputation) return;
    if (builtFor === s.selectedId) { ensureChart().resize(); return; }
    build(s);
  }

  function build(state) {
    const vid = state.selectedId;
    const metrics = state.reputation.metrics_timeline ?? [];
    const d = state.derived;
    ensureChart();
    builtFor = vid;
    markerState = '';

    // 非 CAV（如注入目标）无算法内部指标
    const isCav = (state.meta?.cav_ids ?? []).map(String).includes(vid);
    if (!isCav) {
      chart.clear();
      chart.setOption({
        backgroundColor: 'transparent',
        title: {
          text: `V${vid} 无算法内部指标（非协同车辆）`,
          left: 'center', top: 'middle',
          textStyle: { color: '#94a3b8', fontSize: 13, fontWeight: 400 },
        },
      });
      return;
    }

    const times = metrics.map((m) => m.timestamp);
    const pick = (key) => metrics.map((m) => {
      const c = m.cavs?.[vid];
      const v = c?.[key];
      return [m.timestamp, v == null ? null : Number(v)];
    });
    const bars = metrics.map((m) => {
      const c = m.cavs?.[vid];
      if (!c || c.num_boxes_before == null || c.num_boxes_after == null) return [m.timestamp, 0];
      return [m.timestamp, Math.max(0, c.num_boxes_before - c.num_boxes_after)];
    });

    const lineDefs = [
      { key: 'reputation_after', name: '信誉', width: 2.2 },
      { key: 'evidence_score', name: '证据分', width: 1.6 },
      { key: 'voting_consistency_ratio', name: '投票一致性', width: 1.6 },
      { key: 'physical_score', name: '物理分', width: 1.6 },
    ];

    const series = lineDefs.map((def, i) => ({
      id: `metric-${def.key}`,
      name: def.name,
      type: 'line',
      xAxisIndex: 0, yAxisIndex: 0,
      data: pick(def.key),
      connectNulls: false,
      symbol: 'none',
      smooth: false,
      lineStyle: { width: def.width, color: seriesColor(i) },
      itemStyle: { color: seriesColor(i) },
      z: i === 0 ? 6 : 3,
    }));

    series.push({
      id: 'filtered-boxes',
      name: '被过滤框数',
      type: 'bar',
      xAxisIndex: 1, yAxisIndex: 1,
      data: bars,
      itemStyle: { color: COLORS.status.warn, opacity: 0.85 },
      barMaxWidth: 4,
    });

    chart.clear();
    chart.setOption({
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(15,23,42,0.96)',
        borderColor: '#475569',
        textStyle: { color: '#edf3ff', fontSize: 12 },
        formatter: (params) => {
          if (!params.length) return '';
          const time = Number(params[0].axisValue).toFixed(2);
          const rows = params
            .filter((p) => p.value && p.value[1] != null)
            .map((p) => `${p.marker}${p.seriesName}: <b>${Number(p.value[1]).toFixed(3)}</b>`)
            .join('<br/>');
          return `V${vid} · ${time}s<br/>${rows}`;
        },
      },
      legend: {
        textStyle: { color: '#94a3b8', fontSize: 10 },
        top: 0, left: 4,
        itemWidth: 14, itemHeight: 8,
      },
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      grid: [
        { top: 26, left: 8, right: 12, bottom: '34%', containLabel: true },
        { left: 8, right: 12, top: '72%', bottom: 18, containLabel: true },
      ],
      xAxis: [
        {
          type: 'value', gridIndex: 0, min: 0, max: times[times.length - 1] || 1,
          axisLabel: { show: false }, axisLine: { lineStyle: { color: '#334155' } },
          splitLine: { lineStyle: { color: '#1e293b' } },
        },
        {
          type: 'value', gridIndex: 1, min: 0, max: times[times.length - 1] || 1,
          axisLabel: { color: '#94a3b8', fontSize: 9 },
          axisLine: { lineStyle: { color: '#334155' } },
          splitLine: { show: false },
        },
      ],
      yAxis: [
        {
          type: 'value', gridIndex: 0, min: 0, max: 1,
          axisLabel: { color: '#94a3b8', fontSize: 9 },
          axisLine: { lineStyle: { color: '#334155' } },
          splitLine: { lineStyle: { color: '#1e293b' } },
        },
        {
          type: 'value', gridIndex: 1, minInterval: 1,
          name: '过滤框', nameTextStyle: { color: '#94a3b8', fontSize: 9 },
          axisLabel: { color: '#94a3b8', fontSize: 9 },
          axisLine: { lineStyle: { color: '#334155' } },
          splitLine: { show: false },
        },
      ],
      series,
    });

    updateMarkers(true);
    updateCursor();
  }

  /** 检测帧 markLine / 攻击窗口 markArea（显隐签名变化才 setOption） */
  function updateMarkers(force = false) {
    const s = store.getState();
    if (!chart || builtFor == null || !s.derived) return;
    const d = s.derived;
    const god = s.layers.godView;
    const showDetection = d.detectionFrame != null && (god || d.detectionFrame <= s.frameIdx);
    const sig = `${showDetection ? 'D' : ''}|${god ? 'G' : ''}`;
    if (!force && sig === markerState) return;
    markerState = sig;

    const dt = d.dt;
    chart.setOption({
      series: [{
        id: 'metric-reputation_after',
        markLine: {
          silent: true, symbol: 'none',
          data: showDetection ? [{
            xAxis: d.detectionFrame * dt,
            lineStyle: { color: COLORS.events.detection, type: 'dashed', width: 1.2 },
            label: {
              show: true, formatter: `检测 F${d.detectionFrame}`,
              color: '#fecaca', fontSize: 9, position: 'insideEndTop',
            },
          }] : [],
        },
        markArea: {
          silent: true,
          data: god ? [[
            { xAxis: d.onsetFrame * dt, itemStyle: { color: COLORS.events.attackWindow } },
            { xAxis: (d.attackEndFrame ?? d.numFrames - 1) * dt },
          ]] : [],
        },
      }],
    });
  }

  /** 当前帧游标（跨两个 grid 各画一条） */
  function updateCursor() {
    const s = store.getState();
    if (!chart || builtFor == null || !isActive() || !s.derived) return;
    const time = s.frameIdx * s.derived.dt;
    // 一条贯穿两个 grid 的竖线：上端=上 grid 的 y=1，下端=下 grid 的 y=0
    const top = chart.convertToPixel({ xAxisIndex: 0, yAxisIndex: 0 }, [time, 1]);
    const bottom = chart.convertToPixel({ xAxisIndex: 1, yAxisIndex: 1 }, [time, 0]);
    if (!Array.isArray(top) || !Number.isFinite(top[0])
      || !Array.isArray(bottom) || !Number.isFinite(bottom[1])) return;
    chart.setOption({
      graphic: [{
        id: 'detail-cursor', type: 'line', silent: true, z: 100,
        shape: { x1: top[0], y1: top[1], x2: top[0], y2: bottom[1] },
        style: { stroke: COLORS.ui.cursor, lineWidth: 1.2, opacity: 0.85 },
      }],
    });
  }

  // ---------------- 订阅 ----------------
  store.subscribe('scenario', () => {
    builtFor = null;
    markerState = '';
    if (chart) chart.clear();
  });
  store.subscribe('selection', () => { builtFor = null; maybeBuild(); });
  store.subscribe('tab', () => maybeBuild());
  store.subscribe('frame', () => { if (isActive()) { updateMarkers(); updateCursor(); } });
  store.subscribe('layers', () => { if (isActive()) updateMarkers(); });
}
