<script setup>
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useI18n } from 'vue-i18n';
import { useAppStore } from '../stores/app';
import { rpcSafe } from '../api/rpc';

const store = useAppStore();
const { t } = useI18n();
const tools = ref([]);
const isLoadingTools = ref(false);

const endpoint = computed(() => store.clientConfig?.endpoint ?? '');

async function loadTools() {
  if (!store.isRunning) return;
  isLoadingTools.value = true;
  try {
    const result = await rpcSafe('graphjin.tools', { baseUrl: store.baseUrl });
    if (result.ok) tools.value = result.data.map((tool) => tool.name);
  } finally {
    isLoadingTools.value = false;
  }
}

async function refreshAll() {
  await store.refreshStatus();
  await store.loadClientConfig();
  await loadTools();
}

async function copy(text, label) {
  await navigator.clipboard.writeText(text);
  ElMessage.success(t('common.copied', { label }));
}

async function health() {
  const result = await rpcSafe('graphjin.health');
  if (result.ok) {
    ElMessage[result.data.healthy ? 'success' : 'warning'](
      // 不健康时后端给的 reason 本身就是可读文案，原样展示
      result.data.healthy ? t('status.healthy', { status: result.data.httpStatus }) : result.data.reason
    );
  }
}

async function stop() {
  await store.stopGraphJin();
  tools.value = [];
  ElMessage.success(t('status.stoppedHint'));
}

onMounted(refreshAll);
</script>

<template>
  <div class="stack">
    <section class="panel">
      <div class="panel__head">
        <span class="panel__title">{{ t('status.service') }}</span>
        <span class="pill" :class="store.isRunning ? 'pill--on' : 'pill--off'">
          <span class="dot" />{{ store.isRunning ? t('common.running') : t('common.stopped') }}
        </span>
      </div>
      <div class="panel__body">
        <div class="facts">
          <div class="fact">
            <span class="eyebrow">{{ t('status.endpoint') }}</span>
            <span class="fact__value">{{ store.baseUrl || t('common.dash') }}</span>
          </div>
          <div class="fact">
            <span class="eyebrow">{{ t('status.process') }}</span>
            <span class="fact__value">{{ store.status?.pid ?? t('common.dash') }}</span>
          </div>
          <div class="fact">
            <span class="eyebrow">{{ t('status.projectDir') }}</span>
            <span class="fact__value fact__value--path">
              {{ store.status?.projectDir ?? t('common.dash') }}
            </span>
          </div>
          <div class="fact">
            <span class="eyebrow">{{ t('status.restarts') }}</span>
            <span class="fact__value">{{ store.status?.restarts ?? 0 }}</span>
          </div>
        </div>

        <p v-if="store.status?.lastError" class="alert">{{ store.status.lastError }}</p>

        <div class="row">
          <el-button :loading="store.isBusy" @click="refreshAll">
            {{ t('status.refreshAll') }}
          </el-button>
          <el-button @click="health">{{ t('status.probe') }}</el-button>
          <el-button type="danger" :disabled="!store.isRunning || store.isBusy" @click="stop">
            {{ t('status.stop') }}
          </el-button>
          <RouterLink to="/connections">
            <el-button type="primary">{{ t('status.goConnections') }}</el-button>
          </RouterLink>
        </div>
      </div>
    </section>

    <div class="duo">
      <section class="panel">
        <div class="panel__head">
          <span class="panel__title">{{ t('status.tools') }}</span>
          <span class="eyebrow">{{ t('status.toolCount', { count: tools.length }) }}</span>
        </div>
        <div class="panel__body">
          <div v-if="tools.length" class="chips">
            <span v-for="tool in tools" :key="tool" class="chip">{{ tool }}</span>
          </div>
          <p v-else class="mono-dim">{{ t('status.toolsEmpty') }}</p>
        </div>
      </section>

      <section class="panel">
        <div class="panel__head">
          <span class="panel__title">{{ t('status.clientConfig') }}</span>
          <el-button
            size="small"
            :disabled="!endpoint"
            @click="copy(JSON.stringify(store.clientConfig?.mcpServers, null, 2), t('status.clientConfig'))"
          >
            {{ t('common.copy') }}
          </el-button>
        </div>
        <div class="panel__body">
          <div v-if="endpoint" class="endpoint" @click="copy(endpoint, t('status.endpoint'))">
            {{ endpoint }}
            <span class="endpoint__hint">{{ t('status.clickToCopy') }}</span>
          </div>
          <div v-for="command in store.clientConfig?.cliCommands ?? []" :key="command.label" class="cmd">
            <span class="cmd__label">{{ command.label }}</span>
            <code>{{ command.command }}</code>
          </div>
          <p class="mono-dim note">
            {{ t('status.transportNote') }}
          </p>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.stack,
.duo {
  display: grid;
  gap: var(--gutter);
}

.duo {
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
}

.facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  margin-bottom: 14px;
}

.fact {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 10px 12px;
  background: var(--ink-700);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius);
}

.fact__value {
  font-size: 13px;
  color: var(--amber);
  word-break: break-all;
}

.fact__value--path {
  color: var(--text);
  font-size: 11.5px;
}

.row {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.alert {
  margin: 0 0 12px;
  padding: 8px 10px;
  color: var(--coral);
  background: var(--coral-soft);
  border: 1px solid rgba(226, 115, 94, 0.3);
  border-radius: var(--radius);
  font-size: 11.5px;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip {
  padding: 3px 9px;
  font-size: 11px;
  color: var(--slate);
  background: rgba(111, 139, 163, 0.1);
  border: 1px solid rgba(111, 139, 163, 0.28);
  border-radius: 999px;
}

.endpoint {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  margin-bottom: 12px;
  background: var(--ink-700);
  border: 1px dashed var(--line);
  border-radius: var(--radius);
  color: var(--mint);
  cursor: pointer;
  word-break: break-all;
}

.endpoint__hint {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--text-faint);
}

.cmd {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 5px 0;
  border-bottom: 1px solid var(--line-soft);
}

.cmd__label {
  flex-shrink: 0;
  width: 92px;
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-faint);
}

.cmd code {
  font-size: 11.5px;
  color: var(--text);
}

.note {
  margin: 12px 0 0;
  font-size: 11px;
}

code {
  color: var(--amber);
}
</style>
