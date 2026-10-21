<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useI18n } from 'vue-i18n';
import { useAppStore } from '../stores/app';

const store = useAppStore();
const router = useRouter();
const { t } = useI18n();

const demoReport = ref(null);
const isDemoLoading = ref(false);
const checks = ref([]);
const isChecking = ref(false);

/**
 * 三步状态自己算：用户不该为了知道自己进行到哪一步而点进每一页。
 */
const steps = computed(() => [
  {
    key: '1',
    done: store.connections.length > 0 || store.isRunning,
    route: '/connections',
    label: t('welcome.step1'),
    hint: t('welcome.step1Hint'),
  },
  {
    key: '2',
    done: store.roleNames.length > 0,
    route: '/permissions',
    label: t('welcome.step2'),
    hint: t('welcome.step2Hint'),
  },
  {
    key: '3',
    done: Boolean(store.clientConfig?.endpoint),
    route: '/connect',
    label: t('welcome.step3'),
    hint: t('welcome.step3Hint'),
  },
]);

async function runDemo() {
  isDemoLoading.value = true;
  try {
    demoReport.value = await store.bootstrapDemo();
    ElMessage.success(t('welcome.demoReady'));
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    isDemoLoading.value = false;
  }
}

async function runDiagnostics() {
  isChecking.value = true;
  try {
    checks.value = await store.runDiagnostics();
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    isChecking.value = false;
  }
}

function go(route) {
  router.push(route);
}

onMounted(() => {
  // 第三步的完成标记取自接入配置，进来就顺手拉一次
  if (store.isRunning) store.loadClientConfig();
});
</script>

<template>
  <div class="stack">
    <section class="panel hero">
      <div class="hero__body">
        <p class="eyebrow">{{ t('welcome.eyebrow') }}</p>
        <h2 class="hero__title">{{ t('welcome.title') }}</h2>
        <p class="hero__tagline">{{ t('welcome.tagline') }}</p>
        <div class="hero__actions">
          <el-button type="primary" :loading="isDemoLoading" @click="runDemo">
            {{ t('welcome.tryDemo') }}
          </el-button>
          <el-button @click="go('/connect')">{{ t('welcome.goConnect') }}</el-button>
          <el-button @click="store.openGuide()">{{ t('welcome.openGuide') }}</el-button>
        </div>
        <p class="hero__hint">{{ t('welcome.tryDemoHint') }}</p>
      </div>
    </section>

    <section class="panel">
      <div class="panel__head">
        <span class="panel__title">{{ t('welcome.steps') }}</span>
        <span class="eyebrow">{{ t('welcome.stepsHint') }}</span>
      </div>
      <div class="panel__body steps">
        <div v-for="step in steps" :key="step.key" class="step" @click="go(step.route)">
          <span class="pill" :class="step.done ? 'pill--on' : 'pill--idle'">
            <span class="dot" />{{ step.done ? t('welcome.done') : t('welcome.todo') }}
          </span>
          <div class="step__text">
            <strong class="step__label">{{ step.key }}. {{ step.label }}</strong>
            <p class="step__hint">{{ step.hint }}</p>
          </div>
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="panel__head">
        <span class="panel__title">{{ t('welcome.demoTitle') }}</span>
        <el-button size="small" :loading="isDemoLoading" @click="runDemo">
          {{ t('welcome.tryDemo') }}
        </el-button>
      </div>
      <div class="panel__body">
        <p class="note">{{ t('welcome.demoHint') }}</p>
        <div v-if="demoReport" class="facts">
          <div class="fact">
            <span class="eyebrow">{{ t('welcome.demoDatabases') }}</span>
            <span class="fact__value">{{ demoReport.databases.join(', ') }}</span>
          </div>
          <div class="fact">
            <span class="eyebrow">{{ t('welcome.demoRoles') }}</span>
            <span class="fact__value">{{ demoReport.roles.join(', ') }}</span>
          </div>
          <div class="fact">
            <span class="eyebrow">{{ t('welcome.demoTables') }}</span>
            <span class="fact__value">{{ demoReport.tables.join(', ') }}</span>
          </div>
          <div class="fact">
            <span class="eyebrow">{{ t('welcome.demoEndpoint') }}</span>
            <span class="fact__value">{{ demoReport.status?.baseUrl ?? t('common.dash') }}</span>
          </div>
        </div>
        <p v-else class="mono-dim">{{ t('welcome.demoEmpty') }}</p>
        <div v-if="demoReport" class="row">
          <el-button size="small" type="primary" @click="go('/schema')">
            {{ t('welcome.demoGoSchema') }}
          </el-button>
          <el-button size="small" @click="go('/permissions')">
            {{ t('welcome.demoGoPolicy') }}
          </el-button>
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="panel__head">
        <span class="panel__title">{{ t('welcome.diagnostics') }}</span>
        <el-button size="small" :loading="isChecking" @click="runDiagnostics">
          {{ t('welcome.diagnosticsRun') }}
        </el-button>
      </div>
      <div class="panel__body">
        <p class="note">{{ t('welcome.diagnosticsHint') }}</p>
        <ul v-if="checks.length" class="checks">
          <li v-for="check in checks" :key="check.id" class="check">
            <span
              class="pill"
              :class="check.status === 'ok' ? 'pill--on' : check.status === 'skip' ? 'pill--idle' : 'pill--warn'"
            >
              <span class="dot" />{{ t(`welcome.diag.${check.status}`) }}
            </span>
            <strong class="check__id">{{ t(`welcome.diag.${check.id}`) }}</strong>
            <code class="check__detail">{{ check.detail }}</code>
          </li>
        </ul>
        <p v-else class="mono-dim">{{ t('welcome.diagnosticsEmpty') }}</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.stack {
  display: grid;
  gap: var(--gutter);
}

.hero
{
  padding: 10px;
}


.hero__body {
  display: flex;
  flex-direction: column;
  gap: 10px;

}

.hero__title {
  margin: 0;
  font-family: var(--serif);
  font-size: clamp(22px, 3vw, 30px);
  line-height: 1.3;
  color: var(--ink);
}

.hero__tagline {
  max-width: 640px;
  margin: 0;
  font-size: 15px;
  line-height: 1.8;
  color: var(--text-dim);
}

.hero__actions {
  display: flex;
  gap: 12px;
  margin-top: 8px;
}

.hero__hint {
  margin: 0;
  font-size: var(--fs-note);
  color: var(--text-faint);
}

.steps {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
}

.step {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  cursor: pointer;
  background: var(--ink-700);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
}

.step:hover {
  border-color: var(--line);
}

.step__label {
  font-size: 15px;
  color: var(--ink);
}

.step__hint {
  margin: 4px 0 0;
  font-size: var(--fs-note);
  line-height: 1.7;
  color: var(--text-dim);
}

.facts {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  margin: 12px 0;
}

.fact {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px;
  background: var(--ink-700);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
}

.fact__value {
  font-family: var(--mono);
  font-size: 13px;
  color: var(--accent);
  word-break: break-all;
}

.row {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.note {
  margin: 0;
  font-size: var(--fs-note);
  line-height: 1.7;
  color: var(--text-dim);
}

.checks {
  display: grid;
  gap: 8px;
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
}

.check {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 10px 12px;
  background: var(--ink-700);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
}

.check__id {
  flex-shrink: 0;
  min-width: 96px;
  font-size: 13px;
  color: var(--ink);
}

.check__detail {
  overflow: hidden;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text-dim);
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
