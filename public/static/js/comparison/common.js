/**
 * comparison/common.js — 三算法离线评估的共享契约、格式化与防御性读取。
 *
 * 这里刻意不从现有 reputation.json 推导 DRAMBR/PlexeMDS 数据。所有跨算法数值
 * 只来自 comparison.json；字段缺失永远呈现为“未运行/不适用/未测量”，绝不补 0。
 */

import { COLORS } from '../config.js';

export const ALGORITHMS = Object.freeze([
  {
    id: 'crb_v2v_cpabds', shortName: 'CRB', fullName: 'CRB-V2V-CPABDS',
    color: COLORS.comparison.crb_v2v_cpabds, lineType: 'solid', glyph: '●',
  },
  {
    id: 'drambr', shortName: 'DRAMBR', fullName: 'DRAMBR',
    color: COLORS.comparison.drambr, lineType: 'dashed', glyph: '◆',
  },
  {
    id: 'plexemds', shortName: 'Plexe', fullName: 'PlexeMDS',
    color: COLORS.comparison.plexemds, lineType: 'dotted', glyph: '▲',
  },
]);

export const METRICS = Object.freeze({
  detection_delay: { label: '车辆失信 TTD', direction: 'lower', unit: 'frames', keys: ['ttd_frames', 'ttd_confirmed_frames', 'detection_delay_frames'] },
  attack_recall: { label: '攻击帧 Recall', direction: 'higher', unit: 'ratio', keys: ['attack_recall', 'recall'] },
  f1: { label: 'F1', direction: 'higher', unit: 'ratio', keys: ['f1'] },
});

const STATUS_LABELS = Object.freeze({
  complete: '已完成',
  partial: '部分完成',
  not_run: '未运行',
  failed: '运行失败',
  incompatible: '版本不兼容',
  missing: '结果待生成',
  loading: '正在加载',
  invalid: '结果校验失败',
  error: '加载失败',
  idle: '等待加载',
});

const REASON_LABELS = Object.freeze({
  not_measured: '未测量',
  not_applicable: '不适用',
  missing_input: '缺少输入',
  missing_independent_observations: '缺少独立观测流',
  run_failed: '运行失败',
  not_run: '尚未运行',
  incomplete: '数据不完整',
});

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

export function finite(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

export function algorithmById(id) {
  return ALGORITHMS.find((algorithm) => algorithm.id === id) ?? null;
}

export function algorithmData(data, algorithmId) {
  const candidate = data?.algorithms?.[algorithmId];
  return candidate && typeof candidate === 'object' ? candidate : null;
}

export function algorithmStatus(data, algorithmId) {
  const algorithm = algorithmData(data, algorithmId);
  if (!algorithm) return 'not_run';
  if (typeof algorithm.status === 'string') return algorithm.status;
  return data?.status === 'complete' ? 'complete' : (data?.status || 'partial');
}

export function statusLabel(status, reason = null) {
  const normalized = String(status || 'not_run');
  const base = STATUS_LABELS[normalized] || normalized;
  const detail = reason ? (REASON_LABELS[reason] || reason) : null;
  return detail && detail !== base ? `${base} · ${detail}` : base;
}

export function availabilityLabel(reason) {
  return reason ? (REASON_LABELS[reason] || String(reason)) : '未提供';
}

export function selectedComparisonVehicle(state) {
  return state.comparison?.selectedVehicleId
    ?? state.derived?.adversaryId
    ?? null;
}

function unwrapMetric(value) {
  if (value && typeof value === 'object' && own(value, 'value')) {
    return { value: value.value, reason: value.availability_reason ?? null };
  }
  return { value, reason: null };
}

function attackStartFrame(data) {
  const first = data?.evaluation?.attack_windows?.[0];
  if (Array.isArray(first)) return finite(first[0]);
  if (first && typeof first === 'object') return finite(first.start);
  return null;
}

/** 从算法 summary 中读取预注册指标，缺值保持 null。 */
export function metricValue(data, algorithmId, metricId, scope = 'full', frameIdx = null) {
  const algorithm = algorithmData(data, algorithmId);
  const metric = METRICS[metricId];
  if (!algorithm || !metric) {
    return { value: null, reason: algorithm?.availability_reason ?? 'not_run' };
  }

  let summary = algorithm.summary;
  if (scope === 'current') {
    const timeline = algorithm.metrics_timeline ?? algorithm.summary_timeline;
    if (!Array.isArray(timeline)) {
      return { value: null, reason: 'current_scope_not_exported' };
    }
    const current = latestAtOrBefore(timeline, frameIdx);
    summary = current?.metrics ?? current?.summary ?? current;
    if (!summary) return { value: null, reason: 'not_measured' };
  }
  if (!summary || typeof summary !== 'object') {
    return { value: null, reason: algorithm.availability_reason ?? 'not_measured' };
  }

  // TTD 是三连续失信的第 3 个采样点到攻击起点的延迟。攻击前已稳定失信
  // 和全程未检出都是分类结果，不得被 null/0 吞掉。
  if (metricId === 'detection_delay') {
    const status = String(summary.ttd_status ?? '').toLowerCase();
    if (status === 'preexisting_alert' || status === 'preexisting') {
      return { value: 'preexisting_alert', reason: null };
    }
    if (status === 'not_detected') return { value: 'not_detected', reason: null };
  }

  for (const key of metric.keys) {
    if (own(summary, key)) return unwrapMetric(summary[key]);
  }

  // 兼容早期结果包；新结果应显式导出 ttd_frames。
  if (metricId === 'detection_delay') {
    const confirmed = finite(summary.ttd_confirmed_frame ?? summary.first_confirmed_distrust_frame);
    const onset = attackStartFrame(data);
    if (confirmed != null && onset != null) return { value: confirmed - onset, reason: null };
    if (summary.first_distrust_frame === 'not_detected') return { value: 'not_detected', reason: null };
  }
  return { value: null, reason: summary.availability_reason ?? algorithm.availability_reason ?? 'not_measured' };
}

/** TTD 的辅助定位信息，不参与排名。 */
export function ttdDetails(data, algorithmId) {
  const summary = algorithmData(data, algorithmId)?.summary;
  if (!summary || typeof summary !== 'object') return null;
  const onset = attackStartFrame(data);
  const result = metricValue(data, algorithmId, 'detection_delay');
  const stableFrame = finite(summary.stable_sequence_start_frame
    ?? summary.stable_distrust_start_frame
    ?? summary.first_stable_distrust_frame);
  const stableTtd = finite(summary.stable_sequence_ttd_frames
    ?? summary.ttd_stable_onset_frames
    ?? (stableFrame != null && onset != null ? stableFrame - onset : null));
  const confirmedFrame = finite(summary.ttd_confirmed_frame
    ?? summary.first_confirmed_distrust_frame
    ?? (finite(result.value) != null && onset != null ? onset + finite(result.value) : null));
  return {
    status: result.value === 'preexisting_alert' ? 'preexisting_alert'
      : (result.value === 'not_detected' ? 'not_detected' : 'detected'),
    stableFrame,
    stableTtd,
    confirmedFrame,
  };
}

export function formatMetric(metricId, value, reason = null) {
  if (value == null) {
    if (reason === 'current_scope_not_exported') return '仅完整复盘';
    return availabilityLabel(reason);
  }
  if (value === 'not_detected') return '未检出';
  if (value === 'preexisting_alert') return '预存报警';
  const metric = METRICS[metricId];
  if (!metric) return String(value);
  if (metric.unit === 'ratio') {
    const number = finite(value);
    return number == null ? String(value) : `${(number * 100).toFixed(1)}%`;
  }
  if (metric.unit === 'frames') {
    const number = finite(value);
    return number == null ? String(value) : `${number >= 0 ? '' : '−'}${Math.abs(number)} 帧`;
  }
  return String(value);
}

export function latestAtOrBefore(timeline, frameIdx) {
  if (!Array.isArray(timeline) || !timeline.length || frameIdx == null) return null;
  let answer = null;
  for (const item of timeline) {
    const frame = finite(item?.frame_idx);
    if (frame == null || frame > frameIdx) continue;
    if (!answer || frame >= finite(answer.frame_idx)) answer = item;
  }
  return answer;
}

export function vehicleSnapshot(data, algorithmId, vehicleId, frameIdx) {
  const timeline = algorithmData(data, algorithmId)?.timeline;
  const row = latestAtOrBefore(timeline, frameIdx);
  const vehicle = row?.vehicles?.[String(vehicleId)] ?? null;
  return {
    row,
    vehicle,
    held: Boolean(row && finite(row.frame_idx) !== finite(frameIdx)),
  };
}

export function nativeStateLabel(state) {
  const labels = {
    trusted: '可信', suspicious: '可疑', distrusted: '失信',
    unknown: '未知', unavailable: '无数据',
  };
  return labels[state] || (state ? String(state) : '无原生状态');
}

export function comparisonComplete(data) {
  if (data?.status !== 'complete') return false;
  return ALGORITHMS.every(({ id }) => {
    const algorithm = algorithmData(data, id);
    return algorithm && (!algorithm.status || algorithm.status === 'complete');
  });
}

/**
 * 前端轻量结构校验：它阻止场景串台、乱序帧和越界分数进入图表；正式指标正确性
 * 仍由离线独立评估器负责。
 */
export function validateComparison(data, scenarioId, frameCount = null) {
  const issues = [];
  if (!data || typeof data !== 'object') return { valid: false, issues: ['comparison.json 不是对象'] };
  if (String(data.scenario_id || '') !== String(scenarioId || '')) {
    issues.push(`scenario_id 不匹配（期望 ${scenarioId}）`);
  }
  for (const { id } of ALGORITHMS) {
    const algorithm = algorithmData(data, id);
    if (!algorithm || !Array.isArray(algorithm.timeline)) continue; // partial/not_run 合法
    let previous = -Infinity;
    for (const row of algorithm.timeline) {
      const frame = finite(row?.frame_idx);
      if (frame == null || !Number.isInteger(frame)) {
        issues.push(`${id} 存在非法 frame_idx`);
        break;
      }
      if (frame <= previous) {
        issues.push(`${id} timeline 帧号非严格递增`);
        break;
      }
      if (frameCount != null && (frame < 0 || frame >= frameCount)) {
        issues.push(`${id} frame_idx 超出当前场景范围`);
        break;
      }
      previous = frame;
      for (const vehicle of Object.values(row.vehicles || {})) {
        if (vehicle?.score == null) continue;
        const score = finite(vehicle.score);
        if (score == null || score < 0 || score > 1) {
          issues.push(`${id} 存在不在 [0,1] 的 score`);
          break;
        }
      }
      if (issues.length) break;
    }
  }
  return { valid: issues.length === 0, issues };
}
