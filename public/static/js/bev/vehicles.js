/**
 * vehicles.js — 车辆/尾迹/速度矢量/真值层/ego 绘制（P1-6/7、P2-T1、P3-T1/T2）
 *
 * 无未来泄露（系统视角）：
 *  - CAV 着色只由当前帧 reputations 决定（repColor，缺席=unknown 灰）；
 *  - 注入目标与普通感知目标同样式（不显 FAKE/紫框）；仅当攻击车该帧被过滤时
 *    画"已滤除"样式（融合输出的真实近似）；
 *  - ⚠/红框/FAKE/伪造急停点等真值标记全部收进 drawGodOverlays（攻击视角，内部 godView 门控）。
 */

import { BEV, COLORS, repColor, repStatus } from '../config.js';
import * as store from '../store.js';
import { resetTargets, registerTarget } from './hittest.js';

function isPerception(v) {
  return Boolean(v?.is_cav || v?.is_adversary || v?.is_injected);
}

/** 该帧攻击车贡献是否被过滤（用于注入目标"已滤除"样式；索引用真值但不显示真值） */
function adversaryFilteredAt(ctxInfo) {
  const adv = ctxInfo.derived?.adversaryId;
  if (!adv) return false;
  const c = ctxInfo.metrics?.cavs?.[adv];
  return c != null && c.num_boxes_before != null && c.num_boxes_after != null
    && c.num_boxes_after < c.num_boxes_before;
}

// ---------------- 尾迹 + 速度矢量 ----------------

export function drawTrails(ctxInfo) {
  const { ctx, toX, toY, frame, state, scale } = ctxInfo;
  const t = state.frameIdx;
  const from = Math.max(0, t - BEV.TRAIL_FRAMES);
  const ids = (frame.vehicles || []).filter(isPerception).map((v) => String(v.id));
  if (!ids.length) return;

  // 收集每车最近 N 帧位置
  const tracks = new Map(ids.map((id) => [id, []]));
  for (let k = from; k <= t; k++) {
    const f = state.frames[k];
    if (!f) continue;
    for (const v of f.vehicles || []) {
      const vid = String(v.id);
      const track = tracks.get(vid);
      if (track) track.push([v.x, v.y]);
    }
  }

  ctx.save();
  ctx.lineCap = 'round';
  for (const v of frame.vehicles || []) {
    if (!isPerception(v)) continue;
    const vid = String(v.id);
    const track = tracks.get(vid) ?? [];
    const color = vehicleSystemColor(ctxInfo, v);

    // 渐隐折线：分段绘制，透明度随帧龄衰减。
    // 瞬移目标的相邻点距会异常大 → 视觉呈"跳变断裂"，正是要点破的空间语义。
    for (let i = 1; i < track.length; i++) {
      const alpha = 0.05 + 0.4 * (i / track.length);
      ctx.beginPath();
      ctx.moveTo(toX(track[i - 1][0]), toY(track[i - 1][1]));
      ctx.lineTo(toX(track[i][0]), toY(track[i][1]));
      ctx.strokeStyle = color;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // 速度矢量 = 1s 位移箭头（逆行方向反、超速箭头超长，一眼可辨）
    const speed = Number(v.speed);
    if (Number.isFinite(speed) && speed > 0.5) {
      const yawRad = -Number(v.yaw || 0) * Math.PI / 180;
      const len = speed * BEV.VECTOR_SECONDS * scale;
      const x0 = toX(v.x), y0 = toY(v.y);
      const x1 = x0 + Math.cos(yawRad) * len;
      const y1 = y0 + Math.sin(yawRad) * len;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      // 箭头头部
      const headAngle = Math.atan2(y1 - y0, x1 - x0);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - 6 * Math.cos(headAngle - 0.42), y1 - 6 * Math.sin(headAngle - 0.42));
      ctx.lineTo(x1 - 6 * Math.cos(headAngle + 0.42), y1 - 6 * Math.sin(headAngle + 0.42));
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
  ctx.restore();
}

// ---------------- 车辆本体 ----------------

/** 系统视角颜色（真值门控核心：绝不读 is_adversary/is_injected 定色） */
function vehicleSystemColor(ctxInfo, v) {
  const vid = String(v.id);
  const cavIds = ctxInfo.state.meta?.cav_ids?.map(String) ?? [];
  if (cavIds.includes(vid)) {
    const rep = ctxInfo.reps[vid] ?? null;
    return repColor(rep);
  }
  return COLORS.status.bgVeh;
}

export function drawVehicles(ctxInfo) {
  const { ctx, w, h, toX, toY, scale, frame, reps, state } = ctxInfo;
  resetTargets();

  const cavIds = new Set((state.meta?.cav_ids ?? []).map(String));
  const advFiltered = adversaryFilteredAt(ctxInfo);

  for (const v of frame.vehicles || []) {
    const vid = String(v.id);
    const cx = toX(v.x);
    const cy = toY(v.y);
    if (cx < -60 || cx > w + 60 || cy < -60 || cy > h + 60) continue;

    const halfLen = (v.length * scale) / 2;
    const halfWid = (v.width * scale) / 2;
    const perception = isPerception(v);
    const isCav = cavIds.has(vid);
    const rep = isCav ? (reps[vid] ?? null) : null;
    const status = isCav ? repStatus(rep) : null;
    const color = vehicleSystemColor(ctxInfo, v);

    // 注入目标在攻击车被过滤帧显示"已滤除"（系统输出的真实近似）
    const filteredOut = v.is_injected && advFiltered;

    let alpha = 1;
    if (!perception) alpha = 0.36;
    else if (filteredOut) alpha = 0.22;

    // 命中目标注册（全部可 hover；选中限 CAV 由 hittest 判断）
    registerTarget({
      id: vid, cx, cy, halfLen, halfWid, yawDeg: v.yaw,
      kind: isCav ? 'cav' : (perception ? 'perceived' : 'bg'),
    });

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-Number(v.yaw || 0) * Math.PI / 180);
    ctx.globalAlpha = alpha;

    const shrink = perception ? 1 : 0.82;
    const bw = v.length * scale * shrink;
    const bh = v.width * scale * shrink;

    ctx.fillStyle = color;
    ctx.fillRect(-halfLen * shrink, -halfWid * shrink, bw, bh);

    // 描边：形状冗余编码（P4-19）
    if (isCav && status === 'warn') {
      ctx.setLineDash([3, 2]);
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1.2;
    } else if (isCav && status === 'distrust') {
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.lineWidth = 2;
    } else {
      ctx.setLineDash([]);
      ctx.strokeStyle = perception ? 'rgba(255,255,255,0.3)' : 'rgba(148,163,184,0.22)';
      ctx.lineWidth = perception ? 0.5 : 0.35;
    }
    ctx.strokeRect(-halfLen * shrink, -halfWid * shrink, bw, bh);
    ctx.setLineDash([]);

    // 朝向小三角
    if (perception && !filteredOut) {
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.beginPath();
      ctx.moveTo(halfLen, 0);
      ctx.lineTo(halfLen - 3, -2);
      ctx.lineTo(halfLen - 3, 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // 状态角标（不随车旋转）：失信 ✕；可疑状态由虚线描边冗余编码。
    if (isCav && status === 'distrust') {
      drawBadge(ctx, cx + halfLen + 2, cy - halfWid - 2, '✕', COLORS.status.distrust);
    }

    // 已滤除标记（系统输出）
    if (filteredOut) {
      ctx.strokeStyle = 'rgba(148,163,184,0.8)';
      ctx.lineWidth = 1.4;
      const r = Math.max(6, Math.max(halfLen, halfWid));
      ctx.beginPath();
      ctx.moveTo(cx - r, cy - r); ctx.lineTo(cx + r, cy + r);
      ctx.moveTo(cx + r, cy - r); ctx.lineTo(cx - r, cy + r);
      ctx.stroke();
    }

    // 标签：仅选中/悬停显示（P1-10 去碰撞）
    const showLabel = state.selectedId === vid || state.hoveredId === vid;
    if (showLabel) {
      ctx.fillStyle = perception ? color : 'rgba(148,163,184,0.9)';
      ctx.font = 'bold 10px "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`V${vid}`, cx, cy - halfWid - 5);
      if (state.selectedId === vid && rep != null) {
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.font = '9px monospace';
        ctx.fillText(rep.toFixed(2), cx, cy + halfWid + 11);
      }
    }

    // 选中环
    if (state.selectedId === vid) {
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(12, Math.max(halfLen, halfWid) + 10), 0, Math.PI * 2);
      ctx.strokeStyle = COLORS.ui.selection;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

function drawBadge(ctx, x, y, glyph, color) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, 6, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(11,16,32,0.9)';
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.font = 'bold 8px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(glyph, x, y + 0.5);
  ctx.restore();
}

// ---------------- 真值层（仅攻击视角，内部 godView） ----------------

export function drawGodOverlays(ctxInfo) {
  const { ctx, w, h, toX, toY, scale, frame, derived, state } = ctxInfo;

  for (const v of frame.vehicles || []) {
    const cx = toX(v.x);
    const cy = toY(v.y);
    if (cx < -60 || cx > w + 60 || cy < -60 || cy > h + 60) continue;
    const halfLen = (v.length * scale) / 2;
    const halfWid = (v.width * scale) / 2;

    if (v.is_adversary) {
      ctx.strokeStyle = COLORS.status.truth;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(cx - halfLen - 3, cy - halfWid - 3, v.length * scale + 6, v.width * scale + 6);
      ctx.setLineDash([]);
      ctx.fillStyle = COLORS.status.truth;
      ctx.font = 'bold 11px "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`⚠ V${v.id}`, cx + halfLen + 6, cy + 3);
    }
    if (v.is_injected) {
      ctx.strokeStyle = COLORS.status.fake;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([2, 2]);
      ctx.strokeRect(cx - halfLen - 3, cy - halfWid - 3, v.length * scale + 6, v.width * scale + 6);
      ctx.setLineDash([]);
      ctx.fillStyle = COLORS.status.fake;
      ctx.font = 'bold 10px "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('FAKE', cx, cy + halfWid + 18);
    }
  }

  // 注入坐标 ◇（frames.attack.fake_locations / fake_location）
  const attack = frame.attack || {};
  const locs = Array.isArray(attack.fake_locations) && attack.fake_locations.length
    ? attack.fake_locations
    : (Array.isArray(attack.fake_location) ? [attack.fake_location] : []);
  ctx.strokeStyle = COLORS.status.fake;
  ctx.lineWidth = 1.2;
  for (const loc of locs) {
    const x = toX(loc[0]), y = toY(loc[1]);
    if (x < -20 || x > w + 20 || y < -20 || y > h + 20) continue;
    ctx.beginPath();
    ctx.moveTo(x, y - 6); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 6); ctx.lineTo(x - 6, y);
    ctx.closePath();
    ctx.stroke();
  }

  // brake 场景：伪造急停点（仅攻击窗口内）
  const bv = derived?.brakeVisual;
  if (bv?.stopLocation && bv.window
      && state.frameIdx >= bv.window[0] && state.frameIdx <= bv.window[1]) {
    const x = toX(bv.stopLocation[0]);
    const y = toY(bv.stopLocation[1]);
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.strokeStyle = COLORS.status.truth;
    ctx.lineWidth = 2;
    ctx.setLineDash([2, 2]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = COLORS.status.truth;
    ctx.font = 'bold 10px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('伪造急停点', x, y - 12);
  }
}

// ---------------- ego（P1-7） ----------------

export function drawEgo(ctxInfo) {
  const { ctx, toX, toY, scale, frame, state } = ctxInfo;
  const x = toX(frame.ego_x);
  const y = toY(frame.ego_y);
  const yawRad = -Number(frame.ego_yaw || 0) * Math.PI / 180;
  const egoId = state.meta?.ego_cav_id != null ? String(state.meta.ego_cav_id) : null;

  // 视野扇区（±35°，半径 22m）
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(yawRad);
  const fovR = 22 * scale;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.arc(0, 0, fovR, -Math.PI * 35 / 180, Math.PI * 35 / 180);
  ctx.closePath();
  ctx.fillStyle = 'rgba(0, 114, 178, 0.10)';
  ctx.fill();

  // 车形（圆角矩形近似）+ 朝向三角
  const L = Math.max(4.6 * scale, 10);
  const W = Math.max(2.1 * scale, 5);
  ctx.fillStyle = COLORS.status.ego;
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 1.2;
  roundRect(ctx, -L / 2, -W / 2, L, W, Math.min(3, W / 3));
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.beginPath();
  ctx.moveTo(L / 2, 0);
  ctx.lineTo(L / 2 - Math.min(6, L / 3), -Math.min(3.4, W / 2));
  ctx.lineTo(L / 2 - Math.min(6, L / 3), Math.min(3.4, W / 2));
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // 标签
  ctx.fillStyle = COLORS.status.ego;
  ctx.font = 'bold 10px "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`ego V${egoId ?? '--'}`, x, y - Math.max(2.4 * scale, 8) - 4);

  if (egoId) {
    registerTarget({
      id: egoId, cx: x, cy: y,
      halfLen: Math.max(2.3 * scale, 6), halfWid: Math.max(1.1 * scale, 4),
      yawDeg: frame.ego_yaw || 0, kind: 'ego',
    });
    if (state.selectedId === egoId) {
      ctx.beginPath();
      ctx.arc(x, y, 18, 0, Math.PI * 2);
      ctx.strokeStyle = COLORS.ui.selection;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
