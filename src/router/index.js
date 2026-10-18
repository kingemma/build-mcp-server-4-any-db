import { createRouter, createWebHashHistory } from 'vue-router';

// 页面按路由懒加载：首屏只下载当前页面，其余页面点开再取。
// 之前六个页面全部静态 import，单 chunk 1.17 MB（gzip 383 kB）。
const StatusView = () => import('../views/StatusView.vue');
const ConnectionsView = () => import('../views/ConnectionsView.vue');
const SchemaView = () => import('../views/SchemaView.vue');
const PermissionsView = () => import('../views/PermissionsView.vue');
const PolicyView = () => import('../views/PolicyView.vue');
const SettingsView = () => import('../views/SettingsView.vue');

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
