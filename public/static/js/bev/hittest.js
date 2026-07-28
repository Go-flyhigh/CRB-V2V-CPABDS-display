/**
 * hittest.js — BEV 命中测试 + 悬停 tooltip（P1-10 / P3-T3）
 *
 * 系统视角下 tooltip 绝不出现"注入/攻击"字样（真值门控见 INTERFACES.md 规则 2）。
 */

import { repColor, repStatus, THRESHOLD } from '../config.js';
import * as store from '../store.js';

let targets = [];

export function resetTargets() {
  targets = [];
}

/** kind: 'cav' | 'ego' | 'perceived' | 'bg' */
export function registerTarget({ id, cx, cy, halfLen, halfWid, yawDeg, kind }) {
  const padding = 8;
  targets.push({
    id: String(id),
    cx, cy, halfLen, halfWid,
    angle: -Number(yawDeg || 0) * Math.PI / 180,
    padding,
    radius: Math.max(16, Math.hypot(halfLen, halfWid) + padding),
    kind,
  });
}

function findTarget(x, y) {
  let best = null;
  for (const t of targets) {
    const dx = x - t.cx;
    const dy = y - t.cy;
    const distance = Math.hypot(dx, dy);
    if (distance > t.radius) continue;
    const cos = Math.cos(-t.angle);
    const sin = Math.sin(-t.angle);
    const localX = dx * cos - dy * sin;
    const localY = dx * sin + dy * cos;
    const insideBody =
      Math.abs(localX) <= t.halfLen + t.padding &&
      Math.abs(localY) <= t.halfWid + t.padding;
    const score = distance + (insideBody ? 0 : 24);
    if (!best || score < best.score) best = { target: t, score };
  }
  return best?.target ?? null;
}

function roleText(target, v, godView, derived) {
  if (target.kind === 'ego') return '本车 (ego)';
  if (godView) {
    if (v?.is_injected) return '注入虚假目标';
    if (v?.is_adversary) return '攻击车辆 (CAV)';
  }
  if (target.kind === 'cav') return '协同车辆 (CAV)';
  if (target.kind === 'perceived') return '感知目标';
  return '背景交通';
}

function buildTooltipHtml(target) {
  const s = store.getState();
  const frame = store.currentFrame();
  if (!frame) return null;
  const vid = target.id;
  const v = (frame.vehicles || []).find((x) => String(x.id) === vid)
    ?? (target.kind === 'ego' ? { speed: null } : null);
  const reps = store.currentReputations();
  const metrics = store.currentMetrics()?.cavs?.[vid];
  const isCav = (s.meta?.cav_ids || []).map(String).includes(vid);

  const rows = [];
  rows.push(`<div class="tt-title">V${vid} · ${roleText(target, v, s.layers.godView, s.derived)}</div>`);
  if (v && Number.isFinite(Number(v.speed))) {
    rows.push(`<div class="tt-row">速度 <b>${Number(v.speed).toFixed(1)} m/s</b></div>`);
  }
  if (isCav) {
    const rep = reps[vid] ?? null;
    const statusText = { trust: '可信', warn: '可疑', distrust: '失信', unknown: '无数据' }[repStatus(rep)];
    rows.push(`<div class="tt-row">信誉 <b style="color:${repColor(rep)}">${rep == null ? '--' : rep.toFixed(3)}</b> · ${statusText}</div>`);
    if (metrics) {
      const ev = metrics.evidence_score;
      const cons = metrics.voting_consistency_ratio;
      const phys = metrics.physical_score;
      if (ev != null) rows.push(`<div class="tt-row">证据分 <b>${Number(ev).toFixed(3)}</b></div>`);
      if (cons != null) rows.push(`<div class="tt-row">投票一致性 <b>${Number(cons).toFixed(3)}</b></div>`);
      if (phys != null) rows.push(`<div class="tt-row">物理分 <b>${Number(phys).toFixed(3)}</b></div>`);
      const nb = metrics.num_boxes_before, na = metrics.num_boxes_after;
      if (nb != null && na != null && na < nb) {
        rows.push(`<div class="tt-row">检测框 <b>${nb}→${na}</b>（本帧被过滤）</div>`);
      }
    }
  }
  return rows.join('');
}

export function initHittest(canvasEl, requestRender) {
  const tooltip = document.getElementById('bevTooltip');

  function pointer(event) {
    const rect = canvasEl.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function hideTooltip() {
    tooltip.hidden = true;
  }

  function showTooltip(target, px, py) {
    const html = buildTooltipHtml(target);
    if (!html) { hideTooltip(); return; }
    tooltip.innerHTML = html;
    tooltip.hidden = false;
    // 定位光标右下，越界翻转
    const host = canvasEl.parentElement.getBoundingClientRect();
    const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
    let left = px + 14, top = py + 14;
    if (left + tw > host.width - 8) left = px - tw - 14;
    if (top + th > host.height - 8) top = py - th - 14;
    tooltip.style.left = `${Math.max(4, left)}px`;
    tooltip.style.top = `${Math.max(4, top)}px`;
  }

  canvasEl.addEventListener('mousemove', (e) => {
    const s = store.getState();
    if (!s.frames.length) { hideTooltip(); return; }
    // 拖拽平移期间不做 hover（canvas.js 在拖拽时设置 data-panning）
    if (canvasEl.dataset.panning === '1') { hideTooltip(); return; }
    const p = pointer(e);
    const target = findTarget(p.x, p.y);
    canvasEl.style.cursor = target ? 'pointer' : 'default';
    if (target) {
      store.setHovered(target.id);
      showTooltip(target, p.x, p.y);
    } else {
      store.setHovered(null);
      hideTooltip();
    }
  });

  canvasEl.addEventListener('mouseleave', () => {
    canvasEl.style.cursor = 'default';
    store.setHovered(null);
    hideTooltip();
  });

  canvasEl.addEventListener('click', (e) => {
    const s = store.getState();
    if (!s.frames.length) return;
    if (canvasEl.dataset.dragged === '1') return; // 拖拽结束的 click 不选中
    const p = pointer(e);
    const target = findTarget(p.x, p.y);
    if (!target) return;
    // 仅 CAV / ego 可选中（与 V1 一致：详情图只有 CAV 有指标）
    const selectable = new Set((s.meta?.cav_ids || []).map(String));
    if (selectable.has(target.id)) {
      store.setSelection(target.id);
    }
  });

  // 帧变化时若 tooltip 正在显示，内容会过期 → 隐藏（简单可靠）
  store.subscribe('frame', hideTooltip);
  store.subscribe('scenario', () => { resetTargets(); hideTooltip(); });
}
