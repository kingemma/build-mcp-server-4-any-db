<script setup>
import { computed } from 'vue';

/**
 * 侧栏图标：内联 stroke SVG。
 *
 * 只为 11 个图标引入 @element-plus/icons-vue 不划算（项目当前没装），
 * 统一 24×24 viewBox + currentColor，颜色直接跟随导航项文字色。
 *
 * 下面的字符串全是本文件里的静态常量，不含任何用户输入，v-html 不会成为注入点。
 */
const ICONS = {
  home: '<path d="M4 10.4 12 4l8 6.4V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z"/>',
  database:
    '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.6"/><rect x="13" y="4" width="7" height="7" rx="1.6"/><rect x="4" y="13" width="7" height="7" rx="1.6"/><rect x="13" y="13" width="7" height="7" rx="1.6"/>',
  terminal:
    '<rect x="3" y="4" width="18" height="16" rx="2.4"/><path d="m7.5 9.5 3 2.5-3 2.5"/><path d="M13 15h4"/>',
  book: '<path d="M5 5.5a2 2 0 0 1 2-2h12v17H7a2 2 0 0 0-2 2z"/><path d="M5 18.5h14"/>',
  link: '<path d="M9.5 14.5 14.5 9.5"/><path d="M8 12.2 6.2 14a3.6 3.6 0 0 0 5 5l1.8-1.8"/><path d="M16 11.8 17.8 10a3.6 3.6 0 0 0-5-5l-1.8 1.8"/>',
  table: '<rect x="3.5" y="4" width="17" height="16" rx="2.2"/><path d="M3.5 9.5h17"/><path d="M9.5 9.5V20"/>',
  pulse: '<path d="M3 12h4l2.4-6 3.9 12L16 12h5"/>',
  users:
    '<circle cx="9.2" cy="8.4" r="3.2"/><path d="M3.6 20a5.6 5.6 0 0 1 11.2 0"/><path d="M16.2 5.6a3.1 3.1 0 0 1 0 6"/><path d="M17.6 20a5.4 5.4 0 0 0-2-4.1"/>',
  'file-check':
    '<path d="M6 3.5h7.5L18 8v12.5H6z"/><path d="M13.5 3.5V8H18"/><path d="m9.2 14.2 1.9 1.9 3.6-3.6"/>',
  sliders:
    '<path d="M4 8h8"/><path d="M16 8h4"/><circle cx="14" cy="8" r="2.2"/><path d="M4 16h4"/><path d="M12 16h8"/><circle cx="10" cy="16" r="2.2"/>',
};

const props = defineProps({
  /** 图标名，与 route meta.icon 对应；未知名字回落到九宫格 */
  name: { type: String, required: true },
});

const markup = computed(() => ICONS[props.name] ?? ICONS.grid);
</script>

<template>
  <svg
    class="nav-icon"
    viewBox="0 0 24 24"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    v-html="markup"
  />
</template>

<style scoped>
.nav-icon {
  flex: none;
  /* 图标与左侧文字基线对齐：13.5px 标题的视觉中心略低于几何中心 */
  display: block;
}
</style>
