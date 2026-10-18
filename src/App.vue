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
          <div class="brand__name">MCP BUILDER</div>
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
  grid-template-columns: 232px 1fr;
  height: 100%;
}

.rail {
  display: flex;
  flex-direction: column;
  gap: 28px;
  padding: 22px 16px;
  background: var(--ink-800);
  border-right: 1px solid var(--line);
}

.brand {
  display: flex;
  gap: 10px;
  align-items: center;
}

.brand__mark {
  font-size: 22px;
  color: var(--amber);
  line-height: 1;
}

.brand__name {
  font-size: 12px;
  letter-spacing: 0.2em;
  color: var(--text);
}

.brand__tag {
  font-size: 11px;
  color: var(--text-faint);
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav__item {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 9px 12px;
  border-left: 2px solid transparent;
  color: var(--text-dim);
  text-decoration: none;
  transition: background 0.15s ease, color 0.15s ease;
}

.nav__item:hover {
  background: rgba(217, 162, 75, 0.06);
  color: var(--text);
}

.nav__item--active {
  border-left-color: var(--amber);
  background: var(--amber-soft);
  color: var(--amber);
}

.nav__title {
  font-size: 12.5px;
}

.nav__hint {
  font-size: 10px;
  color: var(--text-faint);
  letter-spacing: 0.06em;
}

.rail__foot {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: auto;
  font-size: 11px;
}

.dot--on {
  background: var(--mint);
}

.dot--off {
  background: var(--text-faint);
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
  padding: 18px 26px;
  border-bottom: 1px solid var(--line);
  background: linear-gradient(180deg, rgba(217, 162, 75, 0.05), transparent);
}

.topbar__title {
  font-size: 21px;
  letter-spacing: -0.01em;
}

.topbar__meta {
  display: flex;
  gap: 8px;
  align-items: center;
}

.locale {
  width: 104px;
}

.content {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: var(--gutter) 26px 40px;
}
</style>
