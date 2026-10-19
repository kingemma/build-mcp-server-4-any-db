<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useI18n } from 'vue-i18n';
import { useAppStore } from '../stores/app';

const store = useAppStore();
const { t } = useI18n();

const newOrg = ref('');
const isCreatingOrg = ref(false);
const isSubmitting = ref(false);
const isSyncing = ref(false);
const savingRoleId = ref(0);
const isEditOpen = ref(false);
const isSavingEdit = ref(false);
const editingUser = reactive({ id: 0, name: '', email: '' });

const form = reactive({
  organizationId: null,
  name: '',
  email: '',
  role: 'viewer',
});

const hasOrganizations = computed(() => store.organizations.length > 0);

/** 组织列表首次加载后默认选中第一个，省一次点击 */
watch(
  () => store.organizations,
  (list) => {
    const ids = list.map((org) => org.id);
    if (!ids.includes(form.organizationId)) form.organizationId = ids[0] ?? null;
  },
  { immediate: true }
);

const orgName = (id) => store.organizations.find((org) => org.id === id)?.name ?? `#${id}`;
const memberCount = (id) => store.users.filter((user) => user.organization_id === id).length;

/**
 * 行内角色下拉的候选：全局候选 + 该成员当前角色。
 *
 * 当前角色可能不在候选里（角色是自由文本，也可能刚被改名），缺了会让下拉显示空。
 */
function roleChoices(current) {
  return [...new Set([...store.roleNames, current])].sort();
}

onMounted(async () => {
  await Promise.all([store.loadOrganizations(), store.loadUsers()]);
});

async function createOrg() {
  const name = newOrg.value.trim();
  if (!name) {
    ElMessage.warning(t('users.orgExists'));
    return;
  }
  isCreatingOrg.value = true;
  try {
    const created = await store.createOrganization(name);
    newOrg.value = '';
    ElMessage.success(t('users.orgCreated', { name: created.name }));
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    isCreatingOrg.value = false;
  }
}

/** 组织还有成员时后端会拒绝删除，避免级联删掉成员记录 */
async function removeOrg(org) {
  try {
    await ElMessageBox.confirm(
      t('users.deleteOrgConfirm', { name: org.name }),
      t('users.deleteOrg'),
      { confirmButtonText: t('common.delete'), cancelButtonText: t('common.cancel'), type: 'warning' }
    );
  } catch {
    return;
  }
  try {
    await store.deleteOrganization(org.id);
    ElMessage.success(t('users.orgDeleted', { name: org.name }));
  } catch (error) {
    ElMessage.error(error.message);
  }
}

function openEdit(user) {
  editingUser.id = user.id;
  editingUser.name = user.name;
  editingUser.email = user.email;
  isEditOpen.value = true;
}

async function saveEdit() {
  const name = editingUser.name.trim();
  const email = editingUser.email.trim();
  if (!name || !email) {
    ElMessage.warning(t('users.fieldsRequired'));
    return;
  }
  isSavingEdit.value = true;
  try {
    await store.updateUser(editingUser.id, { name, email });
    isEditOpen.value = false;
    ElMessage.success(t('users.saved'));
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    isSavingEdit.value = false;
  }
}

async function createUser() {
  if (!form.organizationId) {
    ElMessage.warning(t('users.orgRequired'));
    return;
  }
  const name = form.name.trim();
  const email = form.email.trim();
  const role = (form.role ?? '').trim();
  if (!name || !email || !role) {
    ElMessage.warning(t('users.fieldsRequired'));
    return;
  }
  isSubmitting.value = true;
  try {
    const created = await store.createUser({
      organizationId: form.organizationId,
      name,
      email,
      role,
    });
    form.name = '';
    form.email = '';
    ElMessage.success(t('users.created', { email: created.email }));
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    isSubmitting.value = false;
  }
}

async function changeRole(user, role) {
  if (!role || role === user.role) return;
  savingRoleId.value = user.id;
  try {
    await store.setUserRole(user.id, role);
    ElMessage.success(t('users.roleUpdated', { email: user.email }));
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    savingRoleId.value = 0;
  }
}

async function remove(user) {
  try {
    await ElMessageBox.confirm(
      t('users.deleteConfirm', { email: user.email }),
      t('common.delete'),
      { confirmButtonText: t('common.delete'), cancelButtonText: t('common.cancel'), type: 'warning' }
    );
  } catch {
    return; // 用户取消
  }
  try {
    await store.deleteUser(user.id);
    ElMessage.success(t('users.deleted', { email: user.email }));
  } catch (error) {
    ElMessage.error(error.message);
  }
}

/** 角色名不会自动进 GraphJin 配置，缺角色时 roles[].tables 会被拒 */
async function syncRoles() {
  isSyncing.value = true;
  try {
    const result = await store.syncUserRoles();
    if (result.created.length > 0) {
      ElMessage.success(t('users.syncDone', { names: result.created.join(', ') }));
    } else {
      ElMessage.info(t('users.syncNone'));
    }
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    isSyncing.value = false;
  }
}
</script>

<template>
  <div class="stack">
    <section class="panel">
      <div class="panel__head">
        <span class="panel__title">{{ t('users.organizations') }}</span>
        <div class="head-actions">
          <el-input
            v-model="newOrg"
            size="small"
            :placeholder="t('users.orgPlaceholder')"
            style="width: 200px"
            @keyup.enter="createOrg"
          />
          <el-button size="small" type="primary" :loading="isCreatingOrg" @click="createOrg">
            {{ t('users.addOrg') }}
          </el-button>
        </div>
      </div>
      <div class="panel__body">
        <div v-if="hasOrganizations" class="orgs">
          <div v-for="org in store.organizations" :key="org.id" class="org">
            <span class="org__name">{{ org.name }}</span>
            <span class="org__count">{{ memberCount(org.id) }}</span>
            <button
              type="button"
              class="org__remove"
              :title="t('users.deleteOrg')"
              @click="removeOrg(org)"
            >
              ×
            </button>
          </div>
        </div>
        <p v-else class="mono-dim">{{ t('users.noOrgs') }}</p>
      </div>
    </section>

    <section class="panel">
      <div class="panel__head">
        <span class="panel__title">{{ t('users.members') }}</span>
        <div class="head-actions">
          <el-button
            size="small"
            :disabled="!store.isRunning"
            :loading="isSyncing"
            @click="syncRoles"
          >
            {{ t('users.syncRoles') }}
          </el-button>
          <el-button size="small" @click="store.loadUsers()">{{ t('common.refresh') }}</el-button>
        </div>
      </div>
      <div class="panel__body">
        <el-form :inline="true" size="small" class="form" @submit.prevent>
          <el-form-item :label="t('users.form.organization')">
            <el-select
              v-model="form.organizationId"
              style="width: 150px"
              :placeholder="t('common.notSelected')"
            >
              <el-option
                v-for="org in store.organizations"
                :key="org.id"
                :label="org.name"
                :value="org.id"
              />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('users.form.name')">
            <el-input v-model="form.name" style="width: 130px" />
          </el-form-item>
          <el-form-item :label="t('users.form.email')">
            <el-input v-model="form.email" style="width: 190px" placeholder="name@example.com" />
          </el-form-item>
          <el-form-item :label="t('users.form.role')">
            <el-select
              v-model="form.role"
              style="width: 150px"
              filterable
              allow-create
              default-first-option
              :placeholder="t('users.rolePlaceholder')"
            >
              <el-option v-for="role in store.roleNames" :key="role" :label="role" :value="role" />
            </el-select>
          </el-form-item>
          <el-form-item>
            <el-button type="primary" :loading="isSubmitting" @click="createUser">
              {{ t('users.submit') }}
            </el-button>
          </el-form-item>
        </el-form>
        <p class="hint">{{ t('users.roleNote') }}</p>

        <table v-if="store.users.length" class="users">
          <thead>
            <tr>
              <th>{{ t('users.columns.organization') }}</th>
              <th>{{ t('users.columns.name') }}</th>
              <th>{{ t('users.columns.email') }}</th>
              <th>{{ t('users.columns.role') }}</th>
              <th class="users__actions">{{ t('users.columns.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="user in store.users" :key="user.id">
              <td class="mono">{{ orgName(user.organization_id) }}</td>
              <td>{{ user.name }}</td>
              <td class="mono-dim">{{ user.email }}</td>
              <td>
                <el-select
                  :model-value="user.role"
                  size="small"
                  style="width: 130px"
                  :loading="savingRoleId === user.id"
                  @change="changeRole(user, $event)"
                >
                  <el-option
                    v-for="role in roleChoices(user.role)"
                    :key="role"
                    :label="role"
                    :value="role"
                  />
                </el-select>
              </td>
              <td class="users__actions">
                <el-button size="small" text @click="openEdit(user)">
                  {{ t('users.edit') }}
                </el-button>
                <el-button size="small" text type="danger" @click="remove(user)">
                  {{ t('common.delete') }}
                </el-button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="mono-dim empty">{{ t('users.empty') }}</p>
      </div>
    </section>

    <el-dialog v-model="isEditOpen" :title="t('users.editTitle')" width="420">
      <el-form label-position="top" size="small">
        <el-form-item :label="t('users.form.name')">
          <el-input v-model="editingUser.name" />
        </el-form-item>
        <el-form-item :label="t('users.form.email')">
          <el-input v-model="editingUser.email" placeholder="name@example.com" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="isEditOpen = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="isSavingEdit" @click="saveEdit">
          {{ t('common.save') }}
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

.head-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.orgs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.org {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  padding: 4px 6px 4px 12px;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text);
  background: var(--ink-700);
  border: 1px solid var(--line);
  border-radius: 999px;
}

.org__remove {
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

.org__remove:hover {
  color: var(--danger, #e06c6c);
  background: rgba(224, 108, 108, 0.12);
}

.org__count {
  font-size: 10px;
  color: var(--text-faint);
}

.form {
  margin-bottom: 4px;
}

.hint {
  margin: 0 0 12px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-faint);
}

.users {
  width: 100%;
  border-collapse: collapse;
}

.users th {
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

.users td {
  padding: 6px 14px;
  font-size: 12px;
  border-bottom: 1px solid var(--line-soft);
}

.users tbody tr:hover td {
  background: rgba(217, 162, 75, 0.05);
}

.mono {
  font-family: var(--mono);
  color: var(--text);
}

.users__actions {
  width: 1%;
  text-align: right;
  white-space: nowrap;
}

.empty {
  padding: 4px 0 0;
}
</style>
