"""End-to-end test: loads the extension in Chromium against a mock Locals page that
loads posts as you scroll. Start mock_locals_server.py first, then run this file
(use xvfb-run on a headless Linux machine)."""
import json, os, time, sys
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.normpath(os.path.join(HERE, '..', '..', 'extension'))
CHROME = os.environ.get('CHROME', '/usr/bin/google-chrome')  # Chromium or Chrome for Testing (branded Chrome ignores --load-extension)
with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(os.path.join(HERE, '.profile'), executable_path=CHROME, headless=False,
        args=[f'--disable-extensions-except={EXT}', f'--load-extension={EXT}', '--no-sandbox',
              '--host-resolver-rules=MAP example.beta.locals.com 127.0.0.1:8765'])
    page = ctx.new_page()
    page.goto('http://example.beta.locals.com/feed?mode=content')
    page.wait_for_timeout(1500)
    # find extension id via chrome://extensions internals
    ext_page = ctx.new_page(); ext_page.goto('chrome://extensions')
    ext_id = ext_page.evaluate("""async () => { const m = await chrome.management.getAll(); return m.find(e => e.name.startsWith('Keepsake')).id; }""")
    pop = ext_page; pop.goto(f'chrome-extension://{ext_id}/popup/popup.html')
    tab_id = pop.evaluate("""async () => (await chrome.tabs.query({url: 'http://example.beta.locals.com/*'}))[0].id""")
    page.bring_to_front()
    page.evaluate('playOne()')
    pop.evaluate(f"chrome.tabs.sendMessage({tab_id}, {{type: 'lvs-autoscroll'}})")
    for i in range(60):
        time.sleep(2)
        st = pop.evaluate("async () => (await chrome.storage.local.get('scroll:example'))['scroll:example']")
        if st and st['status'] in ('done', 'stopped'): break
    data = pop.evaluate("async () => (await chrome.storage.local.get('community:example'))['community:example']")
    print('scroll status:', st)
    vids = [data['videos'][i] for i in data['order']]
    print('videos:', len(data['order']), 'titled:', sum(1 for v in vids if v['title']), 'dated:', sum(1 for v in vids if v.get('date')))
    print('first:', vids[0], 'last:', vids[-1])
    bad = [ (i, v) for i, v in enumerate(vids[:100]) if v['title'] != 'Example video %03d' % (i + 1) ]
    print('mismatched titles:', len(bad), bad[:3])
    print('token captured:', bool(data.get('token')))
    print('sources:', sorted(set(v.get('src') for v in vids)))
    pop.reload(); pop.wait_for_timeout(800)
    pop.set_viewport_size({'width': 420, 'height': 1100})
    pop.screenshot(path=os.path.join(HERE, 'popup.png'), full_page=True)
    ctx.close()
    ok = len(data['order']) == 100 and not bad and data.get('token') and all(v.get('src') == 'content' for v in vids)
    print('E2E PASSED' if ok else 'E2E FAILED')
    sys.exit(0 if ok else 1)
