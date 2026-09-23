#!/usr/bin/env python3
"""Screenshot the map in headless Chrome via the DevTools protocol (standard library only).

Usage: python3 tools/screenshot.py URL OUT.png [JS] [--wait SECONDS] [--chrome PATH]
Waits until the page's loading overlay is hidden, runs the optional JavaScript (awaited if it
returns a promise), waits, then captures the page at 1440 × 900.
"""
import base64, json, os, socket, subprocess, sys, time, urllib.request

DEFAULT_CHROME = os.path.expanduser('~/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome')


class WS:
    """Minimal WebSocket client (text frames) for the DevTools protocol."""

    def __init__(self, url):
        host, rest = url[len('ws://'):].split('/', 1)
        h, p = host.split(':')
        self.s = socket.create_connection((h, int(p)))
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall((f'GET /{rest} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                        f'Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n').encode())
        buf = b''
        while b'\r\n\r\n' not in buf:
            buf += self.s.recv(4096)
        self.rest = buf.split(b'\r\n\r\n', 1)[1]
        self.n = 0

    def _recv(self, k):
        while len(self.rest) < k:
            self.rest += self.s.recv(1 << 20)
        out, self.rest = self.rest[:k], self.rest[k:]
        return out

    def send(self, obj):
        data = json.dumps(obj).encode()
        n = len(data)
        if n < 126:
            head = bytes([0x81, 0x80 | n])
        elif n < 65536:
            head = bytes([0x81, 0x80 | 126]) + n.to_bytes(2, 'big')
        else:
            head = bytes([0x81, 0x80 | 127]) + n.to_bytes(8, 'big')
        mask = os.urandom(4)
        self.s.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def frame(self):
        _, b1 = self._recv(2)
        n = b1 & 0x7f
        if n == 126:
            n = int.from_bytes(self._recv(2), 'big')
        elif n == 127:
            n = int.from_bytes(self._recv(8), 'big')
        return self._recv(n)

    def call(self, method, **params):
        self.n += 1
        self.send({'id': self.n, 'method': method, 'params': params})
        while True:
            msg = json.loads(self.frame())
            if msg.get('id') == self.n:
                return msg.get('result', {})


def main():
    argv = sys.argv[1:]
    opts = {}
    for flag in ('--wait', '--chrome'):
        if flag in argv:
            i = argv.index(flag)
            opts[flag] = argv[i + 1]
            del argv[i:i + 2]
    url, out = argv[0], argv[1]
    js = argv[2] if len(argv) > 2 else ''
    wait = float(opts.get('--wait', 3))
    port = 9333
    proc = subprocess.Popen([opts.get('--chrome', DEFAULT_CHROME), '--headless=new', '--no-sandbox', '--use-angle=swiftshader',
                             '--enable-unsafe-swiftshader', '--hide-scrollbars', f'--remote-debugging-port={port}',
                             '--window-size=1440,900', 'about:blank'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        page = None
        for _ in range(100):
            try:
                tabs = json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/json'))
                page = next(t for t in tabs if t['type'] == 'page')
                break
            except Exception:
                time.sleep(.2)
        ws = WS(page['webSocketDebuggerUrl'])
        ws.call('Emulation.setDeviceMetricsOverride', width=1440, height=900, deviceScaleFactor=1, mobile=False)
        ws.call('Page.navigate', url=url)
        loaded = False
        for _ in range(600):                                   # up to 5 minutes
            r = ws.call('Runtime.evaluate', expression="(() => { const l = document.getElementById('loading'); return !!l && l.hidden; })()",
                        returnByValue=True)
            if r.get('result', {}).get('value'):
                loaded = True
                break
            time.sleep(.5)
        if not loaded:
            print('page did not finish loading', file=sys.stderr)
        if js:
            r = ws.call('Runtime.evaluate', expression=js, awaitPromise=True, returnByValue=True)
            if 'exceptionDetails' in r:
                print('JS error:', r['exceptionDetails'].get('exception', {}).get('description'), file=sys.stderr)
        time.sleep(wait)
        shot = ws.call('Page.captureScreenshot', format='png')
        with open(out, 'wb') as f:
            f.write(base64.b64decode(shot['data']))
        print('saved', out)
    finally:
        proc.terminate()


if __name__ == '__main__':
    main()
