<script setup>
import { useI18n } from 'vue-i18n';

/**
 * 「送给 AI 的语境」预览。
 *
 * 只负责展示与复制：内容由后端渲染（`ontology.render`），前端不参与拼装——
 * 这样「AI 看到的」与「页面预览的」永远是同一份文本。
 */
defineProps({
  /** 渲染后的全文；空串时整块不显示 */
  text: { type: String, default: '' },
});

defineEmits(['copy']);

const { t } = useI18n();
</script>

<template>
  <section v-if="text" class="panel">
    <div class="panel__head">
      <span class="panel__title">{{ t('ontology.preview') }}</span>
      <el-button size="small" text @click="$emit('copy')">{{ t('ontology.copy') }}</el-button>
    </div>
    <div class="panel__body">
      <pre class="rendered">{{ text }}</pre>
    </div>
  </section>
</template>

<style scoped>
.rendered {
  margin: 0;
  padding: 14px 16px;
  overflow: auto;
  max-height: 420px;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.75;
  color: var(--text);
  background: var(--ink-700);
  border: 1px solid var(--line);
  border-radius: 10px;
}
</style>
