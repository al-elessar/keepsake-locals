import http.server, json, urllib.parse, base64
def b64(o): return base64.urlsafe_b64encode(json.dumps(o).encode()).decode().rstrip('=')
TOKEN = b64({"typ":"JWT"}) + '.' + b64({"aud":"video","exp":1809764380}) + '.c2ln'
PAGES, PER = 5, 20
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
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path.startswith('/_server/'):
            n = int(urllib.parse.parse_qs(u.query)['page'][0]); body = page(n).encode(); ct = 'text/javascript'
        elif u.path.endswith('.m3u8'):
            body = b'#EXTM3U\n'; ct = 'application/vnd.apple.mpegurl'
        else:
            body = HTML.encode(); ct = 'text/html'
        self.send_response(200); self.send_header('Content-Type', ct); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
http.server.ThreadingHTTPServer(('127.0.0.1', 8765), H).serve_forever()
