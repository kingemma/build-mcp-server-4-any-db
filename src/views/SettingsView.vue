<script setup>
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useAppStore } from '../stores/app';
import { rpcSafe } from '../api/rpc';

const store = useAppStore();
const portInput = ref(store.port);
const info = ref(null);
const isProbing = ref(false);

const platformCount = computed(() =>
  info.value ? Object.keys(info.value.platforms ?? {}).length : 0
);

async function loadInfo() {
  const result = await rpcSafe('system.info');
  if (result.ok) info.value = result.data;
}

async function savePort() {
  store.applyPort(portInput.value);
  await store.refreshBackend();
  ElMessage[store.isBackendUp ? 'success' : 'warning'](
    store.isBackendUp ? `已连接到后端 :${store.port}` : '后端无响应，请确认已启动'
  );
}

async function probe() {
  isProbing.value = true;
  try {
    await store.refreshBackend();
    ElMessage[store.isBackendUp ? 'success' : 'error'](
      store.isBackendUp ? '后端在线' : '后端离线'
    );
  } finally {
    isProbing.value = false;
  }
}

async function copyVersion() {
  if (!info.value) return;
  await navigator.clipboard.writeText(JSON.stringify(info.value, null, 2));
  ElMessage.success('版本信息已复制');
}

onMounted(loadInfo);
</script>

<template>
  <div class="grid">
    <section class="panel">
      <div class="panel__head">
        <span class="panel__title">后端连接</span>
        <span class="pill" :class="store.isBackendUp ? 'pill--on' : 'pill--off'">
          <span class="dot" />{{ store.isBackendUp ? '在线' : '离线' }}
        </span>
      </div>
      <div class="panel__body">
        <p class="mono-dim note">
          Tauri 启动后端后会把端口通过 ready 通知传回来；开发模式下手动填写 <code>npm run backend</code>
          启动时打印的端口。
        </p>
        <div class="row">
          <el-input v-model="portInput" placeholder="例如 50123" style="width: 160px" />
          <el-button type="primary" @click="savePort">保存并连接</el-button>
          <el-button :loading="isProbing" @click="probe">探活</el-button>
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="panel__head">
        <span class="panel__title">内置 GraphJin</span>
        <el-button size="small" :disabled="!info" @click="copyVersion">复制版本信息</el-button>
      </div>
      <div class="panel__body">
        <div v-if="info" class="facts">
          <div class="fact">
            <span class="eyebrow">版本</span>
            <span class="fact__value">{{ info.version }}</span>
          </div>
          <div class="fact">
            <span class="eyebrow">已缓存平台</span>
            <span class="fact__value">{{ platformCount }} / 6</span>
          </div>
          <div class="fact">
            <span class="eyebrow">上游</span>
            <span class="fact__value">{{ info.repo }}</span>
          </div>
          <div class="fact">
            <span class="eyebrow">后端</span>
            <span class="fact__value">{{ info.backendVersion }}</span>
          </div>
        </div>
        <p v-else class="mono-dim">未获取到版本信息，请先连接后端。</p>
        <p class="mono-dim note">
          二进制随安装包分发，不做运行时在线更新；升级 GraphJin 需要发布新的桌面端版本。
        </p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: var(--gutter);
}

.row {
  display: flex;
  gap: 10px;
  align-items: center;
}

.note {
  margin: 0 0 14px;
  font-size: 11.5px;
}

.facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
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
  font-size: 14px;
  color: var(--amber);
}

code {
  color: var(--amber);
}
</style>
