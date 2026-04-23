const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('loginAPI', {
  getSaved:     ()     => ipcRenderer.sendSync('login-get-saved'),
  loginSuccess: (data) => ipcRenderer.send('login-success', data),
})
