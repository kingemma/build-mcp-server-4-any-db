import { createI18n } from 'vue-i18n';

import zhCN from './locales/zh-CN';
import enUS from './locales/en-US';
import { SUPPORTED_LOCALES } from './locales';

const STORAGE_KEY = 'mcpb.locale';

/**
 * 初始语言：手选过的优先，其次跟随系统，最后回落到 zh-CN。
 *
 * 桌面端与浏览器都可读 localStorage；Electron 里 localStorage 是持久的，
 * 所以用户切一次就一直是那个语言。
 *
 * @returns {string}
 */
function detectLocale() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (SUPPORTED_LOCALES.some((item) => item.value === saved)) return saved;
  return navigator.language?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
}

export const i18n = createI18n({
  legacy: false,
  locale: detectLocale(),
  fallbackLocale: 'zh-CN',
  messages: { 'zh-CN': zhCN, 'en-US': enUS },
});

/**
 * 切换语言并持久化。
 *
 * @param {string} locale zh-CN / en-US
 */
export function setLocale(locale) {
  if (!SUPPORTED_LOCALES.some((item) => item.value === locale)) return;
  i18n.global.locale.value = locale;
  localStorage.setItem(STORAGE_KEY, locale);
  document.documentElement.lang = locale;
}

/** @returns {string} 当前语言 */
export function currentLocale() {
  return i18n.global.locale.value;
}

export default i18n;
