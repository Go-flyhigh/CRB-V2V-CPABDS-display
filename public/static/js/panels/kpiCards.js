/**
 * kpiCards.js — 检测效果 KPI 卡（P0-3 / P2-T6）
 *
 * 全部按当前帧 t 累计计算（无未来泄露）：
 *  - 检测延迟：detectionStateAt —— 只在检测帧 ≤ t 后才显示（obstacle 如实显示"未达失信阈值"）；
 *  - 累计过滤框：derived.cumFilteredBoxes[t]（前缀和）；
 *  - 被过滤 CAV：firstFilterByVid 中 frame ≤ t 去重计数；攻击视角时 sub 追加误过滤明细（真值）；
 *  - 最低信誉：当前帧 CAV 最小值（?? 缺席处理）。
 */

import { repColor, THRESHOLD } from '../config.js';
import * as store from '../store.js';
import { detectionStateAt } from '../events.js';

export function initKpiCards() {
  const $ = (id) => document.getElementById(id);
  const els = {
    detCard: $('kpiDetection'), detValue: $('kpiDetectionValue'), detSub: $('kpiDetectionSub'),
    boxValue: $('kpiBoxesValue'), boxSub: $('kpiBoxesSub'),
    cavCard: $('kpiFilteredCavs'), cavValue: $('kpiFilteredCavsValue'), cavSub: $('kpiFilteredCavsSub'),
    worstValue: $('kpiWorstValue'), worstSub: $('kpiWorstSub'),
  };

  function update() {
    const s = store.getState();
    const d = s.derived;
    if (!d) return;
    const t = s.frameIdx;

    // ---- 检测延迟 ----
    const det = detectionStateAt(d, t);
    els.detCard.classList.remove('good', 'alert');
    if (det.detected) {
      els.detValue.textContent = `${det.delayFrames} 帧 / ${det.delaySeconds.toFixed(2)}s`;
      els.detSub.textContent = `攻击 F${d.onsetFrame} → 检测 F${det.frame}`;
      els.detCard.classList.add('good');
    } else if (d.detectionFrame == null && t >= d.numFrames - 1) {
      // 播到结尾仍未检测：如实呈现算法边界（obstacle 场景）
      els.detValue.textContent = '未达失信阈值';
      els.detSub.textContent = '信誉持续降级中（未跌破 0.4）';
      els.detCard.classList.add('alert');
    } else {
      els.detValue.textContent = '——';
      els.detSub.textContent = '尚未判定（攻击→信誉跌破失信阈值）';
    }

    // ---- 累计过滤框 ----
    const boxes = d.cumFilteredBoxes[Math.min(t, d.cumFilteredBoxes.length - 1)] ?? 0;
    els.boxValue.textContent = String(boxes);
    els.boxSub.textContent = `≤ F${t} 累计`;

    // ---- 被过滤 CAV（去重） ----
    const filtered = Object.entries(d.firstFilterByVid).filter(([, f]) => f <= t);
    els.cavValue.textContent = String(filtered.length);
    els.cavCard.classList.remove('alert');
    if (s.layers.godView) {
      const mis = d.misfiltered.filter((m) => m.frame <= t);
      if (mis.length) {
        els.cavSub.textContent = `其中误过滤: ${mis.map((m) => `V${m.vid}`).join(', ')}`;
        els.cavCard.classList.add('alert');
      } else {
        els.cavSub.textContent = '无误过滤（对照真值）';
      }
    } else {
      els.cavSub.textContent = `≤ F${t} 去重`;
    }

    // ---- 最低信誉 ----
    const reps = store.currentReputations();
    const cavIds = (s.meta?.cav_ids ?? []).map(String);
    let worstVid = null, worstRep = null;
    for (const vid of cavIds) {
      const r = reps[vid] ?? null;
      if (r == null) continue;
      if (worstRep == null || r < worstRep) { worstRep = r; worstVid = vid; }
    }
    if (worstRep == null) {
      els.worstValue.textContent = '--';
      els.worstValue.style.color = '';
      els.worstSub.textContent = '当前帧';
    } else {
      els.worstValue.textContent = `V${worstVid} ${worstRep.toFixed(3)}`;
      els.worstValue.style.color = repColor(worstRep);
      els.worstSub.textContent = worstRep > THRESHOLD.TRUST
        ? '全员可信' : (worstRep > THRESHOLD.DISTRUST ? '存在可疑车辆' : '存在失信车辆');
    }
  }

  store.subscribe('scenario', update);
  store.subscribe('frame', update);
  store.subscribe('layers', update);
}
