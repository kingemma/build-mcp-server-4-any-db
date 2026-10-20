<script setup>
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useI18n } from 'vue-i18n';
import { useAppStore, OPERATIONS, OPERATION_KEYS, STATE_KEYS } from '../stores/app';
import { formatDetail } from '../utils/policy';

const store = useAppStore();
const { t } = useI18n();

const newRole = ref('');
const isEditorOpen = ref(false);
const isConfirmOpen = ref(false);
const isHistoryOpen = ref(false);
const isVerifyOpen = ref(false);
const isVerifying = ref(false);
const verifyResult = ref(null);
const verifyForm = reactive({ role: '', query: '' });
const restoringId = ref(0);
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

function addRole() {
  if ((newRole.value ?? '').trim() === 'admin') {
    ElMessage.warning(t('permissions.adminReserved'));
    return;
  }
  const added = store.addRole(newRole.value);
  if (!added) {
    ElMessage.warning(t('permissions.roleExists'));
    return;
  }
  newRole.value = '';
}

/**
 * 删除本地角色。
 *
 * 角色已写进生效策略时要二次确认：这里只删本地矩阵，GraphJin 里的规则还在，
 * 想回收得用「写入历史」回滚。
 */
async function removeRole(role) {
  if (store.isRoleEffective(role)) {
    try {
      await ElMessageBox.confirm(
        t('permissions.removeRoleConfirm', { role }),
        t('permissions.removeRole'),
        {
          confirmButtonText: t('permissions.removeRole'),
          cancelButtonText: t('common.cancel'),
          type: 'warning',
        }
      );
    } catch {
      return;
    }
  }
  store.removeRole(role);
  ElMessage.success(t('permissions.roleRemoved', { role }));
}

/** 视图只认纯表名，库名前缀由 store 统一补 */
const operationOf = (role, table, operation) => store.operationOf(role, table, operation);

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
  if (entry.filters?.length) {
    parts.push(t('permissions.badge.filters', { count: entry.filters.length }));
  }
  if (entry.columns?.length) {
    parts.push(
      entry.columnMode === 'block'
        ? t('permissions.badge.blockList')
        : t('permissions.badge.allowList')
    );
  }
  if (operation === 'query' && entry.limit) {
    parts.push(t('permissions.badge.limit', { count: entry.limit }));
  }
  return parts.join(' · ');
}

function openEditor(role, table, operation) {
  // 矩阵是懒创建的：第一次点规则时才落格子，避免空占位挡住策略回填
  store.ensureOperations(role, table);
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

/** 只列写入目标库的表：跨库同名表不能混在同一张矩阵里 */
const rows = computed(() => store.applyTables);
const changes = computed(() => store.changes);

async function apply() {
  if (!store.applyDatabase) {
    ElMessage.warning(t('permissions.selectDatabase'));
    return;
  }
  if (changes.value.length === 0) {
    ElMessage.info(t('permissions.noChanges'));
    return;
  }
  isConfirmOpen.value = true;
}

async function confirmApply() {
  isConfirmOpen.value = false;
  // 写入成功后会重载生效策略，diff 归零，所以变更数要在写入前取
  const count = changes.value.length;
  try {
    const result = await store.applyPermissions(store.applyDatabase);
    lastSummary.value = result;
    ElMessage.success(t('permissions.applied', { count }));
  } catch (error) {
    ElMessage.error(error.message);
  }
}

/**
 * 用生效策略覆盖本地矩阵。
 *
 * 自动回填只补空格子，所以这里必须先确认：用户可能有一批没提交的改动。
 */
async function importPolicy() {
  if (!store.applyDatabase) {
    ElMessage.warning(t('permissions.selectDatabase'));
    return;
  }
  try {
    await ElMessageBox.confirm(t('permissions.importConfirm'), t('permissions.importPolicy'), {
      confirmButtonText: t('permissions.importSubmit'),
      cancelButtonText: t('common.cancel'),
      type: 'warning',
    });
  } catch {
    return; // 用户取消
  }
  const imported = store.hydrateMatrixFromPolicy({ overwrite: true });
  if (imported.roles === 0) {
    ElMessage.warning(t('permissions.importEmpty'));
    return;
  }
  ElMessage.success(t('permissions.imported', imported));
}

/**
 * 验证结论：GraphJin 拦截 query 是静默的（返回 null 且不报错），
 * 拦截写操作才带 errors —— 所以「有错误」和「全 null」都要显式说出来。
 */
const verifyVerdict = computed(() => {
  const result = verifyResult.value;
  if (!result) return '';
  if ((result.errors ?? []).length > 0) return t('permissions.verifyErrors');
  const data = result.data ?? {};
  return Object.values(data).every((value) => value === null)
    ? t('permissions.verifyNull')
    : '';
});

function openVerify() {
  if (!store.isRunning) {
    ElMessage.warning(t('errors.verifyNeedsRunning'));
    return;
  }
  if (!verifyForm.role) verifyForm.role = store.currentRole || store.roleNames[0] || 'admin';
  if (!verifyForm.query.trim()) {
    const table = rows.value[0];
    verifyForm.query = table ? `query { ${table} { id } }` : '';
  }
  verifyResult.value = null;
  isVerifyOpen.value = true;
}

async function runVerify() {
  if (!verifyForm.query.trim()) return;
  isVerifying.value = true;
  try {
    verifyResult.value = await store.executeGraphql(verifyForm.role, verifyForm.query.trim());
  } catch (error) {
    verifyResult.value = { errors: [{ message: error.message }] };
  } finally {
    isVerifying.value = false;
  }
}

/** 打开写入历史：每次写入前都有一份快照，可恢复到任意一份 */
async function openHistory() {
  if (!store.isRunning) {
    ElMessage.warning(t('errors.rollbackNeedsRunning'));
    return;
  }
  await store.loadSnapshots();
  isHistoryOpen.value = true;
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function reasonLabel(reason) {
  return reason === 'before-rollback'
    ? t('permissions.snapshotBeforeRollback')
    : t('permissions.snapshotBeforeApply');
}

async function restoreSnapshot(snapshot) {
  try {
    await ElMessageBox.confirm(
      t('permissions.restoreConfirm', {
        time: formatTime(snapshot.createdAt),
        roles: snapshot.roleCount,
      }),
      t('permissions.restore'),
      { confirmButtonText: t('permissions.restore'), cancelButtonText: t('common.cancel'), type: 'warning' }
    );
  } catch {
    return;
  }
  restoringId.value = snapshot.id;
  try {
    const result = await store.rollbackPermissions(snapshot.id);
    ElMessage.success(t('permissions.restored', { id: result.target.id }));
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    restoringId.value = 0;
  }
}

/** 冷启动时本组件先挂载、status 还没回来：watch 负责状态到位后补加载 */
watch(
  () => store.isRunning,
  (running) => {
    if (!running) return;
    store.ensureSchemaLoaded();
    store.loadSnapshots();
  },
  { immediate: true }
);
</script>

<template>
  <div class="stack">
    <section class="panel">
      <div class="panel__head">
        <span class="panel__title">{{ t('permissions.roles') }}</span>
        <div class="add">
          <el-input
            v-model="newRole"
            size="small"
            :placeholder="t('permissions.rolePlaceholder')"
            style="width: 200px"
          />
          <el-button size="small" type="primary" @click="addRole">
            {{ t('permissions.addRole') }}
          </el-button>
        </div>
      </div>
      <div class="panel__body">
        <div v-if="store.roles.length" class="roles">
          <div
            v-for="role in store.roles"
            :key="role"
            class="role"
            :class="{ 'role--active': store.currentRole === role }"
          >
            <button type="button" class="role__name" @click="store.currentRole = role">
              {{ role }}
            </button>
            <button
              type="button"
              class="role__remove"
              :title="t('permissions.removeRole')"
              @click.stop="removeRole(role)"
            >
              ×
            </button>
          </div>
        </div>
        <p v-else class="mono-dim">{{ t('permissions.noRoles') }}</p>
        <p class="admin-note mono-dim">{{ t('permissions.adminReserved') }}</p>
      </div>
    </section>

    <section class="panel">
      <div class="panel__head">
        <span class="panel__title">
          {{
            store.currentRole
              ? t('permissions.matrix', { role: store.currentRole })
              : t('permissions.matrixNone')
          }}
        </span>
        <div class="actions">
          <el-select
            :model-value="store.applyDatabase"
            size="small"
            style="width: 150px"
            @change="store.selectDatabase"
          >
            <el-option v-for="name in store.databaseNames" :key="name" :label="name" :value="name" />
          </el-select>
          <el-button size="small" @click="store.loadCurrentPolicy">
            {{ t('permissions.reloadPolicy') }}
          </el-button>
          <el-button size="small" @click="importPolicy">
            {{ t('permissions.importPolicy') }}
          </el-button>
          <el-button size="small" @click="openHistory">
            {{ t('permissions.history') }}
          </el-button>
          <el-button size="small" :disabled="!store.isRunning" @click="openVerify">
            {{ t('permissions.verify') }}
          </el-button>
          <el-button size="small" type="primary" :loading="store.isBusy" @click="apply">
            {{ t('permissions.apply') }}
          </el-button>
        </div>
      </div>

      <div class="panel__body panel__body--flush">
        <table v-if="store.currentRole && rows.length" class="matrix">
          <thead>
            <tr>
              <th class="col-table">{{ t('permissions.tableColumn') }}</th>
              <th v-for="operation in OPERATIONS" :key="operation" class="col-op">
                {{ t(OPERATION_KEYS[operation]) }}
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
                  {{
                    stateOf(store.currentRole, table, operation) === 'allowed'
                      ? t('permissions.states.allowed')
                      : stateOf(store.currentRole, table, operation) === 'none'
                        ? t('permissions.states.default')
                        : t('permissions.states.blocked')
                  }}
                </button>
                <button class="rule" @click="openEditor(store.currentRole, table, operation)">
                  {{ ruleBadge(store.currentRole, table, operation) || t('permissions.rule') }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="mono-dim pad">{{ t('permissions.emptyHint') }}</p>
      </div>
    </section>

    <section v-if="lastSummary" class="panel">
      <div class="panel__head">
        <span class="panel__title">{{ t('permissions.lastWrite') }}</span>
        <span class="pill pill--on">
          <span class="dot" />
          {{ lastSummary.applied.success ? t('permissions.success') : t('permissions.failed') }}
        </span>
      </div>
      <div class="panel__body">
        <div class="sync">
          {{
            t('permissions.syncedRoles', {
              names: lastSummary.synced.created.join(', ') || t('permissions.noneSynced'),
            })
          }}
        </div>
        <ul class="changes">
          <li v-for="change in lastSummary.applied.changes ?? []" :key="change">{{ change }}</li>
        </ul>
      </div>
    </section>

    <el-dialog
      v-model="isEditorOpen"
      :title="`${editing.role} · ${editing.table} · ${t(OPERATION_KEYS[editing.operation])}`"
      width="560"
    >
      <el-form label-position="top" size="small">
        <el-form-item :label="t('permissions.editor.filters')">
          <el-input
            v-model="editing.filters"
            type="textarea"
            :rows="3"
            :placeholder="t('permissions.editor.filtersPlaceholder')"
          />
        </el-form-item>

        <el-form-item :label="t('permissions.editor.columnMode')">
          <el-radio-group v-model="editing.columnMode">
            <el-radio value="none">{{ t('permissions.editor.unlimited') }}</el-radio>
            <el-radio value="allow">{{ t('permissions.editor.allowList') }}</el-radio>
            <el-radio value="block">{{ t('permissions.editor.blockList') }}</el-radio>
          </el-radio-group>
        </el-form-item>

        <el-form-item v-if="editing.columnMode !== 'none'" :label="t('permissions.editor.columns')">
          <el-select v-model="editing.columns" multiple filterable style="width: 100%">
            <el-option v-for="column in columnsOf(editing.table)" :key="column" :label="column" :value="column" />
          </el-select>
          <span class="hint">{{ t('permissions.editor.columnsHint') }}</span>
        </el-form-item>

        <el-form-item v-if="editing.operation === 'query'" :label="t('permissions.editor.limit')">
          <el-input-number v-model="editing.limit" :min="1" controls-position="right" />
          <span class="hint">{{ t('permissions.editor.limitHint') }}</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="isEditorOpen = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" @click="saveEditor">{{ t('common.save') }}</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="isHistoryOpen" :title="t('permissions.historyTitle')" width="640">
      <p v-if="store.snapshots.length === 0" class="mono-dim">
        {{ t('permissions.historyEmpty') }}
      </p>
      <ul v-else class="snapshots">
        <li v-for="snapshot in store.snapshots" :key="snapshot.id">
          <div class="snapshots__meta">
            <span class="mono-dim">#{{ snapshot.id }}</span>
            <span>{{ formatTime(snapshot.createdAt) }}</span>
            <span class="mono-dim">
              {{ reasonLabel(snapshot.reason) }} ·
              {{ t('permissions.snapshotMeta', { roles: snapshot.roleCount }) }}
            </span>
            <span v-if="snapshot.database" class="mono-dim">
              {{ t('permissions.snapshotDatabase', { database: snapshot.database }) }}
            </span>
          </div>
          <el-button
            size="small"
            :loading="restoringId === snapshot.id"
            :disabled="!store.isRunning"
            @click="restoreSnapshot(snapshot)"
          >
            {{ t('permissions.restore') }}
          </el-button>
        </li>
      </ul>
      <template #footer>
        <el-button @click="isHistoryOpen = false">{{ t('common.close') }}</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="isVerifyOpen" :title="t('permissions.verifyTitle')" width="640">
      <el-form label-position="top" size="small">
        <el-form-item :label="t('permissions.verifyRole')">
          <el-select
            v-model="verifyForm.role"
            style="width: 200px"
            filterable
            allow-create
            default-first-option
          >
            <el-option v-for="role in store.roleNames" :key="role" :label="role" :value="role" />
          </el-select>
        </el-form-item>
        <el-form-item :label="t('permissions.verifyQuery')">
          <el-input v-model="verifyForm.query" type="textarea" :rows="6" spellcheck="false" />
        </el-form-item>
      </el-form>
      <p class="verify-hint">{{ t('permissions.verifyHint') }}</p>
      <div v-if="verifyResult">
        <p v-if="verifyVerdict" class="verify__verdict">{{ verifyVerdict }}</p>
        <pre class="verify__result">{{ JSON.stringify(verifyResult, null, 2) }}</pre>
      </div>
      <template #footer>
        <el-button @click="isVerifyOpen = false">{{ t('common.close') }}</el-button>
        <el-button type="primary" :loading="isVerifying" @click="runVerify">
          {{ t('permissions.verifyRun') }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="isConfirmOpen" :title="t('permissions.confirm.title')" width="640">
      <p class="warn">{{ t('permissions.confirm.warning', { count: changes.length }) }}</p>
      <ul class="changes">
        <li v-for="(change, index) in changes" :key="index">
          <b>{{ change.role }}</b> · {{ change.table }} · {{ t(OPERATION_KEYS[change.operation]) }}
          <span class="from">{{ t(STATE_KEYS[change.from.state]) }}</span>
          <span class="arrow">→</span>
          <span class="to">{{ t(STATE_KEYS[change.to.state]) }}</span>
          <span v-if="change.detail" class="detail">{{ formatDetail(change.detail, t) }}</span>
        </li>
      </ul>
      <template #footer>
        <el-button @click="isConfirmOpen = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="store.isBusy" @click="confirmApply">
          {{ t('permissions.confirm.submit') }}
        </el-button>
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
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  justify-content: flex-end;
}

.roles {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.admin-note {
  margin: 14px 0 0;
  font-size: var(--fs-note);
  line-height: 1.7;
}

.snapshots {
  margin: 0;
  padding: 0;
  list-style: none;
}

.snapshots li {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  padding: 11px 0;
  border-bottom: 1px solid var(--line-soft);
}

.snapshots__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 12.5px;
  color: var(--text);
}

.role {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 0 7px 0 0;
  font-family: var(--mono);
  font-size: 13px;
  color: var(--text-dim);
  background: var(--ink-700);
  border: 1px solid var(--line);
  border-radius: 999px;
  transition: all 0.15s ease;
}

.role__name {
  padding: 6px 4px 6px 13px;
  font: inherit;
  color: inherit;
  background: none;
  border: 0;
  cursor: pointer;
}

.role__remove {
  width: 18px;
  height: 18px;
  padding: 0;
  font-size: 13px;
  line-height: 1;
  color: var(--text-faint);
  background: none;
  border: 0;
  border-radius: 999px;
  cursor: pointer;
}

.role__remove:hover {
  color: var(--danger, #b42318);
  background: rgba(180, 35, 24, 0.1);
}

.verify-hint {
  margin: 0 0 10px;
  font-size: var(--fs-note);
  line-height: 1.6;
  color: var(--text-dim);
}

.verify__verdict {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--accent);
}

.verify__result {
  max-height: 260px;
  margin: 0;
  padding: 12px 14px;
  overflow: auto;
  font-family: var(--mono);
  font-size: var(--fs-note);
  line-height: 1.6;
  color: var(--text);
  background: var(--ink-700);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
}

.role:hover {
  color: var(--text);
  border-color: var(--slate);
}

.role--active {
  color: var(--accent);
  background: var(--accent-soft);
  border-color: rgba(29, 78, 216, 0.3);
}

.panel__body--flush {
  padding: 0;
}

.matrix {
  width: 100%;
  border-collapse: collapse;
}

.matrix th {
  padding: 10px 16px;
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-dim);
  text-align: left;
  border-bottom: 1px solid var(--line);
  background: var(--ink-700);
}

.matrix td {
  padding: 9px 16px;
  border-bottom: 1px solid var(--line-soft);
}

.matrix tr:hover td {
  background: #f2f7ff;
}

.col-table {
  width: 30%;
  color: var(--text);
  font-weight: 500;
}

.col-op {
  width: 17.5%;
}

.toggle {
  display: block;
  width: 68px;
  padding: 4px 0;
  font-family: var(--mono);
  font-size: var(--fs-micro);
  font-weight: 500;
  border-radius: 6px;
  border: 1px solid transparent;
  cursor: pointer;
  transition: all 0.12s ease;
}

.toggle--allowed {
  color: var(--mint);
  background: var(--mint-soft);
  border-color: rgba(4, 120, 87, 0.22);
}

.toggle--blocked {
  color: var(--coral);
  background: var(--coral-soft);
  border-color: rgba(180, 35, 24, 0.2);
}

.toggle--none {
  color: var(--text-dim);
  background: #ffffff;
  border-color: var(--line);
}

.rule {
  margin-top: 5px;
  padding: 0;
  font-family: var(--mono);
  font-size: var(--fs-micro);
  color: var(--text-dim);
  background: none;
  border: none;
  cursor: pointer;
}

.rule:hover {
  color: var(--accent);
}

.pad {
  padding: 18px;
}

.sync {
  margin-bottom: 10px;
  font-size: 12.5px;
  color: var(--text-dim);
}

.changes {
  margin: 0;
  padding-left: 18px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text-dim);
}

.changes li {
  margin-bottom: 5px;
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
  font-size: 13px;
  color: var(--accent-strong);
}

.hint {
  display: block;
  margin-top: 6px;
  font-size: var(--fs-note);
  line-height: 1.6;
  color: var(--text-dim);
}
</style>
