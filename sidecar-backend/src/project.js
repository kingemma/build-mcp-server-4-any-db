'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 生成 GraphJin 项目配置（方案 B 形态）。
 *
 * 只输出 `databases:` map —— 实测两条硬约束：
 * - 配置 `sources` 后 `roles[].tables` 会被拒；
 * - 单数 `database:` 会让服务端在 update_current_config 时 panic 退出。
 */

const DEV_YAML_TEMPLATE = `app_name: {appName}
mode: dev
host_port: 0.0.0.0:{port}
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

databases:
{databases}
`;

/**
 * 把一个数据库连接渲染成 YAML 片段。
 *
 * @param {string} name 库名，会写入 RoleTable.database
 * @param {Object} conn 连接信息
 * @returns {string} YAML 片段
 */
/**
 * 把一个数据库连接渲染成 YAML 片段。
 *
 * @param {string} name 库名，会写入 RoleTable.database
 * @param {Object} conn 连接信息
 * @param {number} [indent] 条目缩进空格数；GraphJin 回写配置时用 4
 * @param {number} [nestedIndent] 字段缩进空格数；缺省比条目多 2
 * @returns {string} YAML 片段
 */
function renderDatabase(name, conn, indent = 2, nestedIndent = indent + 2) {
  const config = conn ?? {};
  const pad = ' '.repeat(indent);
  const nested = ' '.repeat(nestedIndent);
  const lines = [`${pad}${renderKey(name)}:`];
  const keys = [
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
  const extras = Object.keys(config).filter(
    (key) => key !== 'default' && !keys.includes(key)
  );
  for (const key of [...keys, ...extras]) {
    const value = config[key];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'number') lines.push(`${nested}${key}: ${value}`);
    else if (typeof value === 'boolean') lines.push(`${nested}${key}: ${value}`);
    else if (typeof value === 'string') lines.push(`${nested}${key}: ${JSON.stringify(value)}`);
  }
  if (config.default === true) lines.push(`${nested}default: true`);
  return lines.join('\n');
}

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
 * 去掉 YAML 键两端的引号并还原最小转义。
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
 * 解析 YAML flow map（只覆盖数据库连接会出现的子集：嵌套 map、字符串、数字、布尔）。
 *
 * 手写的 dev.yml 可能写成 `databases: { app: { type: sqlite } }`；不解析它就没法合并。
 *
 * @param {string} source 形如 `{ app: { type: sqlite, path: app.db } }`
 * @returns {Object} 解析结果
 */
function parseFlowMap(source) {
  const text = String(source);
  let index = 0;

  const skipSpace = () => {
    while (index < text.length && /\s/.test(text[index])) index += 1;
  };

  const parseQuoted = () => {
    const quote = text[index];
    index += 1;
    let out = '';
    while (index < text.length) {
      const char = text[index];
      index += 1;
      if (char === quote) {
        if (quote === "'" && text[index] === "'") {
          out += "'";
          index += 1;
          continue;
        }
        return out;
      }
      if (char === '\\' && quote === '"' && index < text.length) {
        const next = text[index];
        index += 1;
        out += next === 'n' ? '\n' : next === 't' ? '\t' : next;
        continue;
      }
      out += char;
    }
    throw new Error('flow YAML 字符串未闭合');
  };

  const parseKey = () => {
    skipSpace();
    if (text[index] === '"' || text[index] === "'") return parseQuoted();
    const start = index;
    while (index < text.length && text[index] !== ':') index += 1;
    return text.slice(start, index).trim();
  };

  const parseScalar = (raw) => {
    const value = raw.trim();
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (value === 'null' || value === '~') return null;
    if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
    return value;
  };

  const parseValue = () => {
    skipSpace();
    if (text[index] === '{') return parseMap();
    if (text[index] === '"' || text[index] === "'") return parseQuoted();
    const start = index;
    while (index < text.length && text[index] !== ',' && text[index] !== '}') index += 1;
    return parseScalar(text.slice(start, index));
  };

  const parseMap = () => {
    skipSpace();
    if (text[index] !== '{') throw new Error('flow YAML 必须以 { 开头');
    index += 1;
    const result = {};
    skipSpace();
    if (text[index] === '}') {
      index += 1;
      return result;
    }
    for (;;) {
      const key = parseKey();
      skipSpace();
      if (text[index] !== ':') throw new Error(`flow YAML 键 ${key} 缺少冒号`);
      index += 1;
      result[key] = parseValue();
      skipSpace();
      if (text[index] === ',') {
        index += 1;
        continue;
      }
      if (text[index] === '}') {
        index += 1;
        return result;
      }
      throw new Error('flow YAML 缺少 , 或 }');
    }
  };

  const parsed = parseMap();
  skipSpace();
  if (index < text.length) throw new Error('flow YAML 末尾有多余内容');
  return parsed;
}

/**
 * 从 `databases:` 行开始，收集完整的 flow map 文本（可能跨行）。
 *
 * @param {string[]} lines
 * @param {number} start
 * @returns {{text: string, end: number}} end 为结束行序号（不含）
 */
function collectFlowMap(lines, start) {
  const first = lines[start];
  const colon = first.indexOf(':');
  let text = first.slice(colon + 1).trim();
  let end = start + 1;
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === '\\' && quote === '"') i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
  }
  while (depth > 0 && end < lines.length) {
    text += `\n${lines[end]}`;
    for (let i = 0; i < lines[end].length; i += 1) {
      const char = lines[end][i];
      if (quote) {
        if (char === '\\' && quote === '"') i += 1;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === '"' || char === "'") quote = char;
      else if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
    }
    end += 1;
  }
  if (depth !== 0) throw new Error('dev.yml 的 databases flow 段未闭合');
  return { text, end };
}

/**
 * 渲染 dev.yml 全文。
 *
 * @param {Object} options
 * @param {string} options.appName 应用名
 * @param {number} options.port 监听端口
 * @param {Object} options.databases 库名 → 连接信息
 * @param {boolean} [options.webUi] 是否开启内置控制台
 * @param {string} [options.secretKey] 本地开发用的密钥
 * @returns {string} dev.yml 内容
 */
function renderDevYaml({ appName, port, databases, webUi = false, secretKey = 'local-dev-secret' }) {
  if (!appName) throw new Error('appName 不能为空');
  if (!Number.isInteger(port) || port <= 0) throw new Error('port 必须是正整数');
  if (!databases || Object.keys(databases).length === 0) {
    throw new Error('databases 不能为空：方案 B 要求至少配置一个库');
  }

  const rendered = Object.entries(databases)
    .map(([name, conn]) => renderDatabase(name, conn))
    .join('\n');

  return DEV_YAML_TEMPLATE.replace('{appName}', appName)
    .replace('{port}', String(port))
    .replace('{webUi}', String(webUi))
    .replace('{secretKey}', secretKey)
    .replace('{databases}', rendered);
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
 * 把一批连接合并进已有的 dev.yml。
 *
 * GraphJin 执行 update_current_config 后会把配置写回 dev.yml（roles 等都在里面），
 * 所以启动时不能整份重渲染 —— 那会冲掉权限。这里只改 `databases:` 块，其余内容
 * 逐字保留。
 *
 * @param {string} text dev.yml 内容
 * @param {Object} databases 库名 → 连接信息
 * @returns {string} 合并后的内容
 */
function mergeDatabaseBlock(text, databases) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^databases\s*:/.test(line));
  if (start < 0) throw new Error('dev.yml 缺少 databases 段，无法合并连接');

  const provided = Object.entries(databases ?? {});
  const providedDefault = provided.find(([, conn]) => conn?.default === true)?.[0] ?? null;

  // flow 风格（databases: { ... }）：整体解析后转成块风格，否则文本级合并改不动它
  if (lines[start].slice(lines[start].indexOf(':') + 1).trim() !== '') {
    const flow = collectFlowMap(lines, start);
    const parsed = parseFlowMap(flow.text);
    for (const [name, conn] of provided) parsed[name] = conn;

    const defaultName =
      providedDefault ?? Object.entries(parsed).find(([, conn]) => conn?.default === true)?.[0] ?? null;
    const block = Object.entries(parsed).flatMap(([name, conn]) => {
      const value = { ...conn };
      if (defaultName) {
        if (name === defaultName) value.default = true;
        else delete value.default;
      }
      return renderDatabase(name, value).split('\n');
    });

    return [...lines.slice(0, start), 'databases:', ...block, ...lines.slice(flow.end)].join('\n');
  }

  // 块风格：先看第一个缩进行决定条目缩进。本项目生成 2 空格，
  // GraphJin 回写配置时是 4 空格，两种都必须能继续合并。
  let entryIndent = null;
  let end = start + 1;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '') {
      end = i + 1;
      continue;
    }
    const indent = /^ */.exec(lines[i])[0].length;
    if (indent === 0) break;
    if (entryIndent === null) entryIndent = indent;
    if (indent < entryIndent) break;
    end = i + 1;
  }
  const indent = entryIndent ?? 2;
  // 支持手写引号键：  "app": / 'app':
  const headerPattern = new RegExp(
    `^ {${indent}}("(?:[^"\\\\]|\\\\.)*"|'(?:[^']|'')*'|[^\\s:#][^:]*)\\s*:\\s*(.*)$`
  );

  const preamble = [];
  const entries = [];
  let current = null;
  let nestedIndent = null;
  for (let i = start + 1; i < end; i += 1) {
    const line = lines[i];
    const header = headerPattern.exec(line);
    if (header) {
      current = { name: unquote(header[1]), lines: [line] };
      entries.push(current);
      // 行内 flow 值可能跨行；按花括号平衡把后续行并进同一条目
      if (header[2].trim().startsWith('{')) {
        let depth = 0;
        let quote = null;
        const scan = (source) => {
          for (let j = 0; j < source.length; j += 1) {
            const char = source[j];
            if (quote) {
              if (char === '\\' && quote === '"') j += 1;
              else if (char === quote) quote = null;
              continue;
            }
            if (char === '"' || char === "'") quote = char;
            else if (char === '{') depth += 1;
            else if (char === '}') depth -= 1;
          }
        };
        scan(header[2]);
        while (depth > 0 && i + 1 < end) {
          i += 1;
          current.lines.push(lines[i]);
          scan(lines[i]);
        }
      }
    } else if (current) {
      current.lines.push(line);
      if (nestedIndent === null && line.trim() !== '') {
        const lineIndent = /^ */.exec(line)[0].length;
        if (lineIndent > indent) nestedIndent = lineIndent;
      }
    } else if (line.trim() !== '') {
      // databases: 与第一个条目之间的注释 / 空行，原样保留
      preamble.push(line);
    }
  }

  for (const [name, conn] of provided) {
    const rendered = renderDatabase(name, conn, indent, nestedIndent ?? indent + 2).split('\n');
    const existing = entries.find((entry) => entry.name === name);
    if (existing) existing.lines = rendered;
    else entries.push({ name, lines: rendered });
  }

  // GraphJin 只允许一个默认库：新设为 default 时把其它条目的 default 去掉
  const defaultName =
    providedDefault ?? entries.find((entry) => /^\s+default:\s*true\s*$/.test(entry.lines.join('\n')))?.name ?? null;
  if (defaultName) {
    for (const entry of entries) {
      if (entry.name === defaultName) continue;
      entry.lines = entry.lines
        .map((line) =>
          // 行内 flow 条目没有独立的 default 行，直接在文本里摘掉
          /^\s+default:\s*true\s*$/.test(line)
            ? null
            : line.replace(/([{,]\s*)default\s*:\s*true\s*(?=[,}])/, '$1').replace(/\s*,\s*(?=[,}])/g, '')
        )
        .filter((line) => line !== null);
    }
  }

  const block = [...preamble, ...entries.flatMap((entry) => entry.lines)];
  return [...lines.slice(0, start + 1), ...block, ...lines.slice(end)].join('\n');
}

/**
 * 就地合并 dev.yml 里的 databases 段。
 *
 * @param {string} file dev.yml 路径
 * @param {Object} databases 库名 → 连接信息
 * @returns {string} 同一个路径
 */
function mergeProjectDatabases(file, databases) {
  if (!databases || Object.keys(databases).length === 0) return file;
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, mergeDatabaseBlock(text, databases), 'utf8');
  return file;
}

module.exports = {
  renderDevYaml,
  renderDatabase,
  createProject,
  mergeDatabaseBlock,
  mergeProjectDatabases,
};
