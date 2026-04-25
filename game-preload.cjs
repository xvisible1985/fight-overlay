'use strict'
const { contextBridge } = require('electron')
contextBridge.exposeInMainWorld('gameAPI', {
  isElectron: true,
})
