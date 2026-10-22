'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 生成与维护 GraphJin 项目配置（source 模式）。
 *
 * 两条实测约束决定了这里的形态（见 docs/graphjin-source-migration.md §2.3）：
 * - `databases:` 与 `sources:` 在 3.21.14 不能共存，进程会 FATAL 退出；
 * - `roles[].tables` 与 `sources:` 也不能共存。
 *
 * 所以新项目直接渲染 `sources:`，旧项目由 supervisor 走配置 API 迁移（见 migrate.js）。
 * 连接编辑只在 `sources:` 块内按条目更新，其余内容逐字保留 —— GraphJin 会把运行时
 * 配置（access / roles）回写进 dev.yml，整份重渲染会冲掉它。
 */

const DEV_YAML_TEMPLATE = `app_name: {appName}
mode: dev
host_port: 127.0.0.1:{port}
web_ui: {webUi}
log_level: "info"
production: false
default_block: false
secret_key: {secretKey}

identity:
  role_claims: ["roles"]
  admin_roles: ["admin"]

auth:
  type: none
  development: true

header_variables:
  user_code: "X-User-Code"

mcp:
  allow_config_updates: true
  allow_dev_tools: true

system:
  root_access:
    gj_config: admin
  capabilities:
    catalog.read: true
    config.read: true
    config.write: true
    dev_tools.read: true
    security.read: true

artifacts:
  auto_init: true
  globals_path: ./config
  poll_seconds: 15
  schema: _graphjin

sources:
{sources}
`;

/** 连接字段的渲染顺序；default 单独处理，必须排在最后 */
const CONNECTION_KEYS = [
  'kind',
  'type',
  'host',
  'port',
  'dbname',
  'user',
  'password',
  'path',
  'schema',
  'connection_string',
];

/** 回写 sources 时必须跳过的字段：GraphJin 用 time.Duration 表示，字符串形式无法反序列化 */
const DURATION_KEYS = new Set([
  'max_connection_idle_time',
  'max_connection_life_time',
  'ping_timeout',
]);

/** 新数据源的默认访问档位：读需认证，写/删关闭（决策 A） */
const DEFAULT_ACCESS = {
  read: 'authenticated',
  write: 'blocked',
  delete: 'blocked',
};

/**
 * 渲染 YAML 键：只在必要时加引号，保持已有文件的可读性。
 *
 * @param {string} key
 * @returns {string}
 */
function renderKey(key) {
  const text = String(key);
  return /^[A-Za-z0-9_.-]+$/.test(text) ? text : JSON.stringify(text);
}

/**
 * 去掉 YAML 标量两端的引号并还原最小转义。
 *
 * @param {string} raw
 * @returns {string}
 */
function unquote(raw) {
  const text = String(raw).trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return text;
}

/**
 * 渲染一个 YAML 标量。
 *
 * @param {*} value
 * @returns {string}
 */
function renderKind(value) {
  const text = String(value);
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(text) ? text : renderScalar(text);
}

function renderScalar(value) {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return String(value);
  return JSON.stringify(String(value));
}

/**
 * 把一个连接渲染成 `sources` 数组项。
 *
 * @param {string} name 数据源名
 * @param {Object} conn 连接信息
 * @param {number} [indent] 数组项缩进，缺省 2
 * @returns {string} YAML 片段
 */
function renderSource(name, conn, indent = 2) {
  const config = conn ?? {};
  const pad = ' '.repeat(indent);
  const field = `${pad}  `;
  const lines = [`${pad}- name: ${renderScalar(name)}`];

  for (const key of CONNECTION_KEYS) {
    if (key === 'kind') {
      lines.push(`${field}kind: ${renderKind(config.kind ?? 'database')}`);
      continue;
    }
    const value = config[key];
    if (value === undefined || value === null || value === '') continue;
    lines.push(`${field}${key}: ${renderScalar(value)}`);
  }

  if (config.default === true) lines.push(`${field}default: true`);

  const access = config.access ?? DEFAULT_ACCESS;
  lines.push(`${field}access:`);
  lines.push(`${field}  read: ${renderScalar(access.read ?? DEFAULT_ACCESS.read)}`);
  lines.push(`${field}  write: ${renderScalar(access.write ?? DEFAULT_ACCESS.write)}`);
  lines.push(`${field}  delete: ${renderScalar(access.delete ?? DEFAULT_ACCESS.delete)}`);
  if (access.owner_column) lines.push(`${field}  owner_column: ${renderScalar(access.owner_column)}`);
  if (access.namespace_column) {
    lines.push(`${field}  namespace_column: ${renderScalar(access.namespace_column)}`);
  }

  if (Array.isArray(access.admin_tables) && access.admin_tables.length > 0) {
    lines.push(`${field}  admin_tables: [${access.admin_tables.map(renderScalar).join(', ')}]`);
  }
  if (Array.isArray(access.blocked_tables) && access.blocked_tables.length > 0) {
    lines.push(`${field}  blocked_tables: [${access.blocked_tables.map(renderScalar).join(', ')}]`);
  }

  if (Array.isArray(access.grants) && access.grants.length > 0) {
    lines.push(`${field}  grants:`);
    for (const grant of access.grants) {
      lines.push(`${field}    - role: ${renderScalar(grant.role)}`);
      lines.push(`${field}      tables:`);
      for (const table of grant.tables ?? []) {
        lines.push(`${field}        - name: ${renderScalar(table.name)}`);
        lines.push(
          `${field}          columns: [${(table.columns ?? []).map(renderScalar).join(', ')}]`
        );
        if (table.filter) lines.push(`${field}          filter: ${renderScalar(table.filter)}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * 渲染 dev.yml 全文。
 *
 * @param {Object} options
 * @param {string} options.appName 应用名
 * @param {number} options.port 监听端口
 * @param {Array<Object>} options.sources 数据源列表，每项含 name 与连接字段
 * @param {boolean} [options.webUi] 是否开启内置控制台
 * @param {string} [options.secretKey] 本地开发用的密钥
 * @returns {string} dev.yml 内容
 */
function renderDevYaml({ appName, port, sources, webUi = false, secretKey = 'local-dev-secret' }) {
  if (!appName) throw new Error('appName 不能为空');
  if (!Number.isInteger(port) || port <= 0) throw new Error('port 必须是正整数');
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error('sources 不能为空：source 模式要求至少配置一个数据源');
  }

  const rendered = sources
    .map((source) => {
      const { name, ...conn } = source;
      if (!name) throw new Error('sources 每项都必须有 name');
      return renderSource(name, conn);
    })
    .join('\n');

  return DEV_YAML_TEMPLATE.replace('{appName}', appName)
    .replace('{port}', String(port))
    .replace('{webUi}', String(webUi))
    .replace('{secretKey}', secretKey)
    .replace('{sources}', rendered);
}

/**
 * 在目标目录写出 dev.yml。
 *
 * @param {Object} options 同 renderDevYaml，另需 dir
 * @param {string} options.dir 项目目录
 * @returns {string} 写出的 dev.yml 路径
 */
function createProject({ dir, ...options }) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'dev.yml');
  fs.writeFileSync(file, renderDevYaml(options), 'utf8');
  return file;
}

/**
 * 定位 `sources:` 块的起止行。
 *
 * 支持 GraphJin 回写后的 4 空格缩进与手写的 2 空格缩进；flow 风格（同一行写数组）
 * 不做支持 —— 文本级改写它必然出错，宁可报错让用户改成块风格。
 *
 * @param {string[]} lines
 * @returns {{header: number, end: number, itemIndent: number}} end 不含
 */
function findSourcesBlock(lines) {
  const header = lines.findIndex((line) => /^sources\s*:/.test(line));
  if (header < 0) throw new Error('dev.yml 缺少 sources 段，无法合并连接');

  const inline = lines[header].slice(lines[header].indexOf(':') + 1).trim();
  if (inline !== '' && inline !== '[]') {
    throw new Error('dev.yml 的 sources 用了 flow 风格（同一行写数组），平台无法安全合并，请改成块风格');
  }

  let end = header + 1;
  let itemIndent = null;
  for (let i = header + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') {
      end = i + 1;
      continue;
    }
    const indent = /^ */.exec(line)[0].length;
    if (indent === 0) break;
    if (itemIndent === null) {
      const match = /^( *)- /.exec(line);
      if (match) itemIndent = match[1].length;
    }
    end = i + 1;
  }

  return { header, end, itemIndent: itemIndent ?? 2 };
}

/**
 * 把 sources 块切成条目，保留每条的原文。
 *
 * @param {string[]} lines
 * @param {{header: number, end: number, itemIndent: number}} block
 * @returns {Array<{name: string, start: number, end: number, lines: string[]}>}
 */
function splitSourceEntries(lines, block) {
  const headerPattern = new RegExp(`^ {${block.itemIndent}}-\\s`);
  const entries = [];
  let current = null;

  for (let i = block.header + 1; i < block.end; i += 1) {
    const line = lines[i];
    if (headerPattern.test(line)) {
      const nameMatch = /^ *-\s+name\s*:\s*(.+)$/.exec(line);
      current = {
        name: nameMatch ? unquote(nameMatch[1].replace(/\s+#.*$/, '')) : '',
        start: i,
        end: block.end,
        lines: [line],
      };
      entries.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }

  for (let i = 0; i < entries.length; i += 1) {
    entries[i].end = i + 1 < entries.length ? entries[i + 1].start : block.end;
  }
  return entries;
}

/**
 * 在条目内就地更新连接字段，保留 access 与未知字段。
 *
 * @param {string[]} entryLines 条目原文（第一行是 `- name: ...`）
 * @param {Object} conn 新的连接信息
 * @returns {string[]} 更新后的条目
 */
function updateSourceEntry(entryLines, conn) {
  const config = conn ?? {};
  const header = entryLines[0];
  const headerIndent = /^ */.exec(header)[0].length;
  const fieldIndent = ' '.repeat(headerIndent + 2);

  const known = new Set(['name', ...CONNECTION_KEYS, 'default']);
  const accessIndex = entryLines.findIndex((line) =>
    new RegExp(`^ {${headerIndent + 2}}access\\s*:`).test(line)
  );
  const regionEnd = accessIndex >= 0 ? accessIndex : entryLines.length;

  const body = [];
  const seen = new Set();
  const unknown = [];

  for (let i = 1; i < regionEnd; i += 1) {
    const line = entryLines[i];
    const match = new RegExp(`^ {${headerIndent + 2}}([A-Za-z0-9_.-]+)\\s*:`).exec(line);
    if (!match) {
      unknown.push(line);
      continue;
    }
    const key = match[1];
    seen.add(key);
    if (!known.has(key)) unknown.push(line);
  }

  // 按固定顺序重建已知字段，值缺失的字段直接丢掉
  for (const key of CONNECTION_KEYS) {
    if (key === 'kind') {
      body.push(`${fieldIndent}kind: ${renderKind(config.kind ?? 'database')}`);
      continue;
    }
    const value = config[key];
    if (value === undefined || value === null || value === '') continue;
    body.push(`${fieldIndent}${key}: ${renderScalar(value)}`);
  }
  if (config.default === true) body.push(`${fieldIndent}default: true`);

  const rendered = [header, ...body, ...unknown];
  if (accessIndex >= 0) rendered.push(...entryLines.slice(accessIndex));
  return rendered;
}

/**
 * 把一批连接合并进 dev.yml 的 `sources:` 段。
 *
 * 只改连接字段：每条的 `access`（权限）与其它未知字段逐字保留。
 * 新默认源会把其它条目的 `default: true` 摘掉。
 *
 * @param {string} text dev.yml 内容
 * @param {Object} sources { name: conn } 或 [{ name, ...conn }]
 * @returns {string} 合并后的内容
 */
function mergeSourceBlock(text, sources) {
  const provided = Array.isArray(sources)
    ? sources.map(({ name, ...conn }) => [name, conn])
    : Object.entries(sources ?? {});
  if (provided.length === 0) return text;

  // 手写的单行 flow 先归一化成块风格，后面只面对一种格式
  const lines = normalizeFlowSources(text).split('\n');
  const block = findSourcesBlock(lines);

  for (const line of lines.slice(block.header, block.end)) {
    if (/(^|\s)<<\s*:/.test(line)) {
      throw new Error('dev.yml 的 sources 段用了 merge key（<<:），平台无法安全合并，请改成显式字段');
    }
    if (/(^|\s|:)\s*[&*][A-Za-z0-9_-]+/.test(line)) {
      throw new Error('dev.yml 的 sources 段用了 YAML anchor / alias（& / *），平台无法安全合并，请手工编辑');
    }
  }

  const entries = splitSourceEntries(lines, block);
  const rendered = entries.map((entry) => ({ name: entry.name, lines: entry.lines }));

  const providedDefault = provided.find(([, conn]) => conn?.default === true)?.[0] ?? null;

  for (const [name, conn] of provided) {
    const existing = rendered.find((entry) => entry.name === name);
    if (existing) {
      existing.lines = updateSourceEntry(existing.lines, conn);
    } else {
      rendered.push({ name, lines: renderSource(name, conn, block.itemIndent).split('\n') });
    }
  }

  const defaultName =
    providedDefault ??
    rendered.find((entry) => /^\s+default:\s*true\s*$/.test(entry.lines.join('\n')))?.name ??
    null;

  const blockLines = rendered.flatMap((entry) => {
    if (!defaultName || entry.name === defaultName) return entry.lines;
    return entry.lines.map((line) =>
      /^\s+default:\s*true\s*$/.test(line) ? null : line
    ).filter((line) => line !== null);
  });

  return [...lines.slice(0, block.header + 1), ...blockLines, ...lines.slice(block.end)].join('\n');
}

/**
 * 写入 sources 段：已存在则逐项合并，不存在则追加到文件末尾。
 *
 * @param {string} text dev.yml 内容
 * @param {Array<Object>} sources [{ name, ...conn }]
 * @returns {string}
 */
function upsertSourcesBlock(text, sources) {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error('sources 不能为空：source 模式要求至少配置一个数据源');
  }
  const lines = text.split('\n');
  if (lines.some((line) => /^sources\s*:/.test(line))) {
    return mergeSourceBlock(text, sources);
  }

  const block = ['sources:', ...sources.map(({ name, ...conn }) => renderSource(name, conn))].join('\n');
  return `${text.replace(/\s*$/, '')}\n\n${block}\n`;
}

/**
 * 把 roles 段整体替换成「只有名字」的形态。
 *
 * source 模式禁止 `roles[].tables`，而 legacy 文件里每张表都展开成了几十行；
 * 逐段编辑不可靠，直接整块重写。
 *
 * @param {string} text dev.yml 内容
 * @param {string[]} names 角色名
 * @returns {string}
 */
function replaceRolesBlock(text, names) {
  const lines = text.split('\n');
  const rendered = ['roles:', ...names.map((name) => `  - name: ${renderScalar(name)}`)];
  const start = lines.findIndex((line) => /^roles\s*:/.test(line));
  if (start < 0) return `${text.replace(/\s*$/, '')}\n\n${rendered.join('\n')}\n`;

  let end = start + 1;
  while (end < lines.length && !/^[A-Za-z_][\w-]*\s*:/.test(lines[end])) end += 1;
  return [...lines.slice(0, start), ...rendered, ...lines.slice(end)].join('\n');
}

/**
 * 从 dev.yml 的 sources 段删掉一个库。
 *
 * 只动这一个条目，其余条目（含 access）逐字保留；删掉的如果是默认源，
 * 把 default 挪给剩下的第一条，避免整个项目失去默认库。
 *
 * @param {string} file dev.yml 路径
 * @param {string} name 库名
 * @returns {boolean} 文件里没有这个 source 时返回 false
 */
function removeProjectSource(file, name) {
  if (!fs.existsSync(file)) return false;
  const lines = normalizeFlowSources(fs.readFileSync(file, 'utf8')).split('\n');
  const block = findSourcesBlock(lines);
  const entries = splitSourceEntries(lines, block);
  const target = entries.find((entry) => entry.name === name);
  if (!target) return false;

  const isDefaultLine = (line) => /^\s+default:\s*true\s*$/.test(line);
  let kept = entries.filter((entry) => entry !== target);
  const lostDefault =
    target.lines.some(isDefaultLine) && !kept.some((entry) => entry.lines.some(isDefaultLine));
  if (lostDefault && kept.length > 0) {
    const [first, ...rest] = kept;
    const [head, ...body] = first.lines;
    const indent = /^ */.exec(head)[0];
    kept = [{ ...first, lines: [head, `${indent}  default: true`, ...body] }, ...rest];
  }

  const blockLines = kept.flatMap((entry) => entry.lines);
  const text = [
    ...lines.slice(0, block.header + 1),
    ...blockLines,
    ...lines.slice(block.end),
  ].join('\n');
  fs.writeFileSync(file, text, 'utf8');
  return true;
}

/**
 * 就地合并 dev.yml 里的 sources 段。
 *
 * @param {string} file dev.yml 路径
 * @param {Object|Array} sources 数据源连接
 * @returns {string} 同一个路径
 */
function mergeProjectSources(file, sources) {
  const empty = Array.isArray(sources) ? sources.length === 0 : Object.keys(sources ?? {}).length === 0;
  if (empty) return file;
  const text = fs.readFileSync(file, 'utf8');
  const merged = mergeSourceBlock(text, sources);
  if (merged !== text) fs.writeFileSync(file, merged, 'utf8');
  return file;
}

/**
 * 给已存在的 dev.yml 补齐网关需要的配置。
 *
 * 老项目文件不会整份重渲染（只在 sources 段做合并，避免冲掉 GraphJin 回写的权限），
 * 所以「身份变量」和「只监听回环」这两项必须单独补上：
 * - 少了 `header_variables`，`$user_code` 解析不到，行过滤会退化成 0 行；
 * - 监听 0.0.0.0 时外部进程可以绕过网关直连 GraphJin，自称 admin。
 *
 * @param {string} file dev.yml 路径
 * @returns {boolean} 是否改动了文件
 */
function ensureGatewayConfig(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  let changed = false;

  for (let i = 0; i < lines.length; i += 1) {
    if (/^host_port\s*:\s*0\.0\.0\.0:/.test(lines[i])) {
      lines[i] = lines[i].replace('0.0.0.0:', '127.0.0.1:');
      changed = true;
    }
  }

  if (!/^header_variables\s*:/m.test(text)) {
    const insertAt = lines.findIndex((line) => /^(sources|roles|databases)\s*:/.test(line));
    const block = ['header_variables:', '  user_code: "X-User-Code"', ''];
    lines.splice(insertAt >= 0 ? insertAt : lines.length, 0, ...block);
    changed = true;
  }

  if (changed) fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return changed;
}

/**
 * 从 dev.yml 的 sources 段读回连接字段（含密码）。
 *
 * get_current_config 会把密码脱敏成 `[REDACTED]`，而整份 `sources` 替换必须带
 * 真实连接串，所以写入前只能从文件里读。
 *
 * @param {string} text dev.yml 内容
 * @returns {Object} { name: { type, host, port, dbname, user, password, path, schema, connection_string, default } }
 */
function readSourceConnections(text) {
  // 单行 flow 与块风格读同一份结果，避免两条解析路径
  const lines = normalizeFlowSources(text).split('\n');
  const block = findSourcesBlock(lines);
  const entries = splitSourceEntries(lines, block);
  const result = {};

  for (const entry of entries) {
    if (!entry.name) continue;
    let accessIndent = null;
    const conn = {};
    for (const line of entry.lines.slice(1)) {
      const stripped = line.trim();
      if (stripped === '') continue;
      const indent = /^ */.exec(line)[0].length;

      if (accessIndent !== null) {
        if (indent > accessIndent) continue;
        accessIndent = null;
      }

      const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(stripped);
      if (!match) continue;
      const [, key, raw] = match;
      if (key === 'access') {
        accessIndent = indent;
        continue;
      }
      // flow 集合（如 `specs: {}`）文本解析还原不了；duration 写成 "0s" 这类字符串
      // 会被 GraphJin 当作 time.Duration 反序列化失败 —— 两类都跳过
      if (raw === '' || raw.startsWith('{') || raw.startsWith('[')) continue;
      if (DURATION_KEYS.has(key) || /^\d+(\.\d+)?(ns|us|µs|ms|s|m|h)$/.test(raw)) continue;
      conn[key] = parseScalar(raw);
    }
    result[entry.name] = conn;
  }

  return result;
}

/**
 * 取行首缩进宽度。
 *
 * @param {string} line
 * @returns {number}
 */
function indentOf(line) {
  return /^ */.exec(line)[0].length;
}

/**
 * 从 dev.yml 的 sources 段读出每个库的 access（含角色 grants）。
 *
 * 实例没跑时 config.current 没有 baseUrl 可用，权限页与欢迎页要判断「配过没有」，
 * 只能读 GraphJin 回写到磁盘的这份配置。
 *
 * @param {string} text dev.yml 内容
 * @returns {Object} { name: { read?, write?, delete?, owner_column?, grants: Array } }
 */
function readSourceAccess(text) {
  const lines = normalizeFlowSources(text).split('\n');
  const block = findSourcesBlock(lines);
  const entries = splitSourceEntries(lines, block);
  const result = {};

  for (const entry of entries) {
    if (!entry.name) continue;
    result[entry.name] = parseAccessBlock(entry.lines);
  }

  return result;
}

/** access 下「字符串数组」的键：表分类与列白名单 */
const ACCESS_LIST_KEYS = new Set([
  'grants',
  'public_tables',
  'admin_tables',
  'blocked_tables',
  'columns',
]);

/**
 * 找标量字段该挂到哪个对象上：栈里最深的那个已打开对象。
 *
 * @param {Array<Object>} stack
 * @param {string} key 仅用于报错信息
 * @returns {Object}
 */
function accessTargetOf(stack, key) {
  for (let depth = stack.length - 1; depth >= 0; depth -= 1) {
    if (stack[depth].item) return stack[depth].item;
  }
  throw new Error(`dev.yml 的 access 段里 ${key} 找不到所属对象`);
}

/**
 * 解析单个 source 条目里的 access 段。
 *
 * 用缩进栈而不是写死层级宽度：GraphJin 回写与手写项目的缩进可能是 2 或 4 空格。
 * 只认 access → grants[].role → tables[].name 这一条路（外加表分类这类字符串数组），
 * 其余形态直接报错 —— 猜错会让「没配权限」显示成「已配置」，比报错更难查。
 *
 * @param {string[]} entryLines 条目原文（第一行是 `- name: ...`）
 * @returns {Object} access
 */
function parseAccessBlock(entryLines) {
  const access = { grants: [] };
  const start = entryLines.findIndex((line) => /^\s+access\s*:\s*$/.test(line));
  if (start < 0) return access;

  const accessIndent = indentOf(entryLines[start]);
  /** 每层容器一项：item 指向该层刚打开的对象，标量字段挂到最深的 item 上 */
  const stack = [{ kind: 'access', indent: accessIndent, item: access, items: [] }];

  for (let i = start + 1; i < entryLines.length; i += 1) {
    const body = entryLines[i].trim();
    if (body === '' || body.startsWith('#')) continue;

    const indent = indentOf(entryLines[i]);
    if (indent <= accessIndent) break;

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];

    const listItem = /^-\s+(.+)$/.exec(body);
    if (listItem) {
      const rest = listItem[1].trim();
      const pair = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(rest);

      if (parent.kind === 'grants') {
        if (!pair || pair[1] !== 'role') {
          throw new Error(`dev.yml 的 access 段出现无法解析的列表项：${body}`);
        }
        const grant = { role: parseScalar(pair[2]), tables: [] };
        parent.items.push(grant);
        parent.item = grant;
        continue;
      }
      if (parent.kind === 'tables') {
        if (!pair || pair[1] !== 'name') {
          throw new Error(`dev.yml 的 access 段出现无法解析的列表项：${body}`);
        }
        const table = { name: parseScalar(pair[2]), columns: [] };
        parent.items.push(table);
        parent.item = table;
        continue;
      }
      if (parent.kind === 'scalars' && !pair) {
        parent.items.push(parseScalar(rest));
        continue;
      }
      throw new Error(`dev.yml 的 access 段出现无法解析的列表项：${body}`);
    }

    const field = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(body);
    if (!field) throw new Error(`dev.yml 的 access 段出现无法解析的行：${body}`);
    const [, key, raw] = field;
    const value = raw.replace(/\s+#.*$/, '').trim();

    if (value === '' || value === '[]') {
      const empty = value === '[]';
      if (key === 'grants') {
        if (!empty) stack.push({ kind: 'grants', indent, item: null, items: access.grants });
        continue;
      }
      if (key === 'tables') {
        if (parent.kind !== 'grants' || !parent.item) {
          throw new Error('dev.yml 的 access 段里 tables 不在某个 role 下');
        }
        if (!empty) stack.push({ kind: 'tables', indent, item: null, items: parent.item.tables });
        continue;
      }
      if (ACCESS_LIST_KEYS.has(key)) {
        const target = accessTargetOf(stack, key);
        target[key] = [];
        if (!empty) stack.push({ kind: 'scalars', indent, item: null, items: target[key] });
        continue;
      }
      throw new Error(`dev.yml 的 access 段出现未知的嵌套键：${key}`);
    }

    if (key === 'grants') {
      throw new Error('dev.yml 的 access 段里 grants 用了 flow 风格，平台无法解析');
    }

    const target = accessTargetOf(stack, key);
    target[key] = ACCESS_LIST_KEYS.has(key) ? parseFlowList(value) : parseScalar(value);
  }

  return access;
}

/**
 * 解析单行 flow 数组，如 `columns: ["id", "name"]`。
 *
 * @param {string} raw
 * @returns {Array}
 */
function parseFlowList(raw) {
  const text = raw.trim();
  if (!text.startsWith('[') || !text.endsWith(']')) {
    throw new Error(`dev.yml 的 access 段期望数组，实际是：${text}`);
  }
  return splitTopLevel(text.slice(1, -1), ',').map((item) => parseScalar(item));
}

/**
 * 读 dev.yml 顶层的 roles 名单。
 *
 * 实例停止时 grantedRoles 也要有内容，否则 MCP 页的角色下拉只剩 admin。
 *
 * @param {string} text dev.yml 内容
 * @returns {string[]}
 */
function readProjectRoles(text) {
  const lines = text.split('\n');
  const header = lines.findIndex((line) => /^roles\s*:/.test(line));
  if (header < 0) return [];
  const inline = lines[header].slice(lines[header].indexOf(':') + 1).trim();
  if (inline === '[]') return [];

  const names = [];
  for (let i = header + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (indentOf(line) === 0) break;
    const match = /^\s*-\s+name\s*:\s*(.+)$/.exec(line);
    if (match) names.push(unquote(match[1].replace(/\s+#.*$/, '')));
  }
  return names;
}

/**
 * 按顶层分隔符切分，跳过引号内与嵌套括号内的分隔符。
 *
 * @param {string} text
 * @param {string} separator 单字符（, 或 :）
 * @returns {string[]}
 */
function splitTopLevel(text, separator) {
  const parts = [];
  let current = '';
  let depth = 0;
  let quote = null;

  for (const char of text) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '{' || char === '[') depth += 1;
    if (char === '}' || char === ']') depth -= 1;
    if (char === separator && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/**
 * 解析单行 flow 数组 `[{ name: app, type: sqlite }]`。
 *
 * 只支持扁平对象：值必须是标量或带引号的字符串。`access` 这类嵌套结构在文本级
 * 重排会丢权限，遇到直接报错，让用户改回块格式。
 *
 * @param {string} inline `sources:` 冒号后的内容
 * @returns {Array<Object>}
 */
function parseFlowSources(inline) {
  const text = inline.trim();
  if (!text.startsWith('[') || !text.endsWith(']')) {
    throw new Error('dev.yml 的 sources 必须是数组，平台无法安全合并');
  }
  const body = text.slice(1, -1).trim();
  if (body === '') return [];

  return splitTopLevel(body, ',').map((raw) => {
    const item = raw.replace(/^\{/, '').replace(/\}$/, '').trim();
    const fields = {};
    for (const pair of splitTopLevel(item, ',')) {
      const colon = pair.indexOf(':');
      if (colon < 0) throw new Error(`sources 里的 flow 条目无法解析：${pair}`);
      const key = pair.slice(0, colon).trim().replace(/^["']|["']$/g, '');
      const value = pair.slice(colon + 1).trim();
      if (value.startsWith('{') || value.startsWith('[')) {
        throw new Error(
          `dev.yml 的 sources 里 ${key} 是嵌套结构，平台无法安全合并，请改成块风格`
        );
      }
      fields[key] = parseScalar(value);
    }
    return fields;
  });
}

/**
 * 把 `sources: [{...}]` 归一化成块格式，其余行原样保留。
 *
 * 归一化后 mergeSourceBlock / readSourceConnections 都只面对块风格，避免两套路径。
 *
 * @param {string} text dev.yml 内容
 * @returns {string}
 */
function normalizeFlowSources(text) {
  const lines = text.split('\n');
  const header = lines.findIndex((line) => /^sources\s*:/.test(line));
  if (header < 0) return text;
  const inline = lines[header].slice(lines[header].indexOf(':') + 1).trim();
  if (inline === '') return text;
  // 空 flow 数组要还原成空块头部，否则条目会跟在 `sources: []` 后面变成非法 YAML
  if (inline === '[]') {
    return [...lines.slice(0, header), 'sources:', ...lines.slice(header + 1)].join('\n');
  }

  const rendered = ['sources:'];
  for (const item of parseFlowSources(inline)) {
    const { name, ...conn } = item;
    if (!name) throw new Error('dev.yml 的 sources 有缺少 name 的条目，平台无法安全合并');
    rendered.push(...renderSource(name, conn, 2).split('\n'));
  }
  return [...lines.slice(0, header), ...rendered, ...lines.slice(header + 1)].join('\n');
}

/**
 * 解析 YAML 标量（只覆盖连接配置会出现的类型）。
 *
 * @param {string} raw
 * @returns {*}
 */
function parseScalar(raw) {
  const text = String(raw).trim();
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === '~') return null;
  if (/^-?\d+$/.test(text)) return Number(text);
  return unquote(text);
}

module.exports = {
  DEV_YAML_TEMPLATE,
  DEFAULT_ACCESS,
  renderDevYaml,
  renderSource,
  ensureGatewayConfig,
  createProject,
  mergeSourceBlock,
  mergeProjectSources,
  removeProjectSource,
  upsertSourcesBlock,
  replaceRolesBlock,
  readSourceConnections,
  readSourceAccess,
  readProjectRoles,
  parseScalar,
};
