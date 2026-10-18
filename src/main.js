import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';

import App from './App.vue';
import { router } from './router';
import i18n from './i18n';
import './styles/main.css';

createApp(App).use(createPinia()).use(router).use(i18n).use(ElementPlus).mount('#app');
