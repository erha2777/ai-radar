'use strict';

/**
 * Electron 主进程入口。
 *
 * 职责：
 *  - 创建主窗口（自绘标题栏 + 无边框，保留窗口控制按钮）
 *  - 启动抓取调度器，把结果推送给渲染进程
 *  - 系统通知（新内容提醒，点击跳转原文）
 *  - 托盘常驻、关闭到托盘、开机自启
 *  - 通过 IPC 暴露受控的接口给渲染进程（渲染进程无 Node 权限）
 */

const { app, BrowserWindow, ipcMain, shell, Tray, Menu, Notification, nativeImage, session } = require('electron');
const path = require('path');
const fs = require('fs');

const { Store } = require('./store');
const { Scheduler } = require('./scheduler');
const { SOURCES, CATEGORIES } = require('./sources');
const smoke = require('./smoke');

const IS_DEV = process.argv.includes('--dev');
const APP_ID = 'com.airadar.desktop';

// 单实例：第二次启动时聚焦已有窗口而不是开新窗口
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

/** @type {BrowserWindow|null} */
let mainWindow = null;
/** @type {Tray|null} */
let tray = null;
/** @type {Store|null} */
let store = null;
/** @type {Scheduler|null} */
let scheduler = null;
let isQuitting = false;

/* ------------------------------------------------------------------ *
 * 日志
 * ------------------------------------------------------------------ */

const logBuffer = [];

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')}`;
  logBuffer.push(line);
  if (logBuffer.length > 500) logBuffer.shift();
  if (IS_DEV) console.log(line);
}

/* ------------------------------------------------------------------ *
 * 资源路径
 * ------------------------------------------------------------------ */

function assetPath(name) {
  const candidates = [
    path.join(__dirname, '..', 'renderer', 'assets', name),
    path.join(process.resourcesPath || '', 'app', 'src', 'renderer', 'assets', name)
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* 忽略 */
    }
  }
  return candidates[0];
}

/* ------------------------------------------------------------------ *
 * 窗口
 * ------------------------------------------------------------------ */

function createWindow() {
  const icon = nativeImage.createFromPath(assetPath('icon.png'));

  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b1020',
    title: 'AI Radar',
    icon: icon.isEmpty() ? undefined : icon,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0b1020',
      symbolColor: '#c7d2fe',
      height: 44
    },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    log('主窗口已显示');
  });

  // 关闭 → 最小化到托盘（可在设置里关闭该行为）
  mainWindow.on('close', (event) => {
    if (!isQuitting && store && store.getConfig().closeToTray) {
      event.preventDefault();
      mainWindow.hide();
      log('窗口已隐藏到托盘');
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 外部链接交给系统浏览器，绝不在应用内打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      openExternal(url);
    }
  });

  return mainWindow;
}

/** 安全地打开外部链接：仅允许 http/https。 */
function openExternal(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    shell.openExternal(u.href);
    return true;
  } catch {
    return false;
  }
}

function showWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

/* ------------------------------------------------------------------ *
 * 托盘
 * ------------------------------------------------------------------ */

function buildTrayImage() {
  // 优先使用 @2x，Windows 缩放屏更清晰
  const img = nativeImage.createFromPath(assetPath('tray@2x.png'));
  if (!img.isEmpty()) {
    const resized = img.resize({ width: 16, height: 16, quality: 'best' });
    return resized;
  }
  return nativeImage.createFromPath(assetPath('tray.png'));
}

function createTray() {
  const image = buildTrayImage();
  if (image.isEmpty()) {
    log('托盘图标为空，跳过托盘创建');
    return;
  }
  tray = new Tray(image);
  tray.setToolTip('AI Radar — AI 最新消息');
  updateTrayMenu();

  tray.on('click', () => {
    if (mainWindow && mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
    else showWindow();
  });
  tray.on('double-click', () => showWindow());
}

function updateTrayMenu() {
  if (!tray) return;
  const snap = scheduler ? scheduler.snapshot() : null;
  const unread = snap ? snap.unreadCount : 0;
  const lastFetch = snap && snap.fetchedAt ? formatTime(snap.fetchedAt) : '尚未抓取';

  const menu = Menu.buildFromTemplate([
    { label: `AI Radar — 未读 ${unread} 条`, enabled: false },
    { label: `上次更新：${lastFetch}`, enabled: false },
    { type: 'separator' },
    {
      label: '打开主窗口',
      click: () => showWindow()
    },
    {
      label: '立即刷新',
      click: () => {
        if (scheduler) scheduler.refresh('manual');
      }
    },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: store ? store.getConfig().launchAtLogin : false,
      click: (item) => {
        applyLaunchAtLogin(item.checked);
        if (mainWindow) {
          mainWindow.webContents.send('config:changed', store.getConfig());
        }
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(`AI Radar — 未读 ${unread} 条`);
}

function formatTime(iso) {
  try {
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    if (sameDay) return `${hh}:${mm}`;
    return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
  } catch {
    return '未知';
  }
}

/* ------------------------------------------------------------------ *
 * 通知与自启
 * ------------------------------------------------------------------ */

function showNotification({ items }) {
  if (!Notification.isSupported() || !items || !items.length) return;
  for (const item of items) {
    try {
      const n = new Notification({
        title: `【${item.sourceName}】${truncate(item.title, 60)}`,
        body: truncate(item.summary || '点击查看详情', 140),
        silent: false,
        timeoutType: 'default'
      });
      n.on('click', () => {
        showWindow();
        if (mainWindow) mainWindow.webContents.send('feed:highlight', item.id);
      });
      n.show();
    } catch (err) {
      log('通知发送失败：', err.message);
    }
  }
}

function truncate(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function applyLaunchAtLogin(enabled) {
  const cfg = store.updateConfig({ launchAtLogin: Boolean(enabled) });
  try {
    app.setLoginItemSettings({
      openAtLogin: cfg.launchAtLogin,
      path: process.execPath,
      args: cfg.launchAtLogin ? ['--hidden'] : []
    });
    log(`开机自启已${cfg.launchAtLogin ? '开启' : '关闭'}`);
  } catch (err) {
    log('设置开机自启失败：', err.message);
  }
  return cfg;
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */

function registerIpc() {
  ipcMain.handle('feed:get', () => scheduler.snapshot());

  ipcMain.handle('feed:refresh', async () => {
    const res = await scheduler.refresh('manual');
    return { result: res, snapshot: scheduler.snapshot() };
  });

  ipcMain.handle('feed:markRead', (_e, payload) => {
    const { ids, read } = payload || {};
    store.markRead(ids, read !== false);
    return scheduler.snapshot();
  });

  ipcMain.handle('feed:markAllRead', () => {
    const ids = scheduler.snapshot().items.map((i) => i.id);
    store.markAllRead(ids);
    return scheduler.snapshot();
  });

  ipcMain.handle('feed:toggleFavorite', (_e, item) => {
    const res = store.toggleFavorite(item);
    return { ...res, snapshot: scheduler.snapshot() };
  });

  ipcMain.handle('config:get', () => store.getConfig());

  ipcMain.handle('config:update', (_e, patch) => {
    const before = store.getConfig();
    const cfg = store.updateConfig(patch || {});
    if (cfg.refreshMinutes !== before.refreshMinutes) scheduler.schedule();
    if (cfg.launchAtLogin !== before.launchAtLogin) applyLaunchAtLogin(cfg.launchAtLogin);
    // 启用源变化时立刻重新抓取
    if (JSON.stringify(cfg.enabledSources) !== JSON.stringify(before.enabledSources)) {
      scheduler.refresh('config');
    }
    return cfg;
  });

  ipcMain.handle('app:openExternal', (_e, url) => openExternal(url));

  ipcMain.handle('app:openPath', (_e, target) => {
    const map = {
      userData: app.getPath('userData'),
      logs: app.getPath('userData')
    };
    const p = map[target];
    if (!p) return false;
    shell.openPath(p);
    return true;
  });

  ipcMain.handle('app:window', (_e, action) => {
    if (!mainWindow) return false;
    switch (action) {
      case 'minimize':
        mainWindow.minimize();
        return true;
      case 'maximize':
        if (mainWindow.isMaximized()) mainWindow.unmaximize();
        else mainWindow.maximize();
        return mainWindow.isMaximized();
      case 'hide':
        mainWindow.hide();
        return true;
      case 'quit':
        isQuitting = true;
        app.quit();
        return true;
      default:
        return false;
    }
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    userData: app.getPath('userData'),
    isDev: IS_DEV,
    categories: CATEGORIES,
    logs: logBuffer.slice(-100)
  }));

  ipcMain.handle('app:testNotification', () => {
    if (!Notification.isSupported()) return false;
    try {
      new Notification({
        title: 'AI Radar 通知测试',
        body: '如果你看到这条消息，说明系统通知工作正常。',
        silent: false
      }).show();
      return true;
    } catch {
      return false;
    }
  });
}

/* ------------------------------------------------------------------ *
 * 启动流程
 * ------------------------------------------------------------------ */

app.setAppUserModelId(APP_ID);

// 只允许必要的权限，其余一律拒绝
app.whenReady().then(() => {
  try {
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  } catch (err) {
    log('权限处理器设置失败：', err.message);
  }

  try {
    store = new Store(app.getPath('userData')).load();
    log('数据目录：', app.getPath('userData'));
    log('配置：', store.getConfig());
  } catch (err) {
    log('存储初始化失败，使用默认配置：', err.message);
    store = new Store(app.getPath('userData')).load();
  }

  registerIpc();

  scheduler = new Scheduler(store);
  scheduler.on('status', (s) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('feed:status', s);
    if (!s.refreshing) {
      updateTrayMenu();
      log(`刷新结束：ok=${s.ok} 新内容=${s.newCount ?? 0} ${s.error || ''}`);
    }
  });
  scheduler.on('progress', (p) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('feed:progress', p);
  });
  scheduler.on('update', (snap) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('feed:update', snap);
    updateTrayMenu();
  });
  scheduler.on('notify', (payload) => showNotification(payload));

  createWindow();
  createTray();
  scheduler.start();

  // --hidden 用于开机自启时静默启动到托盘（冒烟测试需要窗口可见，故排除）
  if (process.argv.includes('--hidden') && !smoke.isSmokeTest() && mainWindow) {
    mainWindow.once('ready-to-show', () => mainWindow.hide());
  }

  // 冒烟测试：抓取完成后自动截图 + 写诊断报告 + 退出
  if (smoke.isSmokeTest()) {
    try {
      smoke.install({ app, window: mainWindow, scheduler, store });
      log('冒烟测试模式已启用');
    } catch (err) {
      log('冒烟测试初始化失败：', err && err.message);
    }
  }

  app.on('activate', () => showWindow());
});

app.on('second-instance', () => showWindow());

app.on('window-all-closed', () => {
  // 托盘常驻，不随窗口关闭退出
  if (!store || !store.getConfig().closeToTray) {
    isQuitting = true;
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  if (scheduler) scheduler.stop();
});

process.on('uncaughtException', (err) => {
  log('未捕获异常：', err && err.stack ? err.stack : String(err));
});
process.on('unhandledRejection', (err) => {
  log('未处理的 Promise 拒绝：', err && err.stack ? err.stack : String(err));
});

module.exports = { SOURCES };
