const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, globalShortcut } = require('electron')
const path = require('path')
const zlib = require('zlib')
const fs   = require('fs')
const os   = require('os')
const { exec, spawn } = require('child_process')

// ── Win32 helper ──────────────────────────────────────────────────────────────
const helperCs  = path.join(os.tmpdir(), 'FAHelper.cs')
const helperExe = path.join(os.tmpdir(), 'FAHelper.exe')

// Всегда перекомпилируем
if (fs.existsSync(helperExe)) { try { fs.unlinkSync(helperExe) } catch {} }

const HELPER_SRC = [
  'using System; using System.Runtime.InteropServices; using System.Diagnostics; using System.Threading; using System.Text;',
  'class FA {',
  '  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L,T,R,B; }',
  '  [StructLayout(LayoutKind.Sequential)] struct KBDLL { public uint vk,sc,fl,ts; public IntPtr ei; }',
  '  [StructLayout(LayoutKind.Sequential)] struct MSG  { public IntPtr hw; public uint msg; public IntPtr wp,lp; public uint ts; public int px,py; }',
  '  static readonly IntPtr TOPMOST = new IntPtr(-1);',
  '  const uint NOACTIVATE = 0x0010, NOMOVE = 0x0002, NOSIZE = 0x0001;',
  '  const int GWL_EXSTYLE = -20;',
  '  const int WEX_NOACT = unchecked((int)0x08000000);',
  '  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int n);',
  '  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);',
  '  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);',
  '  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);',
  '  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);',
  '  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);',
  '  [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr h, int i, int v);',
  '  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);',
  '  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();',
  '  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint f, uint t2, bool a);',
  '  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);',
  '  delegate IntPtr HookProc(int c, IntPtr w, IntPtr l);',
  '  [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int t, HookProc p, IntPtr m, uint tid);',
  '  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);',
  '  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int c, IntPtr w, IntPtr l);',
  '  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);',
  '  [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint mn, uint mx);',
  '  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string s);',
  '  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int k);',
  '  static IntPtr hookHwnd = IntPtr.Zero;',
  '  static IntPtr hookHandle = IntPtr.Zero;',
  '  static bool modShift = false;',
  '  static HookProc hookProc;',
  '  static IntPtr KeyProc(int c, IntPtr w, IntPtr l) {',
  '    if (c >= 0 && hookHwnd != IntPtr.Zero) {',
  '      int wm = w.ToInt32();',
  '      if (wm==0x100||wm==0x101||wm==0x104||wm==0x105) {',
  '        var k=(KBDLL)Marshal.PtrToStructure(l,typeof(KBDLL));',
  '        uint vk=k.vk; bool dn=(wm==0x100||wm==0x104);',
  '        if(vk==16||vk==160||vk==161){modShift=dn;return CallNextHookEx(hookHandle,c,w,l);}',
  '        if(vk==17||vk==18||vk==91||vk==92) return CallNextHookEx(hookHandle,c,w,l);',
  '        if(dn){',
  '          bool isL=vk>=65&&vk<=90; bool isN=vk>=48&&vk<=57; bool isP=(vk>=186&&vk<=192)||(vk>=219&&vk<=222);',
  '          if(isL||isN||isP){bool caps=(GetAsyncKeyState(20)&1)!=0;bool sh=isL?(modShift^caps):modShift;Console.WriteLine("KK"+vk+":"+(sh?"1":"0"));Console.Out.Flush();}',
  '          if(vk==32||vk==13||vk==8||vk==27||vk==46||vk==35||vk==36||vk==37||vk==38||vk==39||vk==40){Console.WriteLine("KV"+vk);Console.Out.Flush();}',
  '        }',
  '        return new IntPtr(1);',
  '      }',
  '    }',
  '    return CallNextHookEx(hookHandle,c,w,l);',
  '  }',
  '  static void Main(string[] a) {',
  '    if (a.Length > 0 && a[0]=="DAEMON") { RunDaemon(); return; }',
  '    if (a.Length < 1) return;',
  '    Console.WriteLine(ExecCmd(a));',
  '  }',
  '  static void RunDaemon() {',
  '    Console.OutputEncoding = new UTF8Encoding(false);',
  '    string line;',
  '    while ((line = Console.ReadLine()) != null) {',
  '      line = line.Trim(); if (line.Length == 0) continue;',
  '      Console.WriteLine(ExecCmd(line.Split(\' \')));',
  '      Console.Out.Flush();',
  '    }',
  '  }',
  '  static string ExecCmd(string[] a) {',
  '    if (a.Length < 1) return "";',
  '    if (a[0]=="TOP"&&a.Length>1) {',
  '      SetWindowPos(new IntPtr(long.Parse(a[1])), TOPMOST, 0, 0, 0, 0, NOACTIVATE|NOMOVE|NOSIZE);',
  '      return "ok";',
  '    }',
  '    if (a[0]=="FOLLOW"&&a.Length>2) {',
  '      var gh=new IntPtr(long.Parse(a[1])); var oh=new IntPtr(long.Parse(a[2]));',
  '      if (IsIconic(gh)||!IsWindowVisible(gh)) return "hidden";',
  '      RECT r; if (!GetWindowRect(gh, out r)) return "hidden";',
  '      int w=r.R-r.L, h=r.B-r.T;',
  '      SetWindowPos(oh, TOPMOST, r.L, r.T, w, h, NOACTIVATE);',
  '      return r.L+" "+r.T+" "+w+" "+h;',
  '    }',
  '    if (a[0]=="BYPID"&&a.Length>1) {',
  '      var pn=a[1].EndsWith(".exe")?a[1].Substring(0,a[1].Length-4):a[1];',
  '      foreach(var p in Process.GetProcessesByName(pn))',
  '        if (p.MainWindowHandle != IntPtr.Zero) return p.MainWindowHandle.ToInt64().ToString();',
  '      return "0";',
  '    }',
  '    if (a[0]=="SHOW"&&a.Length>1) { ShowWindow(new IntPtr(long.Parse(a[1])),4); return "ok"; }',
  '    if (a[0]=="RESTORE"&&a.Length>1) { ShowWindow(new IntPtr(long.Parse(a[1])),9); return "ok"; }',
  '    if (a[0]=="NOACT"&&a.Length>1) { var h=new IntPtr(long.Parse(a[1])); SetWindowLong(h, GWL_EXSTYLE, GetWindowLong(h, GWL_EXSTYLE)|WEX_NOACT); return "ok"; }',
  '    if (a[0]=="SETFG"&&a.Length>1) { SetForegroundWindow(new IntPtr(long.Parse(a[1]))); return "ok"; }',
  '    if (a[0]=="HOOKSTART"&&a.Length>1) {',
  '      if (hookHandle != IntPtr.Zero) { UnhookWindowsHookEx(hookHandle); hookHandle = IntPtr.Zero; }',
  '      hookHwnd = new IntPtr(long.Parse(a[1]));',
  '      var thr = new Thread(() => {',
  '        hookProc = KeyProc;',
  '        hookHandle = SetWindowsHookEx(13, hookProc, GetModuleHandle(null), 0);',
  '        int rc; MSG mc;',
  '        while ((rc=GetMessage(out mc,IntPtr.Zero,0,0))!=0 && rc!=-1) {}',
  '      });',
  '      thr.IsBackground = true; thr.Start();',
  '      return "ok";',
  '    }',
  '    if (a[0]=="HOOKSTOP") {',
  '      hookHwnd = IntPtr.Zero;',
  '      if (hookHandle != IntPtr.Zero) { UnhookWindowsHookEx(hookHandle); hookHandle = IntPtr.Zero; }',
  '      return "ok";',
  '    }',
  '    return "";',
  '  }',
  '}'
].join('\n')

// ── State ─────────────────────────────────────────────────────────────────────
let savedGameHwnd  = null
let lastGameHwnd   = null   // не сбрасывается — для restore-fallback
let ourHwnd        = null
let chatModeActive = false
let helperProc     = null
let daemonReady    = false
let daemonBuf      = ''

// ── Daemon IPC ────────────────────────────────────────────────────────────────
function sendHelper(cmd) {
  if (!helperProc || helperProc.killed || !daemonReady) return
  try { helperProc.stdin.write(cmd + '\n') } catch {}
}

function startDaemon() {
  if (helperProc && !helperProc.killed) return
  helperProc = spawn(helperExe, ['DAEMON'])
  daemonReady = true
  daemonBuf   = ''
  if (ourHwnd) setTimeout(() => sendHelper('NOACT ' + ourHwnd), 200)

  helperProc.stdout.on('data', chunk => {
    daemonBuf += chunk.toString()
    const lines = daemonBuf.split('\n')
    daemonBuf = lines.pop()
    for (const raw of lines) {
      const line = raw.trim()
      if (!line || line === 'ok') continue
      handleDaemonLine(line)
    }
  })

  helperProc.on('exit', () => {
    daemonReady = false
    helperProc  = null
    if (mainWindow) setTimeout(startDaemon, 1000)
  })

  helperProc.stderr?.on('data', () => {})

  startFollowing()
}

function handleDaemonLine(line) {
  if (!mainWindow) return

  // Клавиши из WH_KEYBOARD_LL hook → пересылаем в renderer
  if (line.startsWith('KK') || line.startsWith('KV')) {
    if (chatModeActive) mainWindow.webContents.send('key-input', line)
    return
  }

  // Ответ FOLLOW: "hidden" или "x y w h"
  if (line === 'hidden') {
    if (mainWindow.isVisible()) mainWindow.hide()
    // НЕ сбрасываем savedGameHwnd — игра могла просто свернуться, а не закрыться.
    // Если были в режиме чата — выходим из него, иначе tick будет слать TOP вместо FOLLOW
    // и overlay никогда не появится когда игра откроется снова.
    if (chatModeActive) {
      chatModeActive = false
      sendHelper('HOOKSTOP')
    }
    return
  }

  const parts = line.split(' ').map(Number)
  if (parts.length === 4 && parts.every(n => !isNaN(n))) {
    const [x, y, w, h] = parts
    if (!mainWindow.isVisible()) mainWindow.showInactive()
    mainWindow.setBounds({ x, y, width: w, height: h })
    return
  }

  // Ответ BYPID: одно число (0 = не найден, >0 = HWND)
  const n = parseInt(line)
  if (!isNaN(n)) {
    if (n > 0) {
      savedGameHwnd = n
      lastGameHwnd  = n
    } else {
      savedGameHwnd = null  // процесс игры закрылся
    }
  }
}

// ── Compile + start ───────────────────────────────────────────────────────────
function initWinHelper() {
  const root = process.env.SystemRoot || 'C:\\Windows'
  const csc = [
    path.join(root, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(root, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ].find(p => fs.existsSync(p))
  if (!csc) return

  fs.writeFileSync(helperCs, HELPER_SRC)
  exec(`"${csc}" /nologo /out:"${helperExe}" "${helperCs}"`, (err) => {
    if (!err) startDaemon()
  })
}

const GAME_PROCESS = '3DXChat.exe'

// ── Follow loop ────────────────────────────────────────────────────────────────
function startFollowing() {
  let followTick = 0

  const tick = () => {
    if (!mainWindow || !daemonReady) return

    if (!savedGameHwnd) {
      // Ищем игру каждые ~500ms
      if (followTick % 10 === 0) sendHelper('BYPID ' + GAME_PROCESS)
      followTick++
      return
    }

    // Даже если HWND есть — проверяем что процесс жив каждые ~5s
    if (followTick % 100 === 0) sendHelper('BYPID ' + GAME_PROCESS)
    followTick++

    if (chatModeActive || !ourHwnd) {
      if (ourHwnd) sendHelper('TOP ' + ourHwnd)
      return
    }

    sendHelper('FOLLOW ' + savedGameHwnd + ' ' + ourHwnd)
  }

  tick()
  setInterval(tick, 50)
}

// ── Chat mode ─────────────────────────────────────────────────────────────────
function showGameNoActivate() {
  const hwnd = savedGameHwnd || lastGameHwnd
  if (!hwnd) return
  sendHelper('SHOW ' + hwnd)
  // Re-assert наш topmost после показа игры
  setTimeout(() => {
    if (mainWindow && chatModeActive) mainWindow.setAlwaysOnTop(true, 'screen-saver')
  }, 80)
}

function restoreGameAfterChat() {
  const hwnd = savedGameHwnd || lastGameHwnd
  if (!hwnd) return
  sendHelper('RESTORE ' + hwnd)
}

// ── PNG helpers ───────────────────────────────────────────────────────────────
function crc32(buf) {
  const table = (() => {
    const t = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
      t[i] = c
    }
    return t
  })()
  let crc = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}
function pngChunk(type, data) {
  const tb = Buffer.from(type, 'ascii'), len = Buffer.alloc(4), cv = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0); cv.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0)
  return Buffer.concat([len, tb, data, cv])
}
function makePNG(w, h, r, g, b) {
  const sig = Buffer.from([137,80,78,71,13,10,26,10]), ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w,0); ihdr.writeUInt32BE(h,4); ihdr[8]=8; ihdr[9]=2
  const rowSize = 1 + w * 3, raw = Buffer.alloc(h * rowSize)
  for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
    const px = row*rowSize + 1 + col*3; raw[px]=r; raw[px+1]=g; raw[px+2]=b
  }
  return Buffer.concat([sig, pngChunk('IHDR',ihdr), pngChunk('IDAT',zlib.deflateSync(raw)), pngChunk('IEND',Buffer.alloc(0))])
}

// ── App state ─────────────────────────────────────────────────────────────────
let mainWindow = null
let loginWindow = null
let tray = null
let widgetVisible = { chat: true, fight: true, warriors: false, calc: false }
try {
  const wp = path.join(app.getPath('userData'), 'widgets.json')
  if (fs.existsSync(wp)) widgetVisible = { ...widgetVisible, ...JSON.parse(fs.readFileSync(wp, 'utf8')) }
} catch {}
function saveWidgets() {
  try { fs.writeFileSync(path.join(app.getPath('userData'), 'widgets.json'), JSON.stringify(widgetVisible)) } catch {}
}

// Clear stale Code Cache so overlay.html is never served from cached bytecode
function clearCodeCache() {
  try {
    const cacheDir = path.join(app.getPath('userData'), 'Code Cache')
    if (fs.existsSync(cacheDir)) fs.rmSync(cacheDir, { recursive: true, force: true })
  } catch {}
}

// Saved login data (in-memory, persisted via Electron store via IPC)
let savedLogin = { srv: 'https://nordheimunion.ru', email: '', remember: false, token: '' }
try {
  const p = path.join(app.getPath('userData'), 'login.json')
  if (fs.existsSync(p)) savedLogin = { ...savedLogin, ...JSON.parse(fs.readFileSync(p, 'utf8')) }
} catch {}
function saveLogin(data) {
  try { fs.writeFileSync(path.join(app.getPath('userData'), 'login.json'), JSON.stringify(data)) } catch {}
}

function createLoginWindow() {
  if (loginWindow) { loginWindow.focus(); return }
  loginWindow = new BrowserWindow({
    width: 360, height: 420, resizable: false,
    title: 'FightArena — Вход', skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'login-preload.cjs'),
      contextIsolation: true, nodeIntegration: false,
    },
  })
  loginWindow.setMenu(null)
  loginWindow.loadFile(path.join(__dirname, 'login.html'))
  loginWindow.on('closed', () => { loginWindow = null })
}

function createWindow() {
  const { bounds } = screen.getPrimaryDisplay()
  mainWindow = new BrowserWindow({
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    transparent: true, frame: false, show: false,
    skipTaskbar: true, hasShadow: false, resizable: false, focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false,
    },
  })
  mainWindow.setAlwaysOnTop(true, 'screen-saver')
  mainWindow.setIgnoreMouseEvents(true, { forward: true })
  mainWindow.once('ready-to-show', () => {
    // Don't show overlay yet — wait for login
    try {
      const buf = mainWindow.getNativeWindowHandle()
      ourHwnd = buf.length >= 8 ? Number(buf.readBigUInt64LE()) : buf.readUInt32LE()
      if (ourHwnd && daemonReady) sendHelper('NOACT ' + ourHwnd)
    } catch {}
  })
  mainWindow.loadFile(path.join(__dirname, 'overlay.html'))
  mainWindow.on('closed', () => { mainWindow = null })
}

function loadIcon() {
  const iconPath = path.join(__dirname, 'icon.png')
  if (fs.existsSync(iconPath)) return nativeImage.createFromPath(iconPath).resize({ width: 32, height: 32 })
  try { require('./generate-icon.cjs') } catch {}
  if (fs.existsSync(iconPath)) return nativeImage.createFromPath(iconPath).resize({ width: 32, height: 32 })
  return nativeImage.createFromBuffer(makePNG(32, 32, 255, 140, 0))
}

function rebuildTrayMenu() {
  if (!tray) return
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Показать', click: () => mainWindow?.show() },
    { label: 'Скрыть',   click: () => mainWindow?.hide() },
    { type: 'separator' },
    {
      label: 'Виджеты', submenu: [
        {
          label: 'Чат', type: 'checkbox', checked: widgetVisible.chat,
          click: (item) => { widgetVisible.chat = item.checked; saveWidgets(); mainWindow?.webContents.send('widget-toggle', { widget: 'chat', visible: item.checked }); rebuildTrayMenu() }
        },
        {
          label: 'Жители', type: 'checkbox', checked: widgetVisible.warriors,
          click: (item) => { widgetVisible.warriors = item.checked; saveWidgets(); mainWindow?.webContents.send('widget-toggle', { widget: 'warriors', visible: item.checked }); rebuildTrayMenu() }
        },
        {
          label: 'Бой', type: 'checkbox', checked: widgetVisible.fight,
          click: (item) => { widgetVisible.fight = item.checked; saveWidgets(); mainWindow?.webContents.send('widget-toggle', { widget: 'fight', visible: item.checked }); rebuildTrayMenu() }
        },
        {
          label: 'Калькулятор', type: 'checkbox', checked: widgetVisible.calc,
          click: (item) => { widgetVisible.calc = item.checked; saveWidgets(); mainWindow?.webContents.send('widget-toggle', { widget: 'calc', visible: item.checked }); rebuildTrayMenu() }
        },
      ]
    },
    { type: 'separator' },
    { label: 'Выход',    click: () => app.quit() },
  ]))
}

function createTray() {
  const icon = loadIcon()
  tray = new Tray(icon)
  tray.setToolTip('FightArena Overlay')
  rebuildTrayMenu()
  tray.on('click', () => { if (mainWindow) mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show() })
}

// ── IPC ───────────────────────────────────────────────────────────────────────
ipcMain.on('set-ignore-mouse-events', (_, ignore) => {
  if (mainWindow) mainWindow.setIgnoreMouseEvents(ignore, { forward: true })
  if (ignore && chatModeActive) {
    chatModeActive = false
    sendHelper('HOOKSTOP')
  }
})

// Login window IPC
ipcMain.on('login-get-saved', (e) => { e.returnValue = savedLogin })
function sendWidgetState() {
  if (!mainWindow) return
  for (const [widget, visible] of Object.entries(widgetVisible))
    mainWindow.webContents.send('widget-toggle', { widget, visible })
}

ipcMain.on('login-success', (_, { token, srv, email, remember }) => {
  savedLogin = { srv, email, remember, token: remember ? token : '' }
  saveLogin(savedLogin)
  if (loginWindow) { loginWindow.close(); loginWindow = null }
  if (mainWindow) {
    mainWindow.showInactive()
    mainWindow.webContents.send('auth-token', { token, srv })
    setTimeout(sendWidgetState, 300)
  }
})
ipcMain.on('logout', () => {
  savedLogin.token = ''
  saveLogin(savedLogin)
  if (mainWindow) mainWindow.hide()
  createLoginWindow()
})

// ── Lifecycle ─────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  clearCodeCache()
  createWindow()
  createTray()
  initWinHelper()
  // Auto-login if saved token exists, otherwise show login window
  if (savedLogin.token && savedLogin.remember) {
    fetch(savedLogin.srv + '/api/auth/me', {
      headers: { 'Authorization': 'Bearer ' + savedLogin.token }
    }).then(r => r.ok ? r.json() : Promise.reject())
      .then(() => {
        if (mainWindow) {
          mainWindow.showInactive()
          mainWindow.webContents.once('did-finish-load', () => {
            mainWindow.webContents.send('auth-token', { token: savedLogin.token, srv: savedLogin.srv })
            setTimeout(sendWidgetState, 300)
          })
        }
      })
      .catch(() => { savedLogin.token = ''; saveLogin(savedLogin); createLoginWindow() })
  } else {
    createLoginWindow()
  }

  globalShortcut.register('CommandOrControl+W', () => {
    if (!mainWindow) return
    mainWindow.setAlwaysOnTop(true, 'screen-saver')
    mainWindow.showInactive()
  })
  globalShortcut.register('CommandOrControl+Q', () => {
    if (mainWindow) mainWindow.hide()
  })

  ipcMain.on('enter-chat-mode', () => {
    if (!mainWindow || chatModeActive) return
    chatModeActive = true
    if (ourHwnd) sendHelper('HOOKSTART ' + ourHwnd)
  })

  ipcMain.on('exit-chat-mode', () => {
    if (!mainWindow || !chatModeActive) return
    chatModeActive = false
    sendHelper('HOOKSTOP')
  })
})

app.on('window-all-closed', (e) => e.preventDefault())

app.on('before-quit', () => {
  globalShortcut.unregisterAll()
  tray?.destroy(); tray = null
  if (helperProc && !helperProc.killed) { try { helperProc.kill() } catch {} }
})
