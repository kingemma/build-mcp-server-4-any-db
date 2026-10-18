import zhCn from 'element-plus/es/locale/lang/zh-cn';
import en from 'element-plus/es/locale/lang/en';

/** 可切换的语言；label 用各自语言写，切换器里不翻译 */
export const SUPPORTED_LOCALES = [
  { value: 'zh-CN', label: '中文' },
  { value: 'en-US', label: 'English' },
];

/** Element Plus 组件内置文案（对话框按钮、空状态等）按语言取 */
export const ELEMENT_LOCALES = {
  'zh-CN': zhCn,
  'en-US': en,
};
