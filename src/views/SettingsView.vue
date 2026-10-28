<script setup>
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useI18n } from 'vue-i18n';
import { useAppStore } from '../stores/app';
import { rpcSafe } from '../api/rpc';
import AiDemoPanel from '../components/AiDemoPanel.vue';

const store = useAppStore();
const { t } = useI18n();
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
    store.isBackendUp
      ? t('settings.messages.connected', { port: store.port })
      : t('settings.messages.unreachable')
  );
}

async function probe() {
  isProbing.value = true;
  try {
    await store.refreshBackend();
    ElMessage[store.isBackendUp ? 'success' : 'error'](
      store.isBackendUp ? t('settings.messages.online') : t('settings.messages.offline')
    );
  } finally {
    isProbing.value = false;
  }
}

async function copyVersion() {
  if (!info.value) return;
  await navigator.clipboard.writeText(JSON.stringify(info.value, null, 2));
  ElMessage.success(t('settings.messages.versionCopied'));
}

onMounted(loadInfo);
</script>

<template>
  <div class="page">
    <div class="grid">
      <section class="panel">
        <div class="panel__head">
          <span class="panel__title">{{ t('settings.backendConnection') }}</span>
          <span class="pill" :class="store.isBackendUp ? 'pill--on' : 'pill--off'">
            <span class="dot" />{{ store.isBackendUp ? t('common.online') : t('common.offline') }}
          </span>
        </div>
        <div class="panel__body">
          <p class="mono-dim note">{{ t('settings.portNote') }}</p>
          <div class="row">
            <el-input
              v-model="portInput"
              :placeholder="t('settings.portPlaceholder')"
              style="width: 160px"
            />
            <el-button type="primary" @click="savePort">
              {{ t('settings.saveAndConnect') }}
            </el-button>
            <el-button :loading="isProbing" @click="probe">{{ t('settings.probe') }}</el-button>
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="panel__head">
          <span class="panel__title">{{ t('settings.bundled') }}</span>
          <el-button size="small" :disabled="!info" @click="copyVersion">
            {{ t('settings.copyVersion') }}
          </el-button>
        </div>
        <div class="panel__body">
          <div v-if="info" class="facts">
            <div class="fact">
              <span class="eyebrow">{{ t('settings.version') }}</span>
              <span class="fact__value">{{ info.version }}</span>
            </div>
            <div class="fact">
              <span class="eyebrow">{{ t('settings.cachedPlatforms') }}</span>
              <span class="fact__value">
                {{ t('settings.platformRatio', { count: platformCount, total: 6 }) }}
              </span>
            </div>
            <div class="fact">
              <span class="eyebrow">{{ t('settings.upstream') }}</span>
              <span class="fact__value">{{ info.repo }}</span>
            </div>
            <div class="fact">
              <span class="eyebrow">{{ t('settings.backend') }}</span>
              <span class="fact__value">{{ info.backendVersion }}</span>
            </div>
          </div>
          <p v-else class="mono-dim">{{ t('settings.noInfo') }}</p>
          <p class="mono-dim note">{{ t('settings.updateNote') }}</p>
        </div>
      </section>
    </div>

    <AiDemoPanel />
  </div>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
  gap: var(--gutter);
  align-items: start;
}

.row {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}

.note {
  margin: 0 0 16px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text-dim);
}

.facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
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
  font-size: 14px;
  font-weight: 500;
  color: var(--accent);
  word-break: break-word;
}

code {
  color: var(--accent);
}
</style>
