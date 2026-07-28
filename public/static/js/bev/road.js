/**
 * road.js — 道路底图图层（P1-5 分层交付）
 *
 * Tier 2：/static/assets/roads/<map>.geojson（离线由 tools/export_town03_roads.py 生成）
 *         车道中心线矢量，世界坐标，随视图变换绘制。
 * Tier 0：零依赖兜底 — 场景加载时把全部帧所有车辆(含背景交通)轨迹渲染进
 *         离屏画布（"车走过的地方"即路），每帧按视图变换贴图。
 * 有 Tier2 数据则优先矢量；Tier 切换只换数据源，渲染接口不变（drawRoad）。
 */

import { COLORS } from '../config.js';
import * as store from '../store.js';
import { fetchRoadGeoJson } from '../api.js';

let geojson = null;        // Tier2 数据（当前场景地图）
let geojsonMap = null;     // 已加载的地图名，避免重复 fetch
let tier0 = null;          // { canvas, minX, minY, metersPerPx }

const TIER0_RES = 0.5;     // 米/像素
const TIER0_MAX = 4096;    // 离屏画布边长上限
const TIER0_PAD = 20;      // 包围盒边距（米）

export function initRoad() {
  store.subscribe('scenario', async (state) => {
    tier0 = null;
    if (!state.meta) { geojson = null; geojsonMap = null; return; }

    buildTier0(state);

    const mapName = state.meta.map;
    if (mapName && mapName !== geojsonMap) {
      geojson = null;
      const data = await fetchRoadGeoJson(mapName);
      // 场景可能已再次切换；仅当地图仍匹配时采纳
      if (store.getState().meta?.map === mapName) {
        geojson = data;
        geojsonMap = data ? mapName : null;
      }
    }
  });
}

function buildTier0(state) {
  const b = state.derived?.worldBounds;
  if (!b || !Number.isFinite(b.minX)) return;

  const minX = b.minX - TIER0_PAD;
  const minY = b.minY - TIER0_PAD;
  const wMeters = (b.maxX - b.minX) + TIER0_PAD * 2;
  const hMeters = (b.maxY - b.minY) + TIER0_PAD * 2;
  let metersPerPx = TIER0_RES;
  let pw = Math.ceil(wMeters / metersPerPx);
  let ph = Math.ceil(hMeters / metersPerPx);
  if (Math.max(pw, ph) > TIER0_MAX) {
    metersPerPx = Math.max(wMeters, hMeters) / TIER0_MAX;
    pw = Math.ceil(wMeters / metersPerPx);
    ph = Math.ceil(hMeters / metersPerPx);
  }

  const cv = document.createElement('canvas');
  cv.width = pw;
  cv.height = ph;
  const c = cv.getContext('2d');
  // 世界 → 离屏像素（y 翻转，与 BEV 一致）
  const px = (x) => (x - minX) / metersPerPx;
  const py = (y) => ph - (y - minY) / metersPerPx;

  c.strokeStyle = 'rgba(148, 163, 184, 1)';
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.globalAlpha = 0.045;                    // 多车反复经过叠加变亮 → 自然呈现主路
  c.lineWidth = Math.max(1, 3.5 / metersPerPx); // ≈3.5m 车道宽

  // 逐车连线（含背景交通；注入目标也画 — 只是"哪里有车走过"的底纹，不承载语义）
  const tracks = new Map();
  for (const f of state.frames) {
    for (const v of f.vehicles || []) {
      const vid = String(v.id);
      let arr = tracks.get(vid);
      if (!arr) { arr = []; tracks.set(vid, arr); }
      arr.push([v.x, v.y]);
    }
  }
  for (const pts of tracks.values()) {
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      // 瞬移类的超长段不画（避免离屏图上划出假线）
      if (Math.hypot(x1 - x0, y1 - y0) > 15) continue;
      c.beginPath();
      c.moveTo(px(x0), py(y0));
      c.lineTo(px(x1), py(y1));
      c.stroke();
    }
  }

  tier0 = { canvas: cv, minX, minY, metersPerPx, ph };
}

export function drawRoad(ctxInfo) {
  if (geojson) {
    drawTier2(ctxInfo);
  } else if (tier0) {
    drawTier0(ctxInfo);
  }
}

function drawTier0(ctxInfo) {
  const { ctx, toX, toY } = ctxInfo;
  const t = tier0;
  // 离屏图左上角对应世界坐标 (minX, minY + ph*metersPerPx)
  const worldTopY = t.minY + t.canvas.height * t.metersPerPx;
  const x0 = toX(t.minX);
  const y0 = toY(worldTopY);
  const wPx = t.canvas.width * t.metersPerPx * ctxInfo.scale;
  const hPx = t.canvas.height * t.metersPerPx * ctxInfo.scale;
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(t.canvas, x0, y0, wPx, hPx);
  ctx.restore();
}

function drawTier2(ctxInfo) {
  const { ctx, w, h, toX, toY } = ctxInfo;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const features = geojson.features || [];
  for (const feat of features) {
    const geom = feat.geometry;
    if (!geom) continue;
    const lines = geom.type === 'LineString' ? [geom.coordinates]
      : geom.type === 'MultiLineString' ? geom.coordinates : [];
    const kind = feat.properties?.kind || 'center';
    ctx.strokeStyle = kind === 'edge' ? COLORS.ui.roadEdge : COLORS.ui.road;
    ctx.lineWidth = kind === 'edge' ? 1 : Math.max(1.5, 3.5 * ctxInfo.scale);
    for (const coords of lines) {
      let started = false;
      let visible = false;
      ctx.beginPath();
      for (const pt of coords) {
        const x = toX(pt[0]);
        const y = toY(pt[1]);
        if (x > -80 && x < w + 80 && y > -80 && y < h + 80) visible = true;
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      if (visible) ctx.stroke();
    }
  }
  ctx.restore();
}
