/**
 * tools/cdp.mjs — tiny Chrome DevTools Protocol driver used to verify the game
 * in a real browser. Node 22 ships fetch + WebSocket, so there are no deps.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  process.env.HOME +
    '/Library/Caches/ms-playwright/chromium-1200/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
];

export function findChrome() {
  for (const p of CHROME_CANDIDATES) if (p && fs.existsSync(p)) return p;
  throw new Error('No Chrome binary found');
}

export async function launch({ port = 9333, width = 1440, height = 900, headless = true } = {}) {
  const bin = findChrome();
  // Metal gives real-GPU headless rendering on macOS (~120fps vs ~3fps with
  // swiftshader). Set POOL_GL=swiftshader to force software rendering.
  const gl =
    process.env.POOL_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--use-angle=swiftshader']
      : ['--use-angle=metal'];
  const args = [
    headless ? '--headless=new' : '--new-window',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    ...gl,
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--disable-features=Translate',
    `--remote-debugging-port=${port}`,
    `--window-size=${width},${height}`,
    '--user-data-dir=' + fs.mkdtempSync('/tmp/dsh-chrome-'),
    'about:blank',
  ];
  const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderr.on('data', () => {});
  proc.stdout.on('data', () => {});

  const base = `http://127.0.0.1:${port}`;
  let version = null;
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${base}/json/version`);
      if (r.ok) {
        version = await r.json();
        break;
      }
    } catch {}
    await sleep(150);
  }
  if (!version) {
    proc.kill('SIGKILL');
    throw new Error('Chrome did not expose the debugging port');
  }
  return { proc, base, version };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export class Session {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.console = [];
    this.errors = [];
    this.failures = [];

    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
        }
        return;
      }
      const { method, params } = msg;
      if (method === 'Runtime.consoleAPICalled') {
        const text = (params.args || [])
          .map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type))
          .join(' ');
        this.console.push({ type: params.type, text });
        if (params.type === 'error') this.errors.push(text);
      } else if (method === 'Runtime.exceptionThrown') {
        const d = params.exceptionDetails;
        this.errors.push(
          (d.exception && (d.exception.description || d.exception.value)) || d.text,
        );
      } else if (method === 'Log.entryAdded') {
        const e = params.entry;
        this.console.push({ type: e.level, text: e.text });
        if (e.level === 'error') this.errors.push(e.text);
      } else if (method === 'Network.loadingFailed') {
        this.failures.push(`${params.errorText} ${params.type}`);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout: ${method}`));
        }
      }, 60000);
    });
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error(
        'evaluate failed: ' +
          (r.exceptionDetails.exception?.description || r.exceptionDetails.text),
      );
    }
    return r.result.value;
  }

  async goto(url) {
    await this.send('Page.navigate', { url });
    for (let i = 0; i < 200; i++) {
      const ready = await this.evaluate('document.readyState');
      if (ready === 'complete') break;
      await sleep(100);
    }
  }

  async waitFor(expression, timeout = 30000, label = expression) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try {
        if (await this.evaluate(`!!(${expression})`)) return true;
      } catch {}
      await sleep(150);
    }
    throw new Error(`waitFor timed out: ${label}`);
  }

  async screenshot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }

  async mouse(type, x, y, button = 'left', clickCount = 1) {
    await this.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button,
      buttons: type === 'mouseMoved' ? 0 : button === 'left' ? 1 : 0,
      clickCount,
    });
  }

  /** Press, drag through the given points, release. */
  async drag(points, { stepDelay = 40 } = {}) {
    const [first, ...rest] = points;
    await this.mouse('mouseMoved', first.x, first.y, 'none');
    await sleep(60);
    await this.mouse('mousePressed', first.x, first.y, 'left');
    await sleep(stepDelay);
    for (const p of rest) {
      await this.mouse('mouseMoved', p.x, p.y, 'left');
      await sleep(stepDelay);
    }
    const last = points[points.length - 1];
    await this.mouse('mouseReleased', last.x, last.y, 'left');
  }

  async key(code, type = 'keyDown') {
    const map = {
      Space: { key: ' ', windowsVirtualKeyCode: 32, text: ' ' },
      KeyC: { key: 'c', windowsVirtualKeyCode: 67, text: 'c' },
      KeyR: { key: 'r', windowsVirtualKeyCode: 82, text: 'r' },
      KeyM: { key: 'm', windowsVirtualKeyCode: 77, text: 'm' },
    };
    const k = map[code] || { key: code };
    await this.send('Input.dispatchKeyEvent', {
      type,
      code,
      key: k.key,
      windowsVirtualKeyCode: k.windowsVirtualKeyCode,
      nativeVirtualKeyCode: k.windowsVirtualKeyCode,
      ...(type === 'keyDown' ? { text: k.text } : {}),
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

export async function connect(base) {
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`${base}/json/list`);
    const targets = await r.json();
    const page = targets.find((t) => t.type === 'page');
    if (page?.webSocketDebuggerUrl) {
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((res, rej) => {
        ws.addEventListener('open', res, { once: true });
        ws.addEventListener('error', rej, { once: true });
      });
      const s = new Session(ws);
      await s.send('Runtime.enable');
      await s.send('Page.enable');
      await s.send('Log.enable');
      await s.send('Network.enable');
      await s.send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      return s;
    }
    await sleep(150);
  }
  throw new Error('no page target');
}
