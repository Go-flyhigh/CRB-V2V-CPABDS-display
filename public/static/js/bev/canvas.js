/**
 * canvas.js — BEV 渲染编排：视图变换、缩放/平移、网格/感知圈/比例尺（P1-8/9/10）
 *
 * 视图模型：
 *  - follow=true（默认）：以当前帧 ego 为中心；滚轮绕中心缩放；
 *  - 拖拽进入 free：中心=state.view.{panX,panY}（世界坐标）；滚轮绕光标缩放；
 *  - 双击 / "复位视图" → zoom=1, follow=true。
 * scale(px/m) = min(w,h) / (2 × DEFAULT_VIEW_RANGE / zoom) —— 固定基准视野，
 * 弃用 V1 "按全程最远车一次定死"（单帧离群车不再压缩全场）。
 */

import { BEV, COLORS } from '../config.js';
import * as store from '../store.js';
import { initRoad, drawRoad } from './road.js';
import { drawTrails, drawVehicles, drawGodOverlays, drawEgo } from './vehicles.js';
import { initHittest } from './hittest.js';

export function initBev() {
  const canvas = document.getElementById('vehicleCanvas');
  const ctx = canvas.getContext('2d');
  let cssW = 0, cssH = 0;
  let renderQueued = false;
  let coverageRadius = null; // EMA 平滑的协同感知范围半径

  // ---------- 渲染请求合并 ----------
  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  // ---------- 尺寸 ----------
  function resize() {
    const rect = canvas.parentElement.getBoundingClientRect();
    cssW = rect.width;
    cssH = rect.height;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    requestRender();
  }
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(resize).observe(canvas.parentElement);
  } else {
    window.addEventListener('resize', resize);
  }

  // ---------- 视图数学 ----------
  function viewParams() {
    const s = store.getState();
    const frame = s.frames[s.frameIdx];
    const zoom = s.view.zoom;
    const range = BEV.DEFAULT_VIEW_RANGE / zoom;
    const scale = Math.min(cssW, cssH) / (range * 2);
    let cx, cy;
    if (s.view.follow && frame) {
      cx = frame.ego_x; cy = frame.ego_y;
    } else {
      cx = s.view.panX; cy = s.view.panY;
    }
    return { scale, centerX: cx, centerY: cy };
  }
  function makeTransform() {
    const { scale, centerX, centerY } = viewParams();
    return {
      scale,
      toX: (x) => cssW / 2 + (x - centerX) * scale,
      toY: (y) => cssH / 2 - (y - centerY) * scale,
      fromPx: (px, py) => ({
        x: centerX + (px - cssW / 2) / scale,
        y: centerY - (py - cssH / 2) / scale,
      }),
      centerX, centerY,
    };
  }

  // ---------- 交互：滚轮缩放 ----------
  canvas.addEventListener('wheel', (e) => {
    const s = store.getState();
    if (!s.frames.length) return;
    e.preventDefault();
    const tf = makeTransform();
    const factor = Math.exp(-e.deltaY * 0.0012);
    const newZoom = Math.min(BEV.MAX_ZOOM, Math.max(BEV.MIN_ZOOM, s.view.zoom * factor));
    if (newZoom === s.view.zoom) return;

    if (s.view.follow) {
      store.setView({ zoom: newZoom }); // 跟随模式绕 ego 缩放
    } else {
      // 自由模式绕光标缩放：保持光标下的世界点不动
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      const world = tf.fromPx(px, py);
      const newRange = BEV.DEFAULT_VIEW_RANGE / newZoom;
      const newScale = Math.min(cssW, cssH) / (newRange * 2);
      store.setView({
        zoom: newZoom,
        panX: world.x - (px - cssW / 2) / newScale,
        panY: world.y + (py - cssH / 2) / newScale,
      });
    }
  }, { passive: false });

  // ---------- 交互：拖拽平移（进入自由模式） ----------
  let dragStart = null;
  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !store.getState().frames.length) return;
    const tf = makeTransform();
    dragStart = {
      px: e.clientX, py: e.clientY,
      centerX: tf.centerX, centerY: tf.centerY,
      scale: tf.scale, moved: false,
    };
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragStart) return;
    const dx = e.clientX - dragStart.px;
    const dy = e.clientY - dragStart.py;
    if (!dragStart.moved && Math.hypot(dx, dy) < 3) return;
    dragStart.moved = true;
    canvas.dataset.panning = '1';
    store.setView({
      follow: false,
      panX: dragStart.centerX - dx / dragStart.scale,
      panY: dragStart.centerY + dy / dragStart.scale,
    });
  });
  window.addEventListener('mouseup', () => {
    if (!dragStart) return;
    if (dragStart.moved) {
      // 让紧随的 click 事件不触发选中
      canvas.dataset.dragged = '1';
      setTimeout(() => { delete canvas.dataset.dragged; }, 0);
    }
    delete canvas.dataset.panning;
    dragStart = null;
  });

  canvas.addEventListener('dblclick', () => {
    if (!store.getState().frames.length) return;
    store.setView({ zoom: 1, panX: 0, panY: 0, follow: true });
  });

  // ---------- 绘制 ----------
  function render() {
    const s = store.getState();
    ctx.fillStyle = COLORS.ui.bg;
    ctx.fillRect(0, 0, cssW, cssH);

    const frame = s.frames[s.frameIdx];
    if (!frame) { drawGridOnly(); return; }

    const tf = makeTransform();
    const reps = store.currentReputations();
    const metrics = store.currentMetrics();
    const ctxInfo = {
      ctx, w: cssW, h: cssH,
      scale: tf.scale, toX: tf.toX, toY: tf.toY,
      frame, reps, metrics,
      derived: s.derived, layers: s.layers, state: s,
    };

    if (s.layers.road) drawRoad(ctxInfo);
    drawGrid(tf);
    if (s.layers.range) drawCoverage(ctxInfo);
    if (s.layers.trails) drawTrails(ctxInfo);
    drawVehicles(ctxInfo);
    if (s.layers.godView) drawGodOverlays(ctxInfo);
    drawEgo(ctxInfo);
    drawScaleBar(tf.scale);
  }

  function drawGridOnly() {
    ctx.strokeStyle = COLORS.ui.grid;
    ctx.lineWidth = 0.5;
    const step = 46;
    for (let x = 0; x <= cssW; x += step) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cssH); ctx.stroke();
    }
    for (let y = 0; y <= cssH; y += step) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cssW, y); ctx.stroke();
    }
  }

  function drawGrid(tf) {
    const step = BEV.GRID_STEP;
    const { scale } = tf;
    const stepPx = step * scale;
    if (stepPx < 8) return; // 缩得太小不画网格

    const topLeft = tf.fromPx(0, 0);
    const bottomRight = tf.fromPx(cssW, cssH);
    const x0 = Math.floor(topLeft.x / step) * step;
    const y0 = Math.floor(bottomRight.y / step) * step;
    const showLabels = stepPx > 34;

    ctx.strokeStyle = COLORS.ui.grid;
    ctx.lineWidth = 0.5;
    ctx.fillStyle = COLORS.ui.gridLabel;
    ctx.font = '9px monospace';
    for (let gx = x0; gx <= bottomRight.x; gx += step) {
      const cx = tf.toX(gx);
      ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, cssH); ctx.stroke();
      if (showLabels && Math.round(gx) % (step * 2) === 0) {
        ctx.textAlign = 'left';
        ctx.fillText(String(Math.round(gx)), cx + 3, cssH - 5);
      }
    }
    for (let gy = y0; gy <= topLeft.y; gy += step) {
      const cy = tf.toY(gy);
      ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(cssW, cy); ctx.stroke();
      if (showLabels && Math.round(gy) % (step * 2) === 0) {
        ctx.textAlign = 'left';
        ctx.fillText(String(Math.round(gy)), 4, cy - 3);
      }
    }
  }

  /** 协同感知范围（P1-9 更名）：以 ego 为心，随当帧最远感知车自适应 + EMA 平滑 */
  function drawCoverage(ctxInfo) {
    const { ctx: c, frame, toX, toY, scale } = ctxInfo;
    let maxDist = 0;
    for (const v of frame.vehicles || []) {
      if (!(v.is_cav || v.is_adversary || v.is_injected)) continue;
      const d = Math.hypot(v.x - frame.ego_x, v.y - frame.ego_y);
      if (Number.isFinite(d)) maxDist = Math.max(maxDist, d);
    }
    const target = Math.max(BEV.COVERAGE_MIN, maxDist + BEV.COVERAGE_MARGIN);
    coverageRadius = coverageRadius == null
      ? target
      : coverageRadius + (target - coverageRadius) * BEV.COVERAGE_SMOOTH;

    const r = coverageRadius * scale;
    c.beginPath();
    c.arc(toX(frame.ego_x), toY(frame.ego_y), r, 0, Math.PI * 2);
    c.strokeStyle = COLORS.ui.coverage;
    c.lineWidth = 1;
    c.stroke();
    c.fillStyle = COLORS.ui.coverageFill;
    c.fill();
  }

  function drawScaleBar(scale) {
    const candidates = [5, 10, 20, 50, 100, 200];
    let best = candidates[0];
    for (const c of candidates) {
      const px = c * scale;
      if (px >= 60 && px <= 160) { best = c; break; }
      if (px < 60) best = c; // 持续放大直到落进区间；全部过小则取最大
    }
    const px = best * scale;
    const x = cssW - px - 18;
    const y = cssH - 20;
    ctx.strokeStyle = 'rgba(199, 210, 254, 0.85)';
    ctx.fillStyle = 'rgba(199, 210, 254, 0.85)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y); ctx.lineTo(x + px, y);
    ctx.moveTo(x, y - 4); ctx.lineTo(x, y + 4);
    ctx.moveTo(x + px, y - 4); ctx.lineTo(x + px, y + 4);
    ctx.stroke();
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${best} m`, x + px / 2, y - 7);
  }

  // ---------- 订阅 ----------
  store.subscribe('scenario', () => { coverageRadius = null; requestRender(); });
  store.subscribe('frame', requestRender);
  store.subscribe('selection', requestRender);
  store.subscribe('layers', requestRender);
  store.subscribe('view', requestRender);
  store.subscribe('hover', requestRender);

  initRoad();
  initHittest(canvas, requestRender);
  resize();

  return { requestRender };
}
