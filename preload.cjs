const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  setIgnoreMouseEvents: (ignore) => ipcRenderer.send('set-ignore-mouse-events', ignore),
  enterChatMode: () => ipcRenderer.send('enter-chat-mode'),
  exitChatMode:  () => ipcRenderer.send('exit-chat-mode'),
  logout:        () => ipcRenderer.send('logout'),
  onFocusChatInput: (cb) => ipcRenderer.on('focus-chat-input', cb),
  onKeyInput:       (cb) => ipcRenderer.on('key-input', (_, p) => cb(p)),
  onAuthToken:      (cb) => ipcRenderer.on('auth-token', (_, d) => cb(d)),
  onWidgetToggle:   (cb) => ipcRenderer.on('widget-toggle', (_, d) => cb(d)),
})
