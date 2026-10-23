<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

/**
 * 「一致性体检」面板。
 *
 * 只回答「结构是否自洽」，不回答「业务是否合理」。跳过的检查必须显示数量：
 * 少查几项却显示「没问题」是最误导的一种结论。
 */
const props = defineProps({
  /** `ontology.lint` 的结果；null 表示还没跑过 */
  lint: { type: Object, default: null },
  busy: { type: Boolean, default: false },
});

defineEmits(['run']);

const { t } = useI18n();

/** 体检级别：错误必须修、建议修、只是提示 */
const levelLabel = (level) => t(`ontology.lint.levels.${level}`);

/** 体检时间只用于让人判断结论是否过期，不需要精确到日期 */
const checkedAt = computed(() => {
  const at = props.lint?.checkedAt;
  if (!at) return '';
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleTimeString();
});
</script>

<template>
  <section class="panel">
    <div class="panel__head">
      <span class="panel__title">{{ t('ontology.lint.title') }}</span>
      <el-button size="small" text :loading="busy" @click="$emit('run')">
        {{ lint ? t('ontology.lint.again') : t('ontology.lint.run') }}
      </el-button>
    </div>
    <div class="panel__body">
      <template v-if="lint">
        <p class="summary-row">
          <span
            v-for="level in ['error', 'warn', 'info']"
            :key="level"
            class="tag"
            :class="`tag--${level}`"
          >
            {{ levelLabel(level) }} {{ lint.summary[level] }}
          </span>
          <span class="mono-dim note">{{ t('ontology.lint.checked', { time: checkedAt }) }}</span>
        </p>
        <p v-if="lint.skipped.length" class="mono-dim note">
          {{ t('ontology.lint.skipped', { count: lint.skipped.length }) }}
        </p>
        <ul v-if="lint.issues.length" class="issues">
          <li
            v-for="(issue, index) in lint.issues"
            :key="`${issue.rule}-${index}`"
            class="issue"
          >
            <span class="tag" :class="`tag--${issue.level}`">{{ levelLabel(issue.level) }}</span>
            <span class="issue__body">
              <span class="issue__text">{{ issue.message }}</span>
              <span v-if="issue.hint" class="issue__hint">{{ issue.hint }}</span>
            </span>
          </li>
        </ul>
        <p v-else class="mono-dim note">{{ t('ontology.lint.clean') }}</p>
      </template>
      <p v-else class="mono-dim note">{{ t('ontology.lint.hint') }}</p>
    </div>
  </section>
</template>
