'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** 主进程通过 additionalArguments 把端口传进来，这里同步解析 */
const PORT_ARG = '--backend-port=';
const portArg = process.argv.find((item) => item.startsWith(PORT_ARG));

contextBridge.exposeInMainWorld('mcpBuilder', {
  backendPort: portArg ? Number(portArg.slice(PORT_ARG.length)) : 0,
  platform: process.platform,
  isDesktop: true,
  /**
   * 把完整窗口标题交给主进程。
   *
   * 品牌名随界面语言变，所以不在主进程侧拼接，渲染进程给什么就用什么。
   */
  setWindowTitle: (title) => ipcRenderer.send('app:window-title', String(title ?? '')),
});
