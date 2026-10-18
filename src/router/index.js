import { createRouter, createWebHashHistory } from 'vue-router';

import StatusView from '../views/StatusView.vue';
import ConnectionsView from '../views/ConnectionsView.vue';
import SchemaView from '../views/SchemaView.vue';
import PermissionsView from '../views/PermissionsView.vue';
import PolicyView from '../views/PolicyView.vue';
import SettingsView from '../views/SettingsView.vue';

// meta 只存 i18n key：切换语言时导航与顶栏标题要跟着变
export const routes = [
  { path: '/', redirect: '/status' },
  { path: '/status', name: 'status', component: StatusView, meta: { titleKey: 'nav.status.title', hintKey: 'nav.status.hint' } },
  { path: '/connections', name: 'connections', component: ConnectionsView, meta: { titleKey: 'nav.connections.title', hintKey: 'nav.connections.hint' } },
  { path: '/schema', name: 'schema', component: SchemaView, meta: { titleKey: 'nav.schema.title', hintKey: 'nav.schema.hint' } },
  { path: '/permissions', name: 'permissions', component: PermissionsView, meta: { titleKey: 'nav.permissions.title', hintKey: 'nav.permissions.hint' } },
  { path: '/policy', name: 'policy', component: PolicyView, meta: { titleKey: 'nav.policy.title', hintKey: 'nav.policy.hint' } },
  { path: '/settings', name: 'settings', component: SettingsView, meta: { titleKey: 'nav.settings.title', hintKey: 'nav.settings.hint' } },
];

// 桌面端用 file:// 加载打包产物，history 模式在 file:// 下无法工作，故统一走 hash
export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});
