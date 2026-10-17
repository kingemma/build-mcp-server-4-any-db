import { createRouter, createWebHashHistory } from 'vue-router';

import StatusView from '../views/StatusView.vue';
import ConnectionsView from '../views/ConnectionsView.vue';
import SchemaView from '../views/SchemaView.vue';
import PermissionsView from '../views/PermissionsView.vue';
import PolicyView from '../views/PolicyView.vue';
import SettingsView from '../views/SettingsView.vue';

export const routes = [
  { path: '/', redirect: '/status' },
  { path: '/status', name: 'status', component: StatusView, meta: { title: '运行状态', hint: '服务与端点' } },
  { path: '/connections', name: 'connections', component: ConnectionsView, meta: { title: '数据库连接', hint: '源与凭据' } },
  { path: '/schema', name: 'schema', component: SchemaView, meta: { title: 'Schema 浏览器', hint: '表 · 列 · 关系' } },
  { path: '/permissions', name: 'permissions', component: PermissionsView, meta: { title: '权限矩阵', hint: '角色 × 表 × 操作' } },
  { path: '/policy', name: 'policy', component: PolicyView, meta: { title: '策略预览', hint: '生效策略 · 变更 diff' } },
  { path: '/settings', name: 'settings', component: SettingsView, meta: { title: '设置', hint: '版本与端口' } },
];

// 桌面端用 file:// 加载打包产物，history 模式在 file:// 下无法工作，故统一走 hash
export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});
