'use strict'
const { contextBridge } = require('electron')

let _ws = null
const _listeners = []

contextBridge.exposeInMainWorld('gameAPI', {
  isElectron: true,

  connect(tableId, token, srv) {
    if (_ws) { _ws.onclose = null; _ws.close() }
    const wsBase = srv.replace(/^http/, 'ws')
    _ws = new WebSocket(`${wsBase}/ws/game/${tableId}?token=${token}`)
    _ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        for (const cb of _listeners) try { cb(msg) } catch {}
      } catch {}
    }
    _ws.onclose = () => {
      // Retry after 2s
      setTimeout(() => {
        if (_ws && _ws.readyState === WebSocket.CLOSED)
          window.gameAPI.connect(tableId, token, srv)
      }, 2000)
    }
    _ws.onerror = () => {}
  },

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
  }
})
