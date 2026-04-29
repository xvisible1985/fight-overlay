'use strict'
const { execSync } = require('child_process')
const fs   = require('fs')
const path = require('path')
const zlib = require('zlib')

const src     = path.join(__dirname, 'tree_2.png')
const tmp256  = path.join(__dirname, 'icon256.png')

// Resize to 256x256 via PowerShell System.Drawing (write to temp ps1 file)
const ps = [
  'Add-Type -AssemblyName System.Drawing',
  `$src = [System.Drawing.Image]::FromFile('${src.replace(/\\/g, '\\\\')}')`,
  '$dst = New-Object System.Drawing.Bitmap(256, 256)',
  '$g = [System.Drawing.Graphics]::FromImage($dst)',
  "$g.InterpolationMode = 'HighQualityBicubic'",
  '$g.DrawImage($src, 0, 0, 256, 256)',
  '$g.Dispose()',
  `$dst.Save('${tmp256.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)`,
  '$src.Dispose()',
  '$dst.Dispose()',
].join('\r\n')
const ps1 = path.join(require('os').tmpdir(), 'gen-icon.ps1')
fs.writeFileSync(ps1, ps, 'utf8')
execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${ps1}"`)
fs.unlinkSync(ps1)

// Copy original PNG as icon.png (for tray)
fs.copyFileSync(src, path.join(__dirname, 'icon.png'))

// Build ICO from 256x256 PNG
function crc32(buf) {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[i] = c
  }
  let crc = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) crc = t[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}
function pngChunk(type, data) {
  const tb = Buffer.from(type, 'ascii')
  const lb = Buffer.alloc(4); lb.writeUInt32BE(data.length)
  const cb = Buffer.alloc(4); cb.writeUInt32BE(crc32(Buffer.concat([tb, data])))
  return Buffer.concat([lb, tb, data, cb])
}

const png256 = fs.readFileSync(tmp256)

const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(1, 4)

const entry = Buffer.alloc(16)
entry[0] = 0; entry[1] = 0; entry[2] = 0; entry[3] = 0
entry.writeUInt16LE(1, 4)
entry.writeUInt16LE(32, 6)
entry.writeUInt32LE(png256.length, 8)
entry.writeUInt32LE(22, 12)

const ico = Buffer.concat([header, entry, png256])
fs.writeFileSync(path.join(__dirname, 'icon.ico'), ico)

console.log('[icon] Generated icon.png + icon256.png + icon.ico from tree_2.png')
