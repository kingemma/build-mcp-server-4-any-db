<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAppStore } from './stores/app';
import NavIcon from './components/NavIcon.vue';
import UsageGuide from './components/UsageGuide.vue';
// 品牌标记用产品图标的 68×68 缩略图：源图 electron/icon.png 是 512×512/417 KB，
// 这里只显示 34px，缩略图按 2 倍图导出，HiDPI 屏也不糊
import brandIcon from './assets/brand-icon.png';
import { routes } from './router';
import { ELEMENT_LOCALES, SUPPORTED_LOCALES } from './locales';
import i18n, { setLocale } from './i18n';

const store = useAppStore();
const route = useRoute();
const { t } = useI18n();

/** i18n.global.locale 是 ref，computed 能跟踪它，切语言后整棵树重渲染 */
const locale = computed({
  get: () => i18n.global.locale.value,
  set: (value) => setLocale(value),
});
const elementLocale = computed(() => ELEMENT_LOCALES[locale.value]);

/** 品牌文案：侧栏 brand 与 Windows 自绘标题带共用一份，避免两处各写一遍后漂移 */
const BRAND_NAME = 'MCP Server with Ontology Build';
const BRAND_TAG = 'any database, one console';

/** 产品名：没打开项目时窗口标题只用它 */
const APP_TITLE = BRAND_NAME;

/** 窗口标题里的项目名，来源是运行实例 dev.yml 的 app_name */
const projectName = computed(() => store.status?.appName || APP_TITLE);

/**
 * 标题三处同步：浏览器标签、Electron 原生标题（macOS / Linux 可见）、
 * 自绘标题带（Windows 隐藏原生标题栏，只能画在页面上）。
 */
watch(
  projectName,
  (name) => {
    const full = name === APP_TITLE ? APP_TITLE : `${name} — ${APP_TITLE}`;
    document.title = full;
    window.mcpBuilder?.setProjectName?.(name === APP_TITLE ? '' : name);
  },
  { immediate: true }
);

const navItems = computed(() => routes.filter((item) => item.meta?.titleKey));
const navTitle = (item) => t(item.meta.titleKey);
const navHint = (item) => t(item.meta.hintKey);
const pageTitle = computed(() => (route.meta?.titleKey ? t(route.meta.titleKey) : ''));
const pageHint = computed(() => (route.meta?.hintKey ? t(route.meta.hintKey) : ''));

/**
 * Windows 用 titleBarOverlay 自绘系统按钮，窗口顶部会多出 40px 控制区。
 * 浏览器模式和 macOS 没有这个 API，值为 false，布局保持原样。
 */
const hasTitlebarOverlay = ref(false);
let overlayApi = null;

const syncTitlebarOverlay = (visible) => {
  hasTitlebarOverlay.value = Boolean(visible);
};

const onOverlayGeometryChange = (event) => syncTitlebarOverlay(event.visible);

onMounted(() => {
  store.refreshBackend();
  store.autoOpenGuide();

  overlayApi = window.navigator.windowControlsOverlay ?? null;
  if (!overlayApi) return;
  syncTitlebarOverlay(overlayApi.visible);
  overlayApi.addEventListener('geometrychange', onOverlayGeometryChange);
});

onBeforeUnmount(() => {
  overlayApi?.removeEventListener('geometrychange', onOverlayGeometryChange);
});
</script>

<template>
  <el-config-provider :locale="elementLocale">
    <div
      class="shell"
      :class="{
        'shell--titlebar': hasTitlebarOverlay,
        'shell--rail-collapsed': store.railCollapsed,
      }"
    >
    <!-- 自绘标题栏：系统按钮画在这条 40px 带上，整条可拖动窗口。
         内容与侧栏 brand 同源，只有 40px 高放不下两行，名称与标语横排 -->
    <div v-if="hasTitlebarOverlay" class="titlebar">
      <img class="brand__mark" :src="brandIcon" alt="" draggable="false" />
      <span class="brand__name">{{ BRAND_NAME }}</span>
      <span class="brand__tag serif">{{ BRAND_TAG }}</span>
    </div>
    <aside class="rail" :class="{ 'rail--collapsed': store.railCollapsed }">
      <nav class="nav">
        <el-tooltip
          v-for="item in navItems"
          :key="item.path"
          placement="right"
          :offset="10"
          :show-after="120"
          :disabled="!store.railCollapsed"
          :content="`${navTitle(item)} · ${navHint(item)}`"
        >
          <RouterLink
            :to="item.path"
            class="nav__item"
            active-class="nav__item--active"
            :aria-label="navTitle(item)"
          >
            <NavIcon :name="item.meta.icon" />
            <span class="nav__text">
              <span class="nav__title">{{ navTitle(item) }}</span>
              <span class="nav__hint">{{ navHint(item) }}</span>
            </span>
          </RouterLink>
        </el-tooltip>
      </nav>

      <div class="rail__foot">
        <span class="dot" :class="store.isRunning ? 'dot--on' : 'dot--off'" />
        <span v-show="!store.railCollapsed" class="mono-dim">
          {{ store.isRunning ? t('app.live') : t('app.down') }}
        </span>
      </div>

      <button
        class="rail__toggle"
        type="button"
        :aria-label="t('app.toggleRail')"
        :title="t('app.toggleRail')"
        :aria-expanded="!store.railCollapsed"
        @click="store.toggleRail()"
      >
        <svg
          class="rail__toggle-icon"
          viewBox="0 0 24 24"
          width="15"
          height="15"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="m15 6-6 6 6 6" />
        </svg>
      </button>
    </aside>

    <main class="stage">
      <header class="topbar">
        <div>
          <div class="eyebrow">{{ pageHint }}</div>
          <h1 class="topbar__title">{{ pageTitle }}</h1>
        </div>
        <div class="topbar__meta no-drag">
          <!-- <el-button size="small" class="guide-open-btn" @click="store.openGuide()">
            {{ t('guide.open') }}
          </el-button> -->
          <el-select v-model="locale" size="small" class="locale" :aria-label="t('app.language')">
            <el-option
              v-for="item in SUPPORTED_LOCALES"
              :key="item.value"
              :label="item.label"
              :value="item.value"
            />
          </el-select>
          <span class="pill" :class="store.isBackendUp ? 'pill--on' : 'pill--off'">
            <span class="dot" />
            {{ t('app.backend', { port: store.port || t('app.backendMissing') }) }}
          </span>
          <span v-if="store.isRunning" class="pill pill--idle">
            {{ t('app.port', { port: store.status.port }) }}
          </span>
        </div>
      </header>

      <section class="content">
        <RouterView />
      </section>
    </main>
    <UsageGuide />

    <button
      class="guide-fab"
      type="button"
      :aria-label="t('guide.open')"
      @click="store.openGuide()"
    >
      <span class="guide-fab__icon" aria-hidden="true">?</span>
      <span class="guide-fab__label">{{ t('guide.open') }}</span>
    </button>
    </div>
  </el-config-provider>
</template>

<style scoped>
.shell {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: 248px minmax(0, 1fr);
  /* 行高必须锁成容器高度：留成 auto 会被内容撑高，overflow 就落到窗口上，
     侧栏跟着整页一起滚（.content 自己的 overflow 永远不触发） */
  grid-template-rows: minmax(0, 1fr);
  height: 100%;
  transition: grid-template-columns 0.16s ease;
}

.shell--rail-collapsed {
  grid-template-columns: 64px minmax(0, 1fr);
}

/* 40px 与 electron/main.js 的 TITLEBAR_HEIGHT 一致 */
.shell--titlebar {
  padding-top: 40px;
}

.titlebar {
  position: fixed;
  top: 0;
  right: 0;
  left: 0;
  z-index: 30;
  display: flex;
  gap: 10px;
  align-items: center;
  height: 40px;
  /* 右侧要让开系统自绘的最小化 / 最大化 / 关闭按钮；
     左侧 22px 与侧栏 brand 对齐（rail 14 + brand 8） */
  padding: 0 150px 0 22px;
  overflow: hidden;
  white-space: nowrap;
  background: #ffffff;
  -webkit-app-region: drag;
}

/* 侧栏 brand 里标语竖排在下一行，标题带只有 40px 高：横排、去掉那条上边距 */
.titlebar .brand__tag {
  margin-top: 0;
}

/* 窗口窄到放不下时先省略标语，别压到系统按钮 */
.titlebar .brand__name,
.titlebar .brand__tag {
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 顶栏留作拖拽区，里面的下拉框 / 状态胶囊要能点 */
.no-drag {
  -webkit-app-region: no-drag;
}

.rail {
  display: flex;
  flex-direction: column;
  gap: 26px;
  min-height: 0;
  padding: 24px 14px 16px;
  overflow: hidden;
  background: linear-gradient(180deg, #ffffff 0%, var(--rail-bg) 56%, #f1f7ff 100%);
  border-right: 1px solid var(--rail-line);
  color: var(--rail-text);
}

/* 折叠态只有 64px：左右不留内边距，图标自己居中 */
.rail--collapsed {
  gap: 18px;
  padding: 24px 0 16px;
}

.brand {
  display: flex;
  gap: 11px;
  align-items: center;
  padding: 0 8px;
  min-width: 0;
}

.rail--collapsed .brand {
  justify-content: center;
  padding: 0;
}

.brand__text {
  min-width: 0;
}

.brand__mark {
  flex: none;
  width: 30px;
  height: 30px;
  border-radius: 10px;
}

.brand__name {
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--rail-text);
}

.brand__tag {
  margin-top: 2px;
  font-size: 11.5px;
  color: var(--rail-faint);
}

/* 菜单区自己滚：窗口矮到放不下 11 项时，只有这里出滚动条，brand 与底部状态钉住 */
.nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}

.rail--collapsed .nav {
  align-items: center;
  gap: 6px;
}

.nav__item {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 9px 12px;
  border-radius: 8px;
  color: var(--rail-dim);
  text-decoration: none;
  transition: background 0.15s ease, color 0.15s ease, box-shadow 0.15s ease;
}

.nav__item:hover {
  background: var(--rail-bg-soft);
  color: var(--rail-text);
}

.nav__item--active {
  background: var(--accent-soft);
  box-shadow: inset 3px 0 0 var(--accent);
  color: var(--accent-strong);
}

/* 折叠态：42×42 方块只放图标。文案用 CSS 藏起来而不是 v-if ——
   UI 冒烟的「菜单顺序」断言读的就是 .nav__title 的文字 */
.rail--collapsed .nav__item {
  width: 42px;
  height: 42px;
  padding: 0;
  justify-content: center;
}

.rail--collapsed .nav__text {
  display: none;
}

.nav__text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.nav__title {
  font-size: 13.5px;
  font-weight: 500;
  white-space: nowrap;
}

.nav__hint {
  font-size: 11px;
  color: var(--rail-faint);
  letter-spacing: 0.01em;
  white-space: nowrap;
}

.nav__item--active .nav__hint {
  color: rgba(29, 78, 216, 0.72);
}

.rail__foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: auto;
  padding: 16px 10px 4px;
  border-top: 1px solid var(--rail-line);
  font-size: 11.5px;
  color: var(--rail-dim);
}

.rail--collapsed .rail__foot {
  justify-content: center;
  margin: 0 10px;
  padding: 14px 0 4px;
}

/* 折叠 / 展开按钮：折叠态在底部居中，展开态靠左 */
.rail__toggle {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  padding: 0;
  color: var(--rail-dim);
  background: transparent;
  border: 1px solid var(--rail-line);
  border-radius: 8px;
  cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease;
}

.rail__toggle:hover {
  color: var(--accent-strong);
  background: var(--rail-bg-soft);
  border-color: var(--accent-soft);
}

.rail--collapsed .rail__toggle {
  margin: 0 auto;
}

/* 折叠时箭头指向右侧，展开时指回左侧 */
.rail__toggle-icon {
  transition: transform 0.16s ease;
}

.rail--collapsed .rail__toggle-icon {
  transform: rotate(180deg);
}

.dot--on {
  background: #16a34a;
  box-shadow: 0 0 0 3px rgba(22, 163, 74, 0.14);
}

.dot--off {
  background: var(--rail-faint);
}

.stage {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  /* 滚动交给 .content，舞台本身不滚 */
  overflow: hidden;
}

.topbar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  padding: 20px 32px;
  border-bottom: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.86);
  backdrop-filter: blur(10px);
  -webkit-app-region: drag;
}

.topbar__title {
  margin-top: 3px;
  font-size: 24px;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: var(--text);
}

.topbar__meta {
  display: flex;
  gap: 8px;
  align-items: center;
}

.locale {
  width: 112px;
}

.content {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 24px 32px 48px;
}

.content > * {
  width: 100%;
  max-width: 1480px;
  margin-right: auto;
  margin-left: auto;
}

/* 右下角常驻悬浮：随时打开使用向导；层级低于抽屉遮罩（约 2000），向导打开时自动被遮住 */
.guide-fab {
  position: fixed;
  right: 32px;
  bottom: 32px;
  z-index: 40;
  display: inline-flex;
  gap: 8px;
  align-items: center;
  padding: 11px 17px;
  font-size: 13px;
  font-weight: 600;
  color: #ffffff;
  background: linear-gradient(145deg, #3b82f6, var(--accent-strong));
  border: none;
  border-radius: 999px;
  box-shadow: 0 12px 26px -10px rgba(29, 78, 216, 0.72);
  cursor: pointer;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}

.guide-fab:hover {
  transform: translateY(-1px);
  box-shadow: 0 16px 30px -10px rgba(29, 78, 216, 0.82);
}

.guide-fab__icon {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  font-size: 12px;
  font-weight: 700;
  background: rgba(255, 255, 255, 0.22);
  border-radius: 999px;
}

@media (max-width: 1100px) {
  .shell {
    grid-template-columns: 216px minmax(0, 1fr);
  }

  /* 窄窗口只压缩展开态；折叠态保持 64px，否则图标会被挤掉 */
  .shell--rail-collapsed {
    grid-template-columns: 64px minmax(0, 1fr);
  }

  .topbar,
  .content {
    padding-right: 22px;
    padding-left: 22px;
  }
}
</style>
