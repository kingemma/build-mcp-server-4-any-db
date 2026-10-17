<script setup>
import { computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { useAppStore } from '../stores/app';

const store = useAppStore();

const tree = computed(() =>
  store.databaseNames.map((database) => ({
    label: database,
    kind: 'database',
    children: store.tables
      .filter((table) => table.database === database)
      .map((table) => ({
        label: table.name,
        kind: 'table',
        children: (store.schema?.tables.find((t) => t.name === table.name)?.columns ?? []).map(
          (column) => ({
            label: `${column.name} · ${column.type}${column.primaryKey ? ' · PK' : ''}`,
            kind: 'column',
          })
        ),
      })),
  }))
);

const relationships = computed(() => store.schema?.relationships ?? []);

async function reload() {
  if (!store.isRunning) {
    ElMessage.warning('服务未运行');
    return;
  }
  await store.loadSchema();
  ElMessage.success(`已刷新：${store.tables.length} 张表`);
}

onMounted(() => {
  if (store.isRunning && store.tables.length === 0) store.loadSchema();
});
</script>

<template>
  <div class="duo">
    <section class="panel">
      <div class="panel__head">
        <span class="panel__title">结构</span>
        <el-button size="small" @click="reload">刷新</el-button>
      </div>
      <div class="panel__body">
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
        <p v-else class="mono-dim">暂无 Schema。请先在「数据库连接」页启动服务。</p>
      </div>
    </section>

    <section class="panel">
      <div class="panel__head">
        <span class="panel__title">关系</span>
        <span class="eyebrow">{{ relationships.length }} 条</span>
      </div>
      <div class="panel__body">
        <div v-for="rel in relationships" :key="rel.fromTable + rel.fromColumn" class="rel">
          <span class="rel__from">{{ rel.fromTable }}.{{ rel.fromColumn }}</span>
          <span class="rel__arrow">→</span>
          <span class="rel__to">{{ rel.toTable }}.{{ rel.toColumn }}</span>
          <span class="rel__type">{{ rel.relType }}</span>
          <span v-if="rel.crossDatabase" class="pill pill--idle">跨库</span>
        </div>
        <p v-if="!relationships.length" class="mono-dim">未发现外键关系。</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
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
