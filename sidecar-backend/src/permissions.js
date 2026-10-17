'use strict';

/**
 * 权限编排：把平台内部的权限矩阵转换成 GraphJin 配置。
 *
 * 采用方案 B —— 不使用 sources，走 legacy 的 `databases` + `roles[].tables`，
 * 因为 `roles[].tables[]` 是唯一支持 query/insert/update/delete 四项独立开关的结构。
 * 实测依据见 docs/graphjin-3.21.14-baseline.md §6.4。
 */

/**
 * 单项操作（query / insert / update / delete）的配置。
 *
 * @param {{enabled?: boolean, filters?: string[], columns?: string[], limit?: number}} op
 * @param {{withLimit?: boolean}} [options] withLimit 只对 query 有意义
 * @returns {Object} GraphJin 的操作配置
 */
function buildOperation(op, { withLimit = false } = {}) {
  if (!op || op.enabled === false) {
    return { block: true };
  }

  const result = { block: false };
  if (Array.isArray(op.filters) && op.filters.length > 0) result.filters = op.filters;
  if (Array.isArray(op.columns) && op.columns.length > 0) result.columns = op.columns;
  if (withLimit && typeof op.limit === 'number') result.limit = op.limit;
  return result;
}

/**
 * 将权限矩阵转换为可直接交给 update_current_config 的 roles 补丁。
 *
 * @param {string} database 目标库名。缺失会让规则挂到内部库 __gj_internal_artifacts 上
 * @param {Object} matrix { roleName: { tableName: { query, insert, update, delete } } }
 * @returns {{roles: Array<Object>}} roles 补丁
 */
function buildRoleTableConfig(database, matrix) {
  if (!database) throw new Error('database 不能为空：缺失会让规则落到 __gj_internal_artifacts');

  const roles = [];
  for (const [role, tables] of Object.entries(matrix ?? {})) {
    const roleTables = [];

    for (const [table, ops] of Object.entries(tables ?? {})) {
      roleTables.push({
        name: table,
        database,
        query: buildOperation(ops.query, { withLimit: true }),
        insert: buildOperation(ops.insert),
        update: buildOperation(ops.update),
        delete: buildOperation(ops.delete),
      });
    }

    roles.push({ name: role, tables: roleTables });
  }

  return { roles };
}

/**
 * 把多条 roles 补丁合并成一份以角色为键的矩阵视图，用于展示变更 diff。
 *
 * @param {{roles: Array<Object>}} patch buildRoleTableConfig 的输出
 * @returns {Object} { roleName: { tableName: { query, insert, update, delete } } }
 */
function summarizePatch(patch) {
  const summary = {};
  for (const role of patch.roles ?? []) {
    const tables = {};
    for (const table of role.tables ?? []) {
      tables[table.name] = {
        query: table.query?.block === true ? 'blocked' : 'allowed',
        insert: table.insert?.block === true ? 'blocked' : 'allowed',
        update: table.update?.block === true ? 'blocked' : 'allowed',
        delete: table.delete?.block === true ? 'blocked' : 'allowed',
      };
    }
    summary[role.name] = tables;
  }
  return summary;
}

module.exports = { buildOperation, buildRoleTableConfig, summarizePatch };
