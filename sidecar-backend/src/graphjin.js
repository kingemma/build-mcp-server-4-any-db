'use strict';

const { McpClient } = require('./mcp-client');

/** 配置形态不符合方案 B 要求 */
class ConfigModeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigModeError';
  }
}

/**
 * GraphJin 配置服务。
 *
 * 封装的是 MCP 工具 `get_current_config` / `update_current_config`，而不是 GraphQL 的
 * gj_config root —— 实测后者在 /api/v1/graphql 上受 anon 拦截，dev 角色头不生效。
 *
 * 方案 B 约束：本项目不配置 sources，只用 databases + roles[].tables。
 */
class GraphJinService {
  /**
   * @param {Object} options
   * @param {string} options.baseUrl GraphJin 服务地址，端口需从启动横幅解析
   * @param {string} [options.role] 默认 admin，配置类操作需要它
   */
  constructor({ baseUrl, role = 'admin' }) {
    this.mcp = new McpClient({ baseUrl, role });
  }

  async connect() {
    return this.mcp.connect();
  }

  async listTools() {
    return this.mcp.listTools();
  }

  /**
   * 读取当前生效配置。
   *
   * @param {string} [section] sources/system/databases/roles/mcp/... 或 all
   * @returns {Promise<Object>} 已脱敏的配置（密码等为 [REDACTED]）
   */
  async readConfig(section = 'all') {
    return this.mcp.callTool('get_current_config', { section });
  }

  /**
   * 写入配置补丁。
   *
   * legacy 模式（不配 sources）下没有 preview/apply 两阶段：即使传 mode:"preview"
   * 也会立即生效且不返回 preview_id，所以调用方必须先自行 diff 与二次确认。
   *
   * @param {Object} patch 形如 { databases: {...}, roles: [...] }
   * @returns {Promise<Object>} GraphJin 的写入结果
   */
  async applyConfig(patch) {
    const result = await this.mcp.callTool('update_current_config', patch);
    if (result && result.success === false) {
      const reason = Array.isArray(result.errors) ? result.errors.join('; ') : result.message;
      throw new ConfigModeError(`配置写入失败：${reason}`);
    }
    return result;
  }

  /**
   * 校验当前配置是否符合方案 B 的形态。
   *
   * 两条硬约束都是实测踩出来的：
   * - 配置 sources 后 roles[].tables 会被拒；
   * - 单数 database: 会让 update_current_config 触发服务端 panic 并退出进程。
   *
   * @param {Object} [config] 已读取的配置，缺省时现读一次
   * @returns {Promise<Object>} 被校验的配置
   */
  async assertLegacyMode(config = null) {
    const current = config ?? (await this.readConfig('all'));
    if (Array.isArray(current.sources) && current.sources.length > 0) {
      throw new ConfigModeError(
        '当前配置含 sources：roles[].tables 会被拒绝，请先移除 sources 再使用方案 B'
      );
    }
    if (current.database && typeof current.database === 'object') {
      throw new ConfigModeError(
        '当前配置使用了单数 database：调用 update_current_config 会导致服务端 panic，请改用 databases'
      );
    }
    return current;
  }
}

module.exports = { GraphJinService, ConfigModeError };
