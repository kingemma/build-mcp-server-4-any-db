<script setup>
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useI18n } from 'vue-i18n';
import { rpcSafe } from '../api/rpc';
import { useAppStore } from '../stores/app';

const store = useAppStore();
const { t } = useI18n();

const tables = ref([]);
const relationships = ref([]);
const isLoading = ref(false);

const databases = computed(() => store.connectedDatabases);
const columnCount = computed(() =>
  tables.value.reduce((total, table) => total + (table.columns?.length ?? 0), 0)
);

/** 结构树只展示当前选中的库，根节点就是库名 */
const tree = computed(() => {
  if (!store.activeDatabase) return [];
  return [
    {
      label: store.activeDatabase,
      kind: 'database',
      children: tables.value.map((table) => ({
        label: table.schema ? `${table.schema}.${table.name}` : table.name,
        kind: 'table',
        children: (table.columns ?? []).map((column) => ({
          label: `${column.name} · ${column.type}${column.primaryKey ? ' · PK' : ''}`,
          kind: 'column',
        })),
      })),
    },
  ];
});

/**
 * 按库加载：query_catalog 的 where 里带 database_name，
 * 表、列、关系都只来自这一个库。
 *
 * @param {string} database
 */
async function load(database) {
  if (!database || !store.isRunning) {
    tables.value = [];
    relationships.value = [];
    return;
  }
  isLoading.value = true;
  try {
    const result = await rpcSafe('schema.discover', { baseUrl: store.baseUrl, database });
    if (!result.ok) {
      ElMessage.error(result.error);
      return;
    }
    tables.value = result.data.tables ?? [];
    relationships.value = result.data.relationships ?? [];
  } finally {
    isLoading.value = false;
  }
}

async function select(database) {
  if (database === store.activeDatabase) return;
  store.activeDatabase = database;
  await load(database);
}

async function reload() {
  if (!store.isRunning) {
    ElMessage.warning(t('common.notRunning'));
    return;
  }
  await store.loadConnectedDatabases();
  if (!store.activeDatabase) {
    tables.value = [];
    relationships.value = [];
    ElMessage.warning(t('schema.noConnectedDatabases'));
    return;
  }
  await load(store.activeDatabase);
  ElMessage.success(t('schema.refreshed', { count: tables.value.length }));
}

/**
 * 冷启动时本组件先挂载、status 还没回来：watch 负责状态到位后补第二次，
 * 否则直接刷新到 #/schema 会停在空态。
 */
watch(
  () => store.isRunning,
  async (running) => {
    if (!running) return;
    await store.loadConnectedDatabases();
    await load(store.activeDatabase);
  },
  { immediate: true }
);
</script>

<template>
  <div class="stack">
    <section class="panel">
      <div class="panel__head">
        <span class="panel__title">{{ t('schema.connectedDatabases') }}</span>
        <div class="head-actions">
          <span class="eyebrow">{{ t('schema.databaseCount', { count: databases.length }) }}</span>
          <el-button size="small" :loading="isLoading" @click="reload">
            {{ t('common.refresh') }}
          </el-button>
        </div>
      </div>
      <div class="panel__body">
        <div v-if="databases.length" class="databases">
          <button
            v-for="name in databases"
            :key="name"
            class="database"
            :class="{ 'database--active': name === store.activeDatabase }"
            @click="select(name)"
          >
            <span class="database__mark">▣</span>
            {{ name }}
          </button>
        </div>
        <p v-else class="mono-dim">
          {{ store.isRunning ? t('schema.noDatabases') : t('schema.notRunningHint') }}
        </p>
      </div>
    </section>

    <div class="duo">
      <section class="panel">
        <div class="panel__head">
          <span class="panel__title">
            {{ store.activeDatabase ? t('schema.structure', { database: store.activeDatabase }) : t('schema.structureNone') }}
          </span>
          <span class="eyebrow">
            {{ t('schema.tableColumnCount', { tables: tables.length, columns: columnCount }) }}
          </span>
        </div>
        <div v-loading="isLoading" class="panel__body">
          <el-tree v-if="tree.length" :data="tree" default-expand-all :props="{ children: 'children' }">
            <template #default="{ data }">
              <span class="node" :class="`node--${data.kind}`">
                <span class="node__mark">
                  {{ data.kind === 'database' ? '▣' : data.kind === 'table' ? '▤' : '·' }}
                </span>
                {{ data.label }}
              </span>
            </template>
          </el-tree>
          <p v-else class="mono-dim">
            {{ store.activeDatabase ? t('schema.noTables') : t('schema.selectHint') }}
          </p>
        </div>
      </section>

      <section class="panel">
        <div class="panel__head">
          <span class="panel__title">
            {{
              store.activeDatabase
                ? t('schema.relationships', { database: store.activeDatabase })
                : t('schema.relationshipsNone')
            }}
          </span>
          <span class="eyebrow">
            {{ t('schema.relationCount', { count: relationships.length }) }}
          </span>
        </div>
        <div class="panel__body">
          <div
            v-for="rel in relationships"
            :key="`${rel.fromTable}.${rel.fromColumn}->${rel.toTable}.${rel.toColumn}`"
            class="rel"
          >
            <span class="rel__from">{{ rel.fromTable }}.{{ rel.fromColumn }}</span>
            <span class="rel__arrow">→</span>
            <span class="rel__to">{{ rel.toTable }}.{{ rel.toColumn }}</span>
            <span class="rel__type">{{ rel.relType }}</span>
            <span v-if="rel.crossDatabase" class="pill pill--idle">
              {{ t('schema.crossDatabase') }}
            </span>
          </div>
          <p v-if="!relationships.length" class="mono-dim">{{ t('schema.noRelationships') }}</p>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.stack {
  display: grid;
  gap: var(--gutter);
}

.head-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.databases {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.database {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 5px 14px;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text-dim);
  background: var(--ink-700);
  border: 1px solid var(--line);
  border-radius: 999px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.database:hover {
  color: var(--text);
  border-color: var(--slate);
}

.database--active {
  color: var(--amber);
  background: var(--amber-soft);
  border-color: rgba(217, 162, 75, 0.45);
}

.database__mark {
  color: var(--text-faint);
}

.duo {
  display: grid;
  grid-template-columns: minmax(320px, 1fr) minmax(320px, 1fr);
  gap: var(--gutter);
  align-items: start;
}

.node {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}

.node__mark {
  color: var(--text-faint);
}

.node--database {
  color: var(--amber);
  letter-spacing: 0.08em;
}

.node--table {
  color: var(--text);
}

.node--column {
  color: var(--text-dim);
  font-size: 11.5px;
}

.rel {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 0;
  border-bottom: 1px solid var(--line-soft);
  font-size: 12px;
}

.rel__from,
.rel__to {
  color: var(--text);
}

.rel__arrow {
  color: var(--amber);
}

.rel__type {
  margin-left: auto;
  font-size: 10.5px;
  color: var(--slate);
}
</style>
