/**
 * vehicleList.js — 车辆列表就地更新（P3-16 / P1-T4 / P1-T5）
 *
 * 场景级建一次 DOM（每 CAV 一张卡，保存节点引用），此后每帧只改文本/颜色/类名。
 * 状态文案按当前帧 t 判定（无未来泄露）：绝不读 reputation.vehicles.detected。
 * 攻击视角（内部 godView）时攻击车追加 ⚠（系统视角绝不出现）。
 */

import { repColor, repStatus, THRESHOLD } from '../config.js';
import * as store from '../store.js';

const STATUS_GLYPH = { trust: '▲', warn: '◆', distrust: '✕', unknown: '·' };

export function initVehicleList() {
  const container = document.getElementById('vehicleList');
  let cards = new Map(); // vid -> { root, icon, name, detail, score }

  // ---------------- 场景级构建 ----------------
  function build(state) {
    cards = new Map();
    if (!state.meta) {
      container.innerHTML = '<div class="empty-state">请选择场景后查看车辆列表</div>';
      return;
    }
    container.innerHTML = '';
    const egoId = state.derived?.egoId;
    for (const rawVid of state.meta.cav_ids ?? []) {
      const vid = String(rawVid);
      const root = document.createElement('div');
      root.className = 'vehicle-card';
      root.dataset.vehicleId = vid;
      root.setAttribute('role', 'button');
      root.setAttribute('tabindex', '0');
      root.innerHTML = `
        <div class="v-icon"></div>
        <div class="v-info">
          <div class="v-name">V${vid}${vid === egoId ? '（本车）' : ''}</div>
          <div class="v-detail">--</div>
        </div>
        <div class="v-score">--</div>`;
      container.appendChild(root);
      cards.set(vid, {
        root,
        icon: root.querySelector('.v-icon'),
        name: root.querySelector('.v-name'),
        detail: root.querySelector('.v-detail'),
        score: root.querySelector('.v-score'),
      });
    }
    update();
  }

  // ---------------- 帧级就地更新 ----------------
  function update() {
    const s = store.getState();
    if (!s.meta || !cards.size) return;
    const reps = store.currentReputations();
    const metricsCavs = store.currentMetrics()?.cavs ?? {};
    const d = s.derived;
    const t = s.frameIdx;
    const god = s.layers.godView;

    for (const [vid, el] of cards) {
      const rep = reps[vid] ?? null;
      const status = repStatus(rep);
      const color = repColor(rep);
      const m = metricsCavs[vid];
      const isEgo = vid === d?.egoId;
      const isAdv = vid === d?.adversaryId;

      // 图标：形状冗余（trust▲ / warn◆ / distrust✕）；攻击视角且攻击车 → ⚠
      const glyph = (god && isAdv) ? '⚠' : STATUS_GLYPH[status];
      if (el.icon.textContent !== glyph) el.icon.textContent = glyph;
      el.icon.style.background = `${color}20`;
      el.icon.style.color = (god && isAdv) ? 'var(--c-truth)' : color;

      // 名称行：攻击视角时攻击车标注真值
      const nameText = `V${vid}${isEgo ? '（本车）' : ''}${god && isAdv ? '（攻击车辆·真值）' : ''}`;
      if (el.name.textContent !== nameText) el.name.textContent = nameText;

      // 状态文案（按当前帧）
      const parts = [];
      if (isEgo) parts.push('本车');
      if (rep == null) {
        parts.push('无数据');
      } else if (rep < THRESHOLD.DISTRUST) {
        parts.push('已判失信');
      }
      const filteringNow = m && m.num_boxes_before != null && m.num_boxes_after != null
        && m.num_boxes_after < m.num_boxes_before;
      const firstFilter = d?.firstFilterByVid?.[vid];
      if (filteringNow) {
        parts.push(`框过滤中 ${m.num_boxes_before}→${m.num_boxes_after}`);
      } else if (firstFilter != null && firstFilter <= t) {
        parts.push(`曾被过滤(F${firstFilter})`);
      }
      if (m?.evidence_score === 0) parts.push('证据异常');
      const cons = Number(m?.voting_consistency_ratio);
      if (Number.isFinite(cons) && cons < 0.999) parts.push(`一致性 ${cons.toFixed(2)}`);
      if (parts.length === 0 || (parts.length === 1 && parts[0] === '本车')) {
        parts.push('正常');
      }
      const detailText = parts.join(' · ');
      if (el.detail.textContent !== detailText) el.detail.textContent = detailText;

      // 分数
      const scoreText = rep == null ? '--' : rep.toFixed(2);
      if (el.score.textContent !== scoreText) el.score.textContent = scoreText;
      el.score.style.color = color;
    }
  }

  // ---------------- 选中 ----------------
  function applySelection({ id }) {
    for (const [vid, el] of cards) {
      el.root.classList.toggle('selected', vid === id);
    }
    if (id && cards.has(id)) {
      cards.get(id).root.scrollIntoView({ block: 'nearest' });
    }
  }

  // ---------------- 交互（委托） ----------------
  function cardFromEvent(event) {
    const card = event.target.closest('.vehicle-card');
    return card && container.contains(card) ? card : null;
  }
  container.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const card = cardFromEvent(e);
    if (!card) return;
    store.setSelection(card.dataset.vehicleId);
    store.setTab('detail');
  });
  container.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = cardFromEvent(e);
    if (!card) return;
    e.preventDefault();
    store.setSelection(card.dataset.vehicleId);
    store.setTab('detail');
  });

  // ---------------- 订阅 ----------------
  store.subscribe('scenario', build);
  store.subscribe('frame', update);
  store.subscribe('layers', update);
  store.subscribe('selection', applySelection);
}
