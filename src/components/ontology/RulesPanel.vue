<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

/**
 * 「强制规则」面板。
 *
 * 只算不写：编译产出 diff，应用是另一个按钮，而且走权限页同一条写入路径（自带快照）。
 * 冲突排在变更前面——做不到的事比做到了的事更需要被看见。
 */
const props = defineProps({
  /** `ontology.compileRules` 的结果；null 表示还没编译过 */
  rules: { type: Object, default: null },
  busy: { type: Boolean, default: false },
  applying: { type: Boolean, default: false },
});

defineEmits(['compile', 'apply']);

const { t } = useI18n();

/** 编译结果合并成一张可读列表：冲突在前，变更在后 */
const rows = computed(() => {
  const data = props.rules;
  if (!data) return [];
  return [
    ...data.conflicts.map((item) => ({
      key: `conflict-${item.ruleId}-${item.reason}`,
      level: 'error',
      label: t('ontology.rules.conflict'),
      text: `${item.ruleName}：${item.reason}`,
    })),
    ...data.changes.map((item, index) => ({
      key: `change-${index}`,
      level: 'info',
      label: t('ontology.rules.change'),
      text: `${item.ruleName}：${item.detail}`,
    })),
  ];
});
</script>

<template>
  <section class="panel">
    <div class="panel__head">
      <span class="panel__title">{{ t('ontology.rules.title') }}</span>
      <div class="rules__actions">
        <el-button size="small" text :loading="busy" @click="$emit('compile')">
          {{ t('ontology.rules.compile') }}
        </el-button>
        <el-button
          v-if="rules?.summary.effectiveChanges"
          size="small"
          type="primary"
          :loading="applying"
          @click="$emit('apply')"
        >
          {{ t('ontology.rules.apply') }}
        </el-button>
      </div>
    </div>
    <div class="panel__body">
      <p class="mono-dim note">{{ t('ontology.rules.hint') }}</p>
      <template v-if="rules">
        <p class="mono-dim note">
          {{
            t('ontology.rules.summary', {
              rules: rules.summary.rules,
              compiled: rules.summary.compiled,
              changes: rules.summary.effectiveChanges,
              conflicts: rules.summary.conflicts,
            })
          }}
        </p>
        <ul v-if="rows.length" class="issues">
          <li v-for="row in rows" :key="row.key" class="issue">
            <span class="tag" :class="`tag--${row.level}`">{{ row.label }}</span>
            <span class="issue__body">
              <span class="issue__text">{{ row.text }}</span>
            </span>
          </li>
        </ul>
        <p v-else class="mono-dim note">{{ t('ontology.rules.none') }}</p>
      </template>
    </div>
  </section>
</template>

<style scoped>
.rules__actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
</style>
