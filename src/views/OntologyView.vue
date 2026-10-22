<script setup>
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useI18n } from 'vue-i18n';
import { useAppStore } from '../stores/app';

const store = useAppStore();
const { t } = useI18n();

/** 四类条目与后端 ontology.js 的 KINDS 一致 */
const KINDS = [
  { id: 'term', labelKey: 'ontology.kinds.term' },
  { id: 'concept', labelKey: 'ontology.kinds.concept' },
  { id: 'rule', labelKey: 'ontology.kinds.rule' },
  { id: 'metric', labelKey: 'ontology.kinds.metric' },
];

const SEVERITIES = ['info', 'warn', 'enforce'];

const activeKind = ref('term');
/** 当前在维护哪个库的本体论；每个库各有自己的一套 */
const activeDatabase = ref('');
const editing = ref(null);
const isSaving = ref(false);

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

/** 当前库的表，给「关联表」当候选；来自 Schema，不是手填 */
const tableOptions = computed(() =>
  store.tables
    .filter((table) => !activeDatabase.value || table.database === activeDatabase.value)
    .map((table) => ({ value: `${table.database}.${table.name}`, label: `${table.name}` }))
);

const kindLabel = (kind) => {
  const found = KINDS.find((item) => item.id === kind);
  return found ? t(found.labelKey) : kind;
};

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
  form.value = {
    id: entry.id,
    database: entry.database,
    kind: entry.kind,
    name: entry.name,
    aliases: entry.aliases.join('、'),
    definition: entry.definition,
    tables: entry.tables,
    expression: entry.expression,
    severity: entry.severity,
  };
  editing.value = entry.id;
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
              {{ entries.filter((entry) => entry.kind === kind.id).length }}
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

    <section class="panel">
      <div class="panel__head">
        <span class="panel__title">
          {{ editing ? t('ontology.editing', { name: form.name }) : t('ontology.create') }}
        </span>
      </div>
      <div class="panel__body">
        <div class="form">
          <label class="field">
            <span class="field__label">{{ t('ontology.form.database') }}</span>
            <el-select v-model="form.database" size="small" filterable allow-create>
              <el-option
                v-for="name in databaseOptions"
                :key="name"
                :label="name"
                :value="name"
              />
            </el-select>
          </label>

          <label class="field">
            <span class="field__label">{{ t('ontology.form.kind') }}</span>
            <el-select v-model="form.kind" size="small">
              <el-option
                v-for="kind in KINDS"
                :key="kind.id"
                :label="t(kind.labelKey)"
                :value="kind.id"
              />
            </el-select>
          </label>

          <label class="field">
            <span class="field__label">{{ t('ontology.form.name') }}</span>
            <el-input v-model="form.name" size="small" :placeholder="t('ontology.form.nameHint')" />
          </label>

          <label class="field">
            <span class="field__label">{{ t('ontology.form.aliases') }}</span>
            <el-input
              v-model="form.aliases"
              size="small"
              :placeholder="t('ontology.form.aliasesHint')"
            />
          </label>

          <label class="field field--wide">
            <span class="field__label">{{ t('ontology.form.definition') }}</span>
            <el-input
              v-model="form.definition"
              size="small"
              type="textarea"
              :rows="3"
              :placeholder="t('ontology.form.definitionHint')"
            />
          </label>

          <label class="field field--wide">
            <span class="field__label">{{ t('ontology.form.tables') }}</span>
            <el-select
              v-model="form.tables"
              size="small"
              multiple
              filterable
              allow-create
              :placeholder="t('ontology.form.tablesHint')"
              style="width: 100%"
            >
              <el-option
                v-for="table in tableOptions"
                :key="table.value"
                :label="table.label"
                :value="table.value"
              />
            </el-select>
            <span class="field__hint">
              {{
                tableOptions.length
                  ? t('ontology.form.tablesFromSchema', { count: tableOptions.length })
                  : t('ontology.form.tablesNoSchema')
              }}
            </span>
          </label>

          <label class="field field--wide">
            <span class="field__label">{{ t('ontology.form.expression') }}</span>
            <el-input
              v-model="form.expression"
              size="small"
              type="textarea"
              :rows="2"
              :placeholder="t('ontology.form.expressionHint')"
            />
          </label>

          <label v-if="form.kind === 'rule'" class="field">
            <span class="field__label">{{ t('ontology.form.severity') }}</span>
            <el-select v-model="form.severity" size="small">
              <el-option
                v-for="severity in SEVERITIES"
                :key="severity"
                :label="severityLabel(severity)"
                :value="severity"
              />
            </el-select>
          </label>
        </div>

        <div class="actions">
          <el-button size="small" type="primary" :loading="isSaving" @click="save">
            {{ t('ontology.save') }}
          </el-button>
          <el-button size="small" @click="startCreate">{{ t('ontology.reset') }}</el-button>
        </div>
      </div>
    </section>

    <section v-if="store.ontologyRendered" class="panel">
      <div class="panel__head">
        <span class="panel__title">{{ t('ontology.preview') }}</span>
        <el-button size="small" text @click="copyRendered">{{ t('ontology.copy') }}</el-button>
      </div>
      <div class="panel__body">
        <pre class="rendered">{{ store.ontologyRendered }}</pre>
      </div>
    </section>
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

.tag {
  margin-left: 6px;
  padding: 1px 7px;
  font-family: var(--mono);
  font-size: 11px;
  border-radius: 999px;
}

.tag--info {
  color: var(--text-dim);
  background: var(--ink-700);
}

.tag--warn {
  color: #b45309;
  background: rgba(245, 158, 11, 0.14);
}

.tag--enforce {
  color: #b91c1c;
  background: rgba(239, 68, 68, 0.14);
}

.form {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 14px;
}

.field {
  display: grid;
  gap: 6px;
  align-content: start;
}

.field--wide {
  grid-column: 1 / -1;
}

.field__label {
  font-size: var(--fs-note);
  color: var(--text-dim);
}

.field__hint {
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-dim);
}

.rendered {
  margin: 0;
  padding: 14px 16px;
  overflow: auto;
  max-height: 420px;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.75;
  color: var(--text);
  background: var(--ink-700);
  border: 1px solid var(--line);
  border-radius: 10px;
}
</style>
