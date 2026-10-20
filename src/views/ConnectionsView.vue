<script setup>
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useI18n } from 'vue-i18n';
import { useAppStore } from '../stores/app';

const store = useAppStore();
const { t, te } = useI18n();

const form = reactive({
  name: 'app',
  typeId: 'sqlite',
  mode: 'path',
  path: '',
  host: '127.0.0.1',
  port: 5432,
  dbname: '',
  user: '',
  password: '',
  schema: '',
  connectionString: '',
  isDefault: true,
  projectDir: 'projects/app',
  appName: 'MCP Server Build',
});

const isTesting = ref(false);
const isSubmitting = ref(false);
const isTemplateOpen = ref(false);
/** 正在用哪条已保存连接启动，用于按钮 loading */
const startingId = ref(0);
const template = reactive({ id: '', label: '', wireType: '', defaultPort: null, note: '' });

const selected = computed(() => store.dbTypes.find((item) => item.id === form.typeId) ?? null);
const wireType = computed(() => selected.value?.wireType ?? '');
/** 白名单通过但连接层没实现的类型：直接禁用测试/启动，避免用户以为是自己填错了 */
const selectedUnverified = computed(() => selected.value?.driverVerified === false);
const isFileBased = computed(() => form.mode === 'path');
const isDsn = computed(() => form.mode === 'dsn');

/** 类型提示来自后端（中文），内置类型按 id 用前端文案覆盖 */
const selectedNote = computed(() => {
  const item = selected.value;
  if (!item) return '';
  if (item.custom) return t('connections.customTemplateNote', { wireType: item.wireType });
  const key = `connections.dbNotes.${item.id}`;
  return te(key) ? t(key) : (item.note ?? '');
});

/** 切换类型时带上它的默认端口，省掉一次手填 */
watch(selected, (item) => {
  if (!item) return;
  form.mode = item.mode ?? 'fields';
  if (item.defaultPort) form.port = item.defaultPort;
});

onMounted(async () => {
  await store.loadDbTypes();
  if (!selected.value && store.dbTypes.length > 0) form.typeId = store.dbTypes[0].id;
  await store.loadConnections();
});

/** 只提交当前模式真正用到的字段，避免把空值写进 dev.yml */
function buildConnection() {
  const connection = { type: wireType.value };
  if (isDsn.value) {
    connection.connection_string = form.connectionString;
  } else if (isFileBased.value) {
    connection.path = form.path;
  } else {
    connection.host = form.host;
    connection.port = Number(form.port);
    connection.dbname = form.dbname;
    connection.user = form.user;
    if (form.password) connection.password = form.password;
    if (form.schema) connection.schema = form.schema;
  }
  if (form.isDefault) connection.default = true;
  return connection;
}

function validate() {
  if (!wireType.value) return t('connections.validate.typeRequired');
  if (isDsn.value && !form.connectionString) return t('connections.validate.dsnRequired');
  if (isFileBased.value && !form.path) return t('connections.validate.pathRequired');
  if (!isDsn.value && !isFileBased.value && !form.dbname) return t('connections.validate.dbnameRequired');
  return null;
}

async function test() {
  const problem = validate();
  if (problem) {
    ElMessage.warning(problem);
    return;
  }
  isTesting.value = true;
  try {
    const result = await store.testConnection(form.name, buildConnection(), {
      projectDir: form.projectDir,
      appName: form.appName,
    });
    ElMessage[result.ok ? 'success' : 'warning'](
      result.message ||
        (result.ok ? t('connections.messages.usable') : t('connections.messages.failed'))
    );
    // 后端在测试通过时已落盘，这里只把列表拉回来
    if (result.ok) await store.loadConnections();
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    isTesting.value = false;
  }
}

async function connect() {
  const problem = validate();
  if (problem) {
    ElMessage.warning(problem);
    return;
  }
  isSubmitting.value = true;
  try {
    await store.startGraphJin({
      projectDir: form.projectDir,
      appName: form.appName,
      databases: { [form.name]: buildConnection() },
    });
    ElMessage.success(t('connections.messages.started', { count: store.tables.length }));
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    isSubmitting.value = false;
  }
}

function openTemplate() {
  template.id = '';
  template.label = '';
  template.wireType = wireType.value;
  template.defaultPort = selected.value?.defaultPort ?? null;
  template.note = '';
  isTemplateOpen.value = true;
}

async function saveTemplate() {
  try {
    await store.addDbTemplate({ ...template, mode: form.mode });
    isTemplateOpen.value = false;
    ElMessage.success(t('connections.messages.templateSaved', { label: template.label }));
  } catch (error) {
    ElMessage.error(error.message);
  }
}

async function dropTemplate(id) {
  await store.removeDbTemplate(id);
  if (form.typeId === id) form.typeId = store.dbTypes[0]?.id ?? '';
  ElMessage.success(t('connections.messages.templateRemoved'));
}

/** 已保存连接的「目标」摘要 */
function targetOf(row) {
  if (row.mode === 'dsn') return t('connections.table.targetDsn');
  if (row.mode === 'path') return row.path || t('common.dash');
  const host = row.host || t('common.dash');
  const port = row.port ? `:${row.port}` : '';
  return `${host}${port}${row.dbname ? `/${row.dbname}` : ''}`;
}

function statusLabel(row) {
  if (!row.readable) return t('connections.status.unreadable');
  return row.status === 'connected'
    ? t('connections.status.connected')
    : t('connections.status.verified');
}

function formatTime(value) {
  if (!value) return t('common.dash');
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** wire type 反查下拉里的类型；自定义别名模板回落到同协议的模板 */
function resolveTypeId(wireType) {
  const exact = store.dbTypes.find((item) => item.id === wireType);
  if (exact) return exact.id;
  return store.dbTypes.find((item) => item.wireType === wireType)?.id ?? wireType;
}

async function fillForm(row) {
  try {
    const detail = await store.fetchConnection(row.id);
    if (!detail) {
      ElMessage.warning(t('connections.messages.missing'));
      return;
    }
    form.typeId = resolveTypeId(detail.wireType);
    // 切类型会触发 watch 覆盖 mode / port，等它跑完再回填其余字段
    await nextTick();
    form.name = detail.name;
    form.projectDir = detail.projectDir;
    form.appName = detail.appName;
    form.mode = detail.mode;
    form.isDefault = detail.isDefault;
    form.path = detail.path ?? '';
    form.host = detail.host || '127.0.0.1';
    form.port = detail.port || selected.value?.defaultPort || 5432;
    form.dbname = detail.dbname ?? '';
    form.user = detail.user ?? '';
    form.schema = detail.schema ?? '';
    form.password = '';
    form.connectionString = '';

    // 摘要字段是明文列，payload 解不开时也能回填目标；敏感字段只能重填
    if (detail.config) {
      form.password = detail.config.password ?? '';
      form.connectionString = detail.config.connection_string ?? '';
      ElMessage.success(t('connections.messages.filled', { name: detail.name }));
      return;
    }
    ElMessage.warning(t('connections.messages.secretLost'));
  } catch (error) {
    ElMessage.error(error.message);
  }
}

async function activate(row) {
  if (!row.readable) {
    ElMessage.warning(t('connections.messages.secretLost'));
    return;
  }
  startingId.value = row.id;
  try {
    const connection = await store.startFromSavedConnection(row.id);
    ElMessage.success(t('connections.messages.startedFrom', { name: connection.name }));
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    startingId.value = 0;
  }
}

async function dropConnection(row) {
  try {
    await ElMessageBox.confirm(
      t('connections.deleteConfirm.message', { name: row.name }),
      t('connections.deleteConfirm.title'),
      { type: 'warning' }
    );
  } catch {
    return;
  }
  try {
    await store.removeConnection(row.id);
    ElMessage.success(t('connections.messages.removed'));
  } catch (error) {
    ElMessage.error(error.message);
  }
}

const summary = computed(() => ({
  project: store.status?.projectDir ?? '—',
  databases: store.databaseNames,
  tables: store.tables.length,
}));
</script>

<template>
  <div class="stack">
    <div class="duo">
    <section class="panel">
      <div class="panel__head">
        <span class="panel__title">{{ t('connections.newConnection') }}</span>
        <span class="eyebrow">{{ wireType || t('common.notSelected') }}</span>
      </div>
      <div class="panel__body">
        <el-form label-position="top" size="small">
          <div class="pair">
            <el-form-item :label="t('connections.form.name')">
              <el-input v-model="form.name" :placeholder="t('connections.form.namePlaceholder')" />
            </el-form-item>
            <el-form-item :label="t('connections.form.type')">
              <el-select v-model="form.typeId" filterable>
                <el-option-group :label="t('connections.form.groupBuiltIn')">
                  <el-option
                    v-for="item in store.builtInTypes"
                    :key="item.id"
                    :label="item.driverVerified === false ? `${item.label} · ${t('connections.form.unverifiedTag')}` : item.label"
                    :value="item.id"
                  />
                </el-option-group>
                <el-option-group
                  v-if="store.customTemplates.length"
                  :label="t('connections.form.groupCustom')"
                >
                  <el-option
                    v-for="item in store.customTemplates"
                    :key="item.id"
                    :label="`${item.label} → ${item.wireType}`"
                    :value="item.id"
                  />
                </el-option-group>
              </el-select>
            </el-form-item>
          </div>

          <p v-if="selectedNote" class="note">{{ selectedNote }}</p>
          <p v-if="selected && selected.driverVerified === false" class="note note--warn">
            {{ t('connections.form.driverUnverified') }}
          </p>
          <el-form-item :label="t('connections.form.inputMode')">
            <el-radio-group v-model="form.mode">
              <el-radio value="path">{{ t('connections.form.modePath') }}</el-radio>
              <el-radio value="fields">{{ t('connections.form.modeFields') }}</el-radio>
              <el-radio value="dsn">{{ t('connections.form.modeDsn') }}</el-radio>
            </el-radio-group>
          </el-form-item>

          <el-form-item v-if="isFileBased" :label="t('connections.form.dbFile')">
            <el-input
              v-model="form.path"
              :placeholder="t('connections.form.dbFilePlaceholder')"
            />
          </el-form-item>

          <el-form-item v-else-if="isDsn" :label="t('connections.form.dsn')">
            <el-input
              v-model="form.connectionString"
              :placeholder="selected?.dsnExample || 'postgres://user:pass@host:5432/db'"
            />
          </el-form-item>

          <template v-else>
            <div class="pair">
              <el-form-item :label="t('connections.form.host')">
                <el-input v-model="form.host" />
              </el-form-item>
              <el-form-item :label="t('connections.form.port')">
                <el-input-number
                  v-model="form.port"
                  :min="1"
                  :max="65535"
                  controls-position="right"
                />
              </el-form-item>
            </div>
            <el-form-item :label="t('connections.form.dbname')">
              <el-input v-model="form.dbname" />
            </el-form-item>
            <div class="pair">
              <el-form-item :label="t('connections.form.user')">
                <el-input v-model="form.user" />
              </el-form-item>
              <el-form-item :label="t('connections.form.password')">
                <el-input v-model="form.password" type="password" show-password />
              </el-form-item>
            </div>
            <el-form-item :label="t('connections.form.schemaOptional')">
              <el-input v-model="form.schema" />
            </el-form-item>
          </template>

          <div class="pair">
            <el-form-item :label="t('connections.form.projectDir')">
              <el-input
                v-model="form.projectDir"
                :placeholder="t('connections.form.projectDirPlaceholder')"
              />
            </el-form-item>
            <el-form-item :label="t('connections.form.appName')">
              <el-input v-model="form.appName" />
            </el-form-item>
          </div>

          <el-checkbox v-model="form.isDefault">{{ t('connections.form.setDefault') }}</el-checkbox>

          <div class="row">
            <el-button :loading="isTesting" :disabled="selectedUnverified" @click="test">
              {{ t('connections.actions.test') }}
            </el-button>
            <el-button
              type="primary"
              :loading="isSubmitting"
              :disabled="selectedUnverified"
              @click="connect"
            >
              {{ t('connections.actions.start') }}
            </el-button>
            <el-button text @click="openTemplate">
              {{ t('connections.actions.saveTemplate') }}
            </el-button>
          </div>
        </el-form>
      </div>
    </section>

    <section class="panel">
      <div class="panel__head">
        <span class="panel__title">{{ t('connections.templates') }}</span>
        <span class="pill pill--idle">{{ store.customTemplates.length }}</span>
      </div>
      <div class="panel__body">
        <ul v-if="store.customTemplates.length" class="templates">
          <li v-for="item in store.customTemplates" :key="item.id">
            <div>
              <div class="templates__label">{{ item.label }}</div>
              <div class="templates__meta mono-dim">{{ item.id }} → {{ item.wireType }}</div>
            </div>
            <el-button size="small" text type="danger" @click="dropTemplate(item.id)">
              {{ t('common.delete') }}
            </el-button>
          </li>
        </ul>
        <p v-else class="mono-dim note">{{ t('connections.templateEmpty') }}</p>

        <div class="facts">
          <div class="fact">
            <span class="eyebrow">{{ t('connections.facts.projectDir') }}</span>
            <span class="fact__value fact__value--path">{{ summary.project }}</span>
          </div>
          <div class="fact">
            <span class="eyebrow">{{ t('connections.facts.connectedDatabases') }}</span>
            <span class="fact__value">
              {{ summary.databases.join(', ') || t('common.dash') }}
            </span>
          </div>
          <div class="fact">
            <span class="eyebrow">{{ t('connections.facts.discoveredTables') }}</span>
            <span class="fact__value">{{ summary.tables }}</span>
          </div>
        </div>
      </div>
    </section>
    </div>

    <section class="panel">
      <div class="panel__head">
        <span class="panel__title">{{ t('connections.saved') }}</span>
        <div class="head-actions">
          <span class="eyebrow">
            {{ t('connections.savedCount', { count: store.connections.length }) }}
          </span>
          <el-button size="small" @click="store.loadConnections">
            {{ t('common.refresh') }}
          </el-button>
        </div>
      </div>
      <div class="panel__body panel__body--flush">
        <table v-if="store.connections.length" class="conns">
          <thead>
            <tr>
              <th>{{ t('connections.table.name') }}</th>
              <th>{{ t('connections.table.type') }}</th>
              <th>{{ t('connections.table.target') }}</th>
              <th>{{ t('connections.table.status') }}</th>
              <th>{{ t('connections.table.projectDir') }}</th>
              <th>{{ t('connections.table.updatedAt') }}</th>
              <th>{{ t('connections.table.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in store.connections" :key="row.id">
              <td class="conns__name">{{ row.name }}</td>
              <td class="mono-dim">{{ row.wireType }}</td>
              <td class="mono-dim conns__target">{{ targetOf(row) }}</td>
              <td>
                <span
                  class="pill"
                  :class="row.readable ? (row.status === 'connected' ? 'pill--on' : 'pill--idle') : 'pill--warn'"
                >
                  <span class="dot" />{{ statusLabel(row) }}
                </span>
              </td>
              <td class="mono-dim conns__path">{{ row.projectDir }}</td>
              <td class="mono-dim">{{ formatTime(row.updatedAt) }}</td>
              <td class="conns__actions">
                <el-button size="small" text @click="fillForm(row)">
                  {{ t('connections.actions.fillForm') }}
                </el-button>
                <el-button
                  size="small"
                  text
                  type="primary"
                  :loading="startingId === row.id"
                  :disabled="!row.readable"
                  @click="activate(row)"
                >
                  {{ t('connections.actions.start') }}
                </el-button>
                <el-button size="small" text type="danger" @click="dropConnection(row)">
                  {{ t('common.delete') }}
                </el-button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="mono-dim note conns__empty">{{ t('connections.table.empty') }}</p>
      </div>
    </section>

    <el-dialog v-model="isTemplateOpen" :title="t('connections.dialog.title')" width="480">
      <el-form label-position="top" size="small">
        <el-form-item :label="t('connections.dialog.id')">
          <el-input v-model="template.id" :placeholder="t('connections.dialog.idPlaceholder')" />
        </el-form-item>
        <el-form-item :label="t('connections.dialog.label')">
          <el-input
            v-model="template.label"
            :placeholder="t('connections.dialog.labelPlaceholder')"
          />
        </el-form-item>
        <el-form-item :label="t('connections.dialog.wireType')">
          <el-select v-model="template.wireType" filterable>
            <el-option v-for="type in store.builtInTypes" :key="type.id" :label="type.wireType" :value="type.wireType" />
          </el-select>
        </el-form-item>
        <el-form-item :label="t('connections.dialog.defaultPort')">
          <el-input-number v-model="template.defaultPort" :min="1" :max="65535" controls-position="right" />
        </el-form-item>
        <el-form-item :label="t('connections.dialog.note')">
          <el-input
            v-model="template.note"
            :placeholder="t('connections.dialog.notePlaceholder')"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="isTemplateOpen = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" @click="saveTemplate">{{ t('common.save') }}</el-button>
      </template>
    </el-dialog>
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
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
}

@media (max-width: 1100px) {
  .duo {
    grid-template-columns: minmax(0, 1fr);
  }
}

.pair {
  display: grid;
  gap: 12px;
  grid-template-columns: 1fr 1fr;
}

.row {
  display: flex;
  gap: 10px;
  margin-top: 14px;
}

.note {
  margin: 0 0 12px;
  font-size: var(--fs-note);
  line-height: 1.7;
  color: var(--text-dim);
}

.note--warn {
  color: var(--accent-strong);
}

.templates {
  margin: 0 0 16px;
  padding: 0;
  list-style: none;
}

.templates li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--line-soft);
}

.templates__label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
}

.templates__meta {
  font-size: var(--fs-note);
}

.facts {
  display: grid;
  gap: 12px;
}

.fact {
  display: grid;
  gap: 3px;
}

.fact__value {
  font-family: var(--mono);
  font-size: 13px;
  color: var(--text);
}

.fact__value--path {
  word-break: break-all;
}

.head-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.conns {
  width: 100%;
  border-collapse: collapse;
}

.conns th {
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

.conns td {
  padding: 10px 16px;
  font-size: 13px;
  border-bottom: 1px solid var(--line-soft);
}

.conns tbody tr:hover td {
  background: #f2f7ff;
}

.conns__name {
  font-family: var(--mono);
  color: var(--text);
  font-weight: 500;
}

.conns__target,
.conns__path {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conns__path {
  font-size: var(--fs-micro);
}

.conns__actions {
  white-space: nowrap;
  text-align: right;
}

.conns__empty {
  margin: 0;
  padding: 18px;
}
</style>
