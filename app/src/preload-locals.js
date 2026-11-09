/*
 * Keepsake desktop app - preload for the Locals window (sandboxed, isolated world).
 *
 * Does the same job as the extension's content script: puts the shared page hook
 * (core/page-hook.js) into the page before the Locals app starts, and passes what it
 * finds to the app. The Locals page itself gets no access to the app or to Node.
 */
'use strict';
const { contextBridge, ipcRenderer, webFrame } = require('electron');

if (/(^|\.)locals\.com$/.test(location.hostname)) {
  const source = ipcRenderer.sendSync('locals:hook-source');
  if (source) {
    let injected = false;
    try {
      // Runs synchronously in the page's own world, before any page script, and is not
      // subject to the page's Content-Security-Policy.
      contextBridge.executeInMainWorld({ func: new Function(source) });
      injected = true;
    } catch (e) {
      /* older Electron: fall back below */
    }
    if (!injected) webFrame.executeJavaScript(source);
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.__lvs !== 'page') return;
    const d = ev.data;
    ipcRenderer.send('locals:findings', {
      href: location.href,
      data: { videos: d.videos, token: d.token, samples: d.samples }
    });
  });

  ipcRenderer.on('locals:rescan', () => {
    window.postMessage({ __lvs: 'ext', type: 'rescan' }, location.origin);
  });
}
