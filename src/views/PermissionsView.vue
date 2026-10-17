<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useAppStore, OPERATIONS, OPERATION_LABELS } from '../stores/app';

const store = useAppStore();

const newRole = ref('');
const selectedDatabase = ref('');
const isEditorOpen = ref(false);
const isConfirmOpen = ref(false);
const editing = reactive({
  role: '',
  table: '',
  operation: 'query',
  filters: '',
  columnMode: 'allow',
  columns: [],
  limit: null,
});
const lastSummary = ref(null);

const UNRESTRICTED = 'none';

const columnsOf = (table) => store.columnsByTable[table] ?? [];

watch(
  () => store.databaseNames,
  (names) => {
    if (!selectedDatabase.value && names.length) selectedDatabase.value = names[0];
  },
  { immediate: true }
);

function addRole() {
  const added = store.addRole(newRole.value);
  if (!added) {
    ElMessage.warning('角色名为空或已存在');
    return;
  }
  newRole.value = '';
}

const operationOf = (role, table, operation) => store.matrix[role]?.[table]?.[operation];

const stateOf = (role, table, operation) => {
  const entry = operationOf(role, table, operation);
  if (!entry) return 'none';
  return entry.enabled ? 'allowed' : 'blocked';
};

/** 单元格下方的小标：行过滤 / 列管控是否配了东西 */
function ruleBadge(role, table, operation) {
  const entry = operationOf(role, table, operation);
  if (!entry) return '';
  const parts = [];
  if (entry.filters?.length) parts.push(`${entry.filters.length} 过滤`);
  if (entry.columns?.length) parts.push(entry.columnMode === 'block' ? '列黑名单' : '列白名单');
  if (operation === 'query' && entry.limit) parts.push(`limit ${entry.limit}`);
  return parts.join(' · ');
}

function openEditor(role, table, operation) {
  const entry = operationOf(role, table, operation);
  if (!entry) return;
  editing.role = role;
  editing.table = table;
  editing.operation = operation;
  editing.filters = (entry.filters ?? []).join('\n');
  editing.columnMode = entry.columns?.length ? (entry.columnMode ?? 'allow') : UNRESTRICTED;
  editing.columns = [...(entry.columns ?? [])];
  editing.limit = entry.limit ?? null;
  isEditorOpen.value = true;
}

function saveEditor() {
  const entry = operationOf(editing.role, editing.table, editing.operation);
  if (!entry) return;
  const filters = editing.filters
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  entry.filters = filters;
  entry.columnMode = editing.columnMode === UNRESTRICTED ? 'allow' : editing.columnMode;
  entry.columns = editing.columnMode === UNRESTRICTED ? [] : [...editing.columns];
  entry.limit = editing.operation === 'query' && Number.isFinite(editing.limit) ? editing.limit : null;
  isEditorOpen.value = false;
}

const rows = computed(() => store.tables.map((table) => table.name));
const changes = computed(() => store.changes);

async function apply() {
  if (!selectedDatabase.value) {
    ElMessage.warning('请选择目标库');
    return;
  }
  if (changes.value.length === 0) {
    ElMessage.info('与当前生效策略一致，没有需要写入的变更');
    return;
  }
  isConfirmOpen.value = true;
}

async function confirmApply() {
  isConfirmOpen.value = false;
  try {
    const result = await store.applyPermissions(selectedDatabase.value);
    lastSummary.value = result;
    ElMessage.success(`已写入：${changes.value.length} 项变更`);
  } catch (error) {
    ElMessage.error(error.message);
  }
}

onMounted(() => {
  if (store.isRunning && store.tables.length === 0) store.loadSchema();
});
</script>

<template>
  <div class="stack">
    <section class="panel">
      <div class="panel__head">
        <span class="panel__title">角色</span>
        <div class="add">
          <el-input v-model="newRole" size="small" placeholder="角色名，如 readonly" style="width: 200px" />
          <el-button size="small" type="primary" @click="addRole">添加</el-button>
        </div>
      </div>
      <div class="panel__body">
        <div v-if="store.roles.length" class="roles">
          <button
            v-for="role in store.roles"
            :key="role"
            class="role"
            :class="{ 'role--active': store.currentRole === role }"
            @click="store.currentRole = role"
          >
            {{ role }}
          </button>
        </div>
        <p v-else class="mono-dim">还没有角色。添加一个后即可为每张表配置四项操作开关。</p>
      </div>
    </section>

    <section class="panel">
      <div class="panel__head">
        <span class="panel__title">矩阵 · {{ store.currentRole || '未选择角色' }}</span>
        <div class="actions">
          <el-select v-model="selectedDatabase" size="small" style="width: 150px">
            <el-option v-for="name in store.databaseNames" :key="name" :label="name" :value="name" />
          </el-select>
          <el-button size="small" @click="store.loadCurrentPolicy">重载生效策略</el-button>
          <el-button size="small" type="primary" :loading="store.isBusy" @click="apply">
            应用到 GraphJin
          </el-button>
        </div>
      </div>

      <div class="panel__body panel__body--flush">
        <table v-if="store.currentRole && rows.length" class="matrix">
          <thead>
            <tr>
              <th class="col-table">表</th>
              <th v-for="operation in OPERATIONS" :key="operation" class="col-op">
                {{ OPERATION_LABELS[operation] }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="table in rows" :key="table">
              <td class="col-table">{{ table }}</td>
              <td v-for="operation in OPERATIONS" :key="operation" class="col-op">
                <button
                  class="toggle"
                  :class="`toggle--${stateOf(store.currentRole, table, operation)}`"
                  @click="store.toggleOperation(store.currentRole, table, operation)"
                >
                  {{ stateOf(store.currentRole, table, operation) === 'allowed' ? '允许' : '阻止' }}
                </button>
                <button class="rule" @click="openEditor(store.currentRole, table, operation)">
                  {{ ruleBadge(store.currentRole, table, operation) || '规则' }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="mono-dim pad">需要至少一个角色和一张已发现的表。</p>
      </div>
    </section>

    <section v-if="lastSummary" class="panel">
      <div class="panel__head">
        <span class="panel__title">最近一次写入</span>
        <span class="pill pill--on">
          <span class="dot" />{{ lastSummary.applied.success ? '成功' : '失败' }}
        </span>
      </div>
      <div class="panel__body">
        <div class="sync">补齐的角色：{{ lastSummary.synced.created.join(', ') || '（无）' }}</div>
        <ul class="changes">
          <li v-for="change in lastSummary.applied.changes ?? []" :key="change">{{ change }}</li>
        </ul>
      </div>
    </section>

    <el-dialog v-model="isEditorOpen" :title="`${editing.role} · ${editing.table} · ${OPERATION_LABELS[editing.operation]}`" width="560">
      <el-form label-position="top" size="small">
        <el-form-item label="行过滤条件（每行一条，GraphJin DSL）">
          <el-input
            v-model="editing.filters"
            type="textarea"
            :rows="3"
            placeholder="{ org_id: { _eq: $user.org_id } }"
          />
        </el-form-item>

        <el-form-item label="列管控">
          <el-radio-group v-model="editing.columnMode">
            <el-radio value="none">不限制</el-radio>
            <el-radio value="allow">白名单（只允许选中的列）</el-radio>
            <el-radio value="block">阻止列表（屏蔽选中的列）</el-radio>
          </el-radio-group>
        </el-form-item>

        <el-form-item v-if="editing.columnMode !== 'none'" label="列">
          <el-select v-model="editing.columns" multiple filterable style="width: 100%">
            <el-option v-for="column in columnsOf(editing.table)" :key="column" :label="column" :value="column" />
          </el-select>
          <span class="hint">
            GraphJin 的 columns 只接受数组（实测对象形态 {allow}/{block} 会被 schema 拒绝），
            阻止列表会转成「全部列减去选中列」的补集白名单写入。查询被屏蔽的列会报错
            <code>db column blocked</code>。
          </span>
        </el-form-item>

        <el-form-item v-if="editing.operation === 'query'" label="返回行数默认值">
          <el-input-number v-model="editing.limit" :min="1" controls-position="right" />
          <span class="hint">仅作为不带 limit 时的默认值，查询显式指定 limit 会覆盖它</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="isEditorOpen = false">取消</el-button>
        <el-button type="primary" @click="saveEditor">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="isConfirmOpen" title="确认写入" width="640">
      <p class="warn">
        legacy 模式下配置更新<b>立即生效</b>，没有 preview / 回滚。请确认下面
        {{ changes.length }} 项变更后再写入。
      </p>
      <ul class="changes">
        <li v-for="(change, index) in changes" :key="index">
          <b>{{ change.role }}</b> · {{ change.table }} · {{ OPERATION_LABELS[change.operation] }}
          <span class="from">{{ change.from.state }}</span>
          <span class="arrow">→</span>
          <span class="to">{{ change.to.state }}</span>
          <span v-if="change.detail" class="detail">{{ change.detail }}</span>
        </li>
      </ul>
      <template #footer>
        <el-button @click="isConfirmOpen = false">取消</el-button>
        <el-button type="primary" :loading="store.isBusy" @click="confirmApply">确认写入</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.stack {
  display: grid;
  gap: var(--gutter);
}

.add,
.actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.roles {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.role {
  padding: 5px 14px;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text-dim);
  background: var(--ink-700);
  border: 1px solid var(--line);
  border-radius: 999px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.role:hover {
  color: var(--text);
  border-color: var(--slate);
}

.role--active {
  color: var(--amber);
  background: var(--amber-soft);
  border-color: rgba(217, 162, 75, 0.45);
}

.panel__body--flush {
  padding: 0;
}

.matrix {
  width: 100%;
  border-collapse: collapse;
}

.matrix th {
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

.matrix td {
  padding: 7px 14px;
  border-bottom: 1px solid var(--line-soft);
}

.matrix tr:hover td {
  background: rgba(217, 162, 75, 0.05);
}

.col-table {
  width: 30%;
  color: var(--text);
}

.col-op {
  width: 17.5%;
}

.toggle {
  display: block;
  width: 62px;
  padding: 3px 0;
  font-family: var(--mono);
  font-size: 11px;
  border-radius: var(--radius);
  border: 1px solid transparent;
  cursor: pointer;
  transition: all 0.12s ease;
}

.toggle--allowed {
  color: var(--mint);
  background: var(--mint-soft);
  border-color: rgba(85, 214, 168, 0.35);
}

.toggle--blocked {
  color: var(--coral);
  background: var(--coral-soft);
  border-color: rgba(226, 115, 94, 0.32);
}

.toggle--none {
  color: var(--text-faint);
  background: transparent;
  border-color: var(--line);
}

.rule {
  margin-top: 4px;
  padding: 0;
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--text-faint);
  background: none;
  border: none;
  cursor: pointer;
}

.rule:hover {
  color: var(--amber);
}

.pad {
  padding: 16px;
}

.sync {
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--text-dim);
}

.changes {
  margin: 0;
  padding-left: 18px;
  font-size: 11.5px;
  color: var(--text-dim);
}

.changes li {
  margin-bottom: 4px;
}

.from {
  color: var(--coral);
}

.to {
  color: var(--mint);
}

.arrow,
.detail {
  margin-left: 6px;
  color: var(--text-faint);
}

.warn {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--amber);
}

.hint {
  display: block;
  margin-top: 6px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-faint);
}
</style>
