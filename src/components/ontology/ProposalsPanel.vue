<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

/**
 * 「从 schema 起草」面板。
 *
 * 只产出候选：点「起草」把候选交给父组件填表单，不保存。定义与边界得人来写，
 * 自动生成的空定义进了 instructions 只会稀释真正的知识。
 */
const props = defineProps({
  /** `ontology.propose` 的结果；null 表示还没生成过 */
  proposals: { type: Object, default: null },
  busy: { type: Boolean, default: false },
});

defineEmits(['run', 'draft']);

const { t } = useI18n();

/** 有没有任何候选（用来区分「没生成过」与「生成过但确实没有」） */
const hasProposals = computed(() => {
  const counts = props.proposals?.counts;
  return Boolean(counts && (counts.concepts > 0 || counts.relations > 0 || counts.terms > 0));
});

/** 候选合并成一张列表，detail 按类别展示（表 / 两端 / 列） */
const rows = computed(() => {
  const source = props.proposals;
  if (!source) return [];

  const list = [];
  for (const item of source.concepts ?? []) {
    list.push({ ...item, detail: item.tables?.[0] ?? '' });
  }
  for (const item of source.relations ?? []) {
    const from = item.from ?? {};
    const to = item.to ?? {};
    list.push({
      ...item,
      detail: `${from.table ?? '?'}.${from.column ?? '?'} → ${to.table ?? '?'}.${to.column ?? '?'}`,
    });
  }
  for (const item of source.terms ?? []) {
    list.push({ ...item, detail: item.column ?? '' });
  }
  return list;
});
</script>

<template>
  <section class="panel">
    <div class="panel__head">
      <span class="panel__title">{{ t('ontology.propose.title') }}</span>
      <el-button size="small" text :loading="busy" @click="$emit('run')">
        {{ proposals ? t('ontology.propose.again') : t('ontology.propose.run') }}
      </el-button>
    </div>
    <div class="panel__body">
      <p class="mono-dim note">{{ t('ontology.propose.hint') }}</p>
      <p v-if="proposals && !hasProposals" class="mono-dim note">
        {{
          proposals.schemaSource === 'none'
            ? t('ontology.propose.noSchema')
            : t('ontology.propose.empty')
        }}
      </p>
      <ul v-if="hasProposals" class="proposals">
        <li
          v-for="(item, index) in rows"
          :key="`${item.kind}-${item.detail}-${index}`"
          class="proposal"
        >
          <span class="tag tag--info">{{ t(`ontology.propose.kinds.${item.kind}`) }}</span>
          <span class="proposal__body">
            <span class="proposal__name">{{ item.name || '—' }}</span>
            <span class="proposal__detail">{{ item.detail }}</span>
          </span>
          <el-button size="small" text type="primary" @click="$emit('draft', item)">
            {{ t('ontology.propose.draft') }}
          </el-button>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.proposals {
  display: grid;
  gap: 8px;
  padding: 0;
  margin: 12px 0 0;
  list-style: none;
}

.proposal {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 8px 12px;
  border: 1px solid var(--line-soft);
  border-radius: 8px;
}

.proposal__body {
  display: grid;
  flex: 1;
  gap: 2px;
  min-width: 0;
}

.proposal__name {
  font-size: 13px;
  font-weight: 600;
}

.proposal__detail {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-dim);
  word-break: break-all;
}
</style>
