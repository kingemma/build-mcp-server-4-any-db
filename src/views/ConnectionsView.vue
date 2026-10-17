<script setup>
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useAppStore } from '../stores/app';

const store = useAppStore();

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
  appName: 'MCP Builder',
});

const isTesting = ref(false);
const isSubmitting = ref(false);
const isTemplateOpen = ref(false);
/** 正在用哪条已保存连接启动，用于按钮 loading */
const startingId = ref(0);
const template = reactive({ id: '', label: '', wireType: '', defaultPort: null, note: '' });

const selected = computed(() => store.dbTypes.find((item) => item.id === form.typeId) ?? null);
const wireType = computed(() => selected.value?.wireType ?? '');
const isFileBased = computed(() => form.mode === 'path');
const isDsn = computed(() => form.mode === 'dsn');

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
  if (!wireType.value) return '请选择数据库类型';
  if (isDsn.value && !form.connectionString) return '连接串不能为空';
  if (isFileBased.value && !form.path) return '文件路径不能为空';
  if (!isDsn.value && !isFileBased.value && !form.dbname) return '请填写数据库名';
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
      result.message || (result.ok ? '连接可用' : '连接失败')
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
    ElMessage.success(`已启动，发现 ${store.tables.length} 张表`);
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
    ElMessage.success(`模板 ${template.label} 已保存`);
  } catch (error) {
    ElMessage.error(error.message);
  }
}

async function dropTemplate(id) {
  await store.removeDbTemplate(id);
  if (form.typeId === id) form.typeId = store.dbTypes[0]?.id ?? '';
  ElMessage.success('模板已删除');
}

/** 已保存连接的「目标」摘要 */
function targetOf(row) {
  if (row.mode === 'dsn') return '连接串';
  if (row.mode === 'path') return row.path || '—';
  const host = row.host || '—';
  const port = row.port ? `:${row.port}` : '';
  return `${host}${port}${row.dbname ? `/${row.dbname}` : ''}`;
}

function statusLabel(row) {
  if (!row.readable) return '需重新录入';
  return row.status === 'connected' ? '已连接' : '已测试';
}

function formatTime(value) {
  if (!value) return '—';
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
      ElMessage.warning('这条连接不存在');
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
      ElMessage.success(`已填入 ${detail.name}`);
      return;
    }
    ElMessage.warning('这条记录无法解密，已回填非敏感字段，请重新填写密码或连接串');
  } catch (error) {
    ElMessage.error(error.message);
  }
}

async function activate(row) {
  if (!row.readable) {
    ElMessage.warning('这条连接无法解密，请重新填写并测试一次');
    return;
  }
  startingId.value = row.id;
  try {
    const connection = await store.startFromSavedConnection(row.id);
    ElMessage.success(`已用 ${connection.name} 启动，发现 ${store.tables.length} 张表`);
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    startingId.value = 0;
  }
}

async function dropConnection(row) {
  try {
    await ElMessageBox.confirm(`删除连接 ${row.name}？`, '确认删除', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await store.removeConnection(row.id);
    ElMessage.success('已删除');
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
        <span class="panel__title">新建连接</span>
        <span class="eyebrow">{{ wireType || '未选择' }}</span>
      </div>
      <div class="panel__body">
        <el-form label-position="top" size="small">
          <div class="pair">
            <el-form-item label="连接名">
              <el-input v-model="form.name" placeholder="app" />
            </el-form-item>
            <el-form-item label="类型">
              <el-select v-model="form.typeId" filterable>
                <el-option-group label="内置">
                  <el-option
                    v-for="item in store.builtInTypes"
                    :key="item.id"
                    :label="item.label"
                    :value="item.id"
                  />
                </el-option-group>
                <el-option-group v-if="store.customTemplates.length" label="自定义模板">
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

          <p v-if="selected?.note" class="note">{{ selected.note }}</p>
          <p v-if="selected && selected.driverVerified === false" class="note note--warn">
            该类型在配置白名单内，但连接层实测报 unsupported database type，驱动可能未实现。
          </p>

          <el-form-item label="录入方式">
            <el-radio-group v-model="form.mode">
              <el-radio value="path">文件路径</el-radio>
              <el-radio value="fields">连接字段</el-radio>
              <el-radio value="dsn">连接串</el-radio>
            </el-radio-group>
          </el-form-item>

          <el-form-item v-if="isFileBased" label="数据库文件">
            <el-input v-model="form.path" placeholder="D:/data/app.db 或相对路径 app.db" />
          </el-form-item>

          <el-form-item v-else-if="isDsn" label="连接串">
            <el-input
              v-model="form.connectionString"
              :placeholder="selected?.dsnExample || 'postgres://user:pass@host:5432/db'"
            />
          </el-form-item>

          <template v-else>
            <div class="pair">
              <el-form-item label="主机">
                <el-input v-model="form.host" />
              </el-form-item>
              <el-form-item label="端口">
                <el-input-number
                  v-model="form.port"
                  :min="1"
                  :max="65535"
                  controls-position="right"
                />
              </el-form-item>
            </div>
            <el-form-item label="数据库名">
              <el-input v-model="form.dbname" />
            </el-form-item>
            <div class="pair">
              <el-form-item label="用户">
                <el-input v-model="form.user" />
              </el-form-item>
              <el-form-item label="密码">
                <el-input v-model="form.password" type="password" show-password />
              </el-form-item>
            </div>
            <el-form-item label="Schema（可选）">
              <el-input v-model="form.schema" />
            </el-form-item>
          </template>

          <div class="pair">
            <el-form-item label="项目目录">
              <el-input v-model="form.projectDir" placeholder="projects/app" />
            </el-form-item>
            <el-form-item label="应用名">
              <el-input v-model="form.appName" />
            </el-form-item>
          </div>

          <el-checkbox v-model="form.isDefault">设为默认库</el-checkbox>

          <div class="row">
            <el-button :loading="isTesting" @click="test">测试连接</el-button>
            <el-button type="primary" :loading="isSubmitting" @click="connect">启动</el-button>
            <el-button text @click="openTemplate">存为模板</el-button>
          </div>
        </el-form>
      </div>
    </section>

    <section class="panel">
      <div class="panel__head">
        <span class="panel__title">已保存的模板</span>
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
              删除
            </el-button>
          </li>
        </ul>
        <p v-else class="mono-dim note">
          还没有自定义模板。TiDB / CockroachDB 这类兼容库不能写自己的类型名，
          只能以 postgres / mysql 协议接入，用模板把这个映射固化下来。
        </p>

        <div class="facts">
          <div class="fact">
            <span class="eyebrow">项目目录</span>
            <span class="fact__value fact__value--path">{{ summary.project }}</span>
          </div>
          <div class="fact">
            <span class="eyebrow">已连接库</span>
            <span class="fact__value">{{ summary.databases.join(', ') || '—' }}</span>
          </div>
          <div class="fact">
            <span class="eyebrow">已发现表</span>
            <span class="fact__value">{{ summary.tables }}</span>
          </div>
        </div>
      </div>
    </section>
    </div>

    <section class="panel">
      <div class="panel__head">
        <span class="panel__title">已保存的连接</span>
        <div class="head-actions">
          <span class="eyebrow">{{ store.connections.length }} 条</span>
          <el-button size="small" @click="store.loadConnections">刷新</el-button>
        </div>
      </div>
      <div class="panel__body panel__body--flush">
        <table v-if="store.connections.length" class="conns">
          <thead>
            <tr>
              <th>连接名</th>
              <th>类型</th>
              <th>目标</th>
              <th>状态</th>
              <th>项目目录</th>
              <th>更新时间</th>
              <th>操作</th>
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
                <el-button size="small" text @click="fillForm(row)">填入表单</el-button>
                <el-button
                  size="small"
                  text
                  type="primary"
                  :loading="startingId === row.id"
                  :disabled="!row.readable"
                  @click="activate(row)"
                >
                  启动
                </el-button>
                <el-button size="small" text type="danger" @click="dropConnection(row)">
                  删除
                </el-button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="mono-dim note conns__empty">
          还没有保存的连接。测试通过或启动成功后会自动记录在这里。
        </p>
      </div>
    </section>

    <el-dialog v-model="isTemplateOpen" title="保存为连接模板" width="480">
      <el-form label-position="top" size="small">
        <el-form-item label="标识（英文，作为下拉的 value）">
          <el-input v-model="template.id" placeholder="tidb" />
        </el-form-item>
        <el-form-item label="显示名">
          <el-input v-model="template.label" placeholder="TiDB" />
        </el-form-item>
        <el-form-item label="实际协议（必须在白名单内）">
          <el-select v-model="template.wireType" filterable>
            <el-option v-for="type in store.builtInTypes" :key="type.id" :label="type.wireType" :value="type.wireType" />
          </el-select>
        </el-form-item>
        <el-form-item label="默认端口">
          <el-input-number v-model="template.defaultPort" :min="1" :max="65535" controls-position="right" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="template.note" placeholder="TiDB 走 MySQL 协议" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="isTemplateOpen = false">取消</el-button>
        <el-button type="primary" @click="saveTemplate">保存</el-button>
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
  gap: 8px;
  margin-top: 12px;
}

.note {
  margin: 0 0 10px;
  font-size: 11px;
  line-height: 1.7;
  color: var(--text-faint);
}

.note--warn {
  color: var(--amber);
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
  padding: 8px 0;
  border-bottom: 1px solid var(--line-soft);
}

.templates__label {
  font-size: 12.5px;
  color: var(--text);
}

.templates__meta {
  font-size: 11px;
}

.facts {
  display: grid;
  gap: 10px;
}

.fact {
  display: grid;
  gap: 2px;
}

.fact__value {
  font-family: var(--mono);
  font-size: 12px;
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
  padding: 9px 14px;
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-dim);
  text-align: left;
  border-bottom: 1px solid var(--line);
  background: var(--ink-700);
}

.conns td {
  padding: 8px 14px;
  font-size: 12px;
  border-bottom: 1px solid var(--line-soft);
}

.conns tbody tr:hover td {
  background: rgba(217, 162, 75, 0.05);
}

.conns__name {
  font-family: var(--mono);
  color: var(--text);
}

.conns__target,
.conns__path {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conns__path {
  font-size: 11px;
}

.conns__actions {
  white-space: nowrap;
  text-align: right;
}

.conns__empty {
  margin: 0;
  padding: 16px;
}
</style>
