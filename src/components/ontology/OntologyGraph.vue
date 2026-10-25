<script setup>
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  bareTable,
  buildOntologyGraph,
  cardinalityLabel,
  layoutOntologyGraph,
} from '../../utils/ontology-graph';

/**
 * 业务本体关系图：节点是概念，连线是关系。
 *
 * 组件只做两件事——把折叠好的图摆到 SVG 上、把选中的节点摊成右侧详情。
 * 「怎么折、怎么摆」都在 utils/ontology-graph.js 里，那边有单测。
 */
const props = defineProps({
  /** 当前库的条目；页面已经按库过滤过一次，这里再传库名是为了空态文案 */
  entries: { type: Array, default: () => [] },
  database: { type: String, default: '' },
});

const { t } = useI18n();

/** 节点盒子尺寸：文字换行靠手写 <tspan>，所以宽高固定 */
const NODE_WIDTH = 176;
const NODE_HEIGHT = 80;

const graph = computed(() => buildOntologyGraph(props.entries, { database: props.database }));
const laid = computed(() => layoutOntologyGraph(graph.value));

const nodeById = computed(() => new Map(laid.value.nodes.map((node) => [node.id, node])));

const hoveredId = ref('');
const selectedId = ref('');

/** 换库就清掉选中：上一个库的节点 id 在新的图里不存在 */
watch(
  () => props.database,
  () => {
    hoveredId.value = '';
    selectedId.value = '';
  }
);

const activeId = computed(() => hoveredId.value || selectedId.value);

/** 高亮范围：当前节点 + 直接相邻的节点 + 两端的连线 */
const activeNodeIds = computed(() => {
  const id = activeId.value;
  if (!id) return null;
  const ids = new Set([id]);
  for (const edge of laid.value.edges) {
    if (edge.from === id) ids.add(edge.to);
    if (edge.to === id) ids.add(edge.from);
  }
  return ids;
});

const selectedNode = computed(() => nodeById.value.get(selectedId.value) ?? null);

const isDim = (nodeId) => activeNodeIds.value !== null && !activeNodeIds.value.has(nodeId);

const isEdgeDim = (edge) => activeNodeIds.value !== null && !(edge.from === activeId.value || edge.to === activeId.value);

/**
 * 文本按字符截断：SVG 里没有自动换行，超出框宽只能自己切。
 * 中文按 1 个字算，够用——这里的文字都是术语与表名。
 */
function fit(text, limit) {
  const value = String(text ?? '');
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

const termsText = (node) => {
  const names = node.terms.map((item) => item.name);
  return names.length > 0 ? fit(names.join('、'), 16) : t('ontology.graph.noTerm');
};

// 节点上只写表名最后一段：`analytics.main.orders` 挤在 176px 的框里既截断又难认，
// 完整名字留给 hover 的 title 和右侧详情
const tablesText = (node) =>
  fit(node.tables.map((table) => bareTable(table)).join('、') || t('ontology.graph.noTable'), 20);

const edgePath = (edge) => {
  const from = nodeById.value.get(edge.from);
  const to = nodeById.value.get(edge.to);
  if (!from || !to) return '';
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const sag = (edge.sag ?? 0) * length;
  // 法线方向偏移中点：同一条边画多条时彼此错开，不会叠成一条
  const cx = (from.x + to.x) / 2 + (-dy / length) * sag;
  const cy = (from.y + to.y) / 2 + (dx / length) * sag;
  return `M ${from.x} ${from.y} Q ${cx} ${cy} ${to.x} ${to.y}`;
};

/**
 * 边标签放在二次贝塞尔 t=0.4 处，而不是正中间。
 *
 * 放中间时，几条边会在圆心附近交汇，标签叠成一团；靠近各自的起点之后，
 * 每个标签都贴着「从哪来」，读起来也更符合顺序。
 */
const edgeLabelPoint = (edge) => {
  const from = nodeById.value.get(edge.from);
  const to = nodeById.value.get(edge.to);
  if (!from || !to) return { x: 0, y: 0 };
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const sag = (edge.sag ?? 0) * length;
  const cx = (from.x + to.x) / 2 + (-dy / length) * sag;
  const cy = (from.y + to.y) / 2 + (dx / length) * sag;
  const t = 0.4;
  const rest = 1 - t;
  return {
    x: rest * rest * from.x + 2 * rest * t * cx + t * t * to.x,
    y: rest * rest * from.y + 2 * rest * t * cy + t * t * to.y,
  };
};

const edgeText = (edge) =>
  [edge.name, cardinalityLabel(edge.cardinality, t)].filter(Boolean).join(' · ');

const severityLabel = (severity) => t(`ontology.severities.${severity}`);
</script>

<template>
  <section class="panel">
    <div class="panel__head">
      <span class="panel__title">{{ t('ontology.graph.title') }}</span>
      <span class="mono-dim">
        {{ t('ontology.graph.counts', { concepts: graph.counts.concepts, edges: graph.counts.edges }) }}
      </span>
    </div>
    <div class="panel__body">
      <p class="mono-dim note">{{ t('ontology.graph.hint') }}</p>

      <div v-if="laid.nodes.length" class="graph">
        <div class="graph__canvas-wrap">
          <svg
            class="graph__canvas"
            :viewBox="`0 0 ${laid.width} ${laid.height}`"
            preserveAspectRatio="xMidYMid meet"
            role="img"
            :aria-label="t('ontology.graph.title')"
            @click.self="selectedId = ''"
          >
            <g class="graph__edges">
              <g
                v-for="edge in laid.edges"
                :key="edge.id"
                class="graph__edge"
                :class="{ 'graph__edge--dim': isEdgeDim(edge) }"
              >
                <path :d="edgePath(edge)" class="graph__edge-line" />
                <text class="graph__edge-label" :x="edgeLabelPoint(edge).x" :y="edgeLabelPoint(edge).y">
                  {{ edgeText(edge) }}
                </text>
              </g>
            </g>

            <g class="graph__nodes">
              <g
                v-for="node in laid.nodes"
                :key="node.id"
                class="graph__node"
                :class="{
                  'graph__node--dim': isDim(node.id),
                  'graph__node--active': node.id === activeId,
                  'graph__node--selected': node.id === selectedId,
                }"
                @mouseenter="hoveredId = node.id"
                @mouseleave="hoveredId = ''"
                @click.stop="selectedId = selectedId === node.id ? '' : node.id"
              >
                <title>{{ node.name }} · {{ node.tables.join('、') }}</title>
                <rect
                  :x="node.x - NODE_WIDTH / 2"
                  :y="node.y - NODE_HEIGHT / 2"
                  :width="NODE_WIDTH"
                  :height="NODE_HEIGHT"
                  rx="12"
                  class="graph__node-box"
                />
                <text :x="node.x" :y="node.y - 20" class="graph__node-name" text-anchor="middle">
                  {{ fit(node.name, 12) }}
                </text>
                <text :x="node.x" :y="node.y + 1" class="graph__node-term" text-anchor="middle">
                  {{ termsText(node) }}
                </text>
                <text :x="node.x" :y="node.y + 21" class="graph__node-table" text-anchor="middle">
                  {{ tablesText(node) }}
                </text>
              </g>
            </g>
          </svg>

          <p v-if="!graph.counts.edges" class="mono-dim note graph__note">
            {{ t('ontology.graph.noRelation') }}
          </p>
          <p v-if="graph.unmatched.length" class="mono-dim note graph__note">
            {{ t('ontology.graph.unmatched', { count: graph.unmatched.length }) }}
            <span class="graph__unmatched">
              {{ graph.unmatched.map((item) => item.relation.name).join('、') }}
            </span>
          </p>
        </div>

        <aside class="graph__detail">
          <div class="graph__detail-head">
            <span class="eyebrow">{{ t('ontology.graph.detail.title') }}</span>
            <span v-if="selectedNode" class="mono-dim">{{ selectedNode.name }}</span>
          </div>

          <p v-if="!selectedNode" class="mono-dim note">{{ t('ontology.graph.detail.hint') }}</p>

          <div v-else class="detail">
            <p v-if="selectedNode.definition" class="detail__definition">{{ selectedNode.definition }}</p>
            <p v-if="selectedNode.aliases.length" class="mono-dim note">
              {{ t('ontology.graph.detail.aliases') }}：{{ selectedNode.aliases.join('、') }}
            </p>

            <div class="detail__block">
              <span class="eyebrow">{{ t('ontology.graph.detail.tables') }}</span>
              <ul class="detail__list">
                <li v-for="table in selectedNode.tables" :key="table" class="detail__table">{{ table }}</li>
              </ul>
            </div>

            <div class="detail__block">
              <span class="eyebrow">{{ t('ontology.graph.detail.terms') }}</span>
              <ul v-if="selectedNode.terms.length" class="detail__list">
                <li v-for="term in selectedNode.terms" :key="term.id">
                  <span class="detail__name">{{ term.name }}</span>
                  <span v-if="term.payload?.column" class="mono-dim"> · {{ term.payload.column }}</span>
                  <span v-if="term.aliases?.length" class="mono-dim"> · {{ term.aliases.join('、') }}</span>
                </li>
              </ul>
              <p v-else class="mono-dim note">{{ t('ontology.graph.detail.none') }}</p>
            </div>

            <div class="detail__block">
              <span class="eyebrow">{{ t('ontology.graph.detail.relations') }}</span>
              <ul v-if="selectedNode.relations.length" class="detail__list">
                <li v-for="relation in selectedNode.relations" :key="relation.id">
                  <span class="detail__name">{{ relation.name }}</span>
                  <span class="mono-dim">
                    · {{ relation.payload?.from?.table || '?' }} →
                    {{ relation.payload?.to?.table || '?' }}
                  </span>
                  <span v-if="relation.payload?.cardinality" class="mono-dim">
                    · {{ cardinalityLabel(relation.payload.cardinality, t) }}
                  </span>
                </li>
              </ul>
              <p v-else class="mono-dim note">{{ t('ontology.graph.detail.none') }}</p>
            </div>

            <div class="detail__block">
              <span class="eyebrow">{{ t('ontology.graph.detail.rules') }}</span>
              <ul v-if="selectedNode.rules.length" class="detail__list">
                <li v-for="rule in selectedNode.rules" :key="rule.id">
                  <span class="detail__name">{{ rule.name }}</span>
                  <span class="tag" :class="`tag--${rule.severity}`">{{ severityLabel(rule.severity) }}</span>
                </li>
              </ul>
              <p v-else class="mono-dim note">{{ t('ontology.graph.detail.none') }}</p>
            </div>

            <div class="detail__block">
              <span class="eyebrow">{{ t('ontology.graph.detail.metrics') }}</span>
              <ul v-if="selectedNode.metrics.length" class="detail__list">
                <li v-for="metric in selectedNode.metrics" :key="metric.id">
                  <span class="detail__name">{{ metric.name }}</span>
                  <span v-if="metric.expression" class="mono-dim"> · {{ fit(metric.expression, 26) }}</span>
                </li>
              </ul>
              <p v-else class="mono-dim note">{{ t('ontology.graph.detail.none') }}</p>
            </div>

            <p v-if="!selectedNode.tables.length" class="mono-dim note">
              {{ t('ontology.graph.detail.empty') }}
            </p>
          </div>
        </aside>
      </div>

      <p v-else class="mono-dim note graph__empty">
        {{ t('ontology.graph.empty', { database: database || t('ontology.graph.emptyAny') }) }}
      </p>
    </div>
  </section>
</template>

<style scoped>
.graph {
  display: grid;
  gap: 18px;
  grid-template-columns: minmax(0, 1fr) 300px;
  align-items: start;
  margin-top: 14px;
}

.graph__canvas-wrap {
  min-width: 0;
}

.graph__canvas {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: #fbfdff;
}

.graph__note {
  margin: 8px 0 0;
}

.graph__unmatched {
  margin-left: 4px;
  font-family: var(--mono);
}

.graph__edge-line {
  fill: none;
  stroke: var(--line);
  stroke-width: 1.5;
}

.graph__edge-label {
  font-family: var(--mono);
  font-size: 11px;
  fill: var(--text-faint);
  text-anchor: middle;
  dominant-baseline: middle;
  paint-order: stroke;
  stroke: #fbfdff;
  stroke-width: 4px;
}

.graph__edge--dim {
  opacity: 0.28;
}

.graph__node {
  cursor: pointer;
}

.graph__node-box {
  fill: #ffffff;
  stroke: var(--line);
  stroke-width: 1.5;
}

.graph__node-name {
  font-size: 13px;
  font-weight: 600;
  fill: var(--text);
}

.graph__node-term {
  font-size: 12px;
  fill: var(--accent);
}

.graph__node-table {
  font-family: var(--mono);
  font-size: 10.5px;
  fill: var(--text-faint);
}

.graph__node--active .graph__node-box {
  stroke: var(--accent);
}

.graph__node--selected .graph__node-box {
  stroke: var(--accent-strong);
  stroke-width: 2.5;
}

.graph__node--dim {
  opacity: 0.34;
}

.graph__detail {
  padding: 12px 14px 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: #ffffff;
}

.graph__detail-head {
  display: flex;
  gap: 8px;
  align-items: baseline;
  justify-content: space-between;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--line-soft);
}

.detail {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 10px;
}

.detail__definition {
  margin: 0;
  font-size: var(--fs-note);
  line-height: 1.7;
  color: var(--text-dim);
}

.detail__block {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.detail__list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin: 0;
  padding: 0;
  font-size: var(--fs-note);
  list-style: none;
}

.detail__name {
  font-weight: 600;
  color: var(--text);
}

.detail__table {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text-dim);
}

.graph__empty {
  margin-top: 12px;
}

@media (max-width: 1200px) {
  .graph {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
