<script setup>
import { useI18n } from 'vue-i18n';

/**
 * 「样例评测」面板。
 *
 * 三条确定性核对（结构 / 可执行 / 覆盖）。面板上的说明必须写明它**不评价模型**——
 * 否则「评测通过」会被读成「AI 很懂业务」，那是另一种谎。
 */
defineProps({
  /** `ontology.eval` 的结果；null 表示还没跑过 */
  evaluation: { type: Object, default: null },
  busy: { type: Boolean, default: false },
});

defineEmits(['run']);

const { t } = useI18n();

/** 评测状态文案（通过 / 警告 / 失败 / 跳过） */
const statusLabel = (status) => t(`ontology.eval.statuses.${status}`);
</script>

<template>
  <section class="panel">
    <div class="panel__head">
      <span class="panel__title">{{ t('ontology.eval.title') }}</span>
      <el-button size="small" text :loading="busy" @click="$emit('run')">
        {{ evaluation ? t('ontology.eval.again') : t('ontology.eval.run') }}
      </el-button>
    </div>
    <div class="panel__body">
      <p class="mono-dim note">{{ t('ontology.eval.hint') }}</p>
      <template v-if="evaluation">
        <p class="summary-row">
          <span
            v-for="status in ['pass', 'warn', 'fail', 'skipped']"
            :key="status"
            class="tag"
            :class="`tag--${status}`"
          >
            {{ statusLabel(status) }} {{ evaluation.summary[status] }}
          </span>
        </p>
        <p v-if="!evaluation.results.length" class="mono-dim note">
          {{ t('ontology.eval.empty') }}
        </p>
        <p v-else-if="evaluation.note" class="mono-dim note">{{ evaluation.note }}</p>
        <ul v-if="evaluation.results.length" class="issues">
          <li v-for="result in evaluation.results" :key="result.id" class="issue">
            <span class="tag" :class="`tag--${result.status}`">
              {{ statusLabel(result.status) }}
            </span>
            <span class="issue__body">
              <span class="issue__text">{{ result.question || '—' }}</span>
              <span v-if="result.messages.length" class="issue__hint">
                {{ result.messages.join('；') }}
              </span>
            </span>
          </li>
        </ul>
      </template>
    </div>
  </section>
</template>
