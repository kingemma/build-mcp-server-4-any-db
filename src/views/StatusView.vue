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

/** legacy 配置迁移报告：只有项目是从 databases: 迁过来的才有 */
const migration = computed(() => store.status?.migration ?? null);

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
  await Promise.all([store.loadClientConfig(), store.loadClients()]);
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
          <span class="dot" />{{ store.isRunning ? t('app.live') : t('app.down') }}
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

    <section v-if="migration" class="panel">
      <div class="panel__head">
        <span class="panel__title">{{ t('status.migration') }}</span>
        <span class="pill" :class="migration.ok ? 'pill--on' : 'pill--warn'">
          <span class="dot" />
          {{ migration.ok ? t('status.migrationDone') : t('status.migrationFailed') }}
        </span>
      </div>
      <div class="panel__body">
        <p v-if="!migration.ok" class="alert">{{ migration.reason }}</p>
        <div class="facts">
          <div class="fact">
            <span class="eyebrow">{{ t('status.migrationSources') }}</span>
            <span class="fact__value">{{ (migration.sources ?? []).join(', ') || t('common.dash') }}</span>
          </div>
          <div class="fact">
            <span class="eyebrow">{{ t('status.migrationConflicts') }}</span>
            <span class="fact__value">{{ migration.conflicts?.length ?? 0 }}</span>
          </div>
        </div>

        <table v-if="migration.conflicts?.length" class="conflicts">
          <thead>
            <tr>
              <th>{{ t('status.migrationTarget') }}</th>
              <th>{{ t('status.migrationDetail') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="conflict in migration.conflicts"
              :key="`${conflict.database}-${conflict.role}-${conflict.table}-${conflict.reason}`"
            >
              <td class="mono">{{ conflict.database }} · {{ conflict.table }}</td>
              <td>
                {{ conflict.role }} · {{ conflict.reason }}
                <span v-if="conflict.detail" class="conflict__detail">{{ conflict.detail }}</span>
              </td>
            </tr>
          </tbody>
        </table>

        <div v-if="migration.backup" class="backup">
          <span class="eyebrow">{{ t('status.migrationBackup') }}</span>
          <code class="backup__path">{{ migration.backup }}</code>
          <el-button size="small" @click="copy(migration.backup, t('status.migrationBackup'))">
            {{ t('common.copy') }}
          </el-button>
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
          <div v-if="store.clients.length" class="clients">
            <span class="eyebrow">{{ t('status.clientsTitle') }}</span>
            <div v-for="client in store.clients" :key="client.id" class="client">
              <span class="client__label">{{ client.label }}</span>
              <code class="client__path">{{ client.configPath }}</code>
            </div>
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
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.fact {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px;
  background: var(--ink-700);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
}

.fact__value {
  font-size: 14.5px;
  font-weight: 500;
  color: var(--accent);
  word-break: break-all;
}

.fact__value--path {
  color: var(--text);
  font-size: 12.5px;
  font-weight: 400;
}

.row {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.alert {
  margin: 0 0 14px;
  padding: 10px 12px;
  color: var(--coral);
  background: var(--coral-soft);
  border: 1px solid rgba(180, 35, 24, 0.2);
  border-radius: var(--radius-sm);
  font-size: 12.5px;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}

.chip {
  padding: 4px 10px;
  font-family: var(--mono);
  font-size: var(--fs-micro);
  color: var(--text-dim);
  background: var(--accent-soft);
  border: 1px solid rgba(29, 78, 216, 0.16);
  border-radius: 999px;
}

.endpoint {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 14px;
  margin-bottom: 14px;
  background: #f7faf8;
  border: 1px solid #d6e6df;
  border-radius: var(--radius-sm);
  color: var(--mint);
  cursor: pointer;
  word-break: break-all;
}

.endpoint__hint {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-faint);
}

.cmd {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 7px 0;
  border-bottom: 1px solid var(--line-soft);
}

.cmd__label {
  flex-shrink: 0;
  width: 96px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-faint);
}

.clients {
  margin-top: 16px;
}

.client {
  display: flex;
  gap: 12px;
  padding: 6px 0;
  font-size: 12.5px;
  border-bottom: 1px solid var(--line-soft);
}

.client__label {
  flex-shrink: 0;
  width: 126px;
  color: var(--text-dim);
}

.client__path {
  color: var(--text-faint);
  word-break: break-all;
}

.cmd code {
  font-size: 12.5px;
  color: var(--text);
}

.note {
  margin: 14px 0 0;
  font-size: var(--fs-note);
  color: var(--text-dim);
}

.conflicts {
  width: 100%;
  margin-top: 4px;
  border-collapse: collapse;
}

.conflicts th {
  padding: 8px 12px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-faint);
  text-align: left;
  border-bottom: 1px solid var(--line);
}

.conflicts td {
  padding: 8px 12px;
  font-size: 12.5px;
  color: var(--text);
  vertical-align: top;
  border-bottom: 1px solid var(--line-soft);
}

.conflict__detail {
  display: block;
  margin-top: 2px;
  font-size: var(--fs-note);
  color: var(--text-dim);
}

.backup {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  margin-top: 14px;
}

.backup__path {
  flex: 1;
  min-width: 220px;
  font-size: 12px;
  color: var(--text-faint);
  word-break: break-all;
}

code {
  color: var(--accent);
}
</style>
