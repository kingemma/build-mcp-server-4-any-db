<script setup>
import { computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { useI18n } from 'vue-i18n';
import { useAppStore, OPERATIONS, OPERATION_KEYS, STATE_KEYS } from '../stores/app';
import { formatDetail, formatOperationRules } from '../utils/policy';

const store = useAppStore();
const { t } = useI18n();

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
  return formatOperationRules(operation, t) || t('common.dash');
}

async function refresh() {
  await store.loadCurrentPolicy();
  ElMessage.success(t('policy.reloaded'));
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
        <span class="panel__title">{{ t('policy.current') }}</span>
        <div class="actions">
          <span class="pill pill--idle">{{ t('policy.source') }}</span>
          <el-button size="small" :loading="store.isBusy" @click="refresh">
            {{ t('policy.reload') }}
          </el-button>
        </div>
      </div>
      <div class="panel__body panel__body--flush">
        <table v-if="currentRows.length" class="policy">
          <thead>
            <tr>
              <th>{{ t('policy.role') }}</th>
              <th>{{ t('policy.table') }}</th>
              <th v-for="operation in OPERATIONS" :key="operation">
                {{ t(OPERATION_KEYS[operation]) }}
              </th>
              <th>{{ t('policy.extraRules') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in currentRows" :key="`${row.role}-${row.table}`">
              <td class="mono">{{ row.role }}</td>
              <td class="mono">{{ row.table }}</td>
              <td v-for="operation in OPERATIONS" :key="operation">
                <span class="state" :class="`state--${row.operations[operation].state}`">
                  {{ t(STATE_KEYS[row.operations[operation].state]) }}
                </span>
              </td>
              <td class="detail">{{ detailsOf(row.operations.query) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="mono-dim pad">
          {{ store.isRunning ? t('policy.emptyRunning') : t('policy.emptyStopped') }}
        </p>
      </div>
    </section>

    <section class="panel">
      <div class="panel__head">
        <span class="panel__title">{{ t('policy.pending') }}</span>
        <span class="pill" :class="changes.length ? 'pill--warn' : 'pill--on'">
          <span class="dot" />
          {{
            changes.length ? t('policy.changeCount', { count: changes.length }) : t('policy.inSync')
          }}
        </span>
      </div>
      <div class="panel__body">
        <ul v-if="changes.length" class="changes">
          <li v-for="(change, index) in changes" :key="index">
            <b>{{ change.role }}</b> · {{ change.table }} · {{ t(OPERATION_KEYS[change.operation]) }}
            <span class="pill pill--tiny">
              {{ change.kind === 'added' ? t('policy.added') : t('policy.changed') }}
            </span>
            <span class="from">{{ t(STATE_KEYS[change.from.state]) }}</span>
            <span class="arrow">→</span>
            <span class="to">{{ t(STATE_KEYS[change.to.state]) }}</span>
            <span v-if="change.detail" class="detail">{{ formatDetail(change.detail, t) }}</span>
          </li>
        </ul>
        <p v-else class="mono-dim">{{ t('policy.noChanges') }}</p>
        <p class="note">{{ t('policy.sourceNote') }}</p>
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
