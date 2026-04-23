'use strict'
const { execSync } = require('child_process')
const path = require('path')
const os = require('os')
const fs = require('fs')

process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
process.env.WIN_CSC_LINK = ''

// Remove potentially corrupt winCodeSign cache
const cacheDir = path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache', 'winCodeSign')
if (fs.existsSync(cacheDir)) {
  try {
    fs.rmSync(cacheDir, { recursive: true, force: true })
    console.log('[build1] Cleared winCodeSign cache')
  } catch (e) {
    console.warn('[build1] Could not clear cache:', e.message)
  }
}

const configPath = path.join(__dirname, 'build1-config.yml')
execSync(`npx electron-builder --config "${configPath}"`, { stdio: 'inherit', env: process.env })
