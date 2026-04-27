'use strict'
const { contextBridge, ipcRenderer } = require('electron')

let _ws = null
const _listeners = []

function _connect(tableId, token, srv) {
  if (_ws) { _ws.onclose = null; _ws.close() }
  const wsBase = srv.replace(/^http/, 'ws')
  const wsUrl = `${wsBase}/ws/game/${tableId}?token=${token}`
  console.log('[preload] connecting to:', wsUrl.slice(0, 80))
  _ws = new WebSocket(wsUrl)
  _ws.onopen = () => console.log('[preload] WS open')
  _ws.onclose = (e) => console.log('[preload] WS closed:', e.code, e.reason)
  _ws.onerror = (e) => console.log('[preload] WS error:', e.message)
  _ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data)
      for (const cb of _listeners) try { cb(msg) } catch {}
    } catch {}
  }
  _ws.onclose = () => {
    setTimeout(() => {
      if (_ws && _ws.readyState === WebSocket.CLOSED)
        _connect(tableId, token, srv)
    }, 2000)
  }
  _ws.onerror = () => {}
}

contextBridge.exposeInMainWorld('gameAPI', {
  isElectron: true,

  connect(tableId, token, srv) { _connect(tableId, token, srv) },

  onEvent(cb) {
    _listeners.push(cb)
    return () => { const i = _listeners.indexOf(cb); if (i !== -1) _listeners.splice(i, 1) }
  },

  sendAction(type, data = {}) {
    if (_ws?.readyState === WebSocket.OPEN)
      _ws.send(JSON.stringify({ type, ...data }))
  },

  disconnect() {
    if (_ws) { _ws.onclose = null; _ws.close(); _ws = null }
  },

  closeWindow:    () => ipcRenderer.send('game-window-close'),
  startResizing:  () => ipcRenderer.send('game-window-start-resize'),
})
