/**
 * reputationChart.js — 主信誉曲线（P2-12/13/14、P2-T4）
 *
 * 场景级一次构建 series（含阈值线、线端直标 vid）；帧级只动游标 graphic 与
 * "事件标注签名"变化时的 markPoint/markArea；选中只增量改目标 series 样式
 * （setOption 按 series.id 合并，保留用户图例勾选）。点击曲线跳帧。
 */

import { COLORS, THRESHOLD, seriesColor, repColor } from '../config.js';
import * as store from '../store.js';
import { visibleEvents } from '../events.js';

export function initReputationChart() {
  const el = document.getElementById('reputationChart');
  const chart = echarts.init(el);
  let lastSelected = null;
  let lastSignature = '';
  let adversarySeriesId = null;

  // 容器尺寸随布局变化（如 KPI 行出现）时必须同步 resize，否则命中坐标错位
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => { chart.resize(); updateCursor(); }).observe(el);
  } else {
    window.addEventListener('resize', () => { chart.resize(); updateCursor(); });
  }

  // ---------------- 场景级构建 ----------------
  function build(state) {
    lastSelected = null;
    lastSignature = '';
    adversarySeriesId = null;
    if (!state.meta || !state.reputation) { chart.clear(); return; }

    const timeline = state.reputation.timeline ?? [];
    const cavIds = (state.meta.cav_ids ?? []).map(String);
    const derived = state.derived;
    const dt = Number(state.meta.fixed_delta_seconds) || 0.05;
    const declaredFrameCount = Number(state.meta.num_frames);
    const frameCount = Number.isFinite(declaredFrameCount) && declaredFrameCount > 0
      ? declaredFrameCount
      : timeline.length;
    const lastTimestamp = Number(timeline[timeline.length - 1]?.timestamp);
    // F0…F199 的采样点止于 9.95 s，但 200 个 0.05 s 帧覆盖完整的 10 s
    // 回放区间。坐标轴展示区间终点，曲线数据仍保持原始采样时间不变。
    const playbackEnd = Math.max(
      frameCount * dt,
      Number.isFinite(lastTimestamp) ? lastTimestamp + dt : 0,
    );
    const axisMax = Math.max(1, Math.round(playbackEnd * 1e9) / 1e9);

    let dataMin = 1;
    const mkData = (vid) => timeline.map((snap) => {
      const v = snap.reputations[vid] ?? null;
      if (v != null && v < dataMin) dataMin = v;
      return [snap.timestamp, v];
    });

    const series = cavIds.map((vid, i) => {
      const id = `cav-${vid}`;
      if (vid === derived?.adversaryId) adversarySeriesId = id;
      return {
        id,
        name: `V${vid}`,
        type: 'line',
        data: mkData(vid),
        smooth: true,
        connectNulls: false,
        symbol: 'none',
        lineStyle: { width: 1.4, color: seriesColor(i), opacity: 0.6 },
        itemStyle: { color: seriesColor(i) },
        emphasis: { focus: 'series' },
        endLabel: {
          show: true,
          formatter: `V${vid}`,
          fontSize: 9,
          color: seriesColor(i),
          distance: 4,
        },
        labelLayout: { moveOverlap: 'shiftY' },
        z: 2,
      };
    });

    // 注入目标（真值 id，但系列以中性"感知目标"呈现，不称 FAKE/虚假 — 门控见 INTERFACES.md）
    const ghostIds = [...(derived?.injectedIds ?? [])]
      .filter((vid) => timeline.some((snap) => snap.reputations[vid] != null));
    for (const vid of ghostIds) {
      series.push({
        id: `ghost-${vid}`,
        name: `V${vid}·感知目标`,
        type: 'line',
        data: mkData(vid),
        smooth: true,
        connectNulls: false,
        symbol: 'none',
        lineStyle: { width: 1.8, type: 'dashed', color: COLORS.status.fake, opacity: 0.8 },
        itemStyle: { color: COLORS.status.fake },
        emphasis: { focus: 'series' },
        z: 4,
      });
    }

    // 阈值线挂第一个系列
    if (series.length) {
      series[0].markLine = {
        silent: true,
        symbol: 'none',
        data: [
          {
            yAxis: THRESHOLD.TRUST,
            lineStyle: { color: COLORS.status.trust, type: 'dashed', width: 1 },
            label: {
              show: true, formatter: `低信誉阈值 ${THRESHOLD.TRUST.toFixed(2)}`, color: COLORS.status.trust, fontSize: 10,
              position: 'insideStartTop', distance: [4, 0],
              backgroundColor: COLORS.ui.panel, padding: [1, 4], borderRadius: 3,
            },
          },
          {
            yAxis: THRESHOLD.DISTRUST,
            lineStyle: { color: COLORS.status.distrust, type: 'dashed', width: 1 },
            label: {
              show: true, formatter: `失信阈值 ${THRESHOLD.DISTRUST.toFixed(1)}`, color: COLORS.status.distrust, fontSize: 10,
              position: 'insideStartTop', distance: [4, 0],
              backgroundColor: COLORS.ui.panel, padding: [1, 4], borderRadius: 3,
            },
          },
        ],
      };
    }

    // y 轴自适应下界，但始终给失信阈值线保留 0.05 的下方空间。
    const thresholdFloor = Math.max(0, THRESHOLD.DISTRUST - 0.05);
    const yMin = Math.max(0, Math.min(thresholdFloor, Math.floor((dataMin - 0.05) * 20) / 20));

    chart.setOption({
      backgroundColor: 'transparent',
      // 顶部独立保留“图例 + 事件标注”双层空间；高信誉区的 pin 标签不再
      // 上探到 CAV 图例。底部空间则供居中的时间轴标题使用。
      grid: { top: 72, right: 46, bottom: 38, left: 36, containLabel: true },
      tooltip: {
        trigger: 'axis',
        backgroundColor: COLORS.ui.panel,
        borderColor: COLORS.ui.border,
        textStyle: { color: COLORS.ui.text, fontSize: 12 },
        axisPointer: { type: 'line', lineStyle: { color: COLORS.ui.accent, width: 1 } },
        formatter: (params) => {
          if (!params.length) return '';
          const time = Number(params[0].axisValue).toFixed(2);
          const rows = params
            .filter((p) => p.value && p.value[1] != null)
            .sort((a, b) => b.value[1] - a.value[1])
            .map((p) => `${p.marker}${p.seriesName}: <b>${Number(p.value[1]).toFixed(3)}</b>`)
            .join('<br/>');
          return `时间 ${time}s · 点击跳帧<br/>${rows}`;
        },
      },
      legend: {
        type: 'scroll',
        textStyle: { color: COLORS.ui.muted, fontSize: 11 },
        pageIconColor: COLORS.ui.muted,
        pageTextStyle: { color: COLORS.ui.muted },
        top: 0, left: 4, right: 4,
      },
      xAxis: {
        type: 'value',
        name: '时间 (s)',
        nameLocation: 'middle',
        nameGap: 28,
        min: 0,
        max: axisMax,
        nameTextStyle: { color: COLORS.ui.gridLabel, fontSize: 11 },
        axisLine: { lineStyle: { color: COLORS.ui.axis } },
        axisLabel: { color: COLORS.ui.gridLabel, fontSize: 10 },
        splitLine: { lineStyle: { color: COLORS.ui.grid } },
      },
      yAxis: {
        type: 'value',
        name: '信誉值',
        nameLocation: 'middle',
        nameRotate: 90,
        nameGap: 30,
        min: yMin, max: 1,
        nameTextStyle: { color: COLORS.ui.gridLabel, fontSize: 11 },
        axisLine: { lineStyle: { color: COLORS.ui.axis } },
        axisLabel: { color: COLORS.ui.gridLabel, fontSize: 10 },
        splitLine: { lineStyle: { color: COLORS.ui.grid } },
      },
      series,
    }, true); // 场景切换时整图重建是合法的（build 路径，非帧路径）

    updateMarkers(true);
    updateCursor();
    updateChips();
  }

  // ---------------- 事件标注（签名变化才 setOption） ----------------
  function markerSignature(state) {
    const t = state.frameIdx;
    const god = state.layers.godView;
    const evs = visibleEvents(state.derived, t, god)
      .filter((e) => ['evidence_drop', 'reputation_below_trust', 'detection'].includes(e.type));
    return `${god ? 'G' : 'S'}|${evs.map((e) => `${e.type}:${e.frame}`).join(',')}`;
  }

  function updateMarkers(force = false) {
    const state = store.getState();
    if (!state.derived || !adversarySeriesId) return;
    const sig = markerSignature(state);
    if (!force && sig === lastSignature) return;
    lastSignature = sig;

    const d = state.derived;
    const timeline = state.reputation.timeline;
    const god = state.layers.godView;
    const t = state.frameIdx;

    const pointAt = (frame, label, color) => {
      const snap = timeline[frame];
      const y = snap?.reputations?.[d.adversaryId];
      if (snap == null || y == null) return null;
      return {
        coord: [snap.timestamp, y],
        value: label,
        itemStyle: { color },
        label: {
          show: true, formatter: label, fontSize: 9, color: COLORS.ui.text,
          backgroundColor: COLORS.ui.panel, padding: [2, 4], borderRadius: 3,
          position: 'top', distance: 8,
        },
      };
    };

    const pts = [];
    for (const e of visibleEvents(d, t, god)) {
      if (e.type === 'detection') {
        pts.push(pointAt(e.frame, `V${e.vid} 跌破失信阈值 @F${e.frame}`, COLORS.events.detection));
      } else if (e.type === 'reputation_below_trust') {
        pts.push(pointAt(e.frame, `跌破可信 @F${e.frame}`, COLORS.status.warn));
      } else if (e.type === 'evidence_drop') {
        pts.push(pointAt(e.frame, `证据骤降 @F${e.frame}`, COLORS.events.evidenceDrop));
      }
    }

    // 攻击窗口（真值）仅攻击视角
    const dt = d.dt;
    const attackWindows = d.attackWindows
      ?? [[d.onsetFrame, d.attackEndFrame ?? d.numFrames - 1]];
    const areas = god ? attackWindows.map(([start, end], index) => [
      {
        xAxis: start * dt,
        itemStyle: { color: COLORS.events.attackWindow },
        label: {
          show: index === 0,
          formatter: attackWindows.length > 1 ? '间歇攻击窗口' : '攻击窗口',
          color: '#fecaca', fontSize: 9, position: 'insideTop',
        },
      },
      { xAxis: end * dt },
    ]) : [];

    chart.setOption({
      series: [{
        id: adversarySeriesId,
        markPoint: {
          silent: true,
          symbol: 'pin',
          symbolSize: 28,
          data: pts.filter(Boolean),
        },
        markArea: { silent: true, data: areas },
      }],
    });
  }

  // ---------------- 帧游标（graphic，每帧就地移动） ----------------
  function updateCursor() {
    const state = store.getState();
    const timeline = state.reputation?.timeline;
    if (!timeline?.length) return;
    const snap = timeline[state.frameIdx] ?? timeline[0];
    const lower = chart.convertToPixel({ xAxisIndex: 0, yAxisIndex: 0 }, [snap.timestamp, 0]);
    const upper = chart.convertToPixel({ xAxisIndex: 0, yAxisIndex: 0 }, [snap.timestamp, 1]);
    if (!Array.isArray(lower) || !Number.isFinite(lower[0])) return;
    const width = el.clientWidth;
    const x = Math.max(0, Math.min(width, lower[0]));
    const labelOnLeft = x > width - 72;
    chart.setOption({
      graphic: [
        {
          id: 'frame-guide', type: 'line', silent: true, z: 100,
          shape: { x1: x, y1: upper[1], x2: x, y2: lower[1] },
          style: { stroke: COLORS.ui.cursor, lineWidth: 1.6 },
        },
        {
          id: 'frame-label', type: 'text', silent: true, z: 101,
          x: labelOnLeft ? x - 6 : x + 6, y: upper[1] + 4,
          style: {
            text: `F${state.frameIdx}`,
            fill: COLORS.ui.accent, font: '10px monospace',
            align: labelOnLeft ? 'right' : 'left', verticalAlign: 'top',
            backgroundColor: COLORS.ui.panel, padding: [2, 5], borderRadius: 4,
          },
        },
      ],
    });
  }

  // ---------------- 选中：仅增量改样式，保留图例勾选 ----------------
  function applySelection(state) {
    const cavIds = (state.meta?.cav_ids ?? []).map(String);
    const patches = [];
    const styleFor = (vid, selected) => {
      const i = cavIds.indexOf(vid);
      if (i < 0) return null;
      return {
        id: `cav-${vid}`,
        lineStyle: {
          width: selected ? 3.2 : 1.4,
          opacity: selected ? 1 : 0.6,
          color: seriesColor(i),
        },
        z: selected ? 10 : 2,
      };
    };
    if (lastSelected) {
      const p = styleFor(lastSelected, false);
      if (p) patches.push(p);
    }
    if (state.selectedId) {
      const p = styleFor(state.selectedId, true);
      if (p) patches.push(p);
    }
    lastSelected = state.selectedId;
    if (patches.length) chart.setOption({ series: patches });
    updateChips();
  }

  // ---------------- stat 芯片 ----------------
  function updateChips() {
    const state = store.getState();
    const snap = state.reputation?.timeline?.[state.frameIdx];
    document.getElementById('chartTime').textContent =
      snap ? `${snap.timestamp.toFixed(2)}s` : '--';
    const vid = state.selectedId;
    document.getElementById('chartSelected').textContent = vid ? `V${vid}` : 'V--';
    const scoreEl = document.getElementById('chartScore');
    const score = vid ? (snap?.reputations?.[vid] ?? null) : null;
    scoreEl.textContent = score == null ? '--' : score.toFixed(3);
    scoreEl.style.color = score == null ? '' : repColor(score);
  }

  // ---------------- 点击跳帧（P2-13） ----------------
  chart.getZr().on('click', (e) => {
    const state = store.getState();
    if (!state.derived) return;
    const pt = [e.offsetX, e.offsetY];
    if (!chart.containPixel({ gridIndex: 0 }, pt)) return;
    const [time] = chart.convertFromPixel({ xAxisIndex: 0, yAxisIndex: 0 }, pt);
    if (!Number.isFinite(time)) return;
    const idx = Math.round(time / state.derived.dt);
    store.setPlaying(false);
    store.setFrame(idx, 'seek');
  });

  // ---------------- 订阅 ----------------
  store.subscribe('scenario', build);
  store.subscribe('frame', () => { updateCursor(); updateMarkers(); updateChips(); });
  store.subscribe('selection', () => applySelection(store.getState()));
  store.subscribe('layers', () => updateMarkers());
}
