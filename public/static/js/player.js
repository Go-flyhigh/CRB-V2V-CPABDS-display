/**
 * player.js — rAF 实时倍速回放（P3-15）
 *
 * 按真实经过时间 × 倍速推进：accum += elapsed*speed；每满 dt（meta.fixed_delta_seconds）
 * 推进一帧，单次 rAF 可跨多帧（高倍速不丢时序）。"1×"即真实时间：200 帧 × 0.05s ≈ 10s。
 */

import { PLAYBACK } from './config.js';
import * as store from './store.js';

export function initPlayer() {
  let rafId = null;
  let lastTs = null;   // 上一次 rAF 时间戳（ms）
  let accum = 0;       // 未消费的模拟时间（s）

  function tick(now) {
    const s = store.getState();
    if (!s.playing) { rafId = null; return; }

    if (lastTs != null) {
      accum += ((now - lastTs) / 1000) * store.getSpeed();
    }
    lastTs = now;

    const dt = s.derived?.dt ?? PLAYBACK.DEFAULT_DT;
    const steps = Math.floor(accum / dt);
    if (steps > 0) {
      accum -= steps * dt;
      const next = s.frameIdx + steps;
      if (next >= s.frames.length - 1) {
        store.setFrame(s.frames.length - 1, 'tick');
        store.setPlaying(false);
        rafId = null;
        return;
      }
      store.setFrame(next, 'tick');
    }
    rafId = requestAnimationFrame(tick);
  }

  store.subscribe('play', (playing) => {
    if (playing) {
      lastTs = null; // 重置计时基准，避免暂停期被计入
      accum = 0;
      if (rafId == null) rafId = requestAnimationFrame(tick);
    }
    // 停止由 tick 内部检测 playing=false 自然退出
  });

  store.subscribe('scenario', () => {
    accum = 0;
    lastTs = null;
  });

  // 页面隐藏时 rAF 自动停摆；恢复可见时重置基准，防止一次性跳大量帧
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      lastTs = null;
      accum = 0;
    }
  });
}
