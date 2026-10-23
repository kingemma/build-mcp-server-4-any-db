<script setup>
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';

/**
 * 条目编辑表单。
 *
 * 为什么直接改 prop 对象而不是逐字段 v-model + emit：这里没有一个字段是「独立值」，
 * 它们只是一个 payload 的扁平投影；拆成二十个 v-model 只会换来二十个 emit 和一堆
 * 同步样板。父组件持有同一个对象，保存时按 kind 组装——这是最不容易出错的形式。
 *
 * 表单里只出现「当前类别允许的键」：payload 在白名单外会被后端硬拒，
 * 多塞一个就会保存失败，所以每个类别的字段都用 v-if 隔开。
 */
const props = defineProps({
  /** 扁平表单状态（父组件持有，保存时组装 payload） */
  form: { type: Object, required: true },
  /** 正在编辑哪条；null 表示新增 */
  editing: { type: Number, default: null },
  databaseOptions: { type: Array, default: () => [] },
  tableOptions: { type: Array, default: () => [] },
  columnOptions: { type: Array, default: () => [] },
  relationshipOptions: { type: Array, default: () => [] },
  saving: { type: Boolean, default: false },
  scanning: { type: Boolean, default: false },
});

const emit = defineEmits(['save', 'reset', 'scan']);

const { t } = useI18n();

const root = ref(null);

/** 父组件起草后要把表单滚进视野；ref 挂在组件上时只能靠暴露方法 */
defineExpose({
  scrollIntoView: () => root.value?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
});

/** 六类条目与后端 ontology.js 的 KINDS 一致；顺序与渲染顺序一致 */
const KINDS = [
  { id: 'term', labelKey: 'ontology.kinds.term' },
  { id: 'concept', labelKey: 'ontology.kinds.concept' },
  { id: 'relation', labelKey: 'ontology.kinds.relation' },
  { id: 'rule', labelKey: 'ontology.kinds.rule' },
  { id: 'metric', labelKey: 'ontology.kinds.metric' },
  { id: 'example', labelKey: 'ontology.kinds.example' },
];

const SEVERITIES = ['info', 'warn', 'enforce'];
const CARDINALITIES = ['many-to-one', 'one-to-many', 'many-to-many', 'one-to-one'];
const RULE_MODES = ['filter', 'hide-column', 'block-table', 'read-only'];

const severityLabel = (severity) => t(`ontology.severities.${severity}`);

/** 选中一条外键就把四端填上；选完清掉，免得它看起来像是要保存的数据 */
function applyRelationship(value) {
  const found = props.relationshipOptions.find((item) => item.value === value);
  props.form.pickedFk = '';
  if (!found) return;
  props.form.fromTable = found.fromTable;
  props.form.fromColumn = found.fromColumn;
  props.form.toTable = found.toTable;
  props.form.toColumn = found.toColumn;
}
</script>

<template>
  <section ref="root" class="panel">
    <div class="panel__head">
      <span class="panel__title">
        {{ editing ? t('ontology.editing', { name: form.name }) : t('ontology.create') }}
      </span>
    </div>
    <div class="panel__body">
      <div class="form">
        <label class="field">
          <span class="field__label">{{ t('ontology.form.database') }}</span>
          <el-select v-model="form.database" size="small" filterable allow-create>
            <el-option v-for="name in databaseOptions" :key="name" :label="name" :value="name" />
          </el-select>
        </label>

        <label class="field">
          <span class="field__label">{{ t('ontology.form.kind') }}</span>
          <el-select v-model="form.kind" size="small">
            <el-option
              v-for="kind in KINDS"
              :key="kind.id"
              :label="t(kind.labelKey)"
              :value="kind.id"
            />
          </el-select>
        </label>

        <label class="field">
          <span class="field__label">{{ t('ontology.form.name') }}</span>
          <el-input v-model="form.name" size="small" :placeholder="t('ontology.form.nameHint')" />
        </label>

        <label class="field">
          <span class="field__label">{{ t('ontology.form.aliases') }}</span>
          <el-input
            v-model="form.aliases"
            size="small"
            :placeholder="t('ontology.form.aliasesHint')"
          />
        </label>

        <label class="field field--wide">
          <span class="field__label">{{ t('ontology.form.definition') }}</span>
          <el-input
            v-model="form.definition"
            size="small"
            type="textarea"
            :rows="3"
            :placeholder="t('ontology.form.definitionHint')"
          />
        </label>

        <label class="field field--wide">
          <span class="field__label">{{ t('ontology.form.tables') }}</span>
          <el-select
            v-model="form.tables"
            size="small"
            multiple
            filterable
            allow-create
            :placeholder="t('ontology.form.tablesHint')"
            style="width: 100%"
          >
            <el-option
              v-for="table in tableOptions"
              :key="table.value"
              :label="table.label"
              :value="table.value"
            />
          </el-select>
          <span class="field__hint">
            {{
              tableOptions.length
                ? t('ontology.form.tablesFromSchema', { count: tableOptions.length })
                : t('ontology.form.tablesNoSchema')
            }}
          </span>
        </label>

        <label class="field field--wide">
          <span class="field__label">
            {{
              form.kind === 'example' ? t('ontology.form.query') : t('ontology.form.expression')
            }}
          </span>
          <el-input
            v-model="form.expression"
            size="small"
            type="textarea"
            :rows="form.kind === 'example' ? 3 : 2"
            :placeholder="
              form.kind === 'example'
                ? t('ontology.form.queryHint')
                : t('ontology.form.expressionHint')
            "
          />
        </label>

        <!-- 术语：绑定到具体列，再列真实取值。值域是模型猜得最凶的地方 -->
        <template v-if="form.kind === 'term'">
          <label class="field field--wide">
            <span class="field__label">{{ t('ontology.form.column') }}</span>
            <el-select
              v-model="form.column"
              size="small"
              filterable
              allow-create
              clearable
              :placeholder="t('ontology.form.columnHint')"
              style="width: 100%"
            >
              <el-option
                v-for="item in columnOptions"
                :key="item.value"
                :label="item.label"
                :value="item.value"
              />
            </el-select>
            <span class="field__hint">
              {{
                columnOptions.length
                  ? t('ontology.form.columnFromSchema', { count: columnOptions.length })
                  : t('ontology.form.columnNoSchema')
              }}
            </span>
          </label>
          <div class="field field--wide">
            <span class="field__row">
              <span class="field__label">{{ t('ontology.form.values') }}</span>
              <el-button size="small" text type="primary" :loading="scanning" @click="emit('scan')">
                {{ t('ontology.scan.run') }}
              </el-button>
            </span>
            <el-input
              v-model="form.values"
              size="small"
              type="textarea"
              :rows="3"
              :placeholder="t('ontology.form.valuesHint')"
            />
            <span class="field__hint">{{ t('ontology.form.valuesScanHint') }}</span>
          </div>
        </template>

        <template v-if="form.kind === 'concept'">
          <label class="field">
            <span class="field__label">{{ t('ontology.form.pkey') }}</span>
            <el-input v-model="form.pkey" size="small" :placeholder="t('ontology.form.pkeyHint')" />
          </label>
          <label class="field">
            <span class="field__label">{{ t('ontology.form.display') }}</span>
            <el-input
              v-model="form.display"
              size="small"
              :placeholder="t('ontology.form.displayHint')"
            />
          </label>
          <label class="field">
            <span class="field__label">{{ t('ontology.form.grain') }}</span>
            <el-input
              v-model="form.grain"
              size="small"
              :placeholder="t('ontology.form.grainHint')"
            />
          </label>
        </template>

        <!-- 关系：从真实外键里选一条，填出「哪条边、哪个方向」 -->
        <template v-if="form.kind === 'relation'">
          <label class="field field--wide">
            <span class="field__label">{{ t('ontology.form.pickFk') }}</span>
            <el-select
              v-model="form.pickedFk"
              size="small"
              filterable
              clearable
              :placeholder="
                relationshipOptions.length
                  ? t('ontology.form.pickFkHint')
                  : t('ontology.form.pickFkNone')
              "
              style="width: 100%"
              @change="applyRelationship"
            >
              <el-option
                v-for="item in relationshipOptions"
                :key="item.value"
                :label="item.label"
                :value="item.value"
              />
            </el-select>
          </label>
          <label class="field">
            <span class="field__label">{{ t('ontology.form.fromTable') }}</span>
            <el-select
              v-model="form.fromTable"
              size="small"
              filterable
              allow-create
              style="width: 100%"
            >
              <el-option
                v-for="item in tableOptions"
                :key="item.value"
                :label="item.label"
                :value="item.value"
              />
            </el-select>
          </label>
          <label class="field">
            <span class="field__label">{{ t('ontology.form.fromColumn') }}</span>
            <el-input v-model="form.fromColumn" size="small" />
          </label>
          <label class="field">
            <span class="field__label">{{ t('ontology.form.toTable') }}</span>
            <el-select
              v-model="form.toTable"
              size="small"
              filterable
              allow-create
              style="width: 100%"
            >
              <el-option
                v-for="item in tableOptions"
                :key="item.value"
                :label="item.label"
                :value="item.value"
              />
            </el-select>
          </label>
          <label class="field">
            <span class="field__label">{{ t('ontology.form.toColumn') }}</span>
            <el-input v-model="form.toColumn" size="small" />
          </label>
          <label class="field">
            <span class="field__label">{{ t('ontology.form.cardinality') }}</span>
            <el-select v-model="form.cardinality" size="small">
              <el-option v-for="item in CARDINALITIES" :key="item" :label="item" :value="item" />
            </el-select>
          </label>
          <label class="field">
            <span class="field__label">{{ t('ontology.form.relAlias') }}</span>
            <el-input
              v-model="form.relAlias"
              size="small"
              :placeholder="t('ontology.form.relAliasHint')"
            />
          </label>
        </template>

        <!-- 规则：形态决定它能不能被执行；强度由 severity 说，不重复解释 -->
        <template v-if="form.kind === 'rule'">
          <label class="field field--wide">
            <span class="field__label">{{ t('ontology.form.mode') }}</span>
            <el-select
              v-model="form.mode"
              size="small"
              clearable
              :placeholder="t('ontology.form.modeHint')"
            >
              <el-option
                v-for="item in RULE_MODES"
                :key="item"
                :label="t(`ontology.form.modes.${item}`)"
                :value="item"
              />
            </el-select>
            <span class="field__hint">{{ t('ontology.form.modeWhy') }}</span>
          </label>
          <label v-if="form.mode && form.mode !== 'read-only'" class="field">
            <span class="field__label">{{ t('ontology.form.ruleTable') }}</span>
            <el-select
              v-model="form.ruleTable"
              size="small"
              filterable
              allow-create
              style="width: 100%"
            >
              <el-option
                v-for="item in tableOptions"
                :key="item.value"
                :label="item.label"
                :value="item.value"
              />
            </el-select>
          </label>
          <label v-if="form.mode === 'hide-column'" class="field">
            <span class="field__label">{{ t('ontology.form.ruleColumn') }}</span>
            <el-input v-model="form.ruleColumn" size="small" />
          </label>
          <label v-if="form.mode === 'filter'" class="field field--wide">
            <span class="field__label">{{ t('ontology.form.predicate') }}</span>
            <el-input
              v-model="form.predicate"
              size="small"
              :placeholder="t('ontology.form.predicateHint')"
            />
          </label>
        </template>

        <!-- 指标：粒度 / 单位 / 时间窗口 / 可执行片段。单位不预设币种，任何度量都能填 -->
        <template v-if="form.kind === 'metric'">
          <label class="field">
            <span class="field__label">{{ t('ontology.form.grain') }}</span>
            <el-input
              v-model="form.grain"
              size="small"
              :placeholder="t('ontology.form.grainHint')"
            />
          </label>
          <label class="field">
            <span class="field__label">{{ t('ontology.form.unit') }}</span>
            <el-input v-model="form.unit" size="small" :placeholder="t('ontology.form.unitHint')" />
          </label>
          <label class="field">
            <span class="field__label">{{ t('ontology.form.window') }}</span>
            <el-input
              v-model="form.windowColumn"
              size="small"
              :placeholder="t('ontology.form.windowHint')"
            />
          </label>
          <label class="field">
            <span class="field__label">{{ t('ontology.form.windowTz') }}</span>
            <el-input v-model="form.windowTz" size="small" placeholder="Asia/Shanghai" />
          </label>
          <label class="field">
            <span class="field__label">{{ t('ontology.form.windowPeriod') }}</span>
            <el-input
              v-model="form.windowPeriod"
              size="small"
              :placeholder="t('ontology.form.windowPeriodHint')"
            />
          </label>
          <label class="field field--wide">
            <span class="field__label">{{ t('ontology.form.graphql') }}</span>
            <el-input
              v-model="form.graphql"
              size="small"
              type="textarea"
              :rows="3"
              :placeholder="t('ontology.form.graphqlHint')"
            />
          </label>
        </template>

        <template v-if="form.kind === 'example'">
          <label class="field field--wide">
            <span class="field__label">{{ t('ontology.form.notes') }}</span>
            <el-input v-model="form.notes" size="small" :placeholder="t('ontology.form.notesHint')" />
          </label>
          <!-- 期望结构是评测的对账基准：用逗号分隔，不写就只验「能跑」与「有覆盖」 -->
          <label class="field">
            <span class="field__label">{{ t('ontology.form.expectTables') }}</span>
            <el-input
              v-model="form.expectTables"
              size="small"
              :placeholder="t('ontology.form.expectTablesHint')"
            />
          </label>
          <label class="field">
            <span class="field__label">{{ t('ontology.form.expectColumns') }}</span>
            <el-input
              v-model="form.expectColumns"
              size="small"
              :placeholder="t('ontology.form.expectHint')"
            />
          </label>
          <label class="field">
            <span class="field__label">{{ t('ontology.form.expectValues') }}</span>
            <el-input
              v-model="form.expectValues"
              size="small"
              :placeholder="t('ontology.form.expectHint')"
            />
          </label>
          <label class="field">
            <span class="field__label">{{ t('ontology.form.expectMustNot') }}</span>
            <el-input
              v-model="form.expectMustNot"
              size="small"
              :placeholder="t('ontology.form.expectHint')"
            />
          </label>
        </template>

        <!-- 扩展属性：系统只转达、不解释的那一层，用来放行业里系统不认识的东西 -->
        <label class="field field--wide">
          <span class="field__label">{{ t('ontology.form.facets') }}</span>
          <el-input
            v-model="form.facets"
            size="small"
            type="textarea"
            :rows="2"
            :placeholder="t('ontology.form.facetsHint')"
          />
          <span class="field__hint">{{ t('ontology.form.facetsWhy') }}</span>
        </label>

        <label v-if="form.kind === 'rule'" class="field">
          <span class="field__label">{{ t('ontology.form.severity') }}</span>
          <el-select v-model="form.severity" size="small">
            <el-option
              v-for="severity in SEVERITIES"
              :key="severity"
              :label="severityLabel(severity)"
              :value="severity"
            />
          </el-select>
        </label>
      </div>

      <div class="actions">
        <el-button size="small" type="primary" :loading="saving" @click="emit('save')">
          {{ t('ontology.save') }}
        </el-button>
        <el-button size="small" @click="emit('reset')">{{ t('ontology.reset') }}</el-button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.form {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 14px;
}

.field {
  display: grid;
  gap: 6px;
  align-content: start;
}

.field--wide {
  grid-column: 1 / -1;
}

.field__label {
  font-size: var(--fs-note);
  color: var(--text-dim);
}

/* 标签旁边挂操作按钮时用这一行：不要把按钮塞进 .field__label，
   否则标签的 textContent 就不是纯标签了（自动化脚本按标签定位字段会失效） */
.field__row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.field__hint {
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-dim);
}
</style>
