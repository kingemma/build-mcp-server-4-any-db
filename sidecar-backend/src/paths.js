'use strict';

const path = require('node:path');

/**
 * 可写数据目录。
 *
 * 开发态默认 `sidecar-backend/data`；打包进 Electron 后安装目录可能是只读的
 * （asar 更不可写），主进程会通过 `MCP_BUILDER_DATA_DIR` 指到 userData。
 *
 * @returns {string} 数据目录绝对路径
 */
function dataDir() {
  return process.env.MCP_BUILDER_DATA_DIR || path.join(__dirname, '..', 'data');
}

/**
 * @param {string} name 文件名
 * @returns {string} 数据目录下的文件路径
 */
function dataFile(name) {
  return path.join(dataDir(), name);
}

module.exports = { dataDir, dataFile };
