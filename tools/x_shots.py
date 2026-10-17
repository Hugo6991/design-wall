#!/usr/bin/env python3
"""沒有圖片影片的推文：用 X 官方嵌入版截一張推文卡（發文人、文字、日期、讚數），下面接一列留言、轉發、讚、views
（數字來自 fxtwitter），上傳到設計牆收件端當這則的媒體。跑在 Mac mini 的 launchd（ai.designwall.x-shots，每 30 分鐘；10-05：不要靠筆電開著）。要 playwright 與 chromium、Pillow。

  python3 x_shots.py            跑到沒有待截的為止
  python3 x_shots.py --limit 20 只跑 20 則
  python3 x_shots.py --dry-run  只列出，不截不傳
  python3 x_shots.py --shard 1/3 三個一起跑時各拿三分之一

"""
import base64, io, json, os, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# 密鑰：repo 裡的 .env.ingest-token，或 mini 上的 ~/.design-wall/ingest-token
_TOK = next((p for p in (os.path.join(ROOT, '.env.ingest-token'), os.path.expanduser('~/.design-wall/ingest-token')) if os.path.exists(p)), None)
if not _TOK:
    sys.exit('WARN 找不到收件密鑰：要有 repo 的 .env.ingest-token 或 ~/.design-wall/ingest-token')
TOKEN = open(_TOK).read().strip()
API = 'https://design-wall.YOUR-SUBDOMAIN.workers.dev'
H = {'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/json', 'User-Agent': 'x-shots'}
FONT = next((f for f in ('/System/Library/Fonts/PingFang.ttc', '/System/Library/Fonts/Helvetica.ttc') if os.path.exists(f)), None)


def api(path, body=None):
    req = urllib.request.Request(API + path, data=json.dumps(body).encode() if body else None, method='POST' if body else 'GET', headers=H)
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def counts(tid):
    try:
        req = urllib.request.Request(f'https://api.fxtwitter.com/status/{tid}', headers={'User-Agent': 'x-shots'})
        with urllib.request.urlopen(req, timeout=20) as r:
            t = json.load(r).get('tweet') or {}
        return {'likes': t.get('likes', 0), 'replies': t.get('replies', 0), 'reposts': t.get('retweets', 0), 'views': t.get('views', 0)}
    except Exception:
        return {}


def fmt(n):
    n = n or 0
    return f'{n / 1e6:.1f}M' if n >= 1e6 else f'{n / 1e3:.1f}K' if n >= 1e3 else str(n)


def stat_bar(png, c):
    # 截圖下面接一列數字；嵌入版本身沒有 views，所以要自己畫
    im = Image.open(io.BytesIO(png)).convert('RGB')
    w = im.width
    bar = Image.new('RGB', (w, 84), (255, 255, 255))
    d = ImageDraw.Draw(bar)
    d.line([(0, 0), (w, 0)], fill=(230, 230, 230), width=2)
    font = ImageFont.truetype(FONT, 26) if FONT else ImageFont.load_default()
    small = ImageFont.truetype(FONT, 18) if FONT else ImageFont.load_default()
    x = 36
    for label, key in (('replies', 'replies'), ('reposts', 'reposts'), ('likes', 'likes'), ('views', 'views')):   # 英文標籤，PIL 用系統字型畫中文會變方框
        v = fmt(c.get(key))
        d.text((x, 16), v, fill=(20, 20, 20), font=font)
        tw = d.textlength(v, font=font)
        d.text((x + tw + 8, 24), label, fill=(120, 120, 120), font=small)
        x += tw + d.textlength(label, font=small) + 56
    out = Image.new('RGB', (w, im.height + bar.height), (255, 255, 255))
    out.paste(im, (0, 0)); out.paste(bar, (0, im.height))
    b = io.BytesIO(); out.save(b, 'PNG', optimize=True)
    return b.getvalue(), out.width, out.height


def shoot(pg, tid):
    # 要等 networkidle 再多等一秒：只等 article 出現就截，會截到排到一半的版面（10-05 晚發現一批壞圖）
    pg.goto(f'https://platform.twitter.com/embed/Tweet.html?dnt=true&id={tid}&theme=light&lang=en&width=550', wait_until='networkidle', timeout=40000)
    try:
        pg.wait_for_selector('article', timeout=8000)
    except Exception:
        return None
    pg.wait_for_timeout(1200)
    el = pg.query_selector('article')
    box = el.bounding_box() if el else None
    if not box or box['width'] < 400 or box['height'] < 120:
        return None   # 版面沒展開，當失敗，下次再截
    if not el:
        return None
    return el.screenshot(type='png')


def main():
    limit = int(sys.argv[sys.argv.index('--limit') + 1]) if '--limit' in sys.argv else 10 ** 6
    shard = sys.argv[sys.argv.index('--shard') + 1] if '--shard' in sys.argv else '0/1'   # 例：--shard 1/3
    dry = '--dry-run' in sys.argv
    from playwright.sync_api import sync_playwright
    done = failed = 0
    t0 = time.time()
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={'width': 620, 'height': 1200}, device_scale_factor=2)
        pg = ctx.new_page()
        while done + failed < limit:
            si, sn = shard.split('/')
            batch = api(f'/api/x/needshot?limit=25&shard={si}&shards={sn}')
            rows = batch['rows'][:limit - done - failed]
            if not rows:
                break
            if dry:
                print(f'待截 {batch["remaining"]} 則，例如 {[r["id"] for r in rows[:5]]}'); return 0
            with ThreadPoolExecutor(8) as ex:
                cs = list(ex.map(lambda r: counts(r['id']), rows))
            for r, c in zip(rows, cs):
                try:
                    png = shoot(pg, r['id'])
                    if not png:
                        api('/api/x/shot', {'id': r['id'], 'failed': True}); failed += 1; print('x', r['id'], '嵌入版沒有 article（可能已刪或受保護）'); continue
                    data, w, h = stat_bar(png, c)
                    api('/api/x/shot', {'id': r['id'], 'image': 'data:image/png;base64,' + base64.b64encode(data).decode(), 'w': w, 'h': h, **c})
                    done += 1
                    if done % 25 == 0:
                        print(f'{done} 則，{time.time() - t0:.0f} 秒，還剩約 {batch["remaining"] - 25}')
                except Exception as e:
                    failed += 1; print('x', r['id'], str(e)[:120])
        b.close()
    msg = f'OK 截了 {done} 則，失敗 {failed} 則，{time.time() - t0:.0f} 秒'
    print(msg)
    try:
        api('/api/x/shot', {'heartbeat': True, 'host': os.uname().nodename, 'note': msg})   # 讓 /api/x/status 看得到上次跑的時間
    except Exception as e:
        print('WARN 心跳沒送到：', e, file=sys.stderr)
    if failed and not done:
        print('WARN 全部失敗：最可能是 playwright 的 chromium 沒裝或 X 嵌入版擋了；先手動跑 --limit 1 看錯誤', file=sys.stderr); return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
