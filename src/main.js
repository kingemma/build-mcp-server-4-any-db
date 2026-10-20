/**
 * MCP Server Build 渲染进程入口。
 *
 * @author Zhen (Evan) Wang <18901599114@163.com> — Tel / WeChat: +86 18901599114
 */

import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';

// 字体随包分发：不再依赖 fonts.googleapis.com，断网也能完整显示
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import '@fontsource/ibm-plex-mono/latin-600.css';
import '@fontsource/ibm-plex-serif/latin-500-italic.css';

import App from './App.vue';
import { router } from './router';
import i18n from './i18n';
import './styles/main.css';

createApp(App).use(createPinia()).use(router).use(i18n).use(ElementPlus).mount('#app');
