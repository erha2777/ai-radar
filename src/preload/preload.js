'use strict';

/**
 * 渲染进程安全桥接层。
 *
 * 渲染进程运行在 contextIsolation + sandbox 环境下，没有 Node 能力。
 * 这里只暴露白名单方法，且不含任何文件系统 / 命令执行接口。
 * 所有网络抓取都在主进程完成（顺带绕开了渲染进程的 CORS 限制）。
 */

const { contextBridge, ipcRenderer } = require('electron');

/** 把主进程推送的事件包装成可取消订阅的形式，避免监听器泄漏。 */
function subscribe(channel, handler) {
  const listener = (_event, payload) => {
    try {
      handler(payload);
    } catch (err) {
      console.error(`[preload] ${channel} 处理失败：`, err);
    }
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  /* 数据 */
  getFeed: () => ipcRenderer.invoke('feed:get'),
  refresh: () => ipcRenderer.invoke('feed:refresh'),
  markRead: (ids, read = true) => ipcRenderer.invoke('feed:markRead', { ids, read }),
  markAllRead: () => ipcRenderer.invoke('feed:markAllRead'),
  toggleFavorite: (item) => ipcRenderer.invoke('feed:toggleFavorite', item),

  /* 配置 */
  getConfig: () => ipcRenderer.invoke('config:get'),
  updateConfig: (patch) => ipcRenderer.invoke('config:update', patch),

  /* 应用 */
  getInfo: () => ipcRenderer.invoke('app:info'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  openPath: (target) => ipcRenderer.invoke('app:openPath', target),
  windowAction: (action) => ipcRenderer.invoke('app:window', action),
  testNotification: () => ipcRenderer.invoke('app:testNotification'),

  /* 事件订阅 */
  onUpdate: (cb) => subscribe('feed:update', cb),
  onStatus: (cb) => subscribe('feed:status', cb),
  onProgress: (cb) => subscribe('feed:progress', cb),
  onHighlight: (cb) => subscribe('feed:highlight', cb),
  onConfigChanged: (cb) => subscribe('config:changed', cb)
});
