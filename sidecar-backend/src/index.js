/**
 * MCP Server Build 后端入口：JSON-RPC 方法表 + HTTP / stdio 双传输。
 *
 * @author Zhen (Evan) Wang <18901599114@163.com> — Tel / WeChat: +86 18901599114
 */

'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const readline = require('node:readline');

const { RpcRouter, RpcError } = require('./rpc');
const { UserStore, syncRolesToGraphJin } = require('./users');
const {
  ConnectionStore,
  ORIGIN_START,
  ORIGIN_TEST,
  STATUS_CONNECTED,
  STATUS_VERIFIED,
} = require('./connections');
const { GraphJinService } = require('./graphjin');
const { probeConnection } = require('./connection-probe');
const { discoverSchema, listTables } = require('./schema');
const { GraphJinSupervisor, resolveGraphJinBinary } = require('./supervisor');
const { pickFreePort } = require('./graphjin-process');
const { createDemoProject } = require('./demo');
const {
  buildSourceAccessConfig,
  migrateLegacyRoleTables,
  summarizeSourceAccess,
} = require('./permissions');
const { buildClientConfig, buildCliCommands, listClients, normalizeEndpoint } = require('./mcp-config');
const {
  BUILT_IN_TYPES,
  SUPPORTED_TYPES,
  UNVERIFIED_DRIVERS,
  addTemplate,
  listTypes,
  removeTemplate,
  unsupportedDriverReason,
  validateConnectionFields,
} = require('./db-types');
const { ensureKeystoreKey } = require('./keystore');
const { OntologyStore } = require('./ontology');
const { lintOntology, buildTableIndex } = require('./ontology-lint');
const { proposeEntries, summarizeValues } = require('./ontology-scaffold');
const { evaluateExamples } = require('./ontology-eval');
const { compileRules } = require('./ontology-rules');
const { createOntologyProvider } = require('./ontology-delivery');
const { SnapshotStore, buildRollbackPatch, accessForWrite } = require('./snapshots');
const {
  readSourceConnections,
  readSourceAccess,
  readProjectRoles,
  removeProjectSource,
} = require('./project');
const { dataFile } = require('./paths');
const { executeGraphql } = require('./graphql-http');
const { createMcpGateway } = require('./mcp-gateway');
const { loadSecret, signToken } = require('./jwt');

/** 同一个 GraphJin 地址 + 角色复用一条 MCP 会话，避免每次调用都重新握手 */
const serviceCache = new Map();

const BINARY_MANIFEST = path.join(__dirname, '..', '..', 'graphjin-binaries', 'version.json');

/** @returns {Object|null} 预置二进制的版本清单，供设置页展示 */
function readBinaryManifest() {
  if (!fs.existsSync(BINARY_MANIFEST)) return null;
  return JSON.parse(fs.readFileSync(BINARY_MANIFEST, 'utf8'));
}

const BACKEND_VERSION = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
).version;

async function getService(baseUrl, role = 'admin') {
  const key = `${baseUrl}|${role}`;
  if (!serviceCache.has(key)) {
    const service = new GraphJinService({ baseUrl, role });
    await service.connect();
    serviceCache.set(key, service);
  }
  return serviceCache.get(key);
}

function requireBaseUrl(params) {
  const baseUrl = params?.baseUrl;
  if (typeof baseUrl !== 'string' || baseUrl === '') {
    throw RpcError.invalidParams('baseUrl 不能为空');
  }
  return baseUrl;
}

/**
 * validate_config 的返回形态不统一：成功可能落在 success 或 valid 上。
 *
 * @param {Object} result
 * @returns {boolean}
 */
/**
 * 写入某个数据源的访问配置。
 *
 * 为什么不用 `source_patches`：实测它只更新 read/write/delete/owner_column 等标量，
 * **`access.grants` 会被静默忽略**（.probe/verify-source-config-write.js）。
 * 所以权限只能走整份 `sources` 替换，而替换需要真实连接串 —— 配置 API 返回的是
 * `[REDACTED]`，必须从 dev.yml 里读。
 *
 * @param {GraphJinService} service
 * @param {string|null} projectDir
 * @param {string} database 目标数据源名
 * @param {Object} access buildSourceAccessConfig 的输出
 * @returns {Promise<Object>} 写入结果
 */
async function applySourceAccess(service, projectDir, database, access) {
  if (!projectDir) throw RpcError.invalidParams('缺少 projectDir，无法读取数据源连接信息');
  const devYaml = path.join(path.resolve(projectDir), 'dev.yml');
  const text = fs.existsSync(devYaml) ? fs.readFileSync(devYaml, 'utf8') : '';
  const connections = text ? readSourceConnections(text) : {};

  const config = await service.readConfig('all');
  const sources = (config.sources ?? []).map((source) => {
    const normalized =
      source.name === database ? { ...access } : (accessForWrite(source.access) ?? {});
    // access 是合并写入：不显式给空数组的话，旧 grants 会留在配置里
    if (!normalized.grants) normalized.grants = [];
    return {
      name: source.name,
      kind: source.kind ?? 'database',
      ...(connections[source.name] ?? {}),
      access: normalized,
    };
  });

  if (!sources.some((source) => source.name === database)) {
    throw RpcError.invalidParams(`数据源 ${database} 不存在`);
  }
  return service.updateConfig({ sources });
}

/**
 * 把入参里的 query 归一成 GraphQL 语句本体。
 *
 * 前端输入框既接受语句本体，也接受从调用示例复制来的 JSON 参数（`{ "query": "..." }`）——
 * 用户分不清这两者很正常。粘了 JSON 就替他把 query 取出来；是 JSON 却取不到 query，
 * 说明粘错了东西，这时候必须说清楚，不能把 JSON 扔给 GraphJin，
 * 换回来一句没人看得懂的「unexpected token 'query'」。
 *
 * @param {*} raw params.query
 * @returns {string} GraphQL 语句本体
 */
function requireGraphqlQuery(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw RpcError.invalidParams('query 不能为空');
  }
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return trimmed;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // 语句本体同样以 { 开头，解析失败就按原样交给 GraphJin 判断
    return trimmed;
  }
  if (parsed && typeof parsed.query === 'string' && parsed.query.trim() !== '') {
    return parsed.query.trim();
  }
  throw RpcError.invalidParams(
    'query 看起来是 JSON 参数而不是 GraphQL 语句：请粘贴 { ... } 语句本体，或 { "query": "..." } 形式的参数'
  );
}

/**
 * 把 GraphJin 形态的 grants 数组折成 { role: { table: rule } }。
 *
 * @param {Array<Object>|Object|null} grants
 * @returns {Object}
 */
function grantsToMap(grants) {
  if (!grants) return {};
  if (!Array.isArray(grants)) return grants;
  const map = {};
  for (const grant of grants) {
    if (!grant?.role) continue;
    map[grant.role] ??= {};
    for (const table of grant.tables ?? []) {
      if (!table?.name) continue;
      map[grant.role][table.name] = {
        columns: table.columns ?? [],
        ...(table.filter ? { filter: table.filter } : {}),
      };
    }
  }
  return map;
}

/**
 * 用显式 access 覆盖迁移出来的默认档位。
 *
 * @param {Object} built buildSourceAccessConfig 或 migrateLegacyRoleTables 的输出
 * @param {Object} access 调用方显式传入的档位
 * @returns {Object}
 */
function mergeAccessOverride(built, access = {}) {
  return buildSourceAccessConfig({
    read: access.read ?? built.read,
    write: access.write ?? built.write,
    del: access.del ?? access.delete ?? built.delete,
    ownerColumn: access.ownerColumn ?? built.owner_column,
    namespaceColumn: access.namespaceColumn ?? built.namespace_column,
    adminTables: access.adminTables ?? built.admin_tables ?? [],
    blockedTables: access.blockedTables ?? built.blocked_tables ?? [],
    grants: grantsToMap(access.grants ?? built.grants),
  });
}

/**
 * 把前端矩阵转成 source access。
 *
 * 优先用显式的 `grants`（阶段 4 的新矩阵）；否则按 legacy 矩阵降级映射，
 * 此时列清单缺失需要调用方提供 schema 兜底。
 *
 * @param {Object} params permissions.build/apply 的入参
 * @param {Object} [columnsByTable]
 * @returns {Object}
 */
function buildAccessFromParams(params, columnsByTable = {}) {
  const access = params?.access ?? {};
  if (params?.grants || access.grants) {
    return mergeAccessOverride(
      { read: 'authenticated', write: 'blocked', delete: 'blocked' },
      access
    );
  }

  const matrix = params?.matrix ?? {};
  const roles = Object.entries(matrix).map(([name, tables]) => ({
    name,
    tables: Object.entries(tables ?? {}).map(([tableName, rule]) => ({
      name: tableName,
      database: params?.database,
      query: rule?.query ?? {},
      insert: rule?.insert ?? {},
      update: rule?.update ?? {},
      delete: rule?.delete ?? {},
    })),
  }));

  const columns = { ...columnsByTable };
  for (const tables of Object.values(matrix)) {
    for (const [tableName, rule] of Object.entries(tables ?? {})) {
      const explicit = rule?.query?.columns;
      if (Array.isArray(explicit) && explicit.length > 0) columns[tableName] = explicit;
    }
  }

  const migrated = migrateLegacyRoleTables({ roles, columnsByTable: columns, adminRoles: ['admin'] });
  return mergeAccessOverride(migrated.access, access);
}

/**
 * 统一入口：没有列清单时从运行实例的 schema 补上（source mode 要求显式 columns）。
 *
 * @param {Object} params
 * @param {GraphJinService|null} service
 * @returns {Promise<Object>}
 */
async function buildAccessPipeline(params, service) {
  if (params?.grants || params?.access?.grants) return buildAccessFromParams(params);
  if (!service) {
    throw RpcError.invalidParams('source 模式需要列清单：请传 grants，或提供 baseUrl 以读取 schema');
  }
  const schema = await discoverSchema(service.mcp, { withRelationships: false });
  const columnsByTable = {};
  for (const table of schema.tables ?? []) {
    columnsByTable[table.name] = (table.columns ?? []).map((column) => column.name);
  }
  return buildAccessFromParams(params, columnsByTable);
}

function isConnectionOk(result) {
  return result?.success === true || result?.valid === true;
}

/**
 * 运行中实例实际加载的库名。
 *
 * supervisor 的 status 只有 running / projectDir，不带库清单；dev.yml 才是
 * GraphJin 启动时真正读的那份配置，所以库名从这里取。
 *
 * @param {string} projectDir 运行中的项目目录
 * @returns {string[]} 库名，读不到时为空（宁可少标「已连接」，也不假报）
 */
function readLiveSourceNames(projectDir) {
  if (!projectDir) return [];
  try {
    const file = path.join(projectDir, 'dev.yml');
    if (!fs.existsSync(file)) return [];
    return Object.keys(readSourceConnections(fs.readFileSync(file, 'utf8')));
  } catch {
    // 文件被改坏只影响「已连接」标记，不该让整个列表报错
    return [];
  }
}

/**
 * 判断两个项目目录是否指向同一处。
 *
 * Windows 路径大小写不敏感，手填的项目目录大小写常和保存时不一致，
 * 所以只在该平台做折叠；大小写敏感的文件系统上保持原样比较。
 *
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 */
function sameProjectDir(left, right) {
  if (!left || !right) return false;
  const normalize = (value) =>
    process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

/**
 * MCP 调用使用的角色：端点只认 X-User-Role 头，配置类操作需要 admin。
 *
 * @param {Object} params RPC 参数
 * @returns {string}
 */
function requireRole(params) {
  const role = params?.role;
  if (role === undefined || role === null || role === '') return 'admin';
  if (typeof role !== 'string') throw RpcError.invalidParams('role 必须是字符串');
  return role;
}

/** 表名 / 列名要能直接拼进 GraphQL 选择集 */
const GRAPHQL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 校验一个要拼进查询的标识符。
 *
 * 值域扫描直接拼 `{ <表>(limit: N) { <列> } }`，不校验就等于把注入面开在
 * 「扫一列」这个小功能上。宁可拒掉带点号/引号的表名，让用户先去 Schema 页看。
 *
 * @param {*} value
 * @param {string} field
 * @returns {string}
 */
function requireGraphqlIdent(value, field) {
  if (typeof value !== 'string' || !GRAPHQL_NAME.test(value)) {
    throw RpcError.invalidParams(`${field} 必须是合法的 GraphQL 名称（字母/数字/下划线）`);
  }
  return value;
}

/**
 * 从 catalog 的 column 卡片里取出「表 → 列」。
 *
 * 卡片 id 形如 `column:analytics:main.events.id`，最后两段才是表名与列名。
 *
 * @param {Array<Object>} cards query_catalog 的 cards
 * @returns {Map<string, string[]>}
 */
function columnsFromCards(cards) {
  const columnsByTable = new Map();
  for (const card of cards) {
    if (card?.kind !== 'column' || typeof card.id !== 'string') continue;
    const parts = card.id.split(':').pop().split('.');
    const column = parts.pop();
    const table = parts.pop();
    if (!table || !column) continue;
    if (!columnsByTable.has(table)) columnsByTable.set(table, []);
    columnsByTable.get(table).push(column);
  }
  return columnsByTable;
}

/**
 * 逐个库探活：先读 catalog，再用该库独有的第一张表跑一次最小查询。
 *
 * 表名跨库重名时，execute_graphql 的纯表名会落到默认库（实测：两库都有 users
 * 时查询命中的是默认库那张），所以重名表不拿来验证，只保留 catalog 可读的结论，
 * 免得把「另一个库的表」当成这个库通过。
 *
 * @param {Object} service GraphJinService
 * @param {string} role 以哪个角色调用
 * @returns {Promise<Object>} { role, databases: Array<Object> }
 */
async function probeDatabases(service, role) {
  const config = await service.readConfig('sources');
  const names = (config?.sources ?? []).map((source) => source?.name).filter(Boolean);

  const entries = [];
  for (const database of names) {
    const started = Date.now();
    try {
      const catalog = await service.mcp.callTool('query_catalog', { database });
      const cards = Array.isArray(catalog?.cards) ? catalog.cards : [];
      const tables = [...new Set(cards.filter((c) => c.kind === 'table').map((c) => c.name))];
      entries.push({
        database,
        tables,
        columnsByTable: columnsFromCards(cards),
        catalogMs: Date.now() - started,
      });
    } catch (error) {
      entries.push({ database, error: error.message, catalogMs: Date.now() - started });
    }
  }

  return { role, databases: await verifyEntries(service, entries) };
}

/** 每库结果的默认形状，字段固定，前端表格不用判空 */
function emptyProbe(database, elapsedMs) {
  return {
    database,
    ok: false,
    mode: 'catalog',
    tables: 0,
    table: null,
    column: null,
    rows: null,
    elapsedMs: elapsedMs ?? 0,
    error: null,
  };
}

/**
 * 把 catalog 结果变成「每个库能不能真的查出数据」。
 *
 * @param {Object} service GraphJinService
 * @param {Array<Object>} entries 每库的 tables / columnsByTable / error
 * @returns {Promise<Array<Object>>}
 */
async function verifyEntries(service, entries) {
  const counts = new Map();
  for (const entry of entries) {
    for (const table of entry.tables ?? []) counts.set(table, (counts.get(table) ?? 0) + 1);
  }

  const results = [];
  for (const entry of entries) {
    if (entry.error) {
      results.push({ ...emptyProbe(entry.database, entry.catalogMs), error: entry.error });
      continue;
    }
    const tables = entry.tables ?? [];
    const sample = tables.find((table) => {
      if (!GRAPHQL_NAME.test(table) || counts.get(table) !== 1) return false;
      return (entry.columnsByTable?.get(table) ?? []).some((column) => GRAPHQL_NAME.test(column));
    });

    // 没有能唯一定位的表：catalog 读到了就算通过，但标明没跑查询
    if (!sample) {
      results.push({
        ...emptyProbe(entry.database, entry.catalogMs),
        ok: true,
        mode: 'catalog',
        tables: tables.length,
      });
      continue;
    }

    const column = entry.columnsByTable.get(sample).find((name) => GRAPHQL_NAME.test(name));
    const started = Date.now();
    try {
      const result = await service.mcp.callTool('execute_graphql', {
        query: `{ ${sample}(limit: 1) { ${column} } }`,
      });
      const errors = Array.isArray(result?.errors) ? result.errors : [];
      if (errors.length > 0) throw new Error(errors[0]?.message ?? '查询返回错误');
      const rows = Array.isArray(result?.data?.[sample]) ? result.data[sample].length : 0;
      results.push({
        ...emptyProbe(entry.database, Date.now() - started),
        ok: true,
        mode: 'query',
        tables: tables.length,
        table: sample,
        column,
        rows,
      });
    } catch (error) {
      results.push({
        ...emptyProbe(entry.database, Date.now() - started),
        mode: 'query',
        tables: tables.length,
        table: sample,
        column,
        error: error.message,
      });
    }
  }
  return results;
}

/**
 * 组装 JSON-RPC 方法表。
 *
 * 同一份路由同时挂在两种传输上：Tauri 走 stdin/stdout，前端走 HTTP POST /rpc。
 *
 * @param {Object} options
 * @param {UserStore} options.store
 * @param {ConnectionStore} [options.connections] 本地连接记录；缺省时连接类方法会报错
 * @param {GraphJinSupervisor} [options.supervisor] 进程编排，缺省时自建一个
 * @param {SnapshotStore} [options.snapshots] 权限快照；缺省时写入不回滚
 * @param {OntologyStore} [options.ontology] 业务本体论；缺省时本体论方法报错
 * @returns {RpcRouter}
 */
function createRouter({ store, connections = null, supervisor = null, snapshots = null, jwtSecret = null, ontology = null }) {
  const router = new RpcRouter();
  const services = supervisor ?? new GraphJinSupervisor();

  /** 连接存储只在 createBackend 里装配，单测里可以省略 */
  const connectionStore = () => {
    if (!connections) throw RpcError.invalidParams('连接存储未初始化');
    return connections;
  };

  /** 快照存储同理：没有装配时只跳过回滚能力，不影响正常写入 */
  const snapshotStore = () => {
    if (!snapshots) throw RpcError.invalidParams('快照存储未初始化');
    return snapshots;
  };

  /** 本体论存储：没有装配时只是「没有业务语境」，不影响其它能力 */
  const ontologyStore = () => {
    if (!ontology) throw RpcError.invalidParams('本体论存储未初始化');
    return ontology;
  };

  /**
   * 体检用的 schema 来源。
   *
   * 优先级：调用方给的（页面已经有一份，省一次 catalog 翻页）→ 运行中的实例 → 没有。
   * 拿不到不算错：lint 会跳过需要 schema 的规则，并在 skipped 里说明为什么跳过——
   * 静默少查几项比少查本身更危险，用户会把「没报错」读成「没问题」。
   *
   * @param {Object} [params]
   * @returns {Promise<{schema: Object|null, source: string}>}
   */
  const resolveLintSchema = async (params) => {
    const provided = params?.schema;
    if (provided && Array.isArray(provided.tables)) return { schema: provided, source: 'provided' };

    const baseUrl = services.status?.()?.baseUrl ?? null;
    if (!baseUrl) return { schema: null, source: 'none' };

    try {
      const service = await getService(baseUrl);
      return { schema: await discoverSchema(service.mcp, {}), source: 'discovered' };
    } catch {
      return { schema: null, source: 'unavailable' };
    }
  };

  /**
   * 快照身份：projectDir 优先，缺失时从 supervisor 当前项目补；
   * 再退回 baseUrl（端口每次启动都会变，只作为最后兜底）。
   */
  const snapshotScope = (params) => {
    let projectDir =
      typeof params?.projectDir === 'string' && params.projectDir !== '' ? params.projectDir : null;
    if (!projectDir) {
      try {
        projectDir = services.status?.()?.projectDir ?? null;
      } catch {
        projectDir = null;
      }
    }
    return {
      projectDir,
      baseUrl: typeof params?.baseUrl === 'string' && params.baseUrl !== '' ? params.baseUrl : null,
    };
  };

  /**
   * 落盘一条连接。写盘失败只记日志 —— 连接本身已经可用，
   * 不该因为持久化失败把测试/启动结果改成失败。
   */
  const remember = (name, connection, { projectDir, appName, status, origin }) => {
    if (!connections) return;
    try {
      connections.save({ name, projectDir, appName, config: connection, status, origin });
    } catch (error) {
      console.error(`[rpc] 保存连接 ${name} 失败: ${error.stack ?? error.message}`);
    }
  };

  /**
   * 起 GraphJin 并补齐 admin 角色。
   *
   * graphjin.start 与「删连接后重启」共用：重启不传 databases，库清单以项目里
   * 的 dev.yml 为准，避免把刚删掉的库又合并回去。
   *
   * @param {Object} params 同 graphjin.start 的参数
   * @returns {Promise<Object>} status()
   */
  async function startService(params) {
    // 驱动未实现的类型不必拉起进程：写进 dev.yml 只会让 GraphJin 启动失败
    for (const [name, connection] of Object.entries(params?.databases ?? {})) {
      if (UNVERIFIED_DRIVERS.has(connection?.type)) {
        throw RpcError.invalidParams(`库 ${name}: ${unsupportedDriverReason(connection.type)}`);
      }
    }
    const status = await services.start(params ?? {});
    // 平台以 admin 执行 GraphJin；roles 里没有 admin 时连它自己都会被拒
    // （基线 §6.5：roles '<role>' not defined，包括 admin）。
    if (status?.running && status.baseUrl) {
      try {
        const service = await getService(status.baseUrl);
        status.adminRole = await syncRolesToGraphJin({ store, service, roleNames: ['admin'] });
      } catch (error) {
        // 补角色失败不该让「进程已启动」变成启动失败，但要让人看得见
        status.adminRoleError = error.message;
      }
    }
    // 只有真的跑起来才记为 connected；库配置以项目里的 dev.yml 为准
    if (status?.running && params?.databases) {
      for (const [name, connection] of Object.entries(params.databases)) {
        remember(name, connection, {
          projectDir: params.projectDir,
          appName: params?.appName,
          status: STATUS_CONNECTED,
          origin: ORIGIN_START,
        });
      }
    }
    return status;
  }

  router
    .register('ping', () => 'pong')
    .register('health', () => ({ ok: true, pid: process.pid }))
    .register('system.info', () => {
      const manifest = readBinaryManifest();
      return {
        version: manifest?.version ?? null,
        repo: manifest?.repo ?? null,
        platforms: manifest?.platforms ?? {},
        backendVersion: BACKEND_VERSION,
      };
    })
    .register('users.createOrganization', (params) => store.createOrganization(params?.name))
    .register('users.listOrganizations', () => store.listOrganizations())
    .register('users.create', (params) => store.createUser(params ?? {}))
    .register('users.list', (params) => store.listUsers(params?.organizationId ?? null))
    .register('users.findByEmail', (params) => {
      const email = params?.email;
      if (typeof email !== 'string' || email === '') {
        throw RpcError.invalidParams('email 不能为空');
      }
      return store.findUserByEmail(email);
    })
    .register('users.setRole', (params) => {
      if (!Number.isInteger(params?.userId)) {
        throw RpcError.invalidParams('userId 必须是整数');
      }
      return { updated: store.setUserRole(params.userId, params.role) };
    })
    .register('users.delete', (params) => {
      if (!Number.isInteger(params?.userId)) {
        throw RpcError.invalidParams('userId 必须是整数');
      }
      return { deleted: store.deleteUser(params.userId) };
    })
    .register('users.update', (params) => {
      if (!Number.isInteger(params?.userId)) {
        throw RpcError.invalidParams('userId 必须是整数');
      }
      const updated = store.updateUser(params.userId, params);
      if (!updated) throw RpcError.invalidParams('用户不存在');
      return updated;
    })
    .register('users.deleteOrganization', (params) => {
      if (!Number.isInteger(params?.organizationId)) {
        throw RpcError.invalidParams('organizationId 必须是整数');
      }
      return store.deleteOrganization(params.organizationId);
    })
    .register('users.listRoles', () => store.listRoles())
    // 把平台里的角色补齐到 GraphJin，角色不存在时 roles[].tables 会被拒
    .register('users.syncRoles', async (params) => {
      const service = await getService(requireBaseUrl(params));
      return syncRolesToGraphJin({ store, service });
    })
    // Schema 发现：权限矩阵的表选择器与列白名单都依赖它
    .register('schema.discover', async (params) => {
      const service = await getService(requireBaseUrl(params));
      return discoverSchema(service.mcp, params ?? {});
    })
    .register('schema.tables', async (params) => {
      const service = await getService(requireBaseUrl(params));
      return listTables(service.mcp, params ?? {});
    })
    // 数据库类型与自定义别名模板
    .register('db.types', () => ({
      builtIn: BUILT_IN_TYPES,
      supported: SUPPORTED_TYPES,
      templates: listTypes().filter((item) => item.custom === true),
    }))
    .register('db.templates.add', (params) => ({ templates: addTemplate(params ?? {}) }))
    .register('db.templates.remove', (params) => {
      const id = params?.id;
      if (typeof id !== 'string' || id === '') {
        throw RpcError.invalidParams('id 不能为空');
      }
      return { templates: removeTemplate(id) };
    })
    // 连接测试：validate_config 会真的去连目标库，不必自己实现 ping（基线 §12.5）
    .register('connections.test', async (params) => {
      const name = params?.name ?? 'probe_db';
      const connection = params?.connection ?? {};
      // 实测这些类型在预置的 3.21.14 连接层直接报 unsupported，提前返回比拉起进程再失败快得多
      if (UNVERIFIED_DRIVERS.has(connection.type)) {
        return {
          success: false,
          unsupported: true,
          errors: [unsupportedDriverReason(connection.type)],
        };
      }
      // 缺必填字段的配置不必起临时实例：一次进程启停约 1–2s，错误也还是同一个字段问题
      const problems = validateConnectionFields(connection);
      if (problems.length > 0) {
        return { success: false, errors: problems };
      }
      const baseUrl =
        typeof params?.baseUrl === 'string' && params.baseUrl !== '' ? params.baseUrl : null;
      // 服务在跑就复用现成实例；没跑就起一个用完即停的临时实例，不必先启动才能测
      const result = baseUrl
        ? await (await getService(baseUrl)).mcp.callTool('validate_config', {
            sources: [{ name, kind: 'database', ...connection }],
          })
        : await probeConnection({
            name,
            connection,
            // 相对路径的库文件要按项目目录解析，否则临时目录里会新建一个空库
            projectDir: typeof params?.projectDir === 'string' ? params.projectDir : null,
          });
      // 测试通过才落盘，列表里看到的都是"真的连通过"的记录
      if (isConnectionOk(result) && params?.projectDir) {
        remember(name, connection, {
          projectDir: params.projectDir,
          appName: params?.appName,
          status: STATUS_VERIFIED,
          origin: ORIGIN_TEST,
        });
      }
      return result;
    })
    // 本地已保存的连接。status 是历史值（最后一次测试 / 启动），不能代表当前实例，
    // 所以在列表出口补一个 active：由运行中的实例现算，停止后自然全部为 false
    .register('connections.list', () => {
      const status = services.status();
      const live = status.running ? readLiveSourceNames(status.projectDir) : [];
      return connectionStore()
        .list()
        .map((row) => ({
          ...row,
          active:
            status.running &&
            sameProjectDir(row.projectDir, status.projectDir) &&
            live.includes(row.name),
        }));
    })
    .register('connections.get', (params) => {
      const id = params?.id;
      if (!Number.isInteger(id)) throw RpcError.invalidParams('id 必须是整数');
      return connectionStore().get(id);
    })
    // 业务本体论：AI 查数据之前的语境。六类条目见 ontology.js
    .register('ontology.list', (params) => {
      const kind = params?.kind ?? null;
      // 按库过滤是 store 早就支持的能力（ontology.js:132-137），之前 RPC 层丢掉了：
      // 页面自己在前端筛，别的调用方拿不到同样的语义
      const database = typeof params?.database === 'string' ? params.database : null;
      return {
        entries: ontologyStore().list({ kind, database }),
        rendered: ontologyStore().render({ database }),
      };
    })
    .register('ontology.save', (params) => ontologyStore().save(params ?? {}))
    .register('ontology.remove', (params) => {
      const id = params?.id;
      if (!Number.isInteger(id)) throw RpcError.invalidParams('id 必须是整数');
      return { removed: ontologyStore().remove(id) };
    })
    // 体检：条目与 schema 对账。拿不到 schema 时只跳过需要 schema 的规则，
    // 其余照跑——否则「先启动实例才能体检」会让这个功能在半数场景下不可用
    .register('ontology.lint', async (params) => {
      const { schema, source } = await resolveLintSchema(params);
      return lintOntology(ontologyStore().list(), { schema, schemaSource: source });
    })
    // 起草助手：把「库里已经有、本体论还没覆盖」的东西列出来。
    // 只产出候选，不落库——定义得人来写，自动生成的空定义只会稀释真正的知识
    .register('ontology.propose', async (params) => {
      const { schema, source } = await resolveLintSchema(params);
      const proposed = proposeEntries({
        schema,
        entries: ontologyStore().list(),
        database: typeof params?.database === 'string' && params.database !== '' ? params.database : null,
      });
      return { ...proposed, schemaSource: source };
    })
    // 值域扫描：只取一列的前若干行，去重后建议字典。
    // 用 admin 身份读：平台自己发现 schema 也是 admin；扫描本身只回低基数列的取值，
    // 且必须由人逐列触发，不做后台遍历
    .register('ontology.scanValues', async (params) => {
      const baseUrl = requireBaseUrl(params);
      const table = requireGraphqlIdent(params?.table, 'table');
      const column = requireGraphqlIdent(params?.column, 'column');
      const requested = Number(params?.limit);
      const limit = Math.min(Math.max(Number.isFinite(requested) ? Math.trunc(requested) : 200, 1), 500);

      const service = await getService(baseUrl);
      const result = await service.mcp.callTool('execute_graphql', {
        query: `{ ${table}(limit: ${limit}) { ${column} } }`,
      });
      const errors = Array.isArray(result?.errors) ? result.errors : [];
      if (errors.length > 0) {
        throw RpcError.invalidParams(`扫描失败：${errors[0]?.message ?? '查询返回错误'}`);
      }

      const rows = Array.isArray(result?.data?.[table]) ? result.data[table] : [];
      return { table, column, limit, ...summarizeValues(rows, column) };
    })
    // 样例评测：确定性的三项核对（可执行 / 结构 / 覆盖）。
    // 不调模型：平台没有模型，假装评测模型只会产出无法解释的分数
    .register('ontology.eval', async (params) => {
      const { schema, source } = await resolveLintSchema(params);
      const index = schema ? buildTableIndex(schema) : null;
      const database =
        typeof params?.database === 'string' && params.database !== '' ? params.database : null;
      const baseUrl =
        typeof params?.baseUrl === 'string' && params.baseUrl !== '' ? params.baseUrl : null;

      let service = null;
      let note = '没有传实例地址：只做了结构与覆盖检查';
      if (baseUrl) {
        try {
          service = await getService(baseUrl);
          note = '';
        } catch (error) {
          note = `连不上实例：只做了结构与覆盖检查（${error.message}）`;
        }
      }

      const runQuery = service
        ? async (query) => {
            const result = await service.mcp.callTool('execute_graphql', { query });
            const errors = Array.isArray(result?.errors) ? result.errors : [];
            if (errors.length > 0) throw new Error(errors[0]?.message ?? '查询返回错误');
          }
        : null;

      return {
        ...(await evaluateExamples({
          entries: ontologyStore().list(),
          index,
          database,
          runQuery,
          note,
        })),
        schemaSource: source,
      };
    })
    // 把强制规则编译成权限补丁。只算、不写：写由 permissions.apply 负责（它自带快照）
    .register('ontology.compileRules', async (params) => {
      const database = params?.database;
      if (typeof database !== 'string' || database === '') {
        throw RpcError.invalidParams('database 不能为空');
      }

      // 现状从哪来：运行中的实例优先；停着时读 dev.yml，与「停止后按 dev.yml 判定权限」一致
      const baseUrl =
        typeof params?.baseUrl === 'string' && params.baseUrl !== '' ? params.baseUrl : null;
      let access = null;
      let accessSource = 'none';
      if (baseUrl) {
        try {
          const service = await getService(baseUrl);
          const config = await service.readConfig('sources');
          const found = (config?.sources ?? []).find((source) => source?.name === database);
          if (found) {
            access = found.access ?? {};
            accessSource = 'instance';
          }
        } catch {
          accessSource = 'unavailable';
        }
      }
      if (access === null) {
        const projectDir = params?.projectDir ?? services.status?.()?.projectDir ?? null;
        if (projectDir) {
          try {
            const devYaml = path.join(path.resolve(projectDir), 'dev.yml');
            if (fs.existsSync(devYaml)) {
              const accesses = readSourceAccess(fs.readFileSync(devYaml, 'utf8'));
              if (accesses[database]) {
                access = accesses[database];
                accessSource = 'dev.yml';
              }
            }
          } catch {
            // 读不到就按「现状为空」编译：补丁会从默认档位起步，应用前有 diff 可看
          }
        }
      }

      const report = compileRules({
        rules: ontologyStore().list(),
        database,
        access: access ?? {},
        roles: Array.isArray(params?.roles) ? params.roles : [],
      });
      return { ...report, accessSource };
    })
    // 删记录；如果这个库正被运行实例加载，连带从 dev.yml 移除并按需要停/重启，
    // 否则 Schema 页与权限矩阵会一直显示一个「已经不存在」的库
    .register('connections.remove', async (params) => {
      const id = params?.id;
      if (!Number.isInteger(id)) throw RpcError.invalidParams('id 必须是整数');
      const record = connectionStore().get(id);
      const deleted = connectionStore().remove(id);
      const live = services.status();
      // 实例没跑，或跑的是别的项目：只删记录
      if (!deleted || !record || !live.running) {
        return { deleted, action: 'record', status: live };
      }
      if (!sameProjectDir(record.projectDir, live.projectDir)) {
        return { deleted, action: 'record', status: live };
      }

      const devYaml = path.join(live.projectDir, 'dev.yml');
      if (!removeProjectSource(devYaml, record.name)) {
        return { deleted, action: 'record', status: live };
      }
      // 最后一个库删掉后没有可用数据源：停掉实例，dev.yml 留空等下一次启动
      if (readLiveSourceNames(live.projectDir).length === 0) {
        return { deleted, action: 'stopped', status: await services.stop() };
      }
      await services.stop();
      return {
        deleted,
        action: 'restarted',
        status: await startService({ projectDir: live.projectDir }),
      };
    })
    // GraphJin 进程生命周期
    .register('graphjin.start', (params) => startService(params))
    .register('graphjin.tools', async (params) => {
      const service = await getService(requireBaseUrl(params));
      return service.listTools();
    })
    // 内置 MCP 客户端：按 MCP 协议打当前实例，用来验证「配置里的库」真的可用
    .register('mcp.tools', async (params) => {
      const service = await getService(requireBaseUrl(params), requireRole(params));
      const tools = await service.listTools();
      return tools.map(({ name, description }) => ({ name, description: description ?? '' }));
    })
    .register('mcp.query', async (params) => {
      const role = requireRole(params);
      const service = await getService(requireBaseUrl(params), role);
      const started = Date.now();
      // MCP 的 execute_graphql 不透传 X-User-Code：只验证角色级规则，行过滤不生效
      const result = await service.mcp.callTool('execute_graphql', {
        query: requireGraphqlQuery(params?.query),
        ...(params?.variables && typeof params.variables === 'object'
          ? { variables: params.variables }
          : {}),
      });
      const errors = Array.isArray(result?.errors) ? result.errors : [];
      return {
        ok: errors.length === 0,
        role,
        elapsedMs: Date.now() - started,
        result,
      };
    })
    .register('mcp.probe', async (params) => {
      const role = requireRole(params);
      const service = await getService(requireBaseUrl(params), role);
      return probeDatabases(service, role);
    })
    // 一键演示：示例库 + 预配只读角色，让用户不必准备环境就能看到权限生效
    .register('demo.bootstrap', async (params) => {
      const dataDir = path.dirname(dataFile('mcp-builder.db'));
      const projectDir = path.resolve(
        typeof params?.projectDir === 'string' && params.projectDir
          ? params.projectDir
          : path.join(dataDir, 'projects', 'demo')
      );
      // 一个后端只托管一个实例，切到演示项目前先停掉旧的
      await services.stop();
      const report = createDemoProject({ dir: projectDir, port: await pickFreePort() });
      const status = await startService({ projectDir });
      // 记录落盘：演示项目也要出现在「已保存连接」里，否则用户找不到入口
      remember('demo', { type: 'sqlite', path: 'orders.db' }, {
        projectDir,
        appName: 'Demo Orders',
        status: STATUS_CONNECTED,
        origin: ORIGIN_START,
      });
      return { ...report, projectDir, status };
    })
    // 一键体检：后端 / 二进制 / 实例 / 库 / 角色逐项打红绿灯
    .register('diagnostics.run', async () => {
      const checks = [];
      const add = (id, status, detail) => checks.push({ id, status, detail: detail ?? '' });

      const binary = resolveGraphJinBinary();
      add('binary', fs.existsSync(binary) ? 'ok' : 'fail', binary);

      add('backend', 'ok', `pid ${process.pid} · ${path.dirname(dataFile('mcp-builder.db'))}`);

      const status = services.status();
      add(
        'instance',
        status.running ? 'ok' : 'fail',
        status.running
          ? `${status.baseUrl} · pid ${status.pid}`
          : status.lastError ?? 'GraphJin 未启动'
      );

      if (!status.running) {
        add('databases', 'skip', '实例未运行');
        add('roles', 'skip', '实例未运行');
        return { checks, generatedAt: new Date().toISOString() };
      }

      const service = await getService(status.baseUrl);
      const probe = await probeDatabases(service, 'admin');
      const failed = probe.databases.filter((row) => !row.ok);
      add(
        'databases',
        failed.length === 0 ? 'ok' : 'fail',
        failed.length === 0
          ? `${probe.databases.length} 个库全部可用`
          : failed.map((row) => `${row.database}: ${row.error}`).join('；')
      );

      try {
        const roles = await service.readConfig('roles');
        const names = (roles?.roles ?? []).map((role) => role?.name).filter(Boolean);
        add('roles', names.includes('admin') ? 'ok' : 'fail', names.join(', ') || '（空）');
      } catch (error) {
        add('roles', 'fail', error.message);
      }

      return { checks, generatedAt: new Date().toISOString() };
    })
    .register('graphjin.stop', () => services.stop())
    .register('graphjin.status', () => services.status())
    // 运行中实例实际加载的库名：Schema 页顶部的库选择器以它为准
    .register('graphjin.databases', async (params) => {
      const service = await getService(requireBaseUrl(params));
      const config = await service.readConfig('sources');
      const databases = (config?.sources ?? [])
        .map((source) => source?.name)
        .filter(Boolean)
        .sort();
      return {
        activeDatabase: config?.active_source ?? config?.active_database ?? databases[0] ?? null,
        databases,
      };
    })
    .register('graphjin.health', () => services.health())
    // 2.7 当前生效策略。gj_security root 走 /api/v1/graphql 需 admin JWT（实测不可达），
    // 所以策略真相来源是 MCP 的 get_current_config，其顶层键含 roles / system / databases
    .register('config.current', async (params) => {
      const service = await getService(requireBaseUrl(params));
      return service.readConfig(params?.section ?? 'all');
    })
    // 离线读配置：实例没跑时 config.current 没有 baseUrl 可用，而「配过没有」这件事
    // 必须能回答。真相来源是 GraphJin 回写进 dev.yml 的 sources[].access。
    .register('config.file', (params) => {
      const projectDir = params?.projectDir;
      if (typeof projectDir !== 'string' || projectDir === '') {
        throw RpcError.invalidParams('projectDir 不能为空');
      }
      const devYaml = path.join(path.resolve(projectDir), 'dev.yml');
      if (!fs.existsSync(devYaml)) {
        throw RpcError.invalidParams(`项目目录缺少 dev.yml：${devYaml}`);
      }
      const text = fs.readFileSync(devYaml, 'utf8');
      const accesses = readSourceAccess(text);
      return {
        sources: Object.entries(accesses).map(([name, access]) => ({ name, access })),
        roles: readProjectRoles(text).map((name) => ({ name })),
      };
    })
    // 权限编排（source 模式：source 级 read/write/delete + 角色级 grants）
    .register('permissions.build', (params) => {
      const database = params?.database;
      if (typeof database !== 'string' || database === '') {
        throw RpcError.invalidParams('database 不能为空');
      }
      return { access: buildAccessFromParams({ ...params, database }) };
    })
    .register('permissions.summarize', async (params) => {
      const database = params?.database;
      if (typeof database !== 'string' || database === '') {
        throw RpcError.invalidParams('database 不能为空');
      }
      const service = params?.baseUrl ? await getService(requireBaseUrl(params)) : null;
      const access = await buildAccessPipeline({ ...params, database }, service);
      return summarizeSourceAccess(access);
    })
    .register('permissions.apply', async (params) => {
      const database = params?.database;
      if (typeof database !== 'string' || database === '') {
        throw RpcError.invalidParams('database 不能为空');
      }
      const baseUrl = requireBaseUrl(params);
      const service = await getService(baseUrl);
      const matrix = params?.matrix ?? {};

      // 必须在 syncRoles 之前拍快照，否则本次新建的角色会被记进快照、回滚时删不掉
      let snapshot = null;
      if (snapshots) {
        const current = await service.readConfig('all');
        snapshot = snapshots.save({
          ...snapshotScope(params),
          database,
          // 来源写在 reason 里：回滚时能分清「手改矩阵」和「应用规则补丁」，
          // 否则历史里全是 before-apply，等于没有审计
          reason: typeof params?.reason === 'string' && params.reason !== '' ? params.reason : 'before-apply',
          roles: current?.roles ?? [],
          sources: current?.sources ?? [],
        });
      }

      const synced = await syncRolesToGraphJin({
        store,
        service,
        roleNames: [...new Set([...Object.keys(matrix), ...Object.keys(params?.grants ?? {}), 'admin'])],
      });

      const access = await buildAccessPipeline({ ...params, database }, service);
      const projectDir = params?.projectDir ?? services.status().projectDir;
      const applied = await applySourceAccess(service, projectDir, database, access);
      return { synced, applied, snapshot, access };
    })
    // 写入历史：只返回摘要，roles 全文按需用 permissions.rollback 恢复
    .register('permissions.snapshots', (params) => {
      if (!snapshots) return [];
      return snapshots.list({
        ...snapshotScope(params),
        limit: Number.isInteger(params?.limit) ? params.limit : 20,
      });
    })
    // 回滚到某份快照；不传 id 时恢复最近一份。回滚前再拍一份，回滚本身也可撤销。
    .register('permissions.rollback', async (params) => {
      const baseUrl = requireBaseUrl(params);
      const snapshotDb = snapshotStore();
      const scope = snapshotScope(params);

      let target = null;
      if (params?.id !== undefined) {
        if (!Number.isInteger(params.id)) throw RpcError.invalidParams('id 必须是整数');
        target = snapshotDb.get(params.id);
      } else {
        const [latest] = snapshotDb.list({ ...scope, limit: 1 });
        target = latest ? snapshotDb.get(latest.id) : null;
      }
      if (!target) throw RpcError.invalidParams('没有可回滚的快照');
      // 快照按项目隔离：不允许把别的项目的 roles 写进当前实例
      if (target.projectKey !== SnapshotStore.projectKey(scope)) {
        throw RpcError.invalidParams('该快照不属于当前项目');
      }

      const service = await getService(baseUrl);
      const current = await service.readConfig('all');
      const before = snapshotDb.save({
        ...scope,
        database: target.database,
        reason: 'before-rollback',
        roles: current?.roles ?? [],
        sources: current?.sources ?? [],
      });

      const patch = buildRollbackPatch(target.roles, current?.roles ?? [], {
        database: target.database,
        sources: target.sources ?? [],
      });

      // 必须先恢复 sources 再删角色：grants 里引用着本次新增的角色，
      // 先 remove_roles 会触发 `role "xxx" is not defined in roles`（实测）
      const projectDir = params?.projectDir ?? services.status().projectDir;
      let sourcesApplied = null;
      for (const entry of patch.source_patches ?? []) {
        sourcesApplied = await applySourceAccess(service, projectDir, entry.name, entry.access);
      }

      // source 模式不允许 roles[].tables，回滚时角色只保留名字
      const rolesPatch = { roles: (patch.roles ?? []).map((role) => ({ name: role.name })) };
      if (patch.remove_roles) rolesPatch.remove_roles = patch.remove_roles;
      const rolesApplied = await service.updateConfig(rolesPatch);
      const { roles, sources, ...summary } = target;
      return {
        target: summary,
        before,
        applied: sourcesApplied ?? rolesApplied,
        removed: patch.remove_roles ?? [],
      };
    })
    // 以某个角色（可选某个用户）真实执行一条 GraphQL，用于验证权限是否生效。
    // 必须走 HTTP GraphQL：MCP 的 execute_graphql 不透传 X-User-Code，行过滤会失效。
    .register('graphql.execute', async (params) => {
      const query = params?.query;
      if (typeof query !== 'string' || query === '') {
        throw RpcError.invalidParams('query 不能为空');
      }
      return executeGraphql(requireBaseUrl(params), {
        query,
        role: params?.role ?? 'admin',
        userCode: params?.userCode ?? null,
      });
    })
    // 为用户签发 MCP 访问令牌：外部客户端拿它连网关，网关验签后转成 GraphJin 的身份头
    .register('auth.token', (params) => {
      if (!jwtSecret) throw RpcError.invalidParams('令牌密钥未初始化');
      const userId = params?.userId;
      if (!Number.isInteger(userId)) throw RpcError.invalidParams('userId 必须是整数');
      const user = store.findUserById(userId);
      if (!user) throw RpcError.invalidParams('用户不存在');

      const ttlSeconds = Number.isInteger(params?.ttlSeconds) ? params.ttlSeconds : 12 * 3600;
      const token = signToken(
        { sub: String(user.id), role: user.role, user_code: user.email, name: user.name },
        jwtSecret,
        ttlSeconds
      );
      return {
        token,
        expiresIn: ttlSeconds,
        user: { id: user.id, name: user.name, email: user.email, role: user.role },
      };
    })
    // 1.8 客户端配置生成
    .register('mcp.endpoint', (params) => ({
      endpoint: normalizeEndpoint(requireBaseUrl(params)),
    }))
    .register('mcp.clients', () => listClients())
    .register('mcp.clientConfig', (params) => {
      const baseUrl = requireBaseUrl(params);
      // 传了 gatewayUrl 就生成「客户端 → 平台网关」的配置：带 Bearer 令牌，不再直连 GraphJin
      const gatewayUrl = typeof params?.gatewayUrl === 'string' && params.gatewayUrl ? params.gatewayUrl : null;
      const token = typeof params?.token === 'string' && params.token ? params.token : null;
      return {
        ...buildClientConfig({
          baseUrl: gatewayUrl ?? baseUrl,
          name: params?.name ?? 'GraphJin',
          transport: params?.transport ?? 'http',
          binPath: params?.binPath ?? null,
          token,
        }),
        gateway: Boolean(gatewayUrl),
        cliCommands: buildCliCommands({ baseUrl: gatewayUrl ?? baseUrl, binPath: params?.binPath ?? 'graphjin' }),
      };
    });

  return router;
}

/**
 * 启动本地 HTTP 服务。端口传 0 由系统动态分配 —— GraphJin 自己也会动态选端口，
 * 硬编码端口在生产环境必然冲突。
 *
 * @param {Object} options
 * @param {RpcRouter} options.router
 * @param {number} [options.port] 默认 0
 * @param {{path: string, handle: Function}} [options.gateway] MCP 网关，挂到 /api/v1/mcp
 * @returns {Promise<http.Server>}
 */
function startHttpServer({ router, port = 0, gateway = null }) {
  const server = http.createServer((request, response) => {
    const finish = (status, payload) => {
      const body = JSON.stringify(payload);
      response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      response.end(body);
    };

    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      });
      response.end();
      return;
    }

    if (request.method === 'GET' && request.url === '/health') {
      finish(200, { ok: true, pid: process.pid });
      return;
    }

    if (gateway && (request.url ?? '').startsWith(gateway.path)) {
      gateway.handle(request, response).catch((error) => {
        if (response.headersSent) {
          response.end();
          return;
        }
        finish(502, { error: `MCP 网关转发失败：${error.message}` });
      });
      return;
    }

    if (request.method === 'POST' && request.url === '/rpc') {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', async () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          finish(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } });
          return;
        }
        const result = await router.dispatch(parsed);
        finish(result === null ? 204 : 200, result ?? {});
      });
      return;
    }

    finish(404, { error: 'not found' });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

/**
 * 把 stdin 接成 JSON-RPC 传输：逐行读取，逐行回写。
 *
 * @param {Object} options
 * @param {RpcRouter} options.router
 */
function attachStdioTransport({ router }) {
  const input = readline.createInterface({ input: process.stdin, terminal: false });
  input.on('line', async (line) => {
    const response = await router.handleLine(line);
    if (response !== null) {
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  });
  return input;
}

/** 通知 Tauri：后端已就绪，并告知实际端口 */
function emitReady(port) {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: '2.0', method: 'ready', params: { port, pid: process.pid } })}\n`
  );
}

/**
 * 组装一个可编程启停的后端实例。
 *
 * Electron 主进程直接复用这个入口：后端跑在同一个 Node 运行时里，
 * 既不用 pkg 打成 exe，也不用 stdio 转发。
 *
 * @param {Object} [options]
 * @param {string} [options.dbPath] 用户库路径，缺省读 MCP_BUILDER_DB 或数据目录
 * @returns {Promise<{port: number, router: Object, dbPath: string, stop: () => Promise<void>}>}
 */
async function createBackend({ dbPath } = {}) {
  const resolvedDbPath = dbPath || process.env.MCP_BUILDER_DB || dataFile('mcp-builder.db');
  fs.mkdirSync(path.dirname(resolvedDbPath), { recursive: true });

  // 令牌密钥落在数据目录，首次运行自动生成；网关和 auth.token 共用同一份
  const jwtSecret = loadSecret(dataFile('jwt.secret'));

  const store = new UserStore(resolvedDbPath);
  // 两张表在同一个 SQLite 文件里，各自一个连接；写入都是同步短事务，不会互相卡住
  const connections = new ConnectionStore(resolvedDbPath);
  const ontology = new OntologyStore(resolvedDbPath);
  const snapshots = new SnapshotStore(resolvedDbPath);
  const supervisor = new GraphJinSupervisor();
  const router = createRouter({ store, connections, supervisor, snapshots, jwtSecret, ontology });
  // 本体论的取用按角色过滤：被屏蔽 / 仅管理员可见的表，它的语义也不该送出去。
  // 项目目录每次现取——实例可能被重启到别的目录，缓存的路径会变成别人的配置。
  const ontologyProvider = createOntologyProvider({
    store: ontology,
    projectDir: () => supervisor.status?.().projectDir ?? null,
  });

  const gateway = createMcpGateway({
    secret: jwtSecret,
    resolveTarget: () => supervisor.status().baseUrl ?? null,
    // 没有维护条目、或该角色看不到任何条目时返回 null，网关保持纯透传
    ontology: ontologyProvider,
  });
  const server = await startHttpServer({ router, port: 0, gateway });

  return {
    port: server.address().port,
    router,
    dbPath: resolvedDbPath,
    gatewayUrl: `http://127.0.0.1:${server.address().port}/api/v1/mcp`,
    /** 先停 GraphJin 再关服务，避免子进程残留锁住二进制 */
    async stop() {
      await supervisor.stop();
      await new Promise((resolve) => server.close(resolve));
      store.close();
      connections.close();
      ontology.close();
      snapshots.close();
    },
  };
}

async function main() {
  const backend = await createBackend();
  emitReady(backend.port);
  const stdio = attachStdioTransport({ router: backend.router });

  const shutdown = () => {
    stdio.close();
    backend.stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`后端启动失败: ${error.stack ?? error.message}`);
    process.exit(1);
  });
}

module.exports = {
  createBackend,
  createRouter,
  startHttpServer,
  attachStdioTransport,
  emitReady,
  // 探活逻辑单独导出，测试可以注入假 service，不必真起 GraphJin
  probeDatabases,
  // 入参归一同理：前端被绕过时后端仍要把「粘错东西」说清楚
  requireGraphqlQuery,
};
