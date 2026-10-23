#!/usr/bin/env python3
"""Build the wall from data/cards.json.

  python3 scripts/build.py          write site/cards.js, then open site/ with any static server
  python3 scripts/build.py --dist   write a self contained dist/ for GitHub Pages or any static host
  python3 scripts/build.py --check  validate cards.json and that every image exists, exit 1 otherwise

The wall is a static page. The worker, the extension and the X likes pipeline are optional
and only needed if you want new cards to flow in by themselves.
"""
import hashlib, json, re, shutil, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CARDS = ROOT / 'data' / 'cards.json'
REQUIRED = ('id', 'title', 'author', 'url', 'date', 'image')


def load():
    if not CARDS.exists():
        sys.exit(f'FAIL: {CARDS} not found. Next: add cards to data/cards.json (see README, "Add your own cards")')
    cards = json.loads(CARDS.read_text())
    bad = []
    for c in cards:
        missing = [k for k in REQUIRED if k not in c]
        if missing:
            bad.append(f"{c.get('id', '?')}: missing {missing}")
        elif not (ROOT / c['image']['src']).exists():
            bad.append(f"{c['id']}: image {c['image']['src']} not found")
    if bad:
        sys.exit('FAIL: cards.json has problems:\n  ' + '\n  '.join(bad[:20]) + '\nNext: fix the rows above or remove them')
    return cards


def to_wall(c):
    return {
        'id': c['id'], 'kind': 'ref', 'group': c['id'], 'title': c['title'], 'group_title': c.get('author', ''),
        'note': c.get('note', ''), 'tags': c.get('tags', []), 'date': c.get('date', ''), 'source': c.get('author', ''),
        'origin': 'X like', 'url': c.get('url', ''), 'video': c.get('video', ''), 'video_hd': c.get('video_hd', ''), 'gif': '', 'video_url': c.get('url', '') if c.get('video') else '',
        'image': c['image'], 'points': [], 'teardown': '', 'strips': [], 'public': True,
        'score': c.get('score'), 'verdict': 'wall', 'palette': c.get('palette', []),
    }


def cards_js(cards, asset_base):
    return 'window.CARDS=' + json.dumps([to_wall(c) for c in cards], ensure_ascii=False) + f';window.ASSET_BASE="{asset_base}";window.API_BASE="";\n'


def main():
    cards = load()
    if '--check' in sys.argv:
        print(f'ok: {len(cards)} cards, all images present'); return
    if '--dist' in sys.argv:
        out = ROOT / 'dist'
        if out.exists():
            shutil.rmtree(out)
        out.mkdir()
        for f in ('wall.css', 'wall.js', 'favicon.svg', 'manifest.webmanifest', 'icon-180.png', 'icon-512.png'):
            shutil.copy(ROOT / 'site' / f, out / f)
        for c in cards:
            src = ROOT / c['image']['src']
            (out / src.relative_to(ROOT).parent).mkdir(parents=True, exist_ok=True)
            shutil.copy(src, out / src.relative_to(ROOT))
        (out / 'cards.js').write_text(cards_js(cards, ''))
        html = (ROOT / 'site' / 'index.html').read_text()
        # the X wall and the drop page need the worker, so the static build drops their links
        html = re.sub(r'\s*<a class="drop-link[^>]*>.*?</a>', '', html, flags=re.S)
        for f in ('wall.css', 'wall.js', 'cards.js'):
            html = html.replace(f'"{f}"', f'"{f}?v={hashlib.md5((out / f).read_bytes()).hexdigest()[:8]}"')
        (out / 'index.html').write_text(html)
        print(f'dist: {len(cards)} cards -> {out}')
        return
    (ROOT / 'site' / 'cards.js').write_text(cards_js(cards, '../'))
    print(f'site/cards.js: {len(cards)} cards. Serve the repo root, e.g. python3 -m http.server 8941, then open http://localhost:8941/site/')


if __name__ == '__main__':
    main()
