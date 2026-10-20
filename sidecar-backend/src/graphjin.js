'use strict';

const { McpClient } = require('./mcp-client');
const { executeGraphql } = require('./graphql-http');

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
    this.baseUrl = baseUrl;
    this.mcp = new McpClient({ baseUrl, role });
  }

  /**
   * 读取当前 catalog revision：source 模式的配置写入必须先拿到它。
   *
   * MCP 的 get_current_config 不返回 revision，只有 GraphQL 的 gj_config root 给。
   *
   * @returns {Promise<string|null>}
   */
  async readCatalogRevision() {
    const body = await executeGraphql(this.baseUrl, {
      query: 'query { gj_config(id: "current") { catalog_revision } }',
      role: 'admin',
    });
    return body?.data?.gj_config?.[0]?.catalog_revision ?? null;
  }

  /**
   * 按当前模式写入配置：source 模式自动走 preview → apply。
   *
   * 实测：source 模式下不带 mode 的写入会被拒
   * （missing or unsupported mode for source-mode config update）。
   *
   * @param {Object} patch
   * @returns {Promise<Object>}
   */
  async updateConfig(patch) {
    const current = await this.readConfig('all');
    const isSource = Array.isArray(current.sources) && current.sources.length > 0;
    if (!isSource) return this.applyConfig(patch);

    const revision = await this.readCatalogRevision();
    const base = revision ? { ...patch, expected_catalog_revision: revision } : { ...patch };
    const preview = await this.applyConfig({ ...base, mode: 'preview' });
    if (!preview?.preview_id) return preview;
    return this.applyConfig({ ...base, mode: 'apply', preview_id: preview.preview_id });
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
   * 注意 source 模式的两套写入语义（实测）：
   * - 整份 `sources` 替换属 core scope，立即落盘、不返回 preview_id；
   * - `source_patches` 属 source_scoped，才真正支持 preview → apply。
   * 平台改权限一律用 source_patches，走两阶段。
   *
   * @param {Object} patch 形如 { source_patches: [...] } 或 { roles: [...] }
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
   * 校验当前配置是否已是 source 模式。
   *
   * source 模式下 `databases` 与 `roles[].tables` 都会让进程启动即 FATAL
   * （见 docs/graphjin-source-migration.md §2.3），所以这里必须拦住旧形态。
   *
   * @param {Object} [config] 已读取的配置，缺省时现读一次
   * @returns {Promise<Object>} 被校验的配置
   */
  async assertSourceMode(config = null) {
    const current = config ?? (await this.readConfig('all'));
    if (!Array.isArray(current.sources) || current.sources.length === 0) {
      throw new ConfigModeError(
        '当前配置没有 sources：legacy 项目请先执行迁移（dev.yml 中的 databases 会被改写）'
      );
    }
    // 不要再检查 current.databases：source 模式下 GraphJin 会把它派生出来（非文件配置），
    // 误判会让正常项目启动失败。文件层面的 databases 由启动校验兜住。
    return current;
  }
}

module.exports = { GraphJinService, ConfigModeError };
