<script setup>
import { computed, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useI18n } from 'vue-i18n';
import { useAppStore, OPERATIONS, OPERATION_KEYS, STATE_KEYS } from '../stores/app';
import { formatDetail, formatOperationRules } from '../utils/policy';

const store = useAppStore();
const { t } = useI18n();

/** 空态要分清三种情况：没运行 / 还没读 / 读了但该库没规则 */
const emptyText = computed(() => {
  if (!store.isRunning) return t('policy.emptyStopped');
  if (!store.hasLoadedPolicy) return t('policy.emptyRunning');
  return t('policy.emptyNoRules');
});

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

/**
 * 本页需要 schema 才能确定「读哪个库」：不加载就只有空策略。
 * 冷启动时 status 还没回来，watch(isRunning) 负责补第二次。
 */
watch(
  () => store.isRunning,
  (running) => {
    if (running) store.ensureSchemaLoaded();
  },
  { immediate: true }
);
</script>

<template>
  <div class="stack">
    <section class="panel">
      <div class="panel__head">
        <span class="panel__title">{{ t('policy.current') }}</span>
        <div class="actions">
          <el-select
            :model-value="store.applyDatabase"
            size="small"
            style="width: 150px"
            :placeholder="t('policy.database')"
            @change="store.selectDatabase"
          >
            <el-option
              v-for="name in store.databaseNames"
              :key="name"
              :label="name"
              :value="name"
            />
          </el-select>
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
        <p v-else class="mono-dim pad">{{ emptyText }}</p>
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
  padding: 10px 16px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-dim);
  text-align: left;
  border-bottom: 1px solid var(--line);
  background: var(--ink-700);
}

.policy td {
  padding: 10px 16px;
  font-size: 13px;
  border-bottom: 1px solid var(--line-soft);
}

.policy tr:hover td {
  background: #f2f7ff;
}

.mono {
  font-family: var(--mono);
  color: var(--text);
  font-weight: 500;
}

.state {
  font-family: var(--mono);
  font-size: var(--fs-micro);
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
  font-size: var(--fs-note);
  color: var(--text-dim);
}

.changes {
  margin: 0 0 12px;
  padding-left: 18px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text-dim);
}

.changes li {
  margin-bottom: 5px;
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
  padding: 2px 7px;
  font-size: 11px;
}

.note {
  margin: 12px 0 0;
  font-size: var(--fs-note);
  line-height: 1.7;
  color: var(--text-dim);
}

.pad {
  padding: 18px;
}
</style>
