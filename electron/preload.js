'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** 主进程通过 additionalArguments 把端口传进来，这里同步解析 */
const PORT_ARG = '--backend-port=';
const portArg = process.argv.find((item) => item.startsWith(PORT_ARG));

contextBridge.exposeInMainWorld('mcpBuilder', {
  backendPort: portArg ? Number(portArg.slice(PORT_ARG.length)) : 0,
  platform: process.platform,
  isDesktop: true,
  /** 把当前项目名交给主进程，窗口标题随之更新；空字符串表示回到产品名 */
  setProjectName: (name) => ipcRenderer.send('app:project-name', String(name ?? '')),
});
