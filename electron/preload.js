'use strict';

const { contextBridge } = require('electron');

/** 主进程通过 additionalArguments 把端口传进来，这里同步解析 */
const PORT_ARG = '--backend-port=';
const portArg = process.argv.find((item) => item.startsWith(PORT_ARG));

contextBridge.exposeInMainWorld('mcpBuilder', {
  backendPort: portArg ? Number(portArg.slice(PORT_ARG.length)) : 0,
  platform: process.platform,
  isDesktop: true,
});
