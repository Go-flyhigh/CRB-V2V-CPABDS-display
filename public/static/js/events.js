/**
 * events.js — 攻击事件模型与场景派生数据（P0-2 / P0-3 基座）
 *
 * 场景加载时一次性扫描 frames + reputation(timeline/metrics_timeline) + attack_params，
 * 按 attack_label 分派解析，产出：
 *  - events[]           统一事件数组（带 godOnly 标记：真值事件仅攻击视角可见）
 *  - detectionFrame 等   关键帧（全部由 ≤该帧 的算法输出判定，不读 vehicles.detected）
 *  - cumFilteredBoxes[]  逐帧累计过滤框（KPI 前缀和）
 *  - firstFilterByVid    每 CAV 首次被过滤帧（列表状态 / 误过滤 KPI）
 *  - worldBounds         全帧包围盒（Tier0 路网 / 视图钳制）
 *
 * 真实数据基准（自检验依据，见 DATA_REFERENCE §4）：
 *   brake  onset=50 detection=60 · rev onset=0 detection=164 · teleport detection=154
 *   imp    detection=16 · obstacle V147 filter=128 / safe pass=161 / detection=null
 */

import { THRESHOLD, EVENT_META, formatAttackLabel } from './config.js';

function isBrake(label) {
  return label === 'brake_fraud' || label === 'emergency_brake';
}

/** 攻击起点：brake=burst_start；持续型=首个 attack.is_active 或出现注入的帧；兜底 0 */
function findOnset(meta, frames) {
  const params = meta.attack_params || {};
  if (isBrake(meta.attack_label)) {
    const start = Number(params.burst_start);
    if (Number.isFinite(start)) return start;
  }
  for (const f of frames) {
    const a = f.attack || {};
    if (a.is_active || (a.injected_ado_ids && a.injected_ado_ids.length)) return f.frame_idx;
  }
  return 0;
}

function findAttackEnd(meta, frames) {
  const params = meta.attack_params || {};
  if (isBrake(meta.attack_label)) {
    const start = Number(params.burst_start);
    const dur = Number(params.burst_frames);
    if (Number.isFinite(start) && Number.isFinite(dur)) return start + dur - 1;
  }
  return null; // 持续型：至最后一帧
}

/** obstacle：原始 ego 轨迹与静态伪造障碍物的最近通过帧。 */
function findObstacleClosestApproach(frames) {
  let closest = null;
  for (const frame of frames) {
    const attack = frame.attack || {};
    const location = Array.isArray(attack.fake_location) && attack.fake_location.length >= 2
      ? attack.fake_location
      : attack.fake_locations?.[0];
    if (!Array.isArray(location) || location.length < 2) continue;
    const dx = Number(frame.ego_x) - Number(location[0]);
    const dy = Number(frame.ego_y) - Number(location[1]);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue;
    const candidate = { frame: frame.frame_idx, distanceM: Math.hypot(dx, dy) };
    if (!closest || candidate.distanceM < closest.distanceM) closest = candidate;
  }
  return closest;
}

export function deriveScenario(meta, frames, reputation) {
  const adversaryId = meta.adversary_cav_ids?.length ? String(meta.adversary_cav_ids[0]) : null;
  const egoId = meta.ego_cav_id != null ? String(meta.ego_cav_id) : null;
  const dt = Number(meta.fixed_delta_seconds) || 0.05;
  const timeline = reputation?.timeline ?? [];
  const metrics = reputation?.metrics_timeline ?? [];
  const params = meta.attack_params || {};
  const numFrames = frames.length;

  // ---- 关键帧（全部由逐帧算法输出判定）----
  const repAt = (t) => timeline[t]?.reputations?.[adversaryId];
  let warnFrame = null, detectionFrame = null;
  for (let t = 0; t < timeline.length; t++) {
    const r = repAt(t);
    if (r == null) continue;
    if (warnFrame == null && r < THRESHOLD.TRUST) warnFrame = timeline[t].frame_idx;
    if (detectionFrame == null && r < THRESHOLD.DISTRUST) { detectionFrame = timeline[t].frame_idx; break; }
  }

  let evidenceDropFrame = null;
  let firstFilterFrame = null;              // 攻击车首次被过滤（仅内部用）
  const firstFilterByVid = {};              // vid -> 首次 cav 级过滤帧
  const cumFilteredBoxes = new Array(numFrames).fill(0);
  const filterActive = new Array(numFrames).fill(false);
  let running = 0;
  for (let t = 0; t < numFrames; t++) {
    const m = metrics[t];
    const summary = m?.summary;
    if (summary) {
      const diff = Number(summary.num_boxes_before ?? 0) - Number(summary.num_boxes_after ?? 0);
      if (diff > 0) { running += diff; filterActive[t] = true; }
    }
    cumFilteredBoxes[t] = running;
    const cavs = m?.cavs || {};
    for (const [vid, c] of Object.entries(cavs)) {
      const nb = c.num_boxes_before, na = c.num_boxes_after;
      if (nb != null && na != null && na < nb && firstFilterByVid[vid] === undefined) {
        firstFilterByVid[vid] = m.frame_idx;
      }
    }
    if (adversaryId) {
      const ev = cavs[adversaryId]?.evidence_score;
      if (evidenceDropFrame == null && ev != null && ev < THRESHOLD.EVIDENCE_DROP) {
        evidenceDropFrame = m.frame_idx;
      }
    }
  }
  if (adversaryId && firstFilterByVid[adversaryId] !== undefined) {
    firstFilterFrame = firstFilterByVid[adversaryId];
  }

  // obstacle 的成功条件是攻击源贡献被框级过滤，而非必须跌破 0.4 信誉阈值。
  // 最近通过帧来自原始 ego 轨迹，仅在到达该帧时发布“无需避让”结果。
  let obstacleOutcome = null;
  if (meta.attack_label === 'obstacle_fabrication' && firstFilterFrame != null) {
    const closest = findObstacleClosestApproach(frames);
    if (closest && firstFilterFrame < closest.frame) {
      obstacleOutcome = {
        filterFrame: firstFilterFrame,
        closestFrame: closest.frame,
        filterLeadFrames: closest.frame - firstFilterFrame,
        filterLeadSeconds: (closest.frame - firstFilterFrame) * dt,
        closestDistanceM: closest.distanceM,
        egoAvoidanceRequired: false,
      };
    }
  }

  // 误过滤（vs 真值）：非攻击车被过滤 → 仅攻击视角/KPI 明细使用
  const misfiltered = Object.entries(firstFilterByVid)
    .filter(([vid]) => vid !== adversaryId)
    .map(([vid, frame]) => ({ vid, frame }))
    .sort((a, b) => a.frame - b.frame);

  // ---- 攻击窗口 / ego 避让（按 attack_label 分派 attack_params）----
  const onsetFrame = findOnset(meta, frames);
  const attackEndFrame = findAttackEnd(meta, frames);
  let egoResponse = null;
  {
    const s = Number(params.response_start_frame);
    const e = Number(params.response_end_frame);
    if (Number.isFinite(s) && Number.isFinite(e)) {
      egoResponse = { start: s, end: e, lateralOffset: Number(params.response_lateral_offset_m) || null };
    }
  }
  let brakeVisual = null;
  if (isBrake(meta.attack_label)) {
    const win = params.visualized_fake_brake_active_frames;
    brakeVisual = {
      window: Array.isArray(win) && win.length === 2 ? [Number(win[0]), Number(win[1])] : null,
      vehicleId: params.visualized_fake_brake_vehicle_id ?? null,
      stopLocation: Array.isArray(params.reported_stop_world_location)
        ? params.reported_stop_world_location : null,
    };
  }

  // ---- 注入车辆 id（真值，仅攻击视角/曲线虚线系列用）----
  const injectedIds = new Set();
  for (const f of frames) {
    for (const v of f.vehicles || []) {
      if (v.is_injected) injectedIds.add(String(v.id));
    }
  }

  // ---- 世界包围盒（含全部车辆 + ego，供 Tier0 路网与视图钳制）----
  const worldBounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (const f of frames) {
    const pts = [[f.ego_x, f.ego_y], ...(f.vehicles || []).map((v) => [v.x, v.y])];
    for (const [x, y] of pts) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < worldBounds.minX) worldBounds.minX = x;
      if (x > worldBounds.maxX) worldBounds.maxX = x;
      if (y < worldBounds.minY) worldBounds.minY = y;
      if (y > worldBounds.maxY) worldBounds.maxY = y;
    }
  }

  // ---- 统一事件数组 ----
  const events = [];
  const push = (frame, type, vid, extraLabel) => {
    if (frame == null || !Number.isFinite(frame)) return;
    const metaE = EVENT_META[type] || { text: type, icon: '·', godOnly: false };
    events.push({
      frame,
      type,
      vid: vid ?? null,
      godOnly: metaE.godOnly,
      icon: metaE.icon,
      label: extraLabel || (vid ? `V${vid} ${metaE.text}` : metaE.text),
    });
  };

  push(onsetFrame, 'attack_onset', adversaryId,
    `攻击开始（${formatAttackLabel(meta.attack_label)}）`);
  if (attackEndFrame != null) push(attackEndFrame, 'attack_end', adversaryId, '攻击窗口结束');
  push(evidenceDropFrame, 'evidence_drop', adversaryId);
  // 每辆曾被过滤的 CAV 都产生 first_box_filter 事件（系统输出，无泄露）。
  // obstacle 攻击源改用专属成功事件，避免与普通框过滤提示重复。
  for (const [vid, frame] of Object.entries(firstFilterByVid).sort((a, b) => a[1] - b[1])) {
    if (obstacleOutcome && vid === adversaryId) continue;
    push(frame, 'first_box_filter', vid);
  }
  if (obstacleOutcome) {
    const metric = metrics.find((m) => m?.frame_idx === obstacleOutcome.filterFrame);
    const cav = metric?.cavs?.[adversaryId];
    const boxChange = cav?.num_boxes_before != null && cav?.num_boxes_after != null
      ? `（${cav.num_boxes_before}→${cav.num_boxes_after}）` : '';
    push(obstacleOutcome.filterFrame, 'obstacle_filtered', adversaryId,
      `V${adversaryId} 攻击源伪造障碍物已过滤${boxChange}`);
    push(obstacleOutcome.closestFrame, 'obstacle_safe_pass', egoId,
      `V${egoId} ego 保持直行通过，无需避让`);
  }
  push(warnFrame, 'reputation_below_trust', adversaryId);
  push(detectionFrame, 'detection', adversaryId);
  if (egoResponse) {
    push(egoResponse.start, 'ego_response_start', egoId);
    push(egoResponse.end, 'ego_response_end', egoId);
  }
  events.sort((a, b) => a.frame - b.frame);

  return {
    adversaryId, egoId, dt, numFrames,
    onsetFrame, attackEndFrame,
    warnFrame, detectionFrame, evidenceDropFrame, firstFilterFrame,
    egoResponse, brakeVisual, obstacleOutcome,
    events,
    cumFilteredBoxes, filterActive,
    firstFilterByVid, misfiltered,
    injectedIds, worldBounds,
  };
}

/**
 * 第 t 帧可见事件（无未来泄露）：
 *  系统视角 = frame ≤ t 且非 godOnly；攻击视角 = 全部事件（含未来窗口边界）。
 */
export function visibleEvents(derived, t, godView) {
  if (!derived) return [];
  return derived.events.filter((e) => (godView ? true : (!e.godOnly && e.frame <= t)));
}

/** 第 t 帧检测状态（系统视角安全）：只在 detectionFrame ≤ t 后才"知道" */
export function detectionStateAt(derived, t) {
  if (!derived || derived.detectionFrame == null || derived.detectionFrame > t) {
    return { detected: false, delayFrames: null, delaySeconds: null };
  }
  const delay = derived.detectionFrame - derived.onsetFrame;
  return {
    detected: true,
    frame: derived.detectionFrame,
    delayFrames: delay,
    delaySeconds: delay * derived.dt,
  };
}
