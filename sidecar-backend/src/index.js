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
const { GraphJinSupervisor } = require('./supervisor');
const { buildRoleTableConfig, summarizePatch } = require('./permissions');
const { buildClientConfig, buildCliCommands, listClients, normalizeEndpoint } = require('./mcp-config');
const {
  BUILT_IN_TYPES,
  SUPPORTED_TYPES,
  addTemplate,
  listTypes,
  removeTemplate,
} = require('./db-types');
const { ensureKeystoreKey } = require('./keystore');
const { dataFile } = require('./paths');

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
function isConnectionOk(result) {
  return result?.success === true || result?.valid === true;
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
 * @returns {RpcRouter}
 */
function createRouter({ store, connections = null, supervisor = null }) {
  const router = new RpcRouter();
  const services = supervisor ?? new GraphJinSupervisor();

  /** 连接存储只在 createBackend 里装配，单测里可以省略 */
  const connectionStore = () => {
    if (!connections) throw RpcError.invalidParams('连接存储未初始化');
    return connections;
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
      const baseUrl =
        typeof params?.baseUrl === 'string' && params.baseUrl !== '' ? params.baseUrl : null;
      // 服务在跑就复用现成实例；没跑就起一个用完即停的临时实例，不必先启动才能测
      const result = baseUrl
        ? await (await getService(baseUrl)).mcp.callTool('validate_config', {
            databases: { [name]: connection },
          })
        : await probeConnection({ name, connection });
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
    // 本地已保存的连接
    .register('connections.list', () => connectionStore().list())
    .register('connections.get', (params) => {
      const id = params?.id;
      if (!Number.isInteger(id)) throw RpcError.invalidParams('id 必须是整数');
      return connectionStore().get(id);
    })
    .register('connections.remove', (params) => {
      const id = params?.id;
      if (!Number.isInteger(id)) throw RpcError.invalidParams('id 必须是整数');
      return { deleted: connectionStore().remove(id) };
    })
    // GraphJin 进程生命周期
    .register('graphjin.start', async (params) => {
      const status = await services.start(params ?? {});
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
    })
    .register('graphjin.tools', async (params) => {
      const service = await getService(requireBaseUrl(params));
      return service.listTools();
    })
    .register('graphjin.stop', () => services.stop())
    .register('graphjin.status', () => services.status())
    // 运行中实例实际加载的库名：Schema 页顶部的库选择器以它为准
    .register('graphjin.databases', async (params) => {
      const service = await getService(requireBaseUrl(params));
      const config = await service.readConfig('databases');
      const databases = Object.keys(config?.databases ?? {}).sort();
      return {
        activeDatabase: config?.active_database ?? databases[0] ?? null,
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
    // 权限编排（方案 B：roles[].tables + 四项操作开关）
    .register('permissions.build', (params) => {
      const database = params?.database;
      if (typeof database !== 'string' || database === '') {
        throw RpcError.invalidParams('database 不能为空');
      }
      return buildRoleTableConfig(database, params?.matrix ?? {});
    })
    .register('permissions.summarize', (params) => {
      const database = params?.database;
      if (typeof database !== 'string' || database === '') {
        throw RpcError.invalidParams('database 不能为空');
      }
      return summarizePatch(buildRoleTableConfig(database, params?.matrix ?? {}));
    })
    .register('permissions.apply', async (params) => {
      const database = params?.database;
      if (typeof database !== 'string' || database === '') {
        throw RpcError.invalidParams('database 不能为空');
      }
      const service = await getService(requireBaseUrl(params));
      // 角色必须先存在，否则 roles[].tables 会被拒
      const synced = await syncRolesToGraphJin({
        store,
        service,
        roleNames: Object.keys(params?.matrix ?? {}),
      });
      const patch = buildRoleTableConfig(database, params.matrix);
      const applied = await service.applyConfig(patch);
      return { synced, applied };
    })
    // 以某个角色真实执行一条 GraphQL，用于验证权限是否生效
    .register('graphql.execute', async (params) => {
      const query = params?.query;
      if (typeof query !== 'string' || query === '') {
        throw RpcError.invalidParams('query 不能为空');
      }
      const service = await getService(requireBaseUrl(params), params?.role ?? 'admin');
      return service.mcp.callTool('execute_graphql', { query });
    })
    // 1.8 客户端配置生成
    .register('mcp.endpoint', (params) => ({
      endpoint: normalizeEndpoint(requireBaseUrl(params)),
    }))
    .register('mcp.clients', () => listClients())
    .register('mcp.clientConfig', (params) => {
      const baseUrl = requireBaseUrl(params);
      return {
        ...buildClientConfig({
          baseUrl,
          name: params?.name ?? 'GraphJin',
          transport: params?.transport ?? 'http',
          binPath: params?.binPath ?? null,
        }),
        cliCommands: buildCliCommands({ baseUrl, binPath: params?.binPath ?? 'graphjin' }),
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
 * @returns {Promise<http.Server>}
 */
function startHttpServer({ router, port = 0 }) {
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

  const store = new UserStore(resolvedDbPath);
  // 两张表在同一个 SQLite 文件里，各自一个连接；写入都是同步短事务，不会互相卡住
  const connections = new ConnectionStore(resolvedDbPath);
  const supervisor = new GraphJinSupervisor();
  const router = createRouter({ store, connections, supervisor });
  const server = await startHttpServer({ router, port: 0 });

  return {
    port: server.address().port,
    router,
    dbPath: resolvedDbPath,
    /** 先停 GraphJin 再关服务，避免子进程残留锁住二进制 */
    async stop() {
      await supervisor.stop();
      await new Promise((resolve) => server.close(resolve));
      store.close();
      connections.close();
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

module.exports = { createBackend, createRouter, startHttpServer, attachStdioTransport, emitReady };
