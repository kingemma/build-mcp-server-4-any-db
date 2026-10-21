import { createRouter, createWebHashHistory } from 'vue-router';

// 页面按路由懒加载：首屏只下载当前页面，其余页面点开再取。
// 之前六个页面全部静态 import，单 chunk 1.17 MB（gzip 383 kB）。
const WelcomeView = () => import('../views/WelcomeView.vue');
const ConnectView = () => import('../views/ConnectView.vue');
const StatusView = () => import('../views/StatusView.vue');
const ConnectionsView = () => import('../views/ConnectionsView.vue');
const SchemaView = () => import('../views/SchemaView.vue');
const McpView = () => import('../views/McpView.vue');
const PermissionsView = () => import('../views/PermissionsView.vue');
const UsersView = () => import('../views/UsersView.vue');
const PolicyView = () => import('../views/PolicyView.vue');
const SettingsView = () => import('../views/SettingsView.vue');

// meta 只存 i18n key：切换语言时导航与顶栏标题要跟着变
export const routes = [
  { path: '/', name: 'welcome', component: WelcomeView, meta: { titleKey: 'nav.welcome.title', hintKey: 'nav.welcome.hint' } },
  { path: '/status', name: 'status', component: StatusView, meta: { titleKey: 'nav.status.title', hintKey: 'nav.status.hint' } },
  { path: '/connections', name: 'connections', component: ConnectionsView, meta: { titleKey: 'nav.connections.title', hintKey: 'nav.connections.hint' } },
  { path: '/schema', name: 'schema', component: SchemaView, meta: { titleKey: 'nav.schema.title', hintKey: 'nav.schema.hint' } },
  { path: '/mcp', name: 'mcp', component: McpView, meta: { titleKey: 'nav.mcp.title', hintKey: 'nav.mcp.hint' } },
  { path: '/connect', name: 'connect', component: ConnectView, meta: { titleKey: 'nav.connect.title', hintKey: 'nav.connect.hint' } },
  { path: '/permissions', name: 'permissions', component: PermissionsView, meta: { titleKey: 'nav.permissions.title', hintKey: 'nav.permissions.hint' } },
  { path: '/users', name: 'users', component: UsersView, meta: { titleKey: 'nav.users.title', hintKey: 'nav.users.hint' } },
  { path: '/policy', name: 'policy', component: PolicyView, meta: { titleKey: 'nav.policy.title', hintKey: 'nav.policy.hint' } },
  { path: '/settings', name: 'settings', component: SettingsView, meta: { titleKey: 'nav.settings.title', hintKey: 'nav.settings.hint' } },
];

// 桌面端用 file:// 加载打包产物，history 模式在 file:// 下无法工作，故统一走 hash
export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});
