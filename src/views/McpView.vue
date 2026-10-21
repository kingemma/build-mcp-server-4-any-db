<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useI18n } from 'vue-i18n';
import { rpc } from '../api/rpc';
import { useAppStore } from '../stores/app';

const store = useAppStore();
const { t } = useI18n();

/** 角色候选：admin 恒在，其余来自当前库角色 / 生效策略 / 成员角色 */
const roles = computed(() => [...new Set(['admin', ...store.roleNames])]);
const role = ref('admin');

const tools = ref([]);
const probes = ref([]);
const result = ref(null);
const elapsed = ref(0);
const query = ref('');

/**
 * 查询示例不进 i18n：花括号在 vue-i18n 消息语法里是插值标记，
 * GraphQL 的花括号会被当成非法表达式，整页渲染直接失败。
 */
const QUERY_PLACEHOLDER = '{ items(limit: 1) { id } }';

const loadingTools = ref(false);
const probing = ref(false);
const querying = ref(false);

/** GraphJin 的成功态是 data 非空；带 errors 就是失败 */
const queryFailed = computed(
  () => Array.isArray(result.value?.errors) && result.value.errors.length > 0
);

async function loadTools() {
  if (!store.isRunning) return;
  loadingTools.value = true;
  try {
    tools.value = await rpc('mcp.tools', { baseUrl: store.baseUrl, role: role.value });
  } catch (error) {
    tools.value = [];
    ElMessage.error(error.message);
  } finally {
    loadingTools.value = false;
  }
}

/** 一键测全部库：每个 source 读 catalog，再跑一次最小查询 */
async function probeAll() {
  probing.value = true;
  try {
    const data = await rpc('mcp.probe', { baseUrl: store.baseUrl, role: role.value });
    probes.value = data?.databases ?? [];
    const failed = probes.value.filter((item) => !item.ok).length;
    if (failed === 0) ElMessage.success(t('mcp.probeOk', { count: probes.value.length }));
    else ElMessage.warning(t('mcp.probeFailed', { count: failed }));
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    probing.value = false;
  }
}

async function run() {
  if (query.value.trim() === '') {
    ElMessage.warning(t('mcp.queryRequired'));
    return;
  }
  querying.value = true;
  try {
    const data = await rpc('mcp.query', {
      baseUrl: store.baseUrl,
      role: role.value,
      query: query.value,
    });
    result.value = data?.result ?? null;
    elapsed.value = data?.elapsedMs ?? 0;
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    querying.value = false;
  }
}

onMounted(loadTools);
watch(() => store.isRunning, (running) => {
  if (running) loadTools();
});
// 换角色等于换一套可见工具，顺手重拉
watch(role, loadTools);
</script>

<template>
  <div class="stack">
    <section class="panel">
      <div class="panel__head">
        <span class="panel__title">{{ t('mcp.instance') }}</span>
        <div class="head-actions">
          <span class="pill" :class="store.isRunning ? 'pill--on' : 'pill--off'">
            <span class="dot" />{{ store.isRunning ? store.baseUrl : t('common.notRunning') }}
          </span>
          <el-button size="small" :loading="loadingTools" :disabled="!store.isRunning" @click="loadTools">
            {{ t('mcp.reloadTools') }}
          </el-button>
        </div>
      </div>
      <div class="panel__body">
        <div class="row">
          <el-select v-model="role" size="small" style="width: 160px" :disabled="!store.isRunning">
            <el-option v-for="name in roles" :key="name" :label="name" :value="name" />
          </el-select>
          <el-button
            type="primary"
            size="small"
            :loading="probing"
            :disabled="!store.isRunning"
            @click="probeAll"
          >
            {{ t('mcp.probeAll') }}
          </el-button>
        </div>
        <p class="note">{{ t('mcp.roleNote') }}</p>
      </div>
    </section>

    <section class="panel">
      <div class="panel__head">
        <span class="panel__title">{{ t('mcp.databases') }}</span>
        <span class="eyebrow">{{ t('mcp.databaseCount', { count: probes.length }) }}</span>
      </div>
      <div class="panel__body panel__body--flush">
        <table v-if="probes.length" class="probes">
          <thead>
            <tr>
              <th>{{ t('mcp.table.database') }}</th>
              <th>{{ t('mcp.table.status') }}</th>
              <th>{{ t('mcp.table.mode') }}</th>
              <th>{{ t('mcp.table.tables') }}</th>
              <th>{{ t('mcp.table.sample') }}</th>
              <th>{{ t('mcp.table.elapsed') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in probes" :key="row.database">
              <td class="mono">{{ row.database }}</td>
              <td class="probes__status">
                <span class="pill" :class="row.ok ? 'pill--on' : 'pill--warn'">
                  <span class="dot" />{{ row.ok ? t('mcp.ok') : t('mcp.failed') }}
                </span>
                <span v-if="row.error" class="probes__error">{{ row.error }}</span>
              </td>
              <td class="mono-dim">
                {{ row.mode === 'query' ? t('mcp.modeQuery') : t('mcp.modeCatalog') }}
              </td>
              <td class="mono-dim">{{ row.tables }}</td>
              <td class="mono-dim">{{ row.table ? `${row.table}.${row.column}` : t('common.dash') }}</td>
              <td class="mono-dim">{{ row.elapsedMs }} ms</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="empty mono-dim">
          {{ store.isRunning ? t('mcp.probeEmpty') : t('mcp.notRunningHint') }}
        </p>
      </div>
    </section>

    <div class="duo">
      <section class="panel">
        <div class="panel__head">
          <span class="panel__title">{{ t('mcp.tools') }}</span>
          <span class="eyebrow">{{ t('mcp.toolCount', { count: tools.length }) }}</span>
        </div>
        <div class="panel__body">
          <div v-if="tools.length" class="tools">
            <span v-for="item in tools" :key="item.name" class="chip" :title="item.description">
              {{ item.name }}
            </span>
          </div>
          <p v-else class="mono-dim">{{ t('mcp.toolsEmpty') }}</p>
        </div>
      </section>

      <section class="panel">
        <div class="panel__head">
          <span class="panel__title">{{ t('mcp.query') }}</span>
          <span class="eyebrow">{{ result ? `${elapsed} ms` : t('common.dash') }}</span>
        </div>
        <div class="panel__body">
          <el-input
            v-model="query"
            type="textarea"
            :rows="5"
            class="query"
            :placeholder="QUERY_PLACEHOLDER"
          />
          <div class="row">
            <el-button
              type="primary"
              size="small"
              :loading="querying"
              :disabled="!store.isRunning"
              @click="run"
            >
              {{ t('mcp.run') }}
            </el-button>
            <span class="eyebrow">{{ t('mcp.rawNote') }}</span>
          </div>
          <pre v-if="result" class="result" :class="{ 'result--error': queryFailed }">{{
            JSON.stringify(result, null, 2)
          }}</pre>
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

.duo {
  display: grid;
  gap: var(--gutter);
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
}

@media (max-width: 1100px) {
  .duo {
    grid-template-columns: minmax(0, 1fr);
  }
}

.head-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.row {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-top: 12px;
}

.note {
  margin: 10px 0 0;
  font-size: var(--fs-note);
  line-height: 1.7;
  color: var(--text-dim);
}

.empty {
  margin: 0;
  padding: 18px;
}

.probes {
  width: 100%;
  border-collapse: collapse;
}

.probes th {
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

.probes td {
  padding: 10px 16px;
  font-size: 13px;
  border-bottom: 1px solid var(--line-soft);
}

.probes__status {
  display: flex;
  gap: 8px;
  align-items: center;
}

.probes__error {
  max-width: 320px;
  overflow: hidden;
  font-size: var(--fs-note);
  color: var(--accent-strong);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tools {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.chip {
  padding: 4px 10px;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text-dim);
  background: var(--ink-700);
  border: 1px solid var(--line);
  border-radius: 999px;
}

.query :deep(textarea) {
  font-family: var(--mono);
  font-size: 12.5px;
}

.result {
  max-height: 260px;
  margin: 12px 0 0;
  padding: 12px;
  overflow: auto;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.6;
  color: var(--text);
  background: var(--ink-700);
  border: 1px solid var(--line);
  border-radius: 8px;
}

.result--error {
  border-color: rgba(220, 38, 38, 0.4);
}
</style>

