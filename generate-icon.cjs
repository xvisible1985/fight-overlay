'use strict'
// Generates electron/icon.png used by both EXE and tray.
// Design: dark circle bg + orange ring + white crossed swords (⚔)
const fs   = require('fs')
const path = require('path')
const zlib = require('zlib')

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

function makePNG(w, h, pixels) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const raw = Buffer.alloc(h * (1 + w * 3))
  for (let y = 0; y < h; y++) {
    const base = y * (1 + w * 3)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixels[y][x]
      raw[base + 1 + x*3] = r; raw[base + 1 + x*3+1] = g; raw[base + 1 + x*3+2] = b
    }
  }
  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

// ── Design ────────────────────────────────────────────────────────────────────
const W = 256, H = 256
const BG     = [15, 23, 42]      // #0f172a  deep navy
const ORANGE = [251, 146, 60]    // #fb923c  orange-400
const DARK   = [30, 41, 59]      // #1e293b  ring background

const px = (y, x) => {
  const dx = x - W/2, dy = y - H/2
  return dx*dx + dy*dy
}

// init background
const pixels = Array.from({length: H}, (_, y) =>
  Array.from({length: W}, (_, x) => {
    const d2 = px(y, x)
    const R = 118, r = 92
    if (d2 <= r*r) return [...DARK]           // inner circle
    if (d2 <= R*R) return [...ORANGE]         // orange ring
    return [...BG]                            // outer bg
  })
)

// ── Draw crossed swords ───────────────────────────────────────────────────────
// Each sword = a diagonal line of 'thickness' pixels wide.
// Sword 1: top-left → bottom-right  (SW direction)
// Sword 2: top-right → bottom-left (SE direction)

function drawLine(y0, x0, y1, x1, thick, color) {
  const steps = Math.max(Math.abs(y1-y0), Math.abs(x1-x0)) * 3
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const cy = y0 + (y1-y0)*t
    const cx = x0 + (x1-x0)*t
    for (let dy = -thick; dy <= thick; dy++) {
      for (let dx = -thick; dx <= thick; dx++) {
        if (dy*dy + dx*dx <= thick*thick) {
          const iy = Math.round(cy+dy), ix = Math.round(cx+dx)
          if (iy>=0 && iy<H && ix>=0 && ix<W) pixels[iy][ix] = [...color]
        }
      }
    }
  }
}

const WHITE = [255, 255, 255]
const GRIP  = [148, 163, 184]  // slate-400 for handle
const GOLD  = [253, 224, 71]   // yellow-300 for guard

const M = 128  // center

// Sword 1: top-right blade → bottom-left handle  (\)
drawLine(M-68, M+68,  M-8, M+8,   4, WHITE)   // blade tip → center-ish
drawLine(M+8,  M-8,   M+68, M-68, 4, GRIP)    // center → handle bottom
// Guard 1 (horizontal bar through center)
drawLine(M-4,  M-24,  M-4, M+24,  4, GOLD)

// Sword 2: top-left blade → bottom-right handle  (/)
drawLine(M-68, M-68,  M-8, M-8,   4, WHITE)
drawLine(M+8,  M+8,   M+68, M+68, 4, GRIP)
// Guard 2
drawLine(M+4,  M-24,  M+4, M+24,  4, GOLD)

// ── Write file ────────────────────────────────────────────────────────────────
const out = path.join(__dirname, 'icon.png')
fs.writeFileSync(out, makePNG(W, H, pixels))
console.log('[icon] Generated', out)
