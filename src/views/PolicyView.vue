<script setup>
import { computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { useAppStore, OPERATIONS, OPERATION_LABELS } from '../stores/app';
import { STATES } from '../utils/policy';

const store = useAppStore();

const currentRows = computed(() => {
  const rows = [];
  for (const [role, tables] of Object.entries(store.currentPolicy ?? {})) {
    for (const [table, operations] of Object.entries(tables)) {
      rows.push({ role, table, operations });
    }
  }
  return rows;
});

const changes = computed(() => store.changes);

function detailsOf(operation) {
  const parts = [];
  if (operation.filters.length > 0) parts.push(`过滤 ${operation.filters.join(' / ')}`);
  if (operation.columns.length > 0) parts.push(`列 ${operation.columns.join(', ')}`);
  if (operation.limit !== null) parts.push(`默认 limit ${operation.limit}`);
  return parts.join(' · ') || '—';
}

async function refresh() {
  await store.loadCurrentPolicy();
  ElMessage.success('已重载生效策略');
}

onMounted(() => {
  if (store.isRunning && Object.keys(store.currentPolicy ?? {}).length === 0) {
    store.loadCurrentPolicy();
  }
});
</script>

<template>
  <div class="stack">
    <section class="panel">
      <div class="panel__head">
        <span class="panel__title">当前生效策略</span>
        <div class="actions">
          <span class="pill pill--idle">来源 get_current_config</span>
          <el-button size="small" :loading="store.isBusy" @click="refresh">重载</el-button>
        </div>
      </div>
      <div class="panel__body panel__body--flush">
        <table v-if="currentRows.length" class="policy">
          <thead>
            <tr>
              <th>角色</th>
              <th>表</th>
              <th v-for="operation in OPERATIONS" :key="operation">{{ OPERATION_LABELS[operation] }}</th>
              <th>附加规则</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in currentRows" :key="`${row.role}-${row.table}`">
              <td class="mono">{{ row.role }}</td>
              <td class="mono">{{ row.table }}</td>
              <td v-for="operation in OPERATIONS" :key="operation">
                <span class="state" :class="`state--${row.operations[operation].state}`">
                  {{ STATES[row.operations[operation].state] }}
                </span>
              </td>
              <td class="detail">{{ detailsOf(row.operations.query) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="mono-dim pad">
          {{ store.isRunning ? '还没读到生效策略，点「重载」拉取一次。' : 'GraphJin 未运行。' }}
        </p>
      </div>
    </section>

    <section class="panel">
      <div class="panel__head">
        <span class="panel__title">待应用变更</span>
        <span class="pill" :class="changes.length ? 'pill--warn' : 'pill--on'">
          <span class="dot" />{{ changes.length ? `${changes.length} 项` : '与生效策略一致' }}
        </span>
      </div>
      <div class="panel__body">
        <ul v-if="changes.length" class="changes">
          <li v-for="(change, index) in changes" :key="index">
            <b>{{ change.role }}</b> · {{ change.table }} · {{ OPERATION_LABELS[change.operation] }}
            <span class="pill pill--tiny">{{ change.kind === 'added' ? '新增' : '修改' }}</span>
            <span class="from">{{ STATES[change.from.state] }}</span>
            <span class="arrow">→</span>
            <span class="to">{{ STATES[change.to.state] }}</span>
            <span v-if="change.detail" class="detail">{{ change.detail }}</span>
          </li>
        </ul>
        <p v-else class="mono-dim">
          权限矩阵与当前生效策略一致。改动开关或规则后这里会出现 diff。
        </p>
        <p class="note">
          说明：<code>gj_security</code> 走 <code>/api/v1/graphql</code> 的 root，需要 admin JWT，
          实测在 anon/dev 头下均不可达，因此策略真相来源是 MCP 的
          <code>get_current_config</code>（顶层键：roles / system / databases / mcp / workflows）。
        </p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.stack {
  display: grid;
  gap: var(--gutter);
}

.actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.panel__body--flush {
  padding: 0;
}

.policy {
  width: 100%;
  border-collapse: collapse;
}

.policy th {
  padding: 9px 14px;
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-dim);
  text-align: left;
  border-bottom: 1px solid var(--line);
  background: var(--ink-700);
}

.policy td {
  padding: 7px 14px;
  font-size: 12px;
  border-bottom: 1px solid var(--line-soft);
}

.policy tr:hover td {
  background: rgba(217, 162, 75, 0.05);
}

.mono {
  font-family: var(--mono);
  color: var(--text);
}

.state {
  font-family: var(--mono);
  font-size: 11px;
}

.state--allowed {
  color: var(--mint);
}

.state--blocked {
  color: var(--coral);
}

.state--default {
  color: var(--text-faint);
}

.detail {
  font-size: 11px;
  color: var(--text-faint);
}

.changes {
  margin: 0 0 10px;
  padding-left: 18px;
  font-size: 11.5px;
  color: var(--text-dim);
}

.changes li {
  margin-bottom: 4px;
}

.from {
  color: var(--coral);
}

.to {
  color: var(--mint);
}

.arrow,
.detail {
  margin-left: 6px;
}

.pill--tiny {
  margin-left: 6px;
  padding: 1px 6px;
  font-size: 10px;
}

.note {
  margin: 10px 0 0;
  font-size: 11px;
  line-height: 1.7;
  color: var(--text-faint);
}

.pad {
  padding: 16px;
}
</style>
