"""Mock Locals community for the end-to-end tests (extension and desktop app).

Serves http://dap2k.beta.locals.com/feed?mode=content (map that host to 127.0.0.1:8765):
5 pages of 20 posts that load as you scroll, from /_server/ responses shaped like the
real site's. Also serves a small real HLS stream for every video ID, which requires the
right vt token and Referer (like Locals), so yt-dlp can really download it.
The page has a strict Content-Security-Policy (no eval), like many real sites.
Video 100 always answers 403, to test the "token expired" handling.
"""
import base64, http.server, json, os, shutil, subprocess, tempfile, urllib.parse

def b64(o): return base64.urlsafe_b64encode(json.dumps(o).encode()).decode().rstrip('=')
TOKEN = b64({"typ":"JWT"}) + '.' + b64({"aud":"video","exp":1809764380}) + '.c2ln'
PAGES, PER = 5, 20
FORBIDDEN = 'v_%08x-1111-4222-8333-%012x' % (99, 99)

def page(n):
    recs = []
    for i in range(PER):
        k = n * PER + i
        vid = 'v_%08x-1111-4222-8333-%012x' % (k, k)
        day = 28 - (k % 28)
        # seroval-like, unquoted keys, title BEFORE nested media, date after
        recs.append('{id:%d,title:"Mock video %03d",media:{video:"%s",duration:%d},createdAt:"2026-10-%02dT12:00:00Z"}' % (900000 + k, k + 1, vid, 600 + k, day))
    return '$R[0]=[' + ','.join(recs) + ']'

HTML = '''<!doctype html><html><head><title>Locals mock</title>
<style>body{margin:0;font:14px sans-serif} #s{height:100vh;overflow-y:auto} .c{height:220px;border-bottom:1px solid #ccc;padding:8px}</style></head>
<body><div id="s"><div id="list"></div><div id="sentinel">loading…</div></div>
<script>
let next = 0, busy = false;
async function more() {
  if (busy || next >= %d) return; busy = true;
  const r = await fetch('/_server/?page=' + next); const t = await r.text();
  const n = (t.match(/title:"([^"]+)"/g) || []).length;
  for (let i = 0; i < n; i++) { const d = document.createElement('div'); d.className = 'c'; d.textContent = 'card ' + (next * %d + i + 1); document.getElementById('list').appendChild(d); }
  next++; busy = false;
  if (next >= %d) document.getElementById('sentinel').textContent = 'end';
}
const io = new IntersectionObserver((e) => { if (e[0].isIntersecting) more(); }, { root: document.getElementById('s') });
io.observe(document.getElementById('sentinel'));
window.playOne = () => { const x = new XMLHttpRequest(); x.open('GET', '/api/v1/posts/content/hls/v_00000000-1111-4222-8333-000000000000/source.m3u8?vt=%s'); x.send(); };
</script></body></html>''' % (PAGES, PER, PAGES, TOKEN)

# A two-second test video, cut into two HLS pieces (made once, with ffmpeg, if it is installed).
HLS_DIR = None
if shutil.which('ffmpeg'):
    HLS_DIR = tempfile.mkdtemp(prefix='keepsake-mock-hls-')
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=2',
                    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
                    '-c:a', 'aac', '-shortest', '-hls_time', '1', '-hls_list_size', '0', '-hls_segment_filename',
                    os.path.join(HLS_DIR, 'seg%d.ts'), os.path.join(HLS_DIR, '720.m3u8')], check=True)

MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=320x180\n720.m3u8\n'

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def reply(self, code, body, ct, extra=None):
        self.send_response(code)
        self.send_header('Content-Type', ct)
        self.send_header('Content-Length', str(len(body)))
        for k, v in (extra or {}).items(): self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        if u.path.startswith('/_server/'):
            return self.reply(200, page(int(q['page'][0])).encode(), 'text/javascript')
        if '/hls/' in u.path:
            name = u.path.rsplit('/', 1)[-1]
            if name == 'source.m3u8':
                ref = self.headers.get('Referer', '')
                ok_ref = ref.startswith('http://dap2k.beta.locals.com/')
                if q.get('vt', [''])[0] != TOKEN or not ok_ref or FORBIDDEN in u.path:
                    return self.reply(403, b'Forbidden', 'text/plain')
                return self.reply(200, MASTER.encode(), 'application/vnd.apple.mpegurl')
            if HLS_DIR and os.path.isfile(os.path.join(HLS_DIR, name)):
                ct = 'application/vnd.apple.mpegurl' if name.endswith('.m3u8') else 'video/mp2t'
                with open(os.path.join(HLS_DIR, name), 'rb') as f:
                    return self.reply(200, f.read(), ct)
            return self.reply(404, b'Not found', 'text/plain')
        return self.reply(200, HTML.encode(), 'text/html',
                          {'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'"})

http.server.ThreadingHTTPServer(('127.0.0.1', 8765), H).serve_forever()
