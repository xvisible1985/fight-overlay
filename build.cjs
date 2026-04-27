'use strict'
const { execSync } = require('child_process')
const path = require('path')
const os   = require('os')
const fs   = require('fs')

require('./generate-icon.cjs')

process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
process.env.WIN_CSC_LINK = ''

// Remove potentially corrupt winCodeSign cache so it gets re-extracted cleanly
const cacheDir = path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache', 'winCodeSign')
if (fs.existsSync(cacheDir)) {
  try {
    fs.rmSync(cacheDir, { recursive: true, force: true })
    console.log('[build] Cleared winCodeSign cache')
  } catch (e) {
    console.warn('[build] Could not clear cache:', e.message)
  }
}

execSync('electron-builder', { stdio: 'inherit', env: process.env })

// Embed icon directly into the portable exe via rcedit
const rcedit  = path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache', 'winCodeSign', 'winCodeSign-2.6.0', 'rcedit-ia32.exe')
const exeFile = path.join(__dirname, 'dist', 'FightArena Overlay 0.0.0.exe')
const icoFile = path.join(__dirname, 'icon.ico')

if (fs.existsSync(rcedit) && fs.existsSync(exeFile)) {
  try {
    execSync(`"${rcedit}" "${exeFile}" --set-icon "${icoFile}"`, { stdio: 'inherit' })
    console.log('[build] Icon embedded into portable exe')
  } catch (e) {
    console.warn('[build] rcedit failed:', e.message)
  }
} else {
  console.warn('[build] rcedit or exe not found, skipping icon embed')
}
