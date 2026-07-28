/**
 * toast.js — 关键事件轻量提示（P0-2 / P2-T5）
 *
 * 仅连续播放（cause='tick'）越过事件帧时触发（跳帧/拖拽不轰炸）；
 * godOnly 事件按图层门控；去抖：单批 ≤2 条、同型 5s 冷却；4s 自动消失。
 */

import * as store from '../store.js';

const SEVERITY = {
  detection: 'critical',
  attack_onset: 'critical',
  attack_end: 'warn',
  evidence_drop: 'warn',
  first_box_filter: 'warn',
  obstacle_filtered: 'good',
  obstacle_safe_pass: 'good',
  reputation_below_trust: 'warn',
  ego_response_start: 'good',
  ego_response_end: 'good',
};

const MAX_PER_BATCH = 2;
const TYPE_COOLDOWN_MS = 5000;
const AUTO_DISMISS_MS = 4000;

export function initToast() {
  const container = document.getElementById('toastContainer');
  let lastShownByType = new Map(); // type -> 时间戳（去抖）

  function show(event) {
    const el = document.createElement('div');
    el.className = `toast ${SEVERITY[event.type] ?? ''}`;
    el.innerHTML = `<span class="t-frame">F${event.frame}</span>${event.icon} ${event.label}`;
    container.appendChild(el);
    setTimeout(() => {
      el.classList.add('leaving');
      el.addEventListener('animationend', () => el.remove(), { once: true });
    }, AUTO_DISMISS_MS);
  }

  store.subscribe('frame', ({ idx, prev, cause }) => {
    const s = store.getState();
    if (cause !== 'tick' || !s.derived || !s.layers.toasts) return;
    if (prev == null || idx <= prev) return;

    const god = s.layers.godView;
    const now = performance.now();
    let shown = 0;
    for (const e of s.derived.events) {
      if (e.frame <= prev || e.frame > idx) continue;   // 本次 tick 越过的区间 (prev, idx]
      if (e.godOnly && !god) continue;                   // 真值事件门控
      const last = lastShownByType.get(e.type) ?? -Infinity;
      if (now - last < TYPE_COOLDOWN_MS) continue;
      if (shown >= MAX_PER_BATCH) break;
      lastShownByType.set(e.type, now);
      show(e);
      shown++;
    }
  });

  store.subscribe('scenario', () => {
    container.innerHTML = '';
    lastShownByType = new Map();
  });

  store.subscribe('layers', (layers) => {
    if (!layers.toasts) container.innerHTML = '';
  });
}
