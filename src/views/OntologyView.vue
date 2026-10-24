<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useI18n } from 'vue-i18n';
import { useAppStore } from '../stores/app';
import EvalPanel from '../components/ontology/EvalPanel.vue';
import LintPanel from '../components/ontology/LintPanel.vue';
import OntologyForm from '../components/ontology/OntologyForm.vue';
import ProposalsPanel from '../components/ontology/ProposalsPanel.vue';
import RenderedPanel from '../components/ontology/RenderedPanel.vue';
import RulesPanel from '../components/ontology/RulesPanel.vue';

/**
 * 业务本体论页。
 *
 * 页面本身只做三件事：持有选中状态、把 RPC 结果塞进 store、把面板拼起来。
 * 每个面板是一个组件——它们各自有明确的输入输出（结果对象 + 一个动作），
 * 这样「加一个面板」不会再让这个文件长一百行。
 */
const store = useAppStore();
const { t } = useI18n();

/** 六类条目与后端 ontology.js 的 KINDS 一致；顺序与渲染顺序一致 */
const KINDS = [
  { id: 'term', labelKey: 'ontology.kinds.term' },
  { id: 'concept', labelKey: 'ontology.kinds.concept' },
  { id: 'relation', labelKey: 'ontology.kinds.relation' },
  { id: 'rule', labelKey: 'ontology.kinds.rule' },
  { id: 'metric', labelKey: 'ontology.kinds.metric' },
  { id: 'example', labelKey: 'ontology.kinds.example' },
];

const activeKind = ref('term');
/** 当前在维护哪个库的本体论；每个库各有自己的一套 */
const activeDatabase = ref('');
const editing = ref(null);
const isSaving = ref(false);
const isLinting = ref(false);
const isProposing = ref(false);
const isScanning = ref(false);
const isEvaluating = ref(false);
const isCompiling = ref(false);
const isApplyingRules = ref(false);
/** 起草后把表单滚进视野：候选在表单上方，不滚一下用户会以为没反应 */
const formSection = ref(null);

/**
 * 表单状态是扁平的：payload 在界面上摊成一个个输入框，保存时再按 kind 组装。
 *
 * 为什么不直接编辑 JSON：payload 的键是白名单（后端会拒收未知键），
 * 让人对着 JSON 手敲 key 只会打错；摊成有标签的输入框，错不了。
 */
const emptyForm = () => ({
  id: null,
  database: '',
  kind: 'term',
  name: '',
  aliases: '',
  definition: '',
  tables: [],
  expression: '',
  severity: 'info',
  // term / concept
  column: '',
  values: '',
  pkey: '',
  display: '',
  grain: '',
  // relation
  pickedFk: '',
  fromTable: '',
  fromColumn: '',
  toTable: '',
  toColumn: '',
  cardinality: 'many-to-one',
  relAlias: '',
  // rule
  mode: '',
  ruleTable: '',
  ruleColumn: '',
  predicate: '',
  // metric
  graphql: '',
  unit: '',
  windowColumn: '',
  windowTz: '',
  windowPeriod: '',
  // example
  notes: '',
  expectTables: '',
  expectColumns: '',
  expectValues: '',
  expectMustNot: '',
  // 所有类别通用
  facets: '',
});

const form = ref(emptyForm());

/**
 * 可选库：运行中实例实际加载的库 + 已保存连接里的库。
 *
 * 两个来源都要：服务停着时 connectedDatabases 是空的，但用户照样该能维护
 * （本体论按库名存，不依赖实例在跑）。
 */
const databaseOptions = computed(() => {
  const names = new Set([...store.connectedDatabases, ...store.connections.map((row) => row.name)]);
  // 已经维护过本体论的库也要出现，否则维护完停下服务就找不到入口
  for (const entry of store.ontology) if (entry.database) names.add(entry.database);
  return [...names].sort();
});

const entries = computed(() =>
  store.ontology.filter(
    (entry) => entry.kind === activeKind.value && entry.database === activeDatabase.value
  )
);

/**
 * 换库 = 换一整套本体论：体检 / 候选 / 评测 / 编译的结论都是上一个库算出来的。
 * 不清掉就会显示「这个库已经检查过了」，而检查的其实是另一个库。
 */
watch(activeDatabase, () => store.resetOntologyConclusions());

/**
 * 每个类别在当前库的条数。
 *
 * 必须从全量算：拿当前类别过滤后的列表去数，别的标签会永远显示 0。
 */
const countOf = (kind) =>
  store.ontology.filter(
    (entry) => entry.database === activeDatabase.value && entry.kind === kind
  ).length;

/**
 * 当前库的表，给「关联表」当候选；来自 Schema，不是手填。
 *
 * 存的是**规范形式**（`database.schema.table`），不是 `database.table`：
 * 同一个库里可能有两个 schema 各有一张 orders，二段式定位不到唯一一张表。
 * 规范形式由 schema 的实际身份段拼成，不同引擎段数不同（有的源没有 schema），
 * 所以这里不硬编码三段，只把手里有的段依序拼上，与后端 ontology-lint 的规则一致。
 */
const tableOptions = computed(() =>
  store.tables
    .filter((table) => !activeDatabase.value || table.database === activeDatabase.value)
    .map((table) => {
      const ref = [table.database, table.schema, table.name].filter(Boolean).join('.');
      const label = [table.schema, table.name].filter(Boolean).join('.');
      return { value: ref, label };
    })
);

/**
 * 当前库的列，给「绑定列」当候选。
 *
 * 来源必须是 schema.discover（带列清单），不能用 schema.tables——那个只有表名。
 * 实例没跑时这里为空，用户可以手填，lint 会替他验。
 */
const columnOptions = computed(() => {
  const tables = store.schema?.tables ?? [];
  return tables
    .filter((table) => !activeDatabase.value || table.database === activeDatabase.value)
    .flatMap((table) => {
      const ref = [table.database, table.schema, table.name].filter(Boolean).join('.');
      return (table.columns ?? []).map((column) => ({
        value: `${ref}.${column.name}`,
        label: `${table.name}.${column.name}`,
      }));
    });
});

/**
 * 当前库已有的外键：选一条就把关系两端填满。
 *
 * 这是「关系」这一层最重要的交互——让人手敲六个字段，既容易敲错，也让人不知道
 * 该填哪条边；从真实外键里选，填出来的东西天然和 schema 对得上。
 */
const relationshipOptions = computed(() => {
  const relationships = store.schema?.relationships ?? [];
  return relationships
    .filter((rel) => !activeDatabase.value || rel.fromDatabase === activeDatabase.value)
    .map((rel) => {
      const from = [rel.fromDatabase, rel.fromSchema, rel.fromTable].filter(Boolean).join('.');
      const to = [rel.toDatabase, rel.toSchema, rel.toTable].filter(Boolean).join('.');
      return {
        value: `${from}.${rel.fromColumn}->${to}.${rel.toColumn}`,
        label: `${rel.fromTable}.${rel.fromColumn} → ${rel.toTable}.${rel.toColumn}`,
        fromTable: from,
        fromColumn: rel.fromColumn,
        toTable: to,
        toColumn: rel.toColumn,
      };
    });
});

const severityLabel = (severity) => t(`ontology.severities.${severity}`);

function startCreate() {
  form.value = { ...emptyForm(), database: activeDatabase.value, kind: activeKind.value };
  editing.value = null;
}

/**
 * 切类别标签。没在编辑时同步表单的 kind：用户先点标签再填表是本能，
 * 不同步的话条目会存到另一个类别下去，列表里死活看不到。
 *
 * @param {string} kind
 */
function pickKind(kind) {
  activeKind.value = kind;
  if (!editing.value) form.value.kind = kind;
}

function startEdit(entry) {
  const payload = entry.payload ?? {};
  form.value = {
    ...emptyForm(),
    id: entry.id,
    database: entry.database,
    kind: entry.kind,
    name: entry.name,
    aliases: entry.aliases.join('、'),
    definition: entry.definition,
    tables: entry.tables,
    expression: entry.expression,
    severity: entry.severity,
    // payload 反向摊平；人话标签写成 `取值=人话`，编辑时看得懂
    column: payload.column ?? '',
    values: (payload.values ?? [])
      .map((item) => (item.label ? `${item.value}=${item.label}` : item.value))
      .join('\n'),
    pkey: payload.pkey ?? '',
    display: payload.display ?? '',
    grain: payload.grain ?? '',
    fromTable: payload.from?.table ?? '',
    fromColumn: payload.from?.column ?? '',
    toTable: payload.to?.table ?? '',
    toColumn: payload.to?.column ?? '',
    cardinality: payload.cardinality ?? 'many-to-one',
    relAlias: payload.alias ?? '',
    mode: payload.mode ?? '',
    ruleTable: payload.on?.table ?? '',
    ruleColumn: payload.on?.column ?? '',
    predicate: payload.predicate ?? '',
    graphql: payload.graphql ?? '',
    unit: payload.unit ?? '',
    windowColumn: payload.window?.column ?? '',
    windowTz: payload.window?.tz ?? '',
    windowPeriod: payload.window?.period ?? '',
    notes: payload.notes ?? '',
    expectTables: (payload.expect?.tables ?? []).join('，'),
    expectColumns: (payload.expect?.columns ?? []).join('，'),
    expectValues: (payload.expect?.values ?? []).join('，'),
    expectMustNot: (payload.expect?.mustNot ?? []).join('，'),
    facets: (entry.facets ?? []).map((facet) => `${facet.key}=${facet.value}`).join('\n'),
  };
  editing.value = entry.id;
}

/** `取值=人话` 每行一条；没有等号就把整行当取值 */
function parseValueLines(source) {
  return String(source ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const at = line.indexOf('=');
      if (at <= 0) return { value: line };
      return { value: line.slice(0, at).trim(), label: line.slice(at + 1).trim() };
    })
    .filter((item) => item.value !== '');
}

/** `键=值` 每行一条；facets 是「系统只转达」的那一层，不解释值 */
function parseFacetLines(source) {
  return String(source ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const at = line.indexOf('=');
      if (at <= 0) return { key: line, value: '' };
      return { key: line.slice(0, at).trim(), value: line.slice(at + 1).trim() };
    })
    .filter((item) => item.key !== '');
}

/** 逗号 / 顿号 / 换行分隔的标记列表（期望结构用） */
function parseTokenList(source) {
  return String(source ?? '')
    .split(/[,，、\n]/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/**
 * 按当前类别把扁平表单组装成 payload。
 *
 * 只放当前类别允许的键——后端对未知键是硬拒的，多塞一个就会保存失败。
 * 空字段一概不放：`{ table: '', column: '' }` 这种半成品会让渲染里出现一堆 `?`。
 *
 * @returns {Object} 可直接交给 ontology.save 的 payload
 */
function buildPayload() {
  const current = form.value;
  const payload = {};

  if (current.kind === 'term') {
    if (current.column) payload.column = current.column;
    const values = parseValueLines(current.values);
    if (values.length > 0) payload.values = values;
    return payload;
  }

  if (current.kind === 'concept') {
    for (const key of ['pkey', 'display', 'grain']) {
      if (current[key]) payload[key] = current[key];
    }
    return payload;
  }

  if (current.kind === 'relation') {
    return {
      from: { table: current.fromTable, column: current.fromColumn },
      to: { table: current.toTable, column: current.toColumn },
      cardinality: current.cardinality,
      alias: current.relAlias,
    };
  }

  if (current.kind === 'rule') {
    if (current.mode) payload.mode = current.mode;
    if (current.ruleTable) {
      payload.on = { table: current.ruleTable, column: current.ruleColumn };
    }
    if (current.predicate) payload.predicate = current.predicate;
    return payload;
  }

  if (current.kind === 'metric') {
    for (const key of ['graphql', 'grain', 'unit']) {
      if (current[key]) payload[key] = current[key];
    }
    if (current.windowColumn || current.windowTz || current.windowPeriod) {
      payload.window = {
        column: current.windowColumn,
        tz: current.windowTz,
        period: current.windowPeriod,
      };
    }
    return payload;
  }

  if (current.kind === 'example') {
    if (current.notes) payload.notes = current.notes;
    // 期望结构是评测唯一的对账基准：没有它，评测只能验「能跑」和「有覆盖」
    const expect = {};
    const fields = [
      ['tables', 'expectTables'],
      ['columns', 'expectColumns'],
      ['values', 'expectValues'],
      ['mustNot', 'expectMustNot'],
    ];
    for (const [key, field] of fields) {
      const list = parseTokenList(current[field]);
      if (list.length > 0) expect[key] = list;
    }
    if (Object.keys(expect).length > 0) payload.expect = expect;
    return payload;
  }
  return payload;
}

async function save() {
  const name = form.value.name.trim();
  if (!name) {
    ElMessage.warning(t('ontology.validate.name'));
    return;
  }
  if (!form.value.database) {
    ElMessage.warning(t('ontology.validate.database'));
    return;
  }
  isSaving.value = true;
  try {
    await store.saveOntology({
      id: form.value.id,
      database: form.value.database,
      kind: form.value.kind,
      name,
      aliases: form.value.aliases,
      definition: form.value.definition.trim(),
      tables: form.value.tables,
      expression: form.value.expression.trim(),
      severity: form.value.severity,
      payload: buildPayload(),
      facets: parseFacetLines(form.value.facets),
    });
    ElMessage.success(t('ontology.messages.saved', { name }));
    startCreate();
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    isSaving.value = false;
  }
}

async function drop(entry) {
  try {
    await ElMessageBox.confirm(
      t('ontology.deleteConfirm.message', { name: entry.name }),
      t('ontology.deleteConfirm.title'),
      { type: 'warning' }
    );
  } catch {
    return;
  }
  try {
    await store.removeOntology(entry.id);
    ElMessage.success(t('ontology.messages.removed', { name: entry.name }));
    if (editing.value === entry.id) startCreate();
  } catch (error) {
    ElMessage.error(error.message);
  }
}

async function copyRendered() {
  try {
    await navigator.clipboard.writeText(store.ontologyRendered);
    ElMessage.success(t('ontology.messages.copied'));
  } catch (error) {
    ElMessage.error(error.message);
  }
}

/** 体检：把条目与真实 schema 对账。结果留在 store 里，改条目后由 store 清掉 */
async function runLint() {
  isLinting.value = true;
  try {
    await store.runOntologyLint();
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    isLinting.value = false;
  }
}

/** 从 schema 生成候选：没有概念的表、没有关系的外键、有注释却没有术语的列 */
async function runPropose() {
  isProposing.value = true;
  try {
    await store.proposeOntology(activeDatabase.value);
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    isProposing.value = false;
  }
}

/** 评测样例：可执行 / 结构 / 覆盖三项核对，都是确定性的 */
async function runEval() {
  isEvaluating.value = true;
  try {
    await store.runOntologyEval(activeDatabase.value);
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    isEvaluating.value = false;
  }
}

/** 编译：把强制规则变成权限补丁。只算不写 */
async function runCompile() {
  isCompiling.value = true;
  try {
    await store.compileOntologyRules(activeDatabase.value);
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    isCompiling.value = false;
  }
}

/**
 * 起草一条：只把候选填进表单，不保存。
 *
 * 自动生成的定义通常是空的或只有一句注释；保存动作必须留给人，
 * 否则本体论会被一堆「有名字没含义」的条目填满，反而稀释真正的知识。
 */
function draftFrom(item) {
  activeKind.value = item.kind;
  startCreate();
  form.value.name = item.name;
  form.value.definition = item.definition ?? '';
  form.value.tables = item.tables ?? [];

  if (item.kind === 'relation') {
    form.value.fromTable = item.from?.table ?? '';
    form.value.fromColumn = item.from?.column ?? '';
    form.value.toTable = item.to?.table ?? '';
    form.value.toColumn = item.to?.column ?? '';
    form.value.cardinality = item.cardinality ?? 'many-to-one';
  }
  if (item.kind === 'term') {
    form.value.column = item.column ?? '';
    form.value.aliases = (item.aliases ?? []).join('、');
  }

  formSection.value?.scrollIntoView();
}

/**
 * 扫一列的真实取值，填进「值域」。
 *
 * 表名要裸名：`execute_graphql` 只认选择集里的标识符，带库/schema 前缀会被拒。
 * 所以从绑定列（`库.schema.表.列`）里取最后两段。
 */
async function scanValues() {
  const columnRef = form.value.column;
  if (!columnRef) {
    ElMessage.warning(t('ontology.scan.needColumn'));
    return;
  }
  if (!store.isRunning) {
    ElMessage.warning(t('ontology.scan.needRunning'));
    return;
  }

  const at = columnRef.lastIndexOf('.');
  if (at <= 0) {
    ElMessage.warning(t('ontology.scan.badColumn'));
    return;
  }
  const column = columnRef.slice(at + 1);
  const table = columnRef.slice(0, at).split('.').pop();

  isScanning.value = true;
  try {
    const result = await store.scanOntologyValues({ table, column });
    if (!result.suitable) {
      ElMessage.warning(result.reason);
      return;
    }
    form.value.values = result.values.join('\n');
    ElMessage.success(
      t('ontology.scan.filled', { sampled: result.sampled, count: result.values.length })
    );
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    isScanning.value = false;
  }
}

/** 应用补丁：先确认（写入立即生效），再走 permissions.apply（它写入前自动存快照） */
async function applyRules() {
  if (!store.isRunning) {
    ElMessage.warning(t('ontology.rules.needRunning'));
    return;
  }
  const access = store.ontologyRules?.access;
  if (!access) return;

  const count = store.ontologyRules?.summary.effectiveChanges ?? 0;
  try {
    await ElMessageBox.confirm(
      t('ontology.rules.confirm', { count, database: activeDatabase.value }),
      t('ontology.rules.confirmTitle'),
      { type: 'warning' }
    );
  } catch {
    return;
  }

  isApplyingRules.value = true;
  try {
    const result = await store.applyOntologyRules(access, activeDatabase.value);
    ElMessage.success(
      result?.snapshot
        ? t('ontology.rules.applied', { id: result.snapshot.id })
        : t('ontology.rules.appliedNoSnapshot')
    );
    // 应用后补丁已经不是「待应用」状态，清掉避免重复点
    store.resetOntologyConclusions();
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    isApplyingRules.value = false;
  }
}

onMounted(async () => {
  await Promise.all([store.loadOntology(), store.loadSchema(), store.loadConnections()]);
  // 默认落在实例的当前库上，而不是字母序第一个：用户此刻在看的库就是他要在维护的库
  activeDatabase.value = store.activeDatabase || databaseOptions.value[0] || '';
  startCreate();
});
</script>

<template>
  <div class="stack">
    <section class="panel">
      <div class="panel__head">
        <span class="panel__title">{{ t('ontology.what') }}</span>
      </div>
      <div class="panel__body">
        <p class="mono-dim note">{{ t('ontology.why') }}</p>
        <p class="mono-dim note">{{ t('ontology.delivery') }}</p>
      </div>
    </section>

    <section class="panel">
      <div class="panel__head">
        <span class="panel__title">{{ t('ontology.entries') }}</span>
        <span class="mono-dim">
          {{ t('ontology.count', { count: store.ontology.length }) }}
        </span>
      </div>
      <div class="panel__body">
        <label class="picker">
          <span class="picker__label">{{ t('ontology.pickDatabase') }}</span>
          <el-select
            v-model="activeDatabase"
            size="small"
            style="width: 240px"
            @change="startCreate"
          >
            <el-option
              v-for="name in databaseOptions"
              :key="name"
              :label="name"
              :value="name"
            />
          </el-select>
          <span v-if="!databaseOptions.length" class="mono-dim note">
            {{ t('ontology.noDatabase') }}
          </span>
        </label>

        <div class="kinds" role="tablist">
          <button
            v-for="kind in KINDS"
            :key="kind.id"
            type="button"
            role="tab"
            class="kind"
            :class="{ 'kind--active': activeKind === kind.id }"
            :aria-selected="activeKind === kind.id"
            @click="pickKind(kind.id)"
          >
            {{ t(kind.labelKey) }}
            <span class="kind__count">
              {{ countOf(kind.id) }}
            </span>
          </button>
        </div>

        <table v-if="entries.length" class="entries">
          <thead>
            <tr>
              <th>{{ t('ontology.table.name') }}</th>
              <th>{{ t('ontology.table.aliases') }}</th>
              <th>{{ t('ontology.table.definition') }}</th>
              <th>{{ t('ontology.table.tables') }}</th>
              <th>{{ t('ontology.table.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in entries" :key="entry.id">
              <td class="entries__name">
                {{ entry.name }}
                <span v-if="entry.kind === 'rule'" class="tag" :class="`tag--${entry.severity}`">
                  {{ severityLabel(entry.severity) }}
                </span>
              </td>
              <td class="mono-dim">{{ entry.aliases.join('、') || '—' }}</td>
              <td class="entries__def">
                {{ entry.definition || '—' }}
                <span v-if="entry.expression" class="mono entries__expr">{{ entry.expression }}</span>
              </td>
              <td class="mono-dim">{{ entry.tables.join(', ') || '—' }}</td>
              <td class="entries__actions">
                <el-button size="small" text type="primary" @click="startEdit(entry)">
                  {{ t('common.edit') }}
                </el-button>
                <el-button size="small" text type="danger" @click="drop(entry)">
                  {{ t('common.delete') }}
                </el-button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="mono-dim note">
          {{ activeDatabase ? t('ontology.empty') : t('ontology.pickFirst') }}
        </p>
      </div>
    </section>

    <ProposalsPanel
      :proposals="store.ontologyProposals"
      :busy="isProposing"
      @run="runPropose"
      @draft="draftFrom"
    />

    <LintPanel :lint="store.ontologyLint" :busy="isLinting" @run="runLint" />

    <EvalPanel :evaluation="store.ontologyEval" :busy="isEvaluating" @run="runEval" />

    <RulesPanel
      :rules="store.ontologyRules"
      :busy="isCompiling"
      :applying="isApplyingRules"
      @compile="runCompile"
      @apply="applyRules"
    />

    <OntologyForm
      ref="formSection"
      :form="form"
      :editing="editing"
      :database-options="databaseOptions"
      :table-options="tableOptions"
      :column-options="columnOptions"
      :relationship-options="relationshipOptions"
      :saving="isSaving"
      :scanning="isScanning"
      @save="save"
      @reset="startCreate"
      @scan="scanValues"
    />

    <RenderedPanel :text="store.ontologyRendered" @copy="copyRendered" />
  </div>
</template>

<style scoped>
.picker {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  margin-bottom: 14px;
}

.picker__label {
  font-size: var(--fs-note);
  color: var(--text-dim);
}

.kinds {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 14px;
}

.kind {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  padding: 6px 14px;
  font-size: 13px;
  color: var(--text-dim);
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 999px;
  cursor: pointer;
}

.kind--active {
  font-weight: 600;
  color: var(--accent);
  background: var(--accent-soft);
  border-color: rgba(29, 78, 216, 0.25);
}

.kind__count {
  font-family: var(--mono);
  font-size: 11px;
  opacity: 0.75;
}

.entries {
  width: 100%;
  border-collapse: collapse;
}

.entries th {
  padding: 8px 10px;
  font-size: var(--fs-note);
  font-weight: 600;
  color: var(--text-dim);
  text-align: left;
  border-bottom: 1px solid var(--line);
}

.entries td {
  padding: 10px;
  font-size: 13px;
  vertical-align: top;
  border-bottom: 1px solid var(--line-soft);
}

.entries__name {
  font-weight: 600;
  white-space: nowrap;
}

.entries__def {
  max-width: 340px;
  line-height: 1.6;
}

.entries__expr {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-dim);
}

.entries__actions {
  white-space: nowrap;
}
</style>
