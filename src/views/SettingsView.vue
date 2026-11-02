<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useI18n } from 'vue-i18n';
import { useAppStore } from '../stores/app';
import { rpc, rpcSafe } from '../api/rpc';

const store = useAppStore();
const { t } = useI18n();
const portInput = ref(store.port);
const info = ref(null);
const isProbing = ref(false);

// ---- LLM 设置 ----
const models = ref([]);
const dialogVisible = ref(false);
const editingId = ref(null);
const saving = ref(false);
const form = reactive({
  name: '',
  provider: 'custom',
  kind: 'remote',
  baseUrl: '',
  model: '',
  apiKey: '',
  isDefault: false,
});

// 供应商预设：覆盖本地（vLLM / Ollama）与远端（DeepSeek / Qwen / 智普 / Mimo / Kimi）。
// kind 决定「本地 / 远端」默认归类；选了就把常见 baseUrl / model 回填，用户仍可再改。
// baseUrl 是 OpenAI 兼容端点（本地推理框架也走 /v1），所以本地远端都只用这一套字段。
const PROVIDERS = {
  custom: { i18n: 'settings.providerCustom', kind: 'remote', baseUrl: '', model: '' },
  deepseek: { i18n: 'settings.providerDeepseek', kind: 'remote', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  qwen: { i18n: 'settings.providerQwen', kind: 'remote', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  zhipu: { i18n: 'settings.providerZhipu', kind: 'remote', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus' },
  mimo: { i18n: 'settings.providerMimo', kind: 'remote', baseUrl: 'https://api.mimo.modelese.com/v1', model: 'mimo' },
  kimi: { i18n: 'settings.providerKimi', kind: 'remote', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  vllm: { i18n: 'settings.providerVllm', kind: 'local', baseUrl: 'http://localhost:8000/v1', model: '' },
  ollama: { i18n: 'settings.providerOllama', kind: 'local', baseUrl: 'http://localhost:11434/v1', model: '' },
};
const providerLabel = (key) => t(PROVIDERS[key]?.i18n ?? 'settings.providerCustom');

const platformCount = computed(() =>
  info.value ? Object.keys(info.value.platforms ?? {}).length : 0
);

async function loadInfo() {
  const result = await rpcSafe('system.info');
  if (result.ok) info.value = result.data;
}

async function loadModels() {
  const result = await rpcSafe('llm.list');
  if (result.ok) models.value = result.data.models ?? [];
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

// ---- LLM 表单 ----
function resetForm() {
  Object.assign(form, {
    name: '',
    provider: 'custom',
    kind: 'remote',
    baseUrl: '',
    model: '',
    apiKey: '',
    isDefault: false,
  });
}

function openAdd() {
  editingId.value = null;
  resetForm();
  dialogVisible.value = true;
}

function openEdit(m) {
  editingId.value = m.id;
  Object.assign(form, {
    name: m.name,
    provider: m.provider || 'custom',
    kind: m.kind,
    baseUrl: m.baseUrl,
    model: m.model,
    apiKey: '', // 编辑时不清空原密钥，留空即「保留已设置」
    isDefault: Boolean(m.isDefault),
  });
  dialogVisible.value = true;
}

function onProviderChange(key) {
  const preset = PROVIDERS[key];
  if (!preset) return;
  form.kind = preset.kind; // 本地/远端随供应商自动归类
  if (preset.baseUrl) form.baseUrl = preset.baseUrl;
  if (preset.model) form.model = preset.model;
}

// 把当前表单并入模型列表后整体保存。apiKey 只在用户真正输入时才上传，
// 留空则后端按 id 保留该模型原有的密文，避免「打开编辑又保存」把密钥清空。
async function saveModel() {
  saving.value = true;
  try {
    const id = editingId.value || crypto.randomUUID();
    const entry = {
      id,
      name: form.name.trim(),
      provider: form.provider,
      kind: form.kind,
      baseUrl: form.baseUrl.trim(),
      model: form.model.trim(),
    };
    if (form.apiKey) entry.apiKey = form.apiKey;

    const others = models.value
      .filter((m) => m.id !== id)
      .map((m) => ({ ...m, isDefault: false }));
    const next = [...others, { ...entry, isDefault: form.isDefault }];
    const defaultId = form.isDefault ? id : next.find((m) => m.isDefault)?.id ?? null;

    const res = await rpc('llm.save', { models: next, defaultId });
    models.value = res.models;
    dialogVisible.value = false;
    ElMessage.success(t('settings.llmSaved'));
  } finally {
    saving.value = false;
  }
}

async function setDefault(m) {
  const next = models.value.map((x) => ({ ...x, isDefault: x.id === m.id }));
  const res = await rpc('llm.save', { models: next, defaultId: m.id });
  models.value = res.models;
}

async function removeModel(m) {
  try {
    await ElMessageBox.confirm(t('settings.llmRemoveConfirm', { name: m.name }), {
      type: 'warning',
    });
  } catch {
    return;
  }
  const res = await rpc('llm.remove', { id: m.id });
  models.value = res.models;
}

onMounted(() => {
  loadInfo();
  loadModels();
});
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

    <section class="panel llm">
      <div class="panel__head">
        <span class="panel__title">{{ t('settings.llmTitle') }}</span>
        <el-button type="primary" size="small" @click="openAdd">{{ t('settings.llmAdd') }}</el-button>
      </div>
      <p class="note">{{ t('settings.llmSummary') }}</p>

      <p v-if="models.length === 0" class="mono-dim empty">{{ t('settings.llmEmpty') }}</p>

      <ul v-else class="models">
        <li v-for="m in models" :key="m.id" class="model">
          <div class="model__main">
            <span class="model__name">{{ m.name }}</span>
            <span class="badge" :class="m.kind === 'local' ? 'badge--local' : 'badge--remote'">
              {{ m.kind === 'local' ? t('settings.llmLocal') : t('settings.llmRemote') }}
            </span>
            <span v-if="m.isDefault" class="badge badge--default">{{ t('settings.llmDefault') }}</span>
          </div>
          <div class="model__meta mono-dim">
            <span>{{ providerLabel(m.provider) }}</span>
            <span class="model__url">{{ m.baseUrl }}</span>
            <span>{{ m.model }}</span>
            <span
              v-if="m.hasApiKey"
              class="model__key"
              :title="t('settings.llmKeySet')"
            >🔑</span>
            <span v-else class="model__key model__key--none" :title="t('settings.llmKeyNone')">—</span>
          </div>
          <div class="model__actions">
            <el-button v-if="!m.isDefault" size="small" text @click="setDefault(m)">
              {{ t('settings.llmSetDefault') }}
            </el-button>
            <el-button size="small" text @click="openEdit(m)">{{ t('common.edit') }}</el-button>
            <el-button size="small" text type="danger" @click="removeModel(m)">
              {{ t('common.delete') }}
            </el-button>
          </div>
        </li>
      </ul>
    </section>

    <el-dialog
      v-model="dialogVisible"
      :title="editingId ? t('settings.llmEdit') : t('settings.llmAdd')"
      width="520px"
    >
      <el-form :model="form" label-width="92px">
        <el-form-item :label="t('settings.llmName')">
          <el-input v-model="form.name" :placeholder="t('settings.llmNamePlaceholder')" />
        </el-form-item>
        <el-form-item :label="t('settings.llmProvider')">
          <el-select v-model="form.provider" @change="onProviderChange">
            <el-option
              v-for="(preset, key) in PROVIDERS"
              :key="key"
              :label="providerLabel(key)"
              :value="key"
            />
          </el-select>
        </el-form-item>
        <el-form-item :label="t('settings.llmKind')">
          <el-radio-group v-model="form.kind">
            <el-radio value="local">{{ t('settings.llmLocal') }}</el-radio>
            <el-radio value="remote">{{ t('settings.llmRemote') }}</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item :label="t('settings.llmBaseUrl')">
          <el-input v-model="form.baseUrl" :placeholder="t('settings.llmBaseUrlPlaceholder')" />
        </el-form-item>
        <el-form-item :label="t('settings.llmModel')">
          <el-input v-model="form.model" :placeholder="t('settings.llmModelPlaceholder')" />
        </el-form-item>
        <el-form-item :label="t('settings.llmApiKey')">
          <el-input
            v-model="form.apiKey"
            type="password"
            show-password
            :placeholder="t('settings.llmApiKeyPlaceholder')"
          />
        </el-form-item>
        <el-form-item :label="t('settings.llmSetDefault')">
          <el-switch v-model="form.isDefault" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="saving" @click="saveModel">{{ t('common.save') }}</el-button>
      </template>
    </el-dialog>
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

.empty {
  margin: 0;
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

/* LLM 模型列表 */
.models {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 10px;
}

.model {
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-areas:
    'main actions'
    'meta actions';
  align-items: center;
  gap: 4px 12px;
  padding: 12px 14px;
  background: var(--ink-700);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
}

.model__main {
  grid-area: main;
  display: flex;
  align-items: center;
  gap: 8px;
}

.model__name {
  font-weight: 600;
  color: var(--text-strong);
}

.model__meta {
  grid-area: meta;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  font-size: 12px;
}

.model__url {
  font-family: var(--mono);
}

.model__key {
  font-size: 13px;
}

.model__key--none {
  opacity: 0.5;
}

.model__actions {
  grid-area: actions;
  display: flex;
  gap: 4px;
}

.badge {
  font-size: 11px;
  line-height: 1;
  padding: 3px 7px;
  border-radius: 999px;
  border: 1px solid var(--line-soft);
  color: var(--text-dim);
  white-space: nowrap;
}

.badge--local {
  border-color: #2f6f4f;
  color: #6ee7a8;
}

.badge--remote {
  border-color: #3b5b8c;
  color: #8fb6ff;
}

.badge--default {
  border-color: var(--accent);
  color: var(--accent);
}
</style>
