/**
 * eventBand.js — 帧滑条下事件带（P0-2 / P2-T3）
 *
 * 系统视角（无未来泄露）：只画 ≤ 当前帧 的部分 —— 过滤活跃区间、ego 避让、
 * 非 godOnly 事件刻度，随回放逐步"生长"；攻击视角：全时段 + 攻击窗口底色。
 * 点击 → 跳帧；悬停 → title 显示最近事件。
 */

import { COLORS } from '../config.js';
import * as store from '../store.js';
import { visibleEvents } from '../events.js';

export function initEventBand() {
  const canvas = document.getElementById('eventBand');
  const ctx = canvas.getContext('2d');
  let cssW = 0, cssH = 0;
  let segments = null; // 场景级预计算

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    cssW = rect.width;
    cssH = rect.height;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(resize).observe(canvas);
  } else {
    window.addEventListener('resize', resize);
  }

  /** filterActive 布尔数组 → 连续区间 [start, end] */
  function toRanges(flags) {
    const ranges = [];
    let start = null;
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] && start == null) start = i;
      if (!flags[i] && start != null) { ranges.push([start, i - 1]); start = null; }
    }
    if (start != null) ranges.push([start, flags.length - 1]);
    return ranges;
  }

  function buildSegments(state) {
    const d = state.derived;
    if (!d) { segments = null; return; }
    segments = {
      numFrames: d.numFrames,
      filterRanges: toRanges(d.filterActive),
      attackWindows: d.attackWindows
        ?? [[d.onsetFrame, d.attackEndFrame ?? d.numFrames - 1]],
      egoResponse: d.egoResponse ? [d.egoResponse.start, d.egoResponse.end] : null,
    };
  }

  const xOf = (frame) => (frame / Math.max(1, segments.numFrames - 1)) * cssW;

  function fillRange(range, color, y, h, clampT = null) {
    let [a, b] = range;
    if (clampT != null) {
      if (a > clampT) return;
      b = Math.min(b, clampT);
    }
    ctx.fillStyle = color;
    ctx.fillRect(xOf(a), y, Math.max(1.5, xOf(b) - xOf(a)), h);
  }

  function draw() {
    ctx.clearRect(0, 0, cssW, cssH);
    if (!segments) return;
    const s = store.getState();
    const t = s.frameIdx;
    const god = s.layers.godView;
    const clampT = god ? null : t; // 系统视角只画 ≤t

    // 攻击窗口底色（真值，仅攻击视角）
    if (god) {
      for (const range of segments.attackWindows) {
        fillRange(range, COLORS.events.attackWindow, 0, cssH);
      }
    }

    // 过滤活跃区间（系统输出）
    for (const r of segments.filterRanges) {
      fillRange(r, COLORS.events.filterActive, cssH * 0.55, cssH * 0.45, clampT);
    }
    // ego 避让窗口（可观测行为）
    if (segments.egoResponse) {
      fillRange(segments.egoResponse, COLORS.events.egoResponse, 0, cssH * 0.4, clampT);
    }

    // 事件刻度
    const evs = visibleEvents(s.derived, t, god);
    for (const e of evs) {
      const x = xOf(e.frame);
      if (e.type === 'detection') {
        ctx.strokeStyle = COLORS.events.detection;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cssH); ctx.stroke();
        ctx.beginPath(); ctx.arc(x, 3.5, 2.6, 0, Math.PI * 2);
        ctx.fillStyle = COLORS.events.detection; ctx.fill();
      } else if (e.type === 'attack_onset' || e.type === 'attack_end') {
        ctx.strokeStyle = COLORS.status.truth;
        ctx.lineWidth = 1.2;
        ctx.setLineDash([2, 2]);
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cssH); ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.strokeStyle = 'rgba(161, 161, 170, 0.8)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, cssH * 0.3); ctx.lineTo(x, cssH); ctx.stroke();
      }
    }

    // 播放头（当前帧三角）
    const px = xOf(t);
    ctx.fillStyle = '#18181B';
    ctx.beginPath();
    ctx.moveTo(px, cssH - 5);
    ctx.lineTo(px - 3.5, cssH);
    ctx.lineTo(px + 3.5, cssH);
    ctx.closePath();
    ctx.fill();
  }

  // ---------------- 交互 ----------------
  function frameFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    return Math.round(ratio * (segments.numFrames - 1));
  }

  canvas.addEventListener('click', (e) => {
    if (!segments) return;
    store.setPlaying(false);
    store.setFrame(frameFromEvent(e), 'seek');
  });

  canvas.addEventListener('mousemove', (e) => {
    if (!segments) { canvas.title = ''; return; }
    const s = store.getState();
    const f = frameFromEvent(e);
    const evs = visibleEvents(s.derived, s.frameIdx, s.layers.godView);
    let nearest = null;
    for (const ev of evs) {
      const dist = Math.abs(ev.frame - f);
      if (dist <= 4 && (!nearest || dist < Math.abs(nearest.frame - f))) nearest = ev;
    }
    canvas.title = nearest
      ? `F${nearest.frame} ${nearest.icon} ${nearest.label}（点击跳帧）`
      : `F${f}（点击跳帧）`;
  });

  // ---------------- 订阅 ----------------
  store.subscribe('scenario', (state) => { buildSegments(state); resize(); });
  store.subscribe('frame', draw);
  store.subscribe('layers', draw);
}
