<script setup>
import { computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAppStore } from './stores/app';
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

const navItems = computed(() => routes.filter((item) => item.meta?.titleKey));
const navTitle = (item) => t(item.meta.titleKey);
const navHint = (item) => t(item.meta.hintKey);
const pageTitle = computed(() => (route.meta?.titleKey ? t(route.meta.titleKey) : ''));
const pageHint = computed(() => (route.meta?.hintKey ? t(route.meta.hintKey) : ''));

onMounted(() => store.refreshBackend());
</script>

<template>
  <el-config-provider :locale="elementLocale">
    <div class="shell">
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
        <div class="topbar__meta">
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
