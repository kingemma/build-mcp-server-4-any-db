/**
 * 把本体论条目折成「概念关系图」：节点是概念，连线是关系。
 *
 * 为什么在渲染前先折一次而不是在模板里现算：折叠规则（概念合并多表、关系两端按表名
 * 对齐、落到概念之外的关系单独回收）是要能被断言的行为，放在纯函数里才测得动；
 * 组件只负责画。
 *
 * 表名一律按**最后一段**比较：条目里的关联表是规范形式 `库.schema.表`，而关系的
 * payload 常常只写 `表`（表单里的下拉就是给的表名）。不统一就会「同一张表两个名字」。
 */

/** 概念在节点数组里的 id 前缀：避免与其它 kind 的 id 撞车 */
const NODE_PREFIX = 'concept:';

/**
 * 取表名的最后一段，用于跨条目对齐。
 *
 * @param {*} table
 * @returns {string}
 */
export function bareTable(table) {
  const text = typeof table === 'string' ? table.trim() : '';
  if (text === '') return '';
  const parts = text.split('.');
  return parts[parts.length - 1].trim();
}

/**
 * @param {Array<Object>} entries 本体论条目（通常是全量，按 database 过滤）
 * @param {Object} [options]
 * @param {string} [options.database] 只看这个库；空串表示不过滤
 * @returns {{database: string, nodes: Array<Object>, edges: Array<Object>,
 *   unmatched: Array<Object>, counts: Object}}
 */
export function buildOntologyGraph(entries = [], { database = '' } = {}) {
  const scoped = (Array.isArray(entries) ? entries : []).filter(
    (entry) => !database || entry.database === database
  );
  const ofKind = (kind) => scoped.filter((entry) => entry.kind === kind);

  const concepts = ofKind('concept');
  const relations = ofKind('relation');

  /** @type {Array<Object>} */
  const nodes = concepts.map((concept) => {
    const tables = (concept.tables ?? []).slice();
    return {
      id: `${NODE_PREFIX}${concept.id ?? concept.name}`,
      name: concept.name,
      aliases: concept.aliases ?? [],
      definition: concept.definition ?? '',
      payload: concept.payload ?? {},
      tables,
      /** 表名最后一段，用来和关系 / 术语对齐 */
      keys: new Set((concept.tables ?? []).map(bareTable).filter(Boolean)),
      terms: [],
      rules: [],
      metrics: [],
      relations: [],
    };
  });

  /** 表名 → 节点：同一张表被两个概念认领时以先出现的为准，不静默造两个节点 */
  const byTable = new Map();
  for (const node of nodes) {
    for (const key of node.keys) if (!byTable.has(key)) byTable.set(key, node);
  }

  const attach = (node, field, entry) => {
    if (!node) return;
    if (!node[field].some((item) => item.id === entry.id)) node[field].push(entry);
  };

  const matches = (entry, node) =>
    node !== null &&
    (entry.tables ?? []).some((table) => node.keys.has(bareTable(table)));

  for (const term of ofKind('term')) {
    for (const node of nodes) if (matches(term, node)) attach(node, 'terms', term);
  }
  for (const metric of ofKind('metric')) {
    for (const node of nodes) if (matches(metric, node)) attach(node, 'metrics', metric);
  }
  for (const rule of ofKind('rule')) {
    const on = rule.payload?.on?.table;
    const target = on ? byTable.get(bareTable(on)) : null;
    if (target) attach(target, 'rules', rule);
    else for (const node of nodes) if (matches(rule, node)) attach(node, 'rules', rule);
  }

  /** @type {Array<Object>} */
  const edges = [];
  /** 关系两端没落到概念上：不静默丢弃，页面要显式说出来 */
  const unmatched = [];

  for (const relation of relations) {
    const fromTable = bareTable(relation.payload?.from?.table);
    const toTable = bareTable(relation.payload?.to?.table);
    const from = fromTable ? byTable.get(fromTable) : null;
    const to = toTable ? byTable.get(toTable) : null;

    if (!from || !to) {
      unmatched.push({
        relation,
        from: from?.id ?? null,
        to: to?.id ?? null,
        fromTable,
        toTable,
      });
      if (from) attach(from, 'relations', relation);
      if (to) attach(to, 'relations', relation);
      continue;
    }

    attach(from, 'relations', relation);
    if (to !== from) attach(to, 'relations', relation);

    // 概念内部的关系（两个端点都在同一个概念里）不画自环：画出来只是噪音，
    // 但详情面板里要看得到，所以两边都挂上了
    if (to === from) continue;

    edges.push({
      id: `relation:${relation.id ?? relation.name}`,
      from: from.id,
      to: to.id,
      name: relation.name,
      cardinality: relation.payload?.cardinality ?? '',
      relation,
    });
  }

  return {
    database,
    nodes,
    edges,
    unmatched,
    counts: {
      concepts: nodes.length,
      relations: relations.length,
      edges: edges.length,
      terms: ofKind('term').length,
      rules: ofKind('rule').length,
      metrics: ofKind('metric').length,
    },
  };
}

/**
 * 同一对节点之间有多条关系时，给每条线一个不同的弧度，否则它们完全重叠。
 *
 * @param {number} index 第几条（同一对节点之间）
 * @returns {number} 相对中点法线的偏移比例
 */
export function edgeSag(index) {
  if (index <= 0) return 0;
  const step = 0.14;
  // 1 → +0.14, 2 → -0.14, 3 → +0.28, 4 → -0.28 ...
  const magnitude = Math.ceil(index / 2) * step;
  return index % 2 === 1 ? magnitude : -magnitude;
}

/**
 * 环形布局：节点按「连线条数」从多到少排在圆周上，孤立的点排在最后。
 *
 * 为什么不用力导向：力导向每次跑出来的位置都不一样，截图与冒烟断言都没法稳定；
 * 本体论的图规模很小（一个库几个到十几个概念），环形已经能看清结构。
 *
 * @param {{nodes: Array<Object>, edges: Array<Object>}} graph
 * @param {Object} [options]
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @param {number} [options.padding]
 * @returns {{width: number, height: number, nodes: Array<Object>, edges: Array<Object>}}
 */
export function layoutOntologyGraph(graph, { width = 760, height = 440, padding = 86 } = {}) {
  const nodes = graph?.nodes ?? [];
  const edges = graph?.edges ?? [];

  const degree = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }

  const ordered = [...nodes].sort((left, right) => {
    const delta = (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0);
    return delta !== 0 ? delta : left.name.localeCompare(right.name, 'zh-Hans-CN');
  });

  const cx = width / 2;
  const cy = height / 2;
  const rx = Math.max((width - padding * 2) / 2, 1);
  const ry = Math.max((height - padding * 2) / 2, 1);

  const positioned = ordered.map((node, index) => {
    if (ordered.length === 1) return { ...node, x: cx, y: cy };
    // 从正上方开始顺时针排，第一个节点固定在最上面
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / ordered.length;
    return { ...node, x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) };
  });

  // 同一对节点之间的多条关系：按出现顺序给弧度，避免线叠在一起
  const pairCount = new Map();
  const laidEdges = edges.map((edge) => {
    const pairKey = [edge.from, edge.to].sort().join('|');
    const index = pairCount.get(pairKey) ?? 0;
    pairCount.set(pairKey, index + 1);
    return { ...edge, sag: edgeSag(index) };
  });

  return { width, height, nodes: positioned, edges: laidEdges };
}

/**
 * 关系基数的人话标签。
 *
 * 键放在 ontology.cardinalities 下（不是 graph 下面），表单里的基数下拉以后可以直接复用。
 *
 * @param {string} cardinality
 * @param {(key: string) => string} t i18n 取词函数
 * @returns {string} 未配置基数时返回空串；没有对应文案时退回原始取值
 */
export function cardinalityLabel(cardinality, t) {
  if (!cardinality) return '';
  const key = `ontology.cardinalities.${cardinality}`;
  const text = t(key);
  return text === key ? cardinality : text;
}
