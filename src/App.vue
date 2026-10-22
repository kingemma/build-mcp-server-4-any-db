<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAppStore } from './stores/app';
import UsageGuide from './components/UsageGuide.vue';
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

/** 产品名：没打开项目时窗口标题只用它 */
const APP_TITLE = 'MCP Server Build';

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
    <div class="shell" :class="{ 'shell--titlebar': hasTitlebarOverlay }">
    <!-- 自绘标题栏：系统按钮画在这条 40px 带上，整条可拖动窗口 -->
    <div v-if="hasTitlebarOverlay" class="titlebar">
      <span class="titlebar__project">{{ projectName }}</span>
    </div>
    <aside class="rail">
      <div class="brand">
        <div class="brand__mark">◈</div>
        <div>
          <div class="brand__name">MCP Server Build</div>
          <div class="brand__tag serif">any database, one console</div>
        </div>
      </div>

      <nav class="nav">
        <RouterLink
          v-for="item in navItems"
          :key="item.path"
          :to="item.path"
          class="nav__item"
          active-class="nav__item--active"
        >
          <span class="nav__title">{{ navTitle(item) }}</span>
          <span class="nav__hint">{{ navHint(item) }}</span>
        </RouterLink>
      </nav>

      <div class="rail__foot">
        <span class="dot" :class="store.isRunning ? 'dot--on' : 'dot--off'" />
        <span class="mono-dim">{{ store.isRunning ? t('app.live') : t('app.down') }}</span>
      </div>
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
  height: 100%;
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
  align-items: center;
  justify-content: center;
  height: 40px;
  /* 右侧要让开系统自绘的最小化 / 最大化 / 关闭按钮 */
  padding: 0 150px;
  background: #ffffff;
  -webkit-app-region: drag;
}

/* 项目名居中，过长时省略，避免压到系统按钮 */
.titlebar__project {
  overflow: hidden;
  font-size: 12px;
  letter-spacing: 0.02em;
  color: var(--text-dim);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 顶栏留作拖拽区，里面的下拉框 / 状态胶囊要能点 */
.no-drag {
  -webkit-app-region: no-drag;
}

.rail {
  display: flex;
  flex-direction: column;
  gap: 30px;
  padding: 24px 14px;
  background: linear-gradient(180deg, #ffffff 0%, var(--rail-bg) 56%, #f1f7ff 100%);
  border-right: 1px solid var(--rail-line);
  color: var(--rail-text);
}

.brand {
  display: flex;
  gap: 11px;
  align-items: center;
  padding: 0 8px;
}

.brand__mark {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  font-size: 19px;
  color: #ffffff;
  background: linear-gradient(145deg, #3b82f6, var(--accent-strong));
  border-radius: 10px;
  box-shadow: 0 6px 16px -8px rgba(29, 78, 216, 0.75);
  line-height: 1;
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

.nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.nav__item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
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

.nav__title {
  font-size: 13.5px;
  font-weight: 500;
}

.nav__hint {
  font-size: 11px;
  color: var(--rail-faint);
  letter-spacing: 0.01em;
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

  .topbar,
  .content {
    padding-right: 22px;
    padding-left: 22px;
  }
}
</style>
