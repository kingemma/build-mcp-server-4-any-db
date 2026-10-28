<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useI18n } from 'vue-i18n';
import { rpcSafe } from '../api/rpc';
import { useAppStore } from '../stores/app';
import {
  DEMO_TOOL_ORDER,
  MAX_DEMO_ATTEMPTS,
  buildDemoArgs,
  repairAttempt,
} from '../utils/mcp-demo.js';

const store = useAppStore();
const { t } = useI18n();

/**
 * 角色与 user_code 是这次测试的「身份」：角色决定能看哪些表，user_code 决定行过滤
 * 命中哪些行。演示库的归属是 hq / sh / gz，默认给 hq 才有数据可看。
 */
const role = ref('admin');
const userCode = ref('hq');

const rows = ref([]);
const isLoading = ref(false);
const isRunningAll = ref(false);
const loadError = ref('');

/**
 * 测试数据要落在当前项目的真实表 / 概念上。写死一个 orders，在别人的库上
 * 第一条就「查无此表」，那种失败测不出任何东西。
 */
const context = computed(() => {
  const table =
    store.tables.find((item) => item.database === store.activeDatabase) ?? store.tables[0] ?? null;
  const concept =
    store.ontology.find((entry) => entry.kind === 'concept') ?? store.ontology[0] ?? null;
  return {
    database: table?.database ?? store.activeDatabase ?? '',
    table: table?.name ?? '',
    column: table?.primaryKey ?? 'id',
    concept: concept?.name ?? '',
  };
});

/** 只统计有预设测试数据的工具：目录外的工具参数要人决定，不该拉低通过率 */
const summary = computed(() => {
  const auto = rows.value.filter((row) => row.auto);
  const passed = auto.filter((row) => row.status === 'pass' || row.status === 'fixed').length;
  const failed = auto.filter((row) => row.status === 'fail').length;
  return { passed, failed, ran: passed + failed, total: auto.length };
});

/** 已跑完的状态：全跑时据此跳过重复执行 */
const DONE = new Set(['pass', 'fixed', 'fail']);

/**
 * 目录里的顺序优先，目录外的新工具按名字缀在后面 —— 上游加了工具也应该能被测到。
 *
 * @param {Array<Object>} tools
 * @returns {Array<Object>}
 */
function orderTools(tools) {
  const rank = (name) => {
    const index = DEMO_TOOL_ORDER.indexOf(name);
    return index === -1 ? DEMO_TOOL_ORDER.length : index;
  };
  return [...tools].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

function toRow(tool) {
  return {
    name: tool.name,
    // 目录里的工具才有可自动跑的测试数据；目录外的（例如写配置的工具）留给人自己填参数
    auto: DEMO_TOOL_ORDER.includes(tool.name),
    description: tool.description ?? '',
    inputSchema: tool.inputSchema ?? null,
    /** null = 用户还没动过，显示按当前 schema 现生成的参数 */
    argsText: null,
    status: 'idle',
    elapsedMs: 0,
    text: '',
    attempts: [],
    open: false,
  };
}

/**
 * 行上的测试参数：没被编辑过就按当前 schema / 本体论现生成。
 *
 * 不在建行时烤死参数，是因为 schema 可能比工具清单晚到（子组件的 onMounted
 * 早于父组件拉运行态），烤死的话第一条就成了「缺必填参数」，一路红。
 *
 * @param {Object} row
 * @returns {string}
 */
function argsTextOf(row) {
  if (typeof row.argsText === 'string') return row.argsText;
  return JSON.stringify(buildDemoArgs(row.name, context.value), null, 2);
}

/** schema 与本体论是测试数据的来源；设置页可能没被访问过，这里现取 */
async function prepareContext() {
  await Promise.all([store.ensureSchemaLoaded(), store.loadOntology()]);
}

async function loadTools() {
  if (isLoading.value) return;
  isLoading.value = true;
  loadError.value = '';
  try {
    await prepareContext();
    const result = await rpcSafe('mcp.demoTools', { role: role.value, userCode: userCode.value });
    if (!result.ok) {
      rows.value = [];
      loadError.value = result.error;
      return;
    }
    rows.value = orderTools(result.data ?? []).map(toRow);
  } finally {
    isLoading.value = false;
  }
}

/**
 * 调一次工具。失败不抛异常：面板要把报错原样展示，并据此改参数重试。
 *
 * @param {string} name
 * @param {Object} args
 * @param {string} currentRole
 * @returns {Promise<Object>}
 */
async function callTool(name, args, currentRole) {
  const result = await rpcSafe('mcp.demoCall', {
    name,
    role: currentRole,
    userCode: userCode.value,
    arguments: args,
  });
  if (result.ok) return result.data;
  // 后端层面就失败了（例如服务没起来）：同样当成一次失败结果，别让面板卡住
  return { ok: false, isError: true, elapsedMs: 0, text: result.error };
}

/** 自动修正的说明文案 */
function repairText(attempt) {
  return t(`aiDemo.repairs.${attempt.reason}`, attempt.detail ?? {});
}

/**
 * 跑一个工具：失败时读报错 → 改参数 → 重试，最多 MAX_DEMO_ATTEMPTS 次。
 *
 * @param {Object} row
 * @returns {Promise<string>} 最终状态
 */
async function runRow(row) {
  if (row.status === 'running') return row.status;

  let args;
  try {
    const text = argsTextOf(row).trim();
    args = text === '' ? {} : JSON.parse(text);
  } catch (error) {
    row.status = 'fail';
    row.open = true;
    row.text = t('aiDemo.invalidJson', { message: error.message });
    row.attempts = [];
    return row.status;
  }

  row.status = 'running';
  row.attempts = [];
  row.text = '';
  row.elapsedMs = 0;

  let currentRole = role.value;
  let last = null;

  for (let attempt = 1; attempt <= MAX_DEMO_ATTEMPTS; attempt += 1) {
    last = await callTool(row.name, args, currentRole);
    row.elapsedMs = last.elapsedMs ?? 0;

    if (last.ok) {
      row.status = attempt === 1 ? 'pass' : 'fixed';
      row.text = last.text ?? '';
      row.argsText = JSON.stringify(args, null, 2);
      return row.status;
    }

    // 读不出来的报错就保持原样失败：宁可让人看见根因，也不要猜参数把失败伪装成通过
    const fix = repairAttempt({
      args,
      role: currentRole,
      error: last.text ?? '',
      context: context.value,
      inputSchema: row.inputSchema,
    });
    if (!fix) break;

    row.attempts.push({ attempt, error: last.text ?? '', reason: fix.reason, detail: fix.detail });
    if (fix.role) {
      currentRole = fix.role;
      role.value = fix.role;
    }
    if (fix.args) args = fix.args;
    row.argsText = JSON.stringify(args, null, 2);
    row.open = true;
  }

  row.status = 'fail';
  row.text = last?.text ?? '';
  row.open = true;
  return row.status;
}

async function runAll() {
  if (rows.value.length === 0) return;
  isRunningAll.value = true;
  try {
    for (const row of rows.value) {
      // 目录外的工具没有可自动跑的测试数据，参数得人来写
      if (!row.auto || DONE.has(row.status)) continue;
      await runRow(row);
    }
    const { passed, failed } = summary.value;
    ElMessage[failed === 0 ? 'success' : 'warning'](
      t('aiDemo.allDone', { passed, failed })
    );
  } finally {
    isRunningAll.value = false;
  }
}

function pillClass(row) {
  if (row.status === 'pass') return 'pill--on';
  if (row.status === 'fixed') return 'pill--warn';
  if (row.status === 'fail') return 'pill--off';
  return 'pill--idle';
}

/**
 * 子组件的 onMounted 早于父组件拉回运行态。运行态没到就取不到工具清单，
 * 所以等它变成 running 再补一次；参数不用补，argsTextOf 会按最新 schema 现生成。
 */
watch(
  () => store.isRunning,
  async (running) => {
    if (!running) return;
    // 运行态没到之前 ensureSchemaLoaded 直接返回空表，测试参数会退化成 {}
    await prepareContext();
    if (rows.value.length === 0) await loadTools();
  }
);

onMounted(loadTools);
</script>

<template>
  <section class="panel ai-demo">
    <div class="panel__head">
      <span class="panel__title">{{ t('aiDemo.title') }}</span>
      <div class="ai-demo__actions">
        <span class="mono-dim">
          {{ t('aiDemo.summary', { passed: summary.passed, total: summary.total }) }}
        </span>
        <el-button size="small" :loading="isLoading" @click="loadTools">
          {{ t('aiDemo.reload') }}
        </el-button>
        <el-button
          size="small"
          type="primary"
          :loading="isRunningAll"
          :disabled="rows.length === 0"
          @click="runAll"
        >
          {{ t('aiDemo.runAll') }}
        </el-button>
      </div>
    </div>

    <div class="panel__body">
      <p class="note">{{ t('aiDemo.note') }}</p>

      <div class="identity">
        <label class="identity__field">
          <span class="eyebrow">{{ t('aiDemo.role') }}</span>
          <el-select v-model="role" size="small" style="width: 180px" @change="loadTools">
            <el-option v-for="name in store.grantedRoles" :key="name" :label="name" :value="name" />
          </el-select>
        </label>
        <label class="identity__field">
          <span class="eyebrow">{{ t('aiDemo.userCode') }}</span>
          <el-input v-model="userCode" size="small" style="width: 180px" />
        </label>
        <span class="mono-dim identity__hint">{{ t('aiDemo.userCodeHint') }}</span>
      </div>

      <p v-if="loadError" class="failure">{{ loadError }}</p>
      <p v-else-if="isLoading" class="mono-dim">{{ t('aiDemo.loading') }}</p>
      <p v-else-if="rows.length === 0" class="mono-dim">{{ t('aiDemo.empty') }}</p>

      <ul class="tools">
        <li v-for="row in rows" :key="row.name" class="tool">
          <div class="tool__head">
            <button type="button" class="tool__toggle" @click="row.open = !row.open">
              <span class="tool__chevron" :class="{ 'tool__chevron--open': row.open }">›</span>
              <span class="tool__name">{{ row.name }}</span>
            </button>
            <span v-if="!row.auto" class="tool__manual">{{ t('aiDemo.manualTag') }}</span>
            <span class="pill" :class="pillClass(row)">
              {{ t(`aiDemo.status.${row.status}`) }}
            </span>
            <span v-if="row.elapsedMs > 0" class="mono-dim tool__elapsed">
              {{ t('aiDemo.elapsed', { ms: row.elapsedMs }) }}
            </span>
            <span class="tool__desc">{{ row.description }}</span>
            <el-button
              size="small"
              :loading="row.status === 'running'"
              :data-tool="row.name"
              @click="runRow(row)"
            >
              {{ t('aiDemo.run') }}
            </el-button>
          </div>

          <div v-show="row.open" class="tool__body">
            <div class="tool__block">
              <span class="eyebrow">{{ t('aiDemo.args') }}</span>
              <el-input
                :model-value="argsTextOf(row)"
                type="textarea"
                :rows="3"
                spellcheck="false"
                class="tool__args"
                @update:model-value="(value) => (row.argsText = value)"
              />
            </div>

            <ol v-if="row.attempts.length > 0" class="attempts">
              <li v-for="attempt in row.attempts" :key="attempt.attempt" class="attempts__item">
                <span class="attempts__badge">{{ attempt.attempt }}</span>
                <span>
                  {{ t('aiDemo.attemptLine', { attempt: attempt.attempt, reason: repairText(attempt) }) }}
                </span>
                <span class="mono-dim attempts__error">{{ attempt.error }}</span>
              </li>
            </ol>

            <div v-if="row.text" class="tool__block">
              <span class="eyebrow">{{ t('aiDemo.result') }}</span>
              <pre class="tool__result">{{ row.text }}</pre>
            </div>
          </div>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.ai-demo {
  margin-top: var(--gutter);
}

.ai-demo__actions {
  display: flex;
  gap: 10px;
  align-items: center;
}

.note {
  margin: 0 0 14px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text-dim);
}

.identity {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  align-items: flex-end;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--line-soft);
}

.identity__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.identity__hint {
  font-size: 12px;
  padding-bottom: 6px;
}

.failure {
  margin: 14px 0 0;
  font-size: 12.5px;
  color: #b42318;
}

.tools {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 16px 0 0;
  padding: 0;
  list-style: none;
}

.tool {
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
  background: var(--ink-700);
}

.tool__head {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 8px 12px;
}

.tool__toggle {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 0;
  font: inherit;
  color: var(--text);
  background: none;
  border: 0;
  cursor: pointer;
}

.tool__chevron {
  display: inline-block;
  font-size: 14px;
  color: var(--text-faint);
  transition: transform 0.14s ease;
}

.tool__chevron--open {
  transform: rotate(90deg);
}

.tool__name {
  font-family: var(--font-mono, monospace);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.01em;
}

.tool__elapsed {
  font-size: 12px;
  white-space: nowrap;
}

.tool__desc {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: 12px;
  color: var(--text-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool__manual {
  flex: none;
  padding: 1px 7px;
  font-size: 11px;
  color: var(--text-faint);
  background: var(--ink-800);
  border: 1px solid var(--line);
  border-radius: 999px;
}

.tool__body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 0 12px 12px;
  border-top: 1px dashed var(--line);
}

.tool__block {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 10px;
}

.tool__args :deep(textarea) {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  line-height: 1.6;
}

.tool__result {
  max-height: 260px;
  margin: 0;
  padding: 10px 12px;
  overflow: auto;
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-dim);
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--ink-800);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
}

.attempts {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
}

.attempts__item {
  display: flex;
  gap: 8px;
  align-items: baseline;
  font-size: 12px;
  color: var(--text-dim);
}

.attempts__badge {
  flex: none;
  width: 18px;
  height: 18px;
  font-size: 11px;
  font-weight: 600;
  line-height: 18px;
  text-align: center;
  color: var(--accent-strong);
  background: var(--accent-soft);
  border-radius: 50%;
}

.attempts__error {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
