'use strict'
const { execSync } = require('child_process')
require('./generate-icon.cjs')
const path = require('path')
const os = require('os')
const fs = require('fs')

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
