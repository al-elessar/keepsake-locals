/*
 * Keepsake desktop app - preload for the app's own window.
 * Exposes a small, fixed set of actions to the user interface (window.keepsake).
 */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (name) => (...args) => ipcRenderer.invoke('ui:' + name, ...args);
const ACTIONS = [
  'init',
  'getCommunity',
  'addCommunity',
  'removeCommunity',
  'openLocals',
  'findAll',
  'checkNew',
  'stopFind',
  'setExcluded',
  'setOption',
  'chooseFolder',
  'chooseToolsFolder',
  'download',
  'queue',
  'toolsStatus',
  'toolsInstall',
  'openPath',
  'showFile',
  'renameOld',
  'exportScript',
  'exportDebug',
  'importFirefox',
  'checkUpdates',
  'updateStatus',
  'installUpdate',
  'signOut',
  'openExternal'
];

const api = {};
for (const a of ACTIONS) api[a] = call(a);
api.on = (channel, fn) => {
  const allowed = ['community', 'scroll', 'queue', 'tools', 'locals', 'notice', 'update'];
  if (!allowed.includes(channel)) return;
  ipcRenderer.on('ev:' + channel, (_e, payload) => fn(payload));
};

contextBridge.exposeInMainWorld('keepsake', api);
