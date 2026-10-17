<script setup>
import { computed, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useAppStore } from '../stores/app';

const store = useAppStore();

const DB_TYPES = [
  { value: 'sqlite', label: 'SQLite' },
  { value: 'postgres', label: 'PostgreSQL' },
  { value: 'mysql', label: 'MySQL' },
];

const form = reactive({
  name: 'app',
  type: 'sqlite',
  path: '',
  host: '127.0.0.1',
  port: 5432,
  dbname: '',
  user: '',
  password: '',
  schema: '',
  isDefault: true,
  projectDir: 'projects/app',
  appName: 'MCP Builder',
});

const isSqlite = computed(() => form.type === 'sqlite');

/** 只提交当前类型真正需要的字段，避免把空字符串写进 dev.yml */
function buildConnection() {
  const connection = { type: form.type };
  if (isSqlite.value) {
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

const isSubmitting = ref(false);

async function connect() {
  const connection = buildConnection();
  if (isSqlite.value && !connection.path) {
    ElMessage.warning('SQLite 需要填写数据库文件路径');
    return;
  }
  if (!isSqlite.value && !connection.dbname) {
    ElMessage.warning('请填写数据库名');
    return;
  }

  isSubmitting.value = true;
  try {
    await store.startGraphJin({
      projectDir: form.projectDir,
      appName: form.appName,
      databases: { [form.name]: connection },
    });
    ElMessage.success(`已启动，发现 ${store.tables.length} 张表`);
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    isSubmitting.value = false;
  }
}

async function test() {
  await store.refreshStatus();
  ElMessage[store.isRunning ? 'success' : 'warning'](
    store.isRunning ? `服务运行中：${store.baseUrl}` : '服务未运行，请先连接'
  );
}

const summary = computed(() => ({
  project: store.status?.projectDir ?? '—',
  databases: store.databaseNames,
  tables: store.tables.length,
}));
</script>

<template>
  <div class="duo">
    <section class="panel">
      <div class="panel__head">
        <span class="panel__title">新建连接</span>
        <span class="eyebrow">{{ form.type }}</span>
      </div>
      <div class="panel__body">
        <el-form label-position="top" size="small">
          <div class="pair">
            <el-form-item label="连接名">
              <el-input v-model="form.name" placeholder="app" />
            </el-form-item>
            <el-form-item label="类型">
              <el-select v-model="form.type">
                <el-option v-for="t in DB_TYPES" :key="t.value" :label="t.label" :value="t.value" />
              </el-select>
            </el-form-item>
          </div>

          <el-form-item v-if="isSqlite" label="数据库文件">
            <el-input v-model="form.path" placeholder="D:/data/app.db 或相对路径 app.db" />
          </el-form-item>

          <template v-else>
            <div class="pair">
              <el-form-item label="主机">
                <el-input v-model="form.host" />
              </el-form-item>
              <el-form-item label="端口">
                <el-input-number v-model="form.port" :min="1" :max="65535" controls-position="right" />
              </el-form-item>
            </div>
            <div class="pair">
              <el-form-item label="数据库名">
                <el-input v-model="form.dbname" />
              </el-form-item>
              <el-form-item label="Schema">
                <el-input v-model="form.schema" placeholder="可留空" />
              </el-form-item>
            </div>
            <div class="pair">
              <el-form-item label="用户">
                <el-input v-model="form.user" />
              </el-form-item>
              <el-form-item label="密码">
                <el-input v-model="form.password" type="password" show-password />
              </el-form-item>
            </div>
          </template>

          <div class="pair">
            <el-form-item label="项目目录">
              <el-input v-model="form.projectDir" placeholder="projects/app" />
            </el-form-item>
            <el-form-item label="应用名">
              <el-input v-model="form.appName" />
            </el-form-item>
          </div>

          <el-checkbox v-model="form.isDefault" label="设为默认库" />

          <div class="row">
            <el-button type="primary" :loading="isSubmitting" @click="connect">连接并启动</el-button>
            <el-button @click="test">测试连通性</el-button>
          </div>
        </el-form>
      </div>
    </section>

    <section class="panel">
      <div class="panel__head">
        <span class="panel__title">当前连接</span>
        <span class="pill" :class="store.isRunning ? 'pill--on' : 'pill--idle'">
          <span class="dot" />{{ store.isRunning ? '已连接' : '空闲' }}
        </span>
      </div>
      <div class="panel__body">
        <dl class="dl">
          <dt>项目目录</dt>
          <dd>{{ summary.project }}</dd>
          <dt>库</dt>
          <dd>{{ summary.databases.length ? summary.databases.join(', ') : '—' }}</dd>
          <dt>已发现表</dt>
          <dd>{{ summary.tables }}</dd>
        </dl>
        <p class="mono-dim note">
          连接信息写入项目目录的 <code>dev.yml</code>，采用方案 B 的
          <code>databases</code> 写法（不使用 <code>sources</code>），
          这样才能启用 <code>roles[].tables</code> 的四项操作开关。
        </p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.duo {
  display: grid;
  grid-template-columns: minmax(420px, 1.15fr) minmax(300px, 0.85fr);
  gap: var(--gutter);
  align-items: start;
}

.pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.row {
  display: flex;
  gap: 10px;
  margin-top: 6px;
}

.dl {
  display: grid;
  grid-template-columns: 92px 1fr;
  gap: 8px 12px;
  margin: 0;
  font-size: 12px;
}

.dl dt {
  color: var(--text-faint);
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  padding-top: 2px;
}

.dl dd {
  margin: 0;
  color: var(--text);
  word-break: break-all;
}

.note {
  margin: 16px 0 0;
  font-size: 11px;
}

code {
  color: var(--amber);
}

:deep(.el-form-item) {
  margin-bottom: 12px;
}
</style>
