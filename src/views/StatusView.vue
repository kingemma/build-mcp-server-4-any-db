<script setup>
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useAppStore } from '../stores/app';
import { rpcSafe } from '../api/rpc';

const store = useAppStore();
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
  ElMessage.success(`${label}已复制`);
}

async function health() {
  const result = await rpcSafe('graphjin.health');
  if (result.ok) {
    ElMessage[result.data.healthy ? 'success' : 'warning'](
      result.data.healthy ? `健康（HTTP ${result.data.httpStatus}）` : result.data.reason
    );
  }
}

async function stop() {
  await store.stopGraphJin();
  tools.value = [];
  ElMessage.success('已停止');
}

onMounted(refreshAll);
</script>

<template>
  <div class="stack">
    <section class="panel">
      <div class="panel__head">
        <span class="panel__title">服务</span>
        <span class="pill" :class="store.isRunning ? 'pill--on' : 'pill--off'">
          <span class="dot" />{{ store.isRunning ? '运行中' : '未运行' }}
        </span>
      </div>
      <div class="panel__body">
        <div class="facts">
          <div class="fact">
            <span class="eyebrow">端点</span>
            <span class="fact__value">{{ store.baseUrl || '—' }}</span>
          </div>
          <div class="fact">
            <span class="eyebrow">进程</span>
            <span class="fact__value">{{ store.status?.pid ?? '—' }}</span>
          </div>
          <div class="fact">
            <span class="eyebrow">项目目录</span>
            <span class="fact__value fact__value--path">{{ store.status?.projectDir ?? '—' }}</span>
          </div>
          <div class="fact">
            <span class="eyebrow">崩溃重启次数</span>
            <span class="fact__value">{{ store.status?.restarts ?? 0 }}</span>
          </div>
        </div>

        <p v-if="store.status?.lastError" class="alert">{{ store.status.lastError }}</p>

        <div class="row">
          <el-button :loading="store.isBusy" @click="refreshAll">刷新</el-button>
          <el-button @click="health">探活</el-button>
          <el-button
            type="danger"
            :disabled="!store.isRunning || store.isBusy"
            @click="stop"
          >
            停止
          </el-button>
          <RouterLink to="/connections">
            <el-button type="primary">去配置连接</el-button>
          </RouterLink>
        </div>
      </div>
    </section>

    <div class="duo">
      <section class="panel">
        <div class="panel__head">
          <span class="panel__title">MCP 工具</span>
          <span class="eyebrow">{{ tools.length }} 个</span>
        </div>
        <div class="panel__body">
          <div v-if="tools.length" class="chips">
            <span v-for="tool in tools" :key="tool" class="chip">{{ tool }}</span>
          </div>
          <p v-else class="mono-dim">服务未运行或工具不可用。</p>
        </div>
      </section>

      <section class="panel">
        <div class="panel__head">
          <span class="panel__title">客户端配置</span>
          <el-button
            size="small"
            :disabled="!endpoint"
            @click="copy(JSON.stringify(store.clientConfig?.mcpServers, null, 2), '配置')"
          >
            复制
          </el-button>
        </div>
        <div class="panel__body">
          <div v-if="endpoint" class="endpoint" @click="copy(endpoint, '端点')">
            {{ endpoint }}
            <span class="endpoint__hint">点击复制</span>
          </div>
          <div v-for="command in store.clientConfig?.cliCommands ?? []" :key="command.label" class="cmd">
            <span class="cmd__label">{{ command.label }}</span>
            <code>{{ command.command }}</code>
          </div>
          <p class="mono-dim note">
            默认生成 HTTP 传输直连 <code>/api/v1/mcp</code>，不经过 v3.21.14 有缺陷的内置 stdio proxy。
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
