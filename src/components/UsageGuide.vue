<script setup>
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAppStore } from '../stores/app';

const store = useAppStore();
const router = useRouter();
const { t } = useI18n();

/** 关闭走 store.closeGuide：顺手写 localStorage，下次启动不再自动弹 */
const visible = computed({
  get: () => store.guideOpen,
  set: (value) => (value ? store.openGuide() : store.closeGuide()),
});

/**
 * 步骤顺序就是用户动线：连接 → 配权限 → 验证 → 本体论 → 接入 AI。
 *
 * 本体论排在接入之前：AI 客户端一旦接上就会开始问业务问题，语境得先就位，
 * 否则前几步做得再对，AI 也只是个会查表的东西。
 */
const STEPS = [
  { key: 'connect', path: '/connections' },
  { key: 'permissions', path: '/permissions' },
  { key: 'verify', path: '/mcp' },
  { key: 'ontology', path: '/ontology' },
  { key: 'connectAi', path: '/connect' },
];

function go(path) {
  store.closeGuide();
  router.push(path);
}
</script>

<template>
  <el-drawer
    v-model="visible"
    class="guide-drawer"
    :title="t('guide.title')"
    size="440px"
    destroy-on-close
  >
    <p class="guide__intro">{{ t('guide.intro') }}</p>

    <ol class="guide__steps">
      <li v-for="(step, index) in STEPS" :key="step.key" class="guide-step">
        <div class="guide-step__head">
          <span class="guide-step__index">{{ index + 1 }}</span>
          <span class="guide-step__title">{{ t(`guide.steps.${step.key}.title`) }}</span>
        </div>
        <p class="guide-step__desc">{{ t(`guide.steps.${step.key}.desc`) }}</p>
        <el-button size="small" @click="go(step.path)">
          {{ t(`guide.steps.${step.key}.go`) }}
        </el-button>
      </li>
    </ol>

    <p class="guide__tip">{{ t('guide.tip') }}</p>

    <template #footer>
      <div class="guide__foot">
        <span class="guide__hint mono-dim">{{ t('guide.reopenHint') }}</span>
        <el-button @click="store.closeGuide()">{{ t('guide.close') }}</el-button>
      </div>
    </template>
  </el-drawer>
</template>

<style scoped>
.guide__intro {
  margin: 0 0 18px;
  font-size: var(--fs-note);
  line-height: 1.8;
  color: var(--text-dim);
}

.guide__steps {
  display: grid;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
  counter-reset: guide-step;
}

.guide-step {
  padding: 14px 16px;
  background: var(--ink-700);
  border: 1px solid var(--line);
  border-radius: 10px;
}

.guide-step__head {
  display: flex;
  gap: 10px;
  align-items: center;
}

.guide-step__index {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  font-family: var(--mono);
  font-size: 12px;
  color: #ffffff;
  background: var(--accent-strong);
  border-radius: 999px;
  line-height: 1;
}

.guide-step__title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.guide-step__desc {
  margin: 10px 0 12px;
  font-size: var(--fs-note);
  line-height: 1.75;
  color: var(--text-dim);
}

.guide__tip {
  margin: 18px 0 0;
  padding: 12px 14px;
  font-size: var(--fs-note);
  line-height: 1.75;
  color: var(--text-dim);
  background: var(--accent-soft);
  border-radius: 10px;
}

.guide__foot {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
}

.guide__hint {
  font-size: 12px;
}
</style>
