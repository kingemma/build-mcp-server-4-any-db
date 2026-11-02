<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useI18n } from 'vue-i18n';
import { useAppStore } from '../stores/app';
import { rpc } from '../api/rpc';

/**
 * 本体构建页：选库 + 选 LLM 模型，让模型根据 schema 一次性产出六类业务本体候选。
 *
 * 关键：生成结果先落到后端「草稿表（ontology_staging）」，不进正式库。
 * 用户逐条或批量「审核通过」后才升舱进 ontology——没审核的草稿绝不会经网关流给 AI。
 */
const store = useAppStore();
const { t } = useI18n();

const KINDS = [
  { id: 'term', labelKey: 'ontology.kinds.term' },
  { id: 'concept', labelKey: 'ontology.kinds.concept' },
  { id: 'relation', labelKey: 'ontology.kinds.relation' },
  { id: 'rule', labelKey: 'ontology.kinds.rule' },
  { id: 'metric', labelKey: 'ontology.kinds.metric' },
  { id: 'example', labelKey: 'ontology.kinds.example' },
];
const RENDER_ORDER = KINDS.map((k) => k.id);

const activeDatabase = ref('');
const models = ref([]);
const selectedModelId = ref('');
const staged = ref(null);
const isGenerating = ref(false);
const isApproving = ref(false);
const isRejecting = ref(false);

/** 可选库：运行中实例实际加载的库 + 已保存连接 + 已维护过本体论的库 */
const databaseOptions = computed(() => {
  const names = new Set([
    ...store.connectedDatabases,
    ...store.connections.map((row) => row.name),
  ]);
  for (const entry of store.ontology) if (entry.database) names.add(entry.database);
  return [...names].sort();
});

const hasModels = computed(() => models.value.length > 0);

const entries = computed(() => staged.value?.entries ?? []);

/** 按渲染顺序把草稿分组，每组带本地化的类别标题 */
const grouped = computed(() =>
  RENDER_ORDER.map((kind) => ({
    kind,
    label: t(`ontology.kinds.${kind}`),
    items: entries.value.filter((e) => e.kind === kind),
  })).filter((group) => group.items.length > 0)
);

/** 各类草稿计数，给标题用 */
const counts = computed(() => {
  const c = { term: 0, concept: 0, relation: 0, rule: 0, metric: 0, example: 0 };
  for (const e of entries.value) c[e.kind] = (c[e.kind] ?? 0) + 1;
  return c;
});

const totalCount = computed(() => entries.value.length);

/** 从 payload 抽一句给人看的摘要（表 / 两端 / 口径等） */
function metaOf(entry) {
  const p = entry.payload ?? {};
  const parts = [];
  if (entry.kind === 'term') {
    if (p.column) parts.push(p.column);
    if (Array.isArray(p.values) && p.values.length) parts.push(`值域 ${p.values.map((v) => v.value).join('/')}`);
  } else if (entry.kind === 'concept') {
    if (p.pkey) parts.push(`主键 ${p.pkey}`);
    if (p.display) parts.push(`显示 ${p.display}`);
    if (p.grain) parts.push(`粒度 ${p.grain}`);
  } else if (entry.kind === 'relation') {
    const end = (side) => (side?.table ? `${side.table}${side.column ? `.${side.column}` : ''}` : '?');
    parts.push(`${end(p.from)} → ${end(p.to)}`);
    if (p.cardinality) parts.push(p.cardinality);
    if (p.alias) parts.push(`关系名 ${p.alias}`);
  } else if (entry.kind === 'rule') {
    if (p.mode) parts.push(p.mode);
    if (p.on?.table) parts.push(`表 ${p.on.column ? `${p.on.table}.${p.on.column}` : p.on.table}`);
    if (p.predicate) parts.push(p.predicate);
  } else if (entry.kind === 'metric') {
    if (p.grain) parts.push(`粒度 ${p.grain}`);
    if (p.unit) parts.push(p.unit);
    if (p.graphql) parts.push(`查询 ${p.graphql}`);
  } else if (entry.kind === 'example') {
    if (p.notes) parts.push(p.notes);
    if (p.expect?.tables?.length) parts.push(`碰表 ${p.expect.tables.join(',')}`);
  }
  return parts.join(' · ');
}

async function loadModels() {
  try {
    const res = await rpc('llm.list');
    models.value = res.models ?? [];
    const def = models.value.find((m) => m.isDefault) || models.value[0];
    selectedModelId.value = def ? def.id : '';
  } catch {
    models.value = [];
  }
}

/** 拉当前库的待审草稿（生成后 / 审核后 / 切换库时都会刷新） */
async function loadStaging() {
  if (!activeDatabase.value) {
    staged.value = { entries: [] };
    return;
  }
  try {
    const res = await rpc('ontology.staging.list', { database: activeDatabase.value });
    staged.value = res;
  } catch {
    staged.value = { entries: [] };
  }
}

async function generate() {
  if (!activeDatabase.value) {
    ElMessage.warning(t('ontologyBuild.noDatabase'));
    return;
  }
  if (!selectedModelId.value) {
    ElMessage.warning(t('ontologyBuild.noModel'));
    return;
  }
  isGenerating.value = true;
  try {
    if (!store.schema) await store.loadSchema().catch(() => {});
    const result = await rpc('ontology.generate', {
      database: activeDatabase.value,
      schema: store.schema,
      modelId: selectedModelId.value,
    });
    staged.value = result;
    const failedBatches = result.batches?.failed ?? 0;
    if (failedBatches > 0) {
      // 分批后允许部分失败：说清失败批次数与首个原因，别让「生成了几条」掩盖「有几批没跑成」
      ElMessage.warning(
        t('ontologyBuild.partialFailed', {
          failed: failedBatches,
          total: result.batches.total,
          message: result.batches.failures?.[0]?.message ?? '',
        })
      );
    } else if (!result.entries?.length) {
      ElMessage.warning(t('ontologyBuild.empty'));
    }
  } catch (err) {
    ElMessage.error(err?.message || t('common.error'));
  } finally {
    isGenerating.value = false;
  }
}

/** 单条审核通过：草稿升舱进正式本体库 */
async function approveEntry(entry) {
  isApproving.value = true;
  try {
    await rpc('ontology.staging.approve', { id: entry.id });
    await Promise.all([loadStaging(), store.loadOntology()]);
    ElMessage.success(t('ontologyBuild.audited', { name: entry.name }));
  } catch (err) {
    ElMessage.error(err?.message || t('common.error'));
  } finally {
    isApproving.value = false;
  }
}

/** 批量审核通过：当前库所有待审草稿一次性升舱 */
async function approveAll() {
  if (!totalCount.value) return;
  isApproving.value = true;
  try {
    const res = await rpc('ontology.staging.approveAll', { database: activeDatabase.value });
    await Promise.all([loadStaging(), store.loadOntology()]);
    ElMessage.success(t('ontologyBuild.auditedAll', { count: res.count ?? totalCount.value }));
  } catch (err) {
    ElMessage.error(err?.message || t('common.error'));
  } finally {
    isApproving.value = false;
  }
}

/** 放弃一条草稿（不入库） */
async function rejectEntry(entry) {
  isRejecting.value = true;
  try {
    await rpc('ontology.staging.reject', { id: entry.id });
    await loadStaging();
    ElMessage.info(t('ontologyBuild.rejected', { name: entry.name }));
  } catch (err) {
    ElMessage.error(err?.message || t('common.error'));
  } finally {
    isRejecting.value = false;
  }
}

onMounted(() => {
  loadModels();
  if (!store.schema) store.loadSchema().catch(() => {});
  loadStaging();
});

// 切换库时拉该库的待审草稿，刷新后也能看到之前生成、还没审核的批次
watch(activeDatabase, loadStaging);
</script>

<template>
  <div class="page">
    <section class="panel">
      <div class="panel__head">
        <span class="panel__title">{{ t('ontologyBuild.title') }}</span>
      </div>
      <div class="panel__body">
        <p class="note">{{ t('ontologyBuild.hint') }}</p>
        <p class="note staged-hint">{{ t('ontologyBuild.stagedHint') }}</p>

        <div class="row controls">
          <el-select v-model="activeDatabase" :placeholder="t('ontologyBuild.database')" style="width: 220px">
            <el-option v-for="db in databaseOptions" :key="db" :label="db" :value="db" />
          </el-select>

          <el-select
            v-model="selectedModelId"
            :placeholder="t('ontologyBuild.modelPlaceholder')"
            style="width: 260px"
          >
            <el-option
              v-for="m in models"
              :key="m.id"
              :label="m.name + (m.isDefault ? `（${t('ontologyBuild.defaultBadge')}）` : '')"
              :value="m.id"
            />
          </el-select>

          <el-button type="primary" :loading="isGenerating" :disabled="!hasModels" @click="generate">
            {{ isGenerating ? t('ontologyBuild.generating') : t('ontologyBuild.generate') }}
          </el-button>
        </div>

        <p v-if="!hasModels" class="mono-dim note warn">
          {{ t('ontologyBuild.noModels') }}
        </p>
      </div>
    </section>

    <section v-if="staged && totalCount > 0" class="panel">
      <div class="panel__head">
        <span class="panel__title">
          {{ t('ontologyBuild.counts', { total: totalCount, ...counts }) }}
        </span>
        <div class="panel__actions">
          <span class="tag tag--warn">{{ t('ontologyBuild.pending') }}</span>
          <el-button size="small" type="primary" :loading="isApproving" :disabled="!totalCount" @click="approveAll">
            {{ t('ontologyBuild.auditAll') }}
          </el-button>
        </div>
      </div>
      <div class="panel__body">
        <div v-for="group in grouped" :key="group.kind" class="group">
          <h4 class="group__title">
            <span class="tag tag--info">{{ group.label }}</span>
            <span class="mono-dim group__count">{{ group.items.length }}</span>
          </h4>
          <ul class="proposals">
            <li v-for="(item, idx) in group.items" :key="`${group.kind}-${idx}`" class="proposal">
              <span class="proposal__body">
                <span class="proposal__name">{{ item.name }}</span>
                <span v-if="item.definition" class="proposal__def">{{ item.definition }}</span>
                <span class="proposal__detail">{{ metaOf(item) }}</span>
              </span>
              <span class="proposal__actions">
                <el-button size="small" type="primary" :loading="isApproving" @click="approveEntry(item)">
                  {{ t('ontologyBuild.audit') }}
                </el-button>
                <el-button size="small" text type="danger" :loading="isRejecting" @click="rejectEntry(item)">
                  {{ t('ontologyBuild.reject') }}
                </el-button>
              </span>
            </li>
          </ul>
        </div>
      </div>
    </section>

    <section v-else-if="staged" class="panel">
      <div class="panel__body">
        <p class="mono-dim note">{{ t('ontologyBuild.empty') }}</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.controls {
  align-items: center;
}

.warn {
  margin-top: 12px;
  color: var(--accent-warn, #e0a96d);
}

.staged-hint {
  margin-top: 8px;
  color: var(--text-dim);
}

.panel__actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.group + .group {
  margin-top: 18px;
}

.group__title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 10px;
  font-size: 13px;
}

.group__count {
  font-size: 12px;
}

.proposals {
  display: grid;
  gap: 8px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.proposal {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 8px 12px;
  border: 1px solid var(--line-soft);
  border-radius: 8px;
}

.proposal__body {
  display: grid;
  flex: 1;
  gap: 2px;
  min-width: 0;
}

.proposal__name {
  font-size: 13px;
  font-weight: 600;
}

.proposal__def {
  font-size: 12px;
  color: var(--text-dim);
}

.proposal__detail {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-dim);
  word-break: break-all;
}

.proposal__actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.tag--warn {
  color: var(--accent-warn, #e0a96d);
  border-color: rgba(224, 169, 109, 0.4);
  background: rgba(224, 169, 109, 0.08);
}
</style>
