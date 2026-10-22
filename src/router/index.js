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
const OntologyView = () => import('../views/OntologyView.vue');
const UsersView = () => import('../views/UsersView.vue');
const PolicyView = () => import('../views/PolicyView.vue');
const SettingsView = () => import('../views/SettingsView.vue');

// meta 只存 i18n key：切换语言时导航与顶栏标题要跟着变
//
// 顺序就是用户动线，与「使用向导」的五步严格一致：欢迎页之后依次是
// 连接数据库 → 配置权限 → 验证生效 → 讲清业务 → 接入 AI。
// 导航直接由这个数组生成（App.vue 的 navItems），所以改这里的顺序就等于改菜单顺序。
// 向导覆盖不到的运维类页面（运行状态 / 用户与组织 / 策略预览 / 设置）排在动线之后。
export const routes = [
  { path: '/', name: 'welcome', component: WelcomeView, meta: { titleKey: 'nav.welcome.title', hintKey: 'nav.welcome.hint' } },
  { path: '/connections', name: 'connections', component: ConnectionsView, meta: { titleKey: 'nav.connections.title', hintKey: 'nav.connections.hint' } },
  { path: '/permissions', name: 'permissions', component: PermissionsView, meta: { titleKey: 'nav.permissions.title', hintKey: 'nav.permissions.hint' } },
  { path: '/mcp', name: 'mcp', component: McpView, meta: { titleKey: 'nav.mcp.title', hintKey: 'nav.mcp.hint' } },
  { path: '/ontology', name: 'ontology', component: OntologyView, meta: { titleKey: 'nav.ontology.title', hintKey: 'nav.ontology.hint' } },
  { path: '/connect', name: 'connect', component: ConnectView, meta: { titleKey: 'nav.connect.title', hintKey: 'nav.connect.hint' } },
  // 以下不是向导步骤，归到动线之后；Schema 放在这组最前——连接完最常看的就是它
  { path: '/schema', name: 'schema', component: SchemaView, meta: { titleKey: 'nav.schema.title', hintKey: 'nav.schema.hint' } },
  { path: '/status', name: 'status', component: StatusView, meta: { titleKey: 'nav.status.title', hintKey: 'nav.status.hint' } },
  { path: '/users', name: 'users', component: UsersView, meta: { titleKey: 'nav.users.title', hintKey: 'nav.users.hint' } },
  { path: '/policy', name: 'policy', component: PolicyView, meta: { titleKey: 'nav.policy.title', hintKey: 'nav.policy.hint' } },
  { path: '/settings', name: 'settings', component: SettingsView, meta: { titleKey: 'nav.settings.title', hintKey: 'nav.settings.hint' } },
];

// 桌面端用 file:// 加载打包产物，history 模式在 file:// 下无法工作，故统一走 hash
export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});
