/**
 * AI Demo：MCP 工具测试目录 + 「失败后自动改参数」的修复规则。
 *
 * 为什么把这件事做成纯函数：这些入参形态只有实测才知道（query_catalog 的 search 是全文检索、
 * validate_where_clause 要 { table, where }、graphql_help 的 for 是枚举），而「改参数」这类
 * 逻辑最怕靠点界面确认。放在这里，`npm run test:frontend` 就能逐条覆盖。
 *
 * 修复只做「能从报错读出确定答案」的改动（角色不存在、缺必填、参数名不认识、表名列名不存在），
 * 读不出来的返回 null —— 宁可让用户看见原始报错，也不要瞎猜把测试伪装成通过。
 */

/** 面板里工具的顺序：先摸清结构，再查数据，最后把整件事交给 agent */
export const DEMO_TOOL_ORDER = [
  'graphql_help',
  'query_catalog',
  'get_current_config',
  'business_ontology',
  'describe_business_object',
  'validate_config',
  'validate_where_clause',
  'execute_saved_query',
  'execute_graphql',
  'ask_graphjin_agent',
];

/** 单次测试最多尝试几次（首次 + 2 次自动修正） */
export const MAX_DEMO_ATTEMPTS = 3;

/**
 * 报错 → 修复动作。顺序有讲究：
 * 「Cannot query field ... on type Query」是表名，而字段名那条例里的类型名不会是 Query/Mutation，
 * 所以表名规则必须先匹配，否则会把表名当成列名去换。
 */
const RULES = [
  {
    pattern: /roles?\s+['"]?([\w.@-]+)['"]?\s+not defined/i,
    fix: ({ match }) => ({
      role: 'admin',
      reason: 'roleFallback',
      detail: { role: match[1] },
    }),
  },
  {
    pattern: /missing propert(?:y|ies):?\s*\[([^\]]*)\]/i,
    fix: ({ args, match, context, inputSchema }) => {
      const missing = [...match[1].matchAll(/["']?([A-Za-z_]\w*)["']?/g)].map((item) => item[1]);
      if (missing.length === 0) return null;
      const next = { ...args };
      for (const key of missing) {
        const value = sampleFor(key, context, inputSchema);
        if (value === undefined) return null;
        next[key] = value;
      }
      return { args: next, reason: 'addedRequired', detail: { properties: missing } };
    },
  },
  {
    pattern: /(?:unknown (?:argument|property)|additional propert(?:y|ies)[^'"]*)['"]([A-Za-z_]\w*)['"]/i,
    fix: ({ args, match }) => {
      if (!(match[1] in args)) return null;
      const next = { ...args };
      delete next[match[1]];
      return { args: next, reason: 'droppedUnknown', detail: { property: match[1] } };
    },
  },
  {
    pattern: /Cannot query field "([A-Za-z_]\w*)" on type "(?:Query|Mutation)"/,
    fix: ({ args, match, context }) => swapTable(args, match[1], context),
  },
  {
    // 排除 Query / Mutation：那是表名走错了地方（上一条已经处理过），当列名换会改出 `{ id(...) { id } }`
    pattern: /Cannot query field "([A-Za-z_]\w*)" on type "(?!Query\b|Mutation\b)([A-Za-z_]\w*)"/,
    fix: ({ args, match, context }) => swapColumn(args, match[1], context),
  },
  {
    pattern: /no such table:?\s*['"]?([\w.]+)['"]?|relation "([\w.]+)" does not exist/i,
    fix: ({ args, match, context }) => swapTable(args, match[1] ?? match[2], context),
  },
  {
    // GraphJin 自己的措辞，且带一份可用表名清单：当前项目没加载 schema 时也能修
    pattern: /table not found:\s*(?:\w+\.)?([\w]+)/i,
    fix: ({ args, match, text, context }) => {
      const available = availableNames(text, 'available tables');
      const table = context.table || available[0] || '';
      return swapTable(args, match[1], { ...context, table });
    },
  },
  {
    pattern: /no such column:?\s*['"]?([\w.]+)['"]?|column "([A-Za-z_]\w*)" does not exist/i,
    fix: ({ args, match, context }) => swapColumn(args, match[1] ?? match[2], context),
  },
  {
    pattern: /column not found:\s*(?:\w+\.)?([\w]+)/i,
    fix: ({ args, match, text, context }) => {
      const available = availableNames(text, 'available columns');
      const column = context.column || available[0] || '';
      return swapColumn(args, match[1], { ...context, column });
    },
  },
];

/**
 * 从报错文本里取出「可用表 / 可用列」清单。
 *
 * GraphJin 的报错自带这份清单（`available tables: accounts, invoices, ...`），
 * 比我们自己查一遍 schema 更贴合它此刻真正认识的表。
 *
 * @param {string} text
 * @param {string} label
 * @returns {string[]}
 */
function availableNames(text, label) {
  const match = new RegExp(`${label}:\\s*([\\w,\\s]+)`, 'i').exec(text);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/**
 * 按工具的入参形态给出可直接跑的测试数据。
 *
 * 表名 / 列名 / 概念名都来自当前项目的真实 schema 与本体论：写死一个 `orders`
 * 在别人的库上必然「查无此表」，那种失败测不出任何东西。
 *
 * @param {string} name 工具名
 * @param {{database?: string, table?: string, column?: string, concept?: string}} [context]
 * @returns {Object} 工具入参
 */
export function buildDemoArgs(name, context = {}) {
  const table = context.table ?? '';
  const column = context.column ?? 'id';
  const concept = context.concept ?? '';

  switch (name) {
    case 'graphql_help':
      return { for: 'discovery' };
    case 'query_catalog':
      return table === '' ? {} : { search: table };
    case 'get_current_config':
      // 只读：只问 sources 一节，避免把整份配置（含库连接串）倒进面板
      return { section: 'sources' };
    case 'business_ontology':
      return { kind: 'metric' };
    case 'describe_business_object':
      return { name: concept || table };
    case 'validate_config':
      // 空变更就是一次只读校验，不碰配置
      return {};
    case 'validate_where_clause':
      return table === '' ? {} : { table, where: { [column]: { gt: 0 } } };
    case 'execute_saved_query':
      return { name: table };
    case 'execute_graphql':
      return table === '' ? {} : { query: `{ ${table}(limit: 1) { ${column} } }` };
    case 'ask_graphjin_agent':
      return {
        instruction: '列出这个库里最适合回答「最近订单情况」的表，并给出一个可以直接执行的查询',
      };
    default:
      // 目录外的新工具：不猜参数，让用户自己填或靠报错自动补必填
      return {};
  }
}

/**
 * 从一次失败里推出下一个可尝试的参数。
 *
 * @param {Object} input
 * @param {Object} input.args 本次实际发出的参数
 * @param {string} input.role 本次使用的角色
 * @param {string} input.error 工具返回的错误文本（或协议错误消息）
 * @param {Object} [input.context] 当前项目的 schema / 本体论
 * @param {Object} [input.inputSchema] 该工具的 inputSchema，用于取枚举默认值
 * @returns {{args?: Object, role?: string, reason: string, detail: Object}|null} 无法修复时返回 null
 */
export function repairAttempt({ args, role, error, context = {}, inputSchema = null }) {
  const text = typeof error === 'string' ? error : '';
  if (text.trim() === '') return null;

  for (const rule of RULES) {
    const match = rule.pattern.exec(text);
    if (!match) continue;
    const fixed = rule.fix({ args: args ?? {}, role, match, text, context, inputSchema });
    // 命中了规则但没改动（例如表名已经是新名字）：继续看后面的规则，别把「修不动」当成「不需要修」
    if (fixed) return fixed;
  }
  return null;
}

/**
 * 必填参数的兜底取值：先看 schema 的枚举，再看按参数名准备的知识，最后放弃。
 *
 * @param {string} key 参数名
 * @param {Object} context
 * @param {Object|null} inputSchema
 * @returns {*} 取不到时返回 undefined
 */
function sampleFor(key, context, inputSchema) {
  const spec = inputSchema?.properties?.[key] ?? null;
  if (Array.isArray(spec?.enum) && spec.enum.length > 0) return spec.enum[0];

  const table = context.table ?? '';
  const column = context.column ?? 'id';
  switch (key) {
    case 'for':
      return 'discovery';
    case 'name':
      return context.concept || table || 'demo';
    case 'table':
      return table === '' ? undefined : table;
    case 'where':
      return table === '' ? undefined : { [column]: { gt: 0 } };
    case 'query':
      return table === '' ? undefined : `{ ${table}(limit: 1) { ${column} } }`;
    case 'instruction':
      return '列出这个库里最适合回答「最近订单情况」的表，并给出一个可以直接执行的查询';
    default:
      break;
  }

  if (spec?.type === 'string') return '';
  if (spec?.type === 'number' || spec?.type === 'integer') return 1;
  if (spec?.type === 'boolean') return true;
  return undefined;
}

/** 把查询串 / table 参数里的错误表名换成真实表名 */
function swapTable(args, from, context) {
  const table = context.table ?? '';
  if (!from || !table || from === table) return null;

  const next = { ...args };
  if (typeof next.query === 'string') next.query = replaceIdentifier(next.query, from, table);
  if (next.table === from) next.table = table;
  const changed = next.query !== args.query || next.table !== args.table;
  return changed ? { args: next, reason: 'tableFallback', detail: { from, to: table } } : null;
}

/** 把查询串里的错误列名换成主键列 */
function swapColumn(args, from, context) {
  const column = context.column ?? '';
  if (!from || !column || from === column) return null;
  if (typeof args.query !== 'string' || !args.query.includes(from)) return null;

  return {
    args: { ...args, query: replaceIdentifier(args.query, from, column) },
    reason: 'columnFallback',
    detail: { from, to: column },
  };
}

function replaceIdentifier(text, from, to) {
  return text.replace(new RegExp(`\\b${from}\\b`, 'g'), to);
}
