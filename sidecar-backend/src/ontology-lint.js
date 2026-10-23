'use strict';

/**
 * 本体论体检：只回答「结构是否自洽」，不回答「业务是否合理」。
 *
 * 为什么单独一个模块：lint 要拿 schema 快照对账，而 OntologyStore 刻意只碰自己的表。
 * 把「读条目」与「对账」分开，lint 才能在实例没跑、schema 拿不到时降级运行——
 * 降级时只跳过依赖 schema 的规则，其余照跑，否则体检就成了「必须先启动才能用」。
 *
 * 通用性约束（docs/ontology-next.md §0.1）：规则一律按 schema 与数据探测，不按行业惯例假定。
 * 刻意没有的规则：必须存在 status 列、金额必须为正、必须有时间列、主键必须叫 id。
 * 这些都不是事实，只是某个行业的习惯；写进来就会让体检对别的行业全红。
 */

// 判定「强制规则能不能执行」与编译器共用同一份实现：体检说不能、编译器却能编，是最糟的分裂
const { ruleShape } = require('./ontology-rules');
const { MAX_BODY_CHARS } = require('./ontology-catalog');

/**
 * 引用的「规范形式」由 schema 自己决定，不由这里硬编码。
 *
 * 一条引用在不同引擎里的限定级数不同（sqlite 只要 main，Postgres 要 schema，
 * 有的源 database 段为空）。所以规范形式 = 把该表实际拥有的身份段按顺序拼起来：
 * 有 database 就带 database，有 schema 就带 schema。这样「规范」永远等于「引擎给的」，
 * 而不是「我们猜的三段式」。
 *
 * @param {{database?: string, schema?: string, name?: string}} table
 * @returns {string} 形如 `db.schema.table` / `schema.table` / `table`；表名为空时返回空串
 */
function canonicalTableRef(table) {
  const name = typeof table?.name === 'string' ? table.name.trim() : '';
  if (name === '') return '';
  const database = typeof table?.database === 'string' ? table.database.trim() : '';
  const schema = typeof table?.schema === 'string' ? table.schema.trim() : '';
  return [database, schema, name].filter((part) => part !== '').join('.');
}

/**
 * 除规范形式外，还能被用户写出来的简写。
 *
 * 用途不是「宽容地接受任意写法」，而是「认出简写并告诉用户该改成什么」——
 * 所以简写命中算 partial（warn + 给出建议），不算通过。
 *
 * @param {{database?: string, schema?: string, name?: string}} table
 * @returns {string[]}
 */
function looseTableRefs(table) {
  const name = typeof table?.name === 'string' ? table.name.trim() : '';
  if (name === '') return [];
  const database = typeof table?.database === 'string' ? table.database.trim() : '';
  const schema = typeof table?.schema === 'string' ? table.schema.trim() : '';
  const refs = new Set([name]);
  if (schema !== '') refs.add(`${schema}.${name}`);
  if (database !== '') refs.add(`${database}.${name}`);
  if (database !== '' && schema !== '') refs.add(`${database}.${schema}.${name}`);
  return [...refs];
}

/**
 * @param {Map<string, Array<Object>>} map
 * @param {string} key
 * @param {Object} value
 */
function pushTo(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

/**
 * 建索引：规范形式精确查，简写宽松查。两者分开，才能区分「对」与「能猜出来但不规范」。
 *
 * @param {{tables?: Array<Object>}} schema
 * @returns {{byCanonical: Map<string, Array<Object>>, byLoose: Map<string, Array<Object>>, tables: Array<Object>}}
 */
function buildTableIndex(schema) {
  const tables = Array.isArray(schema?.tables) ? schema.tables.filter((table) => table?.name) : [];
  const relationships = Array.isArray(schema?.relationships) ? schema.relationships : [];
  const byCanonical = new Map();
  const byLoose = new Map();

  for (const table of tables) {
    const canonical = canonicalTableRef(table);
    if (canonical === '') continue;
    pushTo(byCanonical, canonical, table);
    for (const ref of looseTableRefs(table)) {
      if (ref !== canonical) pushTo(byLoose, ref, table);
    }
  }

  return { byCanonical, byLoose, tables, relationships };
}

/**
 * 把一条引用解析到表。
 *
 * @param {ReturnType<typeof buildTableIndex>} index
 * @param {string} ref
 * @returns {{status: 'exact'|'partial'|'ambiguous'|'missing', table?: Object, canonical?: string, tables?: Array<Object>}}
 */
function resolveTableRef(index, ref) {
  const exact = index.byCanonical.get(ref);
  if (exact && exact.length === 1) return { status: 'exact', table: exact[0], canonical: ref };
  if (exact && exact.length > 1) return { status: 'ambiguous', tables: exact };

  const loose = index.byLoose.get(ref);
  if (loose && loose.length === 1) {
    return { status: 'partial', table: loose[0], canonical: canonicalTableRef(loose[0]) };
  }
  if (loose && loose.length > 1) return { status: 'ambiguous', tables: loose };

  return { status: 'missing' };
}

/**
 * 规则清单。UI、文档、报告都从这里取，避免三处各写一份后互相漂移。
 *
 * `needsSchema` 的规则在拿不到 schema 时进 `skipped` 而不是静默省略——
 * 用户必须知道「这次体检少查了几项」，否则「没有报错」会被误读成「没有问题」。
 */
const RULES = [
  {
    id: 'table-ref-format',
    level: 'warn',
    needsSchema: true,
    title: '表引用应使用规范形式',
  },
  {
    id: 'stale-reference',
    level: 'error',
    needsSchema: true,
    title: '引用的表已不在 schema 中',
  },
  {
    id: 'ambiguous-reference',
    level: 'error',
    needsSchema: true,
    title: '引用无法唯一定位到一张表',
  },
  {
    id: 'cross-database-reference',
    level: 'warn',
    needsSchema: true,
    title: '条目归属的库与引用表所在的库不一致',
  },
  {
    id: 'enforce-not-codable',
    level: 'error',
    needsSchema: false,
    title: '强制规则没有可判定的表达式',
  },
  {
    id: 'relation-incomplete',
    level: 'error',
    needsSchema: false,
    title: '关系没有标明两端',
  },
  {
    id: 'relation-edge',
    level: 'error',
    needsSchema: true,
    title: '关系的两端在 schema 里对不上',
  },
  {
    id: 'term-column',
    level: 'warn',
    needsSchema: true,
    title: '术语绑定的列在 schema 里不存在',
  },
  {
    id: 'example-without-query',
    level: 'warn',
    needsSchema: false,
    title: '样例没有问题对应的查询',
  },
  {
    id: 'metric-no-formula',
    level: 'error',
    needsSchema: false,
    title: '指标没有计算式',
  },
  {
    id: 'alias-conflict',
    level: 'warn',
    needsSchema: false,
    title: '同一说法指向多个条目',
  },
  {
    id: 'term-no-alias',
    level: 'info',
    needsSchema: false,
    title: '术语没有别名',
  },
  {
    id: 'concept-no-table',
    level: 'warn',
    needsSchema: false,
    title: '概念没有关联表',
  },
  {
    id: 'entry-too-long',
    level: 'warn',
    needsSchema: false,
    title: '条目正文过长',
  },
  {
    id: 'coverage-gap',
    level: 'info',
    needsSchema: true,
    title: '有表没有任何条目引用',
  },
];

const LEVEL_ORDER = { error: 0, warn: 1, info: 2 };

/** 覆盖率提示里最多列几张表，其余折叠成计数：50 张表全列出来没人看 */
const COVERAGE_PREVIEW = 8;

/**
 * @param {Object} entry
 * @param {Object} rule
 * @param {string} message
 * @param {string} [hint]
 * @returns {Object} 一条问题
 */
function issue(entry, rule, message, hint) {
  return {
    rule: rule.id,
    level: rule.level,
    entryId: entry?.id ?? null,
    entryName: entry?.name ?? '',
    kind: entry?.kind ?? '',
    database: entry?.database ?? '',
    message,
    ...(hint ? { hint } : {}),
  };
}

/** 表引用解析到表对象：只认能唯一定位的（简写也算，因为 lintTableRefs 已经就格式单独报过） */
function tableByRef(index, ref) {
  if (typeof ref !== 'string' || ref.trim() === '') return null;
  const resolved = resolveTableRef(index, ref.trim());
  return resolved.status === 'exact' || resolved.status === 'partial' ? resolved.table : null;
}

/** 列名比较一律忽略大小写：不同引擎对标识符的大小写态度不一样，报错要报真问题 */
function hasColumn(table, column) {
  const wanted = String(column ?? '').trim().toLowerCase();
  if (wanted === '') return false;
  const columns = Array.isArray(table?.columns) ? table.columns : [];
  return columns.some((item) => String(item?.name ?? '').toLowerCase() === wanted);
}

/**
 * 把 `表.列` 拆开。
 *
 * 从最后一个点切：表引用本身可能含点（库.schema.表），列名基本不会。
 * 拆不出两段就返回 null，由调用方报「格式不对」而不是猜。
 */
function splitColumnRef(ref) {
  const clean = String(ref ?? '').trim();
  const at = clean.lastIndexOf('.');
  if (at <= 0 || at === clean.length - 1) return null;
  return { table: clean.slice(0, at), column: clean.slice(at + 1) };
}

/** 关系卡片的两个端点，统一成规范形式，方便与用户填的两端比对 */
function relationshipEnds(rel) {
  return [
    {
      table: canonicalTableRef({
        database: rel.fromDatabase,
        schema: rel.fromSchema,
        name: rel.fromTable,
      }),
      column: rel.fromColumn,
    },
    {
      table: canonicalTableRef({
        database: rel.toDatabase,
        schema: rel.toSchema,
        name: rel.toTable,
      }),
      column: rel.toColumn,
    },
  ];
}

/**
 * schema 里是否存在这条外键（正反两个方向都算）。
 *
 * 只比对外键本身，不判断方向：同一条边从订单看是 many-to-one，从客户看就是
 * one-to-many，方向由 payload.cardinality 表达，不在这里较真。
 */
function hasRelationship(relationships, a, b) {
  const same = (x, y) => String(x ?? '').toLowerCase() === String(y ?? '').toLowerCase();
  return relationships.some((rel) => {
    const [from, to] = relationshipEnds(rel);
    const forward =
      same(from.table, a.table) &&
      same(from.column, a.column) &&
      same(to.table, b.table) &&
      same(to.column, b.column);
    const backward =
      same(from.table, b.table) &&
      same(from.column, b.column) &&
      same(to.table, a.table) &&
      same(to.column, a.column);
    return forward || backward;
  });
}

/**
 * 表引用的三条规则：规范形式、腐烂、歧义；外加跨库归属对账
 */
function lintTableRefs(entry, index, rulesById, findings) {
  const refs = Array.isArray(entry.tables) ? entry.tables : [];
  for (const rawRef of refs) {
    const ref = typeof rawRef === 'string' ? rawRef.trim() : '';
    if (ref === '') continue;
    const resolved = resolveTableRef(index, ref);

    if (resolved.status === 'exact') {
      // 规范形式对上了，再看归属：条目写在 A 库，引用的却是 B 库的表
      const declared = typeof entry.database === 'string' ? entry.database : '';
      const actual = typeof resolved.table.database === 'string' ? resolved.table.database : '';
      if (declared !== '' && actual !== '' && declared !== actual) {
        findings.push(
          issue(
            entry,
            rulesById.get('cross-database-reference'),
            `引用「${ref}」属于库 ${actual}，但这条条目登记在库 ${declared}`,
            '要么改条目归属的库，要么改引用——两者不一致时，按库取本体论会漏掉它'
          )
        );
      }
      continue;
    }

    if (resolved.status === 'partial') {
      findings.push(
        issue(
          entry,
          rulesById.get('table-ref-format'),
          `引用「${ref}」是简写，不是规范形式`,
          `建议改成「${resolved.canonical}」（规范形式由 schema 决定，不同引擎段数不同）`
        )
      );
      continue;
    }

    if (resolved.status === 'ambiguous') {
      const candidates = (resolved.tables ?? [])
        .map((table) => canonicalTableRef(table))
        .filter((item) => item !== '')
        .join('、');
      findings.push(
        issue(
          entry,
          rulesById.get('ambiguous-reference'),
          `引用「${ref}」能对上多张表`,
          `候选：${candidates}——写成规范形式才能唯一确定`
        )
      );
      continue;
    }

    findings.push(
      issue(
        entry,
        rulesById.get('stale-reference'),
        `引用「${ref}」在 schema 里找不到`,
        '表可能已改名或删除；这条语境现在会误导模型'
      )
    );
  }
}

/**
 * 同一库里两个条目用同一个说法（名字或别名）——模型无法判断该听谁的。
 *
 * 按库分组：同一个词在不同库有不同含义是设计允许的，跨库不算冲突。
 */
function lintSurfaceConflicts(entries, rulesById, findings) {
  const byDatabase = new Map();
  for (const entry of entries) {
    const database = typeof entry.database === 'string' ? entry.database : '';
    if (!byDatabase.has(database)) byDatabase.set(database, []);
    byDatabase.get(database).push(entry);
  }

  for (const [database, scoped] of byDatabase) {
    const surfaces = new Map();
    for (const entry of scoped) {
      const forms = new Set(
        [entry.name, ...(Array.isArray(entry.aliases) ? entry.aliases : [])].filter(
          (item) => typeof item === 'string' && item.trim() !== ''
        )
      );
      for (const form of forms) {
        const key = form.trim();
        if (!surfaces.has(key)) surfaces.set(key, new Set());
        surfaces.get(key).add(entry);
      }
    }

    for (const [form, owners] of surfaces) {
      if (owners.size < 2) continue;
      // 只报一次：把冲突的双方（或全部）列出来，避免每方各报一条把列表刷满
      const first = [...owners][0];
      const names = [...owners].map((entry) => `「${entry.name}」`).join('、');
      findings.push(
        issue(
          first,
          rulesById.get('alias-conflict'),
          `库 ${database || '（未归属）'} 里「${form}」同时指向 ${names}`,
          '同一说法只能有一个含义；把其中一个改名，或删掉重复的那条'
        )
      );
    }
  }
}

/**
 * 体检。
 *
 * @param {Array<Object>} entries 全部条目（OntologyStore.list()）
 * @param {Object} [options]
 * @param {Object|null} [options.schema] `{tables, relationships}`；为 null 时跳过需要 schema 的规则
 * @param {string} [options.schemaSource] 记录 schema 从哪来，方便 UI 说明为什么跳过了几项
 * @returns {Object} { checkedAt, schemaSource, rules, skipped, issues, summary }
 */
function lintOntology(entries, { schema = null, schemaSource = null } = {}) {
  const list = Array.isArray(entries) ? entries.filter((entry) => entry && typeof entry === 'object') : [];
  const index = schema && Array.isArray(schema.tables) ? buildTableIndex(schema) : null;
  const source = schemaSource ?? (index ? 'provided' : 'none');

  const rulesById = new Map(RULES.map((rule) => [rule.id, rule]));
  const findings = [];
  const skippedIds = new Set();

  if (!index) {
    for (const rule of RULES) {
      if (rule.needsSchema) {
        skippedIds.add(rule.id);
      }
    }
  }

  for (const entry of list) {
    if (index) {
      lintTableRefs(entry, index, rulesById, findings);
    }

    // 强制规则必须能被执行：形态、目标、判据三者缺一，它就只是一句空头承诺。
    // 判定逻辑与编译器共用 ruleShape——体检说「不能执行」而编译器偷偷能编，是最糟的分裂
    if (entry.kind === 'rule' && entry.severity === 'enforce') {
      const shape = ruleShape(entry.payload);
      if (typeof shape === 'string') {
        findings.push(
          issue(
            entry,
            rulesById.get('enforce-not-codable'),
            `强制规则不可执行：${shape}`,
            '选一种可执行形态（读筛选 / 隐藏列 / 整表禁读 / 全局只读）；做不到就把强度降为「提醒」'
          )
        );
      }
    }

    // 指标没有计算式：模型只能自己编一个口径
    if (entry.kind === 'metric') {
      const expression = typeof entry.expression === 'string' ? entry.expression.trim() : '';
      const graphql =
        typeof entry.payload?.graphql === 'string' ? entry.payload.graphql.trim() : '';
      const definition = typeof entry.definition === 'string' ? entry.definition.trim() : '';
      if (expression === '' && graphql === '') {
        findings.push(
          issue(
            entry,
            rulesById.get('metric-no-formula'),
            definition === '' ? '指标既没有计算式也没有含义' : '指标只有说明，没有计算式',
            definition === '' ? undefined : '说明给人看，计算式给模型抄；没有计算式，同一问题会得到不同口径'
          )
        );
      }
    }

    // 关系：两端写全、且能对上真实 schema。这是「同一张表三条外键」的解法
    if (entry.kind === 'relation') {
      const from = entry.payload?.from;
      const to = entry.payload?.to;
      const missing = [];
      if (!from?.table) missing.push('起点表');
      if (!from?.column) missing.push('起点列');
      if (!to?.table) missing.push('目标表');
      if (!to?.column) missing.push('目标列');

      if (missing.length > 0) {
        findings.push(
          issue(
            entry,
            rulesById.get('relation-incomplete'),
            `关系缺少 ${missing.join('、')}`,
            '两端都写全，模型才知道该按哪条边 join——只写一半等于没写'
          )
        );
      } else if (index) {
        let broken = false;
        for (const [side, end] of [
          ['起点', from],
          ['目标', to],
        ]) {
          const table = tableByRef(index, end.table);
          if (!table) {
            findings.push(
              issue(
                entry,
                rulesById.get('relation-edge'),
                `${side}表「${end.table}」在 schema 里找不到`
              )
            );
            broken = true;
            continue;
          }
          if (!hasColumn(table, end.column)) {
            findings.push(
              issue(
                entry,
                rulesById.get('relation-edge'),
                `${side}列「${end.table}.${end.column}」在 schema 里不存在`
              )
            );
            broken = true;
          }
        }

        // 只在 schema 真的给了外键信息时才要求对得上：有的引擎/视图不报外键，
        // 那时硬要求会把这个功能对所有这类库变成全红（通用性问题，不是业务问题）
        if (!broken && index.relationships.length > 0 && !hasRelationship(index.relationships, from, to)) {
          findings.push(
            issue(
              entry,
              rulesById.get('relation-edge'),
              `schema 里没有 ${from.table}.${from.column} 与 ${to.table}.${to.column} 这条外键`,
              '逻辑关系（没有外键约束）在这里也允许，只要两端列真实存在；这条报的是「既没有外键、也没写对列」'
            )
          );
        }
      }
    }

    // 术语可以绑到一列上：值域、单位这类语义只有落到列上才用得上
    if (entry.kind === 'term' && index) {
      const columnRef = typeof entry.payload?.column === 'string' ? entry.payload.column.trim() : '';
      if (columnRef !== '') {
        const parsed = splitColumnRef(columnRef);
        if (!parsed) {
          findings.push(
            issue(
              entry,
              rulesById.get('term-column'),
              `绑定的列「${columnRef}」不是「表.列」的形式`,
              '写成 <库>.<schema>.<表>.<列>；字段留空表示这条术语不绑具体列'
            )
          );
        } else {
          const table = tableByRef(index, parsed.table);
          if (!table) {
            findings.push(
              issue(
                entry,
                rulesById.get('term-column'),
                `绑定的表「${parsed.table}」在 schema 里找不到`
              )
            );
          } else if (!hasColumn(table, parsed.column)) {
            findings.push(
              issue(
                entry,
                rulesById.get('term-column'),
                `列「${parsed.table}.${parsed.column}」在 schema 里不存在`
              )
            );
          }
        }
      }
    }

    // 样例没有查询：就只是一句问题，等于零样本
    if (entry.kind === 'example') {
      const expression = typeof entry.expression === 'string' ? entry.expression.trim() : '';
      if (expression === '') {
        findings.push(
          issue(
            entry,
            rulesById.get('example-without-query'),
            '这条样例没有给出对应的查询',
            '样例的价值就是「问题 → 怎么写」；只有问题，模型学不到东西'
          )
        );
      }
    }

    if (entry.kind === 'term' && (!Array.isArray(entry.aliases) || entry.aliases.length === 0)) {
      findings.push(
        issue(
          entry,
          rulesById.get('term-no-alias'),
          '术语没有别名',
          '别名是检索时唯一的命中依据；没有别名，模型用别的说法就找不到它'
        )
      );
    }

    if (entry.kind === 'concept' && (!Array.isArray(entry.tables) || entry.tables.length === 0)) {
      findings.push(
        issue(
          entry,
          rulesById.get('concept-no-table'),
          '概念没有关联表',
          '概念的价值是把业务实体落到具体表上；没有表，它就只是一段散文'
        )
      );
    }

    // 正文过长：渲染时会截断，而截断意味着「写进去的没送达」——不如现在拆开
    const definitionLength = typeof entry.definition === 'string' ? entry.definition.length : 0;
    const expressionLength = typeof entry.expression === 'string' ? entry.expression.length : 0;
    const longest = Math.max(definitionLength, expressionLength);
    if (longest > MAX_BODY_CHARS) {
      findings.push(
        issue(
          entry,
          rulesById.get('entry-too-long'),
          `正文 ${longest} 字，超过 ${MAX_BODY_CHARS} 字上限（渲染时会截断）`,
          '拆成多条，或把查询片段放进「样例」：一条超长条目挤掉的是十条更有用的'
        )
      );
    }
  }

  lintSurfaceConflicts(list, rulesById, findings);

  // 覆盖率：schema 里有表，却没有任何条目提到它——不是错误，是「这里还缺知识」
  if (index) {
    const used = new Set();
    for (const entry of list) {
      for (const rawRef of Array.isArray(entry.tables) ? entry.tables : []) {
        const ref = typeof rawRef === 'string' ? rawRef.trim() : '';
        if (ref === '') continue;
        const resolved = resolveTableRef(index, ref);
        if (resolved.status === 'exact' || resolved.status === 'partial') {
          const canonical = canonicalTableRef(resolved.table);
          if (canonical !== '') used.add(canonical);
        }
      }
    }
    const uncovered = index.tables
      .map((table) => canonicalTableRef(table))
      .filter((ref) => ref !== '' && !used.has(ref));

    if (uncovered.length > 0) {
      const preview = uncovered.slice(0, COVERAGE_PREVIEW).join('、');
      const rest = uncovered.length - COVERAGE_PREVIEW;
      findings.push({
        rule: 'coverage-gap',
        level: rulesById.get('coverage-gap').level,
        entryId: null,
        entryName: '',
        kind: '',
        database: '',
        message:
          rest > 0
            ? `${uncovered.length} 张表没有任何条目引用：${preview} 等`
            : `${uncovered.length} 张表没有任何条目引用：${preview}`,
        hint: '这些表模型只能靠表名猜含义；按重要性挑几张补上术语或概念最划算',
      });
    }
  }

  findings.sort((a, b) => {
    const byLevel = LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level];
    if (byLevel !== 0) return byLevel;
    const byDatabase = String(a.database).localeCompare(String(b.database));
    if (byDatabase !== 0) return byDatabase;
    return Number(a.entryId ?? 0) - Number(b.entryId ?? 0);
  });

  const summary = { error: 0, warn: 0, info: 0, total: findings.length };
  for (const finding of findings) summary[finding.level] += 1;

  return {
    checkedAt: new Date().toISOString(),
    schemaSource: source,
    rules: RULES.map((rule) => ({
      id: rule.id,
      level: rule.level,
      title: rule.title,
      active: !skippedIds.has(rule.id),
    })),
    skipped: RULES.filter((rule) => skippedIds.has(rule.id)).map((rule) => ({
      id: rule.id,
      reason: '需要 schema：启动实例后再体检，或把 schema 一起传进来',
    })),
    issues: findings,
    summary,
  };
}

module.exports = {
  RULES,
  lintOntology,
  canonicalTableRef,
  buildTableIndex,
  resolveTableRef,
  // 起草助手也要按同一套规则理解引用：一处定义，避免体检与起草对同一个字符串有两种解读
  splitColumnRef,
};
