<script setup>
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useI18n } from 'vue-i18n';
import { rpcSafe } from '../api/rpc';
import { useAppStore } from '../stores/app';

const store = useAppStore();
const { t } = useI18n();

const selected = ref('');
const tools = ref([]);
const isChecking = ref(false);

const clients = computed(() => store.clients);
const endpoint = computed(() => store.clientConfig?.endpoint ?? '');
const configText = computed(() => JSON.stringify(store.clientConfig?.mcpServers ?? {}, null, 2));
const commands = computed(() => store.clientConfig?.cliCommands ?? []);

/** 选中客户端的配置文件位置（各客户端路径不同） */
const selectedClient = computed(
  () => clients.value.find((client) => client.id === selected.value) ?? null
);

async function copy(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success(t('connect.copied', { label }));
  } catch (error) {
    ElMessage.error(error.message);
  }
}

/** 自检：调一次 tools/list，证明配置写对了、端点通了 */
async function selfCheck() {
  if (!store.isRunning) {
    ElMessage.warning(t('connect.notRunning'));
    return;
  }
  isChecking.value = true;
  try {
    const result = await rpcSafe('mcp.tools', { baseUrl: store.baseUrl, role: 'admin' });
    if (result.ok) {
      tools.value = result.data;
      ElMessage.success(t('connect.selfCheckOk', { count: result.data.length }));
    } else {
      ElMessage.error(result.error);
    }
  } finally {
    isChecking.value = false;
  }
}

onMounted(async () => {
  await store.loadClientConfig();
  await store.loadClients();
});
</script>

<template>
  <div class="stack">
    <section class="panel">
      <div class="panel__head">
        <span class="panel__title">{{ t('connect.title') }}</span>
        <span class="eyebrow">{{ endpoint || t('common.notRunning') }}</span>
      </div>
      <div class="panel__body">
        <p class="note">{{ t('connect.hint') }}</p>

        <p class="eyebrow">{{ t('connect.pickClient') }}</p>
        <div class="clients">
          <div
            v-for="client in clients"
            :key="client.id"
            class="client"
            :class="{ 'client--active': selected === client.id }"
            @click="selected = client.id"
          >
            <strong>{{ client.label }}</strong>
            <code class="client__path">{{ client.configPath }}</code>
          </div>
        </div>

        <div class="actions">
          <el-button
            type="primary"
            size="small"
            :disabled="!endpoint"
            @click="copy(configText, t('connect.configJson'))"
          >
            {{ t('connect.copyJson') }}
          </el-button>
          <el-button size="small" :loading="isChecking" :disabled="!store.isRunning" @click="selfCheck">
            {{ t('connect.selfCheck') }}
          </el-button>
          <span v-if="tools.length" class="eyebrow">
            {{ t('connect.selfCheckOk', { count: tools.length }) }}
          </span>
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="panel__head">
        <span class="panel__title">{{ t('connect.configJson') }}</span>
        <el-button size="small" :disabled="!endpoint" @click="copy(configText, t('connect.configJson'))">
          {{ t('common.copy') }}
        </el-button>
      </div>
      <div class="panel__body">
        <pre class="code">{{ configText }}</pre>
        <p v-if="selectedClient" class="note">
          {{ t('connect.configFile') }}：<code>{{ selectedClient.configPath }}</code>
        </p>
      </div>
    </section>

    <section class="panel">
      <div class="panel__head">
        <span class="panel__title">{{ t('connect.commands') }}</span>
      </div>
      <div class="panel__body">
        <div v-for="command in commands" :key="command.label" class="cmd">
          <span class="cmd__label">{{ command.label }}</span>
          <code class="cmd__text">{{ command.command }}</code>
          <el-button size="small" @click="copy(command.command, command.label)">
            {{ t('common.copy') }}
          </el-button>
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="panel__body">
        <p class="note">{{ t('connect.limitNote') }}</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.stack {
  display: grid;
  gap: var(--gutter);
}

.note {
  margin: 0 0 12px;
  font-size: var(--fs-note);
  line-height: 1.7;
  color: var(--text-dim);
}

.clients {
  display: grid;
  gap: 10px;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  margin: 10px 0 16px;
}

.client {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px 16px;
  cursor: pointer;
  background: var(--ink-700);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
}

.client--active {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}

.client__path {
  overflow: hidden;
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--text-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

.code {
  max-height: 300px;
  margin: 0;
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

.cmd {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 8px 0;
  border-bottom: 1px solid var(--line-soft);
}

.cmd:last-child {
  border-bottom: none;
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

.cmd__text {
  flex: 1;
  overflow: hidden;
  font-family: var(--mono);
  font-size: 12.5px;
  color: var(--text);
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
