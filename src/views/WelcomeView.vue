<script setup>
import { computed, onMounted, ref, watch } from 'vue';
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

/** 演示会按三个库的 schema 生成本体论：这里把每个库的条目数摊开给用户看 */
const ONTOLOGY_KINDS = ['concept', 'term', 'relation', 'rule', 'metric'];
const demoOntology = computed(() => {
  const byDatabase = demoReport.value?.ontology?.byDatabase;
  if (!byDatabase) return '';
  return Object.entries(byDatabase)
    .map(([database, counts]) => {
      const parts = ONTOLOGY_KINDS.filter((kind) => counts[kind]).map(
        (kind) => `${counts[kind]} ${t(`ontology.kinds.${kind}`)}`
      );
      return `${database}: ${parts.join(' · ')}`;
    })
    .join('    ');
});

/**
 * 步骤 2 的判定依据分三层：生效配置 → 历史快照 → 未知。
 *
 * 停止态读不到 config.current，但 dev.yml 里留着 GraphJin 回写的 access，
 * 后端 config.file 能读出来（store.loadCurrentPolicy 会自动走这条）。
 * 文件也读不出来时退回历史快照；连快照都没有，只能说「看不到」，
 * 不能断言「没做」—— 那会让人白重做一遍。
 */
const policyState = computed(() => {
  if (Object.keys(store.policyRaw ?? {}).length > 0) return 'done';
  if (store.isRunning || store.hasLoadedPolicy) return 'todo';
  return store.snapshots.length > 0 ? 'done' : 'unknown';
});

/**
 * 三步状态自己算：用户不该为了知道自己进行到哪一步而点进每一页。
 *
 * 每张卡都取「真的发生了」的证据，不拿间接信号凑数：
 * - 连接：已落盘的连接，或实例正在跑（跑起来就一定带着一份可用连接）
 * - 权限：生效配置里真的有 grants；建了角色但没配规则不算完成
 * - 接入：配置只在实例运行时才有效，停了就不是「已完成」
 */
const steps = computed(() => [
  {
    key: '1',
    state: store.isRunning || store.connections.length > 0 ? 'done' : 'todo',
    route: '/connections',
    label: t('welcome.step1'),
    hint: t('welcome.step1Hint'),
  },
  {
    key: '2',
    state: policyState.value,
    route: '/permissions',
    label: t('welcome.step2'),
    hint: t('welcome.step2Hint'),
  },
  {
    key: '3',
    state: store.isRunning && Boolean(store.clientConfig?.endpoint) ? 'done' : 'todo',
    route: '/connect',
    label: t('welcome.step3'),
    hint: t('welcome.step3Hint'),
  },
]);

/** 三态配色：unknown 走灰底 + 虚线边框，和「待完成」的实线灰分开 */
const STATE_PILL = {
  done: ['pill--on'],
  todo: ['pill--idle'],
  unknown: ['pill--idle', 'step__pill--unknown'],
};

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

/**
 * 三张卡要用的 state 平时由各页面自己加载，直接落在欢迎页（尤其是刷新）时还是空的，
 * 卡片会全部显示「待完成」。这里进来就把判定依据补齐。
 *
 * 冷启动时 App.vue 的 refreshBackend() 还没回来，isRunning 仍是 false：
 * 所以必须 watch 运行态再补一次，不能只在 onMounted 里做判断。
 */
async function syncProgress() {
  // 运行态是别的页面改的（启动 / 停止都发生在连接页、状态页），进来先对齐一次，
  // 否则卡片会照着上一页残留的状态渲染
  await store.refreshStatus();
  const tasks = [
    store.loadConnections(),
    // 停止态读不到生效配置，快照是最后一道离线证据
    store.loadSnapshots(),
    store.ensureSchemaLoaded(),
  ];
  if (store.isRunning) tasks.push(store.loadClientConfig());
  // 停止时 ensureSchemaLoaded 直接返回，权限判定得单独从 dev.yml 读一次
  else tasks.push(store.loadCurrentPolicy());
  // 单个请求失败不该让另外两张卡跟着空掉
  await Promise.allSettled(tasks);
}

onMounted(syncProgress);
watch(() => store.isRunning, syncProgress);
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
          <span class="pill" :class="STATE_PILL[step.state]">
            <span class="dot" />{{ t(`welcome.${step.state}`) }}
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
            <span class="eyebrow">{{ t('welcome.demoOntology') }}</span>
            <span class="fact__value">{{ demoOntology || t('common.dash') }}</span>
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
          <el-button size="small" @click="go('/ontology')">
            {{ t('welcome.demoGoOntology') }}
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

/* 「未确认」与「待完成」同底色，用虚线边框说明前者是看不到、后者是没做 */
.step__pill--unknown {
  border-style: dashed;
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
