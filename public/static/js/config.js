/**
 * config.js — V2 全局常量与色板令牌（单一来源）
 *
 * 色板经 dataviz skill 校验器验证（2026-07-10，light surface #F7F8FA）：
 *  - status 五色：CVD 相邻 ΔE 18.3（PASS）、对比度全部 ≥3:1（PASS）；
 *    橙/粉亮度带越界属 status 职能豁免，强制配合形状/图标冗余使用。
 *  - SERIES 十色（曲线类别色，固定顺序按 cav_ids 下标分配、绝不循环）：
 *    六检验全 PASS，最差相邻 ΔE 17.6（protan）。
 * CSS 变量（styles.css :root）与本文件同步，两处必须一致。
 */

// ---- CRB 信誉阈值（场景统一）----
export const THRESHOLD = {
  TRUST: 0.85,    // > 0.85 可信；<=0.85 为低信誉/可疑
  DISTRUST: 0.5,  // < 0.5 失信（= “检测帧”与整车过滤判定）
  EVIDENCE_DROP: 0.3, // 证据分骤降事件阈值；具体帧由当前发布的信誉时间线动态判定
};

// ---- 回放 ----
export const PLAYBACK = {
  DEFAULT_DT: 0.05,               // meta.fixed_delta_seconds 缺失时的兜底
  SPEED_STEPS: [0.25, 0.5, 1, 2, 4, 8], // ×实时
  DEFAULT_SPEED_IDX: 2,           // 1× 实时
};

// ---- BEV ----
export const BEV = {
  DEFAULT_VIEW_RANGE: 120,  // 初始半视野（米）
  MIN_ZOOM: 0.25,
  MAX_ZOOM: 8,
  GRID_STEP: 20,            // 米，带标注
  TRAIL_FRAMES: 24,         // 尾迹长度（1.2s @ 20fps）
  COVERAGE_MIN: 60,         // 协同感知范围下限（米）
  COVERAGE_MARGIN: 8,       // 半径余量
  COVERAGE_SMOOTH: 0.15,    // 感知圈半径 EMA 平滑系数
  VECTOR_SECONDS: 1.0,      // 速度矢量 = 1s 位移
};

// ---- 色板令牌 ----
export const COLORS = {
  // 状态色（Okabe-Ito · status 职能 · 必须叠加形状/线型/图标冗余）
  status: {
    trust:    '#009E73', // 可信 >0.85 · 实心
    warn:     '#E69F00', // 低信誉/可疑 0.5–0.85 · 实心+虚线描边
    distrust: '#D55E00', // 失信 <0.5 · 实心+粗描边+✕角标
    fake:     '#CC79A7', // 注入虚假（仅攻击视角）· 紫虚线框+FAKE
    ego:      '#0072B2', // ego · 车形+朝向+视野扇区
    bgVeh:    '#7F8C9B', // 背景交通 · 刻意低色度（去强调，不承担识别）
    truth:    '#D55E00', // 攻击真值（仅攻击视角）· 虚线描边+⚠
  },
  // 曲线类别色（10 槽，固定顺序按 cav_ids 下标分配；线端直标 vid 作二级编码）
  series: ['#1d7cd5', '#b84412', '#17933e', '#89579d', '#30a4ae',
           '#907900', '#7866d2', '#b93c4e', '#278d73', '#ad6723'],
  // 界面
  ui: {
    bg: '#F7F8FA',
    panel: '#FFFFFF',
    grid: '#E4E4E7',
    gridLabel: '#71717A',
    text: '#18181B',
    muted: '#71717A',
    accent: '#2563EB',
    border: '#E4E4E7',
    axis: '#D4D4D8',
    road: 'rgba(82, 82, 91, 0.10)',   // Tier0/Tier2 道路底色
    roadEdge: 'rgba(82, 82, 91, 0.24)',
    coverage: 'rgba(37, 99, 235, 0.20)',
    coverageFill: 'rgba(37, 99, 235, 0.04)',
    selection: '#2563EB',
    cursor: '#2563EB',
  },
  // 事件带 / 事件标注
  events: {
    attackWindow: 'rgba(213, 94, 0, 0.30)',   // 攻击窗口（仅攻击视角）
    filterActive: 'rgba(230, 159, 0, 0.45)',  // 框过滤活跃
    egoResponse:  'rgba(0, 114, 178, 0.45)',  // ego 避让窗口
    detection:    '#D55E00',                  // 检测点
    evidenceDrop: '#E69F00',
  },
  // 算法身份色：仅用于离线三算法对比；不与车辆可信/可疑/失信状态色混用。
  comparison: {
    crb_v2v_cpabds: '#38bdf8',
    drambr: '#E69F00',
    plexemds: '#CC79A7',
  },
};

/** 按当前帧信誉取状态键（无未来泄露：只看传入的 rep 值） */
export function repStatus(rep) {
  if (rep == null) return 'unknown';
  if (rep > THRESHOLD.TRUST) return 'trust';
  if (rep >= THRESHOLD.DISTRUST) return 'warn';
  return 'distrust';
}

/** 状态键 → 颜色 */
export function repColor(rep) {
  const s = repStatus(rep);
  if (s === 'unknown') return COLORS.status.bgVeh;
  return COLORS.status[s];
}

/** 曲线系列颜色：按 cav_ids 固定下标，绝不按值/排名换色 */
export function seriesColor(index) {
  return COLORS.series[index % COLORS.series.length];
}

// ---- 攻击标签文案（沿用 V1）----
export const ATTACK_LABELS = {
  ghost_vehicle: '幽灵车注入',
  ghost_vehicle_reverse_direction_pcd_only: '幽灵车逆行',
  ghost_vehicle_teleport_pcd_only: '幽灵车瞬移',
  ghost_vehicle_impossible_speed_pcd_only: '幽灵车超速',
  intermittent_ghost: '间歇性',
  emergency_brake: '紧急刹车欺诈',
  brake_fraud: '紧急刹车欺诈',
  obstacle_fabrication: '障碍物伪造',
  trust_visual_pose_spoof: '视觉位姿欺骗',
  adaptive: '自适应攻击',
  none: '无攻击',
};

export function formatAttackLabel(label) {
  return ATTACK_LABELS[label] || String(label || '').replaceAll('_', ' ');
}

export function classifyAttackBadge(label) {
  if (!label || label === 'none') return 'none';
  if (label.startsWith('ghost_vehicle') || label === 'intermittent_ghost') return 'ghost';
  if (label === 'emergency_brake' || label === 'brake_fraud') return 'brake';
  return 'obstacle';
}

// ---- 图层默认值 ----
export const LAYER_DEFAULTS = {
  godView: false, // 攻击视角（唯一可切换图层，默认关闭）
  trails: true,   // 轨迹尾迹（固定开启）
  road: true,     // 道路底图（固定开启）
  range: true,    // 协同感知范围（固定开启）
  toasts: true,   // 关键事件 toast（固定开启）
};

// ---- 事件类型 → 展示文案 ----
export const EVENT_META = {
  attack_onset:           { text: '攻击开始', icon: '⚠', godOnly: true },
  attack_end:             { text: '攻击结束', icon: '⚠', godOnly: true },
  evidence_drop:          { text: '证据分骤降', icon: '📉', godOnly: false },
  first_box_filter:       { text: '首次过滤可疑检测框', icon: '🛡', godOnly: false },
  obstacle_filtered:      { text: '伪造障碍物已过滤', icon: '🛡', godOnly: false },
  obstacle_safe_pass:     { text: 'ego 保持直行安全通过', icon: '✅', godOnly: false },
  reputation_below_trust: { text: '信誉跌破可信阈值', icon: '↓', godOnly: false },
  detection:              { text: '信誉跌破失信阈值 · 判定为攻击源', icon: '✅', godOnly: false },
  ego_response_start:     { text: 'ego 开始避让', icon: '🚗', godOnly: false },
  ego_response_end:       { text: 'ego 避让结束', icon: '🚗', godOnly: false },
};
