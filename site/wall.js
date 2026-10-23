(() => {
  const ALL = window.CARDS || [];
  const BASE = window.ASSET_BASE || '';
  const API = window.API_BASE || '';
  const srcOf = (s) => (/^(https?:)?\//.test(s) ? s : BASE + s);
  const $ = (id) => document.getElementById(id);
  const wall = $('wall'), empty = $('empty'), q = $('q'), sheet = $('sheet');
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const day = (d) => (d && d.length === 8 ? `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6)}` : '');
  const POLS = ['喜歡', '不要', '規則', '參考', '背景'];
  const MAX_TALL = 1.6;

  // 沒有審核流程：收進來的全部上牆
  const VIEW_DEFS = [
    { key: 'ref', label: '收藏', test: (c) => c.kind === 'ref' },
    { key: 'lesson', label: '學到的規則', test: (c) => c.kind === 'lesson' },
    { key: 'mine', label: '我的判斷', test: (c) => c.kind === 'mine' },
    { key: 'note', label: '筆記', test: (c) => c.kind === 'note' },
  ];
  let VIEWS = VIEW_DEFS.filter((v) => ALL.some(v.test));
  const KIND_ORDER = ['ref', 'lesson', 'mine', 'note'];
  // 收藏最新在前，同一天的再依分數排；沒打分的手挑參考當 8 分
  function sortAll() {
    ALL.forEach((c, i) => { if (c._i === undefined) c._i = i; });
    ALL.sort((a, b) => (KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
      || (a.kind === 'ref' ? String(b.date).localeCompare(String(a.date)) || (b.score ?? 8) - (a.score ?? 8) : 0) || a._i - b._i);
  }
  sortAll();
  let KEY = '';
  try {
    const m = /^#key=(.+)$/.exec(location.hash);
    if (m) { localStorage.setItem('wall-key', m[1]); history.replaceState(null, '', location.pathname); }
    KEY = localStorage.getItem('wall-key') || '';
  } catch (e) { /* 沒有儲存空間就當訪客 */ }

  const state = { view: VIEWS[0] ? VIEWS[0].key : 'ref', tag: '', pol: '', text: '' };
  try {
    const s = JSON.parse(localStorage.getItem('wall-state') || '{}');
    if (VIEWS.some((v) => v.key === s.view)) state.view = s.view;
  } catch (e) { /* 沒有儲存空間也照常顯示 */ }

  const hay = (c) => {
    c._hay = [c.title, c.group_title, c.note, (c.cats || []).join(' '), (c.tags || []).join(' '), c.pol, c.project, c.source, c.tool,
      (c.refs || []).join(' '), (c.points || []).join(' '), c.origin, (c.quotes || []).map((x) => x.text + ' ' + x.note).join(' ')]
      .join(' ').toLowerCase();
  };
  ALL.forEach(hay);

  const BATCH = 60;
  let shown = [], cols = 0, drawn = 0, colEls = [], colHs = [], colW = 0;

  function pool() {
    const v = VIEWS.find((x) => x.key === state.view);
    const words = state.text.toLowerCase().split(/\s+/).filter(Boolean);
    return ALL.filter((c) => (words.length ? words.every((w) => c._hay.includes(w)) : !v || v.test(c)));
  }
  function visible() {
    return pool().filter((c) => {
      if (state.tag && !(c.cats || []).includes(state.tag) && !(c.tags || []).includes(state.tag)) return false;
      if (state.pol && c.pol !== state.pol) return false;
      return true;
    });
  }

  function colCount() {
    return Math.max(2, Math.min(7, Math.floor((wall.clientWidth + 16) / 252)));
  }

  function cardEl(c, i) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.i = i;
    const v = c.pol ? `<span class="v"><span class="dot" data-p="${esc(c.pol)}"></span>${esc(c.pol)}</span>` : '';
    if (c.image) {
      const m = c.image;
      const tall = m.h / m.w > MAX_TALL;
      b.className = 'card' + (tall ? ' crop' : '');
      const pic = c.gif ? srcOf(c.gif) : srcOf(m.src);
      b.innerHTML = `<img loading="lazy" decoding="async" width="${m.w}" height="${tall ? Math.round(m.w * MAX_TALL) : m.h}" src="${esc(pic)}" alt="">`
        + (c.video ? '<span class="play"></span>' : '')
        + `<span class="veil"><span><span class="v">${esc(c.origin || '')}</span>${c.kind === 'mine' || c.kind === 'lesson' ? v : ''}<b>${esc(c.kind === 'ref' ? c.group_title + '　' + c.title : c.title)}</b></span></span>`;
      if (c.video) {
        b._card = c;
        if (vio) vio.observe(b);
        b.addEventListener('mouseenter', () => startVideo(b, true));
      }
    } else {
      b.className = 'card text' + (c.kind === 'note' ? ' note' : '');
      b.innerHTML = v + `<blockquote>${esc(c.kind === 'note' ? c.title : ((c.quotes && c.quotes[0] && c.quotes[0].text) || c.title))}</blockquote>`;
    }
    return b;
  }

  function estimate(c, colW) {
    if (c.image) return colW * Math.min(MAX_TALL, c.image.h / c.image.w);
    const len = c.kind === 'note' ? c.title.length : ((c.quotes && c.quotes[0] && c.quotes[0].text) || '').length;
    const perLine = Math.max(8, Math.floor((colW - 40) / 15.5));
    return Math.min(9, Math.ceil(len / perLine)) * 26 + 70;
  }

  // 影片卡：滑到畫面裡停一下才疊一支靜音 <video> 上去播，離開畫面就拆掉，同時最多 MAX_PLAYING 支
  // 影片直接連 X 的原址不進 repo；省流量、2G、偏好減少動態的人不自動播，只留播放章，滑過去或點開才播
  const MAX_PLAYING = 3;
  const net = navigator.connection || {};
  const quiet = net.saveData || /2g/.test(net.effectiveType || '') || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const playing = new Set(), waiting = new Set();
  function startVideo(b, force) {
    if (b._vid || b.classList.contains('no-video')) return;
    if (!force && playing.size >= MAX_PLAYING) { waiting.add(b); return; }
    waiting.delete(b);
    const vid = document.createElement('video');
    vid.muted = true; vid.loop = true; vid.playsInline = true; vid.preload = 'none';
    vid.addEventListener('playing', () => b.classList.add('is-playing'), { once: true });
    vid.addEventListener('error', () => { stopVideo(b); b.classList.add('no-video'); });   // 原推刪了或連不上就留著圖
    vid.src = srcOf(b._card.video);
    b.appendChild(vid); b._vid = vid; playing.add(b);
    vid.play().catch(() => stopVideo(b));
  }
  function stopVideo(b) {
    clearTimeout(b._t); waiting.delete(b);
    if (!b._vid) return;
    b._vid.pause(); b._vid.removeAttribute('src'); b._vid.load(); b._vid.remove();
    b._vid = null; playing.delete(b); b.classList.remove('is-playing');
    const next = waiting.values().next().value;   // 空出一個位子就讓排隊中、還在畫面裡的下一支播
    if (next) startVideo(next);
  }
  const vio = 'IntersectionObserver' in window ? new IntersectionObserver((es) => es.forEach((e) => {
    const b = e.target;
    clearTimeout(b._t);
    if (e.isIntersecting && !quiet) b._t = setTimeout(() => startVideo(b), 300);   // 快速滑過的不開
    else stopVideo(b);
  }), { threshold: 0.6 }) : null;

  function render() {
    playing.forEach(stopVideo); waiting.clear();
    if (vio) vio.disconnect();
    shown = visible();
    wall.textContent = '';
    empty.hidden = shown.length > 0;
    cols = colCount();
    colW = Math.floor((wall.clientWidth - (cols - 1) * 16) / cols);
    wall.style.setProperty('--colw', colW + 'px');
    colEls = []; colHs = []; drawn = 0;
    for (let i = 0; i < cols; i++) {
      const d = document.createElement('div');
      d.className = 'col';
      wall.appendChild(d); colEls.push(d); colHs.push(0);
    }
    more();
    drawTabs(); drawFilters();
    fill();
  }

  // 無限下滑：一次排一批，底部哨兵進到視窗附近就再排下一批
  function more() {
    const end = Math.min(shown.length, drawn + BATCH);
    for (let i = drawn; i < end; i++) {
      const c = shown[i];
      let k = 0;
      for (let j = 1; j < cols; j++) if (colHs[j] < colHs[k] - 1) k = j;
      colEls[k].appendChild(cardEl(c, i));
      colHs[k] += estimate(c, colW) + 16;
    }
    drawn = end;
    $('more').hidden = drawn >= shown.length;
  }
  // 哨兵離視窗底部不到 1600px 就一直補排；捲動和觀察器都會叫它
  function fill() {
    while (drawn < shown.length && $('more').getBoundingClientRect().top < innerHeight + 1600) more();
  }
  new IntersectionObserver(fill, { rootMargin: '1600px 0px' }).observe($('more'));
  window.addEventListener('scroll', fill, { passive: true });

  function drawTabs() {
    VIEWS = VIEW_DEFS.filter((v) => ALL.some(v.test));
    $('tabs').innerHTML = VIEWS.length > 1
      ? VIEWS.map((v) => `<button type="button" data-v="${v.key}" aria-pressed="${!state.text && state.view === v.key}">${v.label}<i>${ALL.filter(v.test).length}</i></button>`).join('')
      : '';
  }

  function drawFilters() {
    const p = pool();
    const count = {};
    p.forEach((c) => [...(c.cats || []), ...(c.tags || [])].forEach((t) => { count[t] = (count[t] || 0) + 1; }));
    const tags = Object.keys(count).sort((a, b) => count[b] - count[a]).slice(0, 14);
    const pols = POLS.map((x) => [x, p.filter((c) => c.pol === x).length]).filter((x) => x[1]);
    const all = (pols.length > 1 || tags.length > 1) ? `<button type="button" data-all="1" aria-pressed="${!state.tag && !state.pol}">全部</button>` : '';
    $('filters').innerHTML = all + (pols.length > 1 ? pols.map(([x, n]) => `<button type="button" data-p="${x}" aria-pressed="${state.pol === x}"><span class="dot" data-p="${x}"></span>${x} ${n}</button>`).join('') : '')
      + (tags.length > 1 ? tags.map((t) => `<button type="button" data-c="${esc(t)}" aria-pressed="${state.tag === t}">${esc(t)}</button>`).join('') : '');
  }

  const sw = (s) => esc(s).replace(/#[0-9a-fA-F]{6}\b/g, (m) => `<span class="hex"><span class="sw" style="background:${m}"></span>${m}</span>`);

  // ---------- 容器變形（10-06：照 product card 的做法，從點的位置浮出來，內容分段到位） ----------
  // 曲線與時長沿用 product card：0.55s、cubic-bezier(.19,1,.22,1)；內容 0.25s 後 meta、0.32s 後主塊上浮 10px
  const EASE = 'cubic-bezier(.19,1,.22,1)';
  const REDUCE = matchMedia('(prefers-reduced-motion: reduce)');
  const scrim = $('scrim');
  const expo = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
  const onScreen = (el) => { if (!el || !el.isConnected) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth; };
  // FLIP：外層 translate+scale，內層反向 scale 讓文字不變形；兩邊同樣的取樣點、線性插值，乘起來永遠約等於 1
  function flipFrames(from, to, back) {
    const sx0 = from.w / to.w, sy0 = from.h / to.h, dx0 = from.x - to.x, dy0 = from.y - to.y;
    const outer = [], inner = [], N = 48;
    for (let i = 0; i <= N; i++) {
      const p = expo(i / N), g = back ? 1 - p : p;
      const sx = sx0 + (1 - sx0) * g, sy = sy0 + (1 - sy0) * g;
      outer.push({ transform: `translate(${dx0 * (1 - g)}px, ${dy0 * (1 - g)}px) scale(${sx}, ${sy})`, offset: i / N });
      inner.push({ transform: `scale(${1 / sx}, ${1 / sy})`, offset: i / N });
    }
    return { outer, inner };
  }
  // 一組進行中的動畫：隨時可以整組取消或倒放（可中斷）
  const M = { anims: [], ghosts: [], main: null };
  M.run = (el, kf, opts) => { const a = el.animate(kf, opts); M.anims.push(a); a.finished.then(() => { if (!opts.fill) a.cancel(); }).catch(() => {}); return a; };
  M.stop = () => { M.anims.forEach((a) => a.cancel()); M.anims = []; M.ghosts.forEach((x) => x.remove()); M.ghosts = []; M.main = null; };
  M.running = () => !!M.main && M.main.playState === 'running';
  // 卡上的圖飛到細節頁的圖位。比例一樣就等比縮放；直式裁切卡（牆上只露上半）改動 width/height，讓裁切邊真的往下展開而不是把圖壓扁
  function ghostImage(from, to, src, fromRadius, toRadius) {
    const im = document.createElement('img');
    im.className = 'morph-ghost'; im.src = src; im.alt = '';
    const sameAspect = Math.abs(from.w / from.h - to.w / to.h) < 0.02;
    document.body.appendChild(im);
    M.ghosts.push(im);
    if (sameAspect) {
      Object.assign(im.style, { left: `${to.x}px`, top: `${to.y}px`, width: `${to.w}px`, height: `${to.h}px` });
      M.run(im, [{ transform: `translate(${from.x - to.x}px, ${from.y - to.y}px) scale(${from.w / to.w}, ${from.h / to.h})` }, { transform: 'none' }], { duration: 550, easing: EASE, fill: 'both' });
    } else {
      M.run(im, [{ left: `${from.x}px`, top: `${from.y}px`, width: `${from.w}px`, height: `${from.h}px` }, { left: `${to.x}px`, top: `${to.y}px`, width: `${to.w}px`, height: `${to.h}px` }], { duration: 550, easing: EASE, fill: 'both' });
    }
    M.run(im, [{ borderRadius: fromRadius }, { borderRadius: toRadius }], { duration: 550, easing: EASE, fill: 'both' });
  }
  // 內容分段到位：前兩塊淡入（150、250ms），之後每塊 320ms 起上浮 10px，塊與塊差 40ms
  function staged(pieces, reduce) {
    pieces.forEach(([el, delay, rise]) => {
      if (!el) return;
      M.run(el, [{ opacity: 0, transform: rise && !reduce ? 'translateY(10px)' : 'none' }, { opacity: 1, transform: 'none' }],
        { delay: reduce ? 0 : delay, duration: reduce ? 150 : rise ? 500 : 300, easing: reduce ? 'ease-out' : EASE, fill: 'backwards' });
    });
  }
  // 圖在 object-fit: contain 下實際畫出來的框
  function drawnRect(el, w, h) {
    const q = rect(el);
    if (!w || !h) return q;
    const k = Math.min(q.w / w, q.h / h), dw = w * k, dh = h * k;
    return { x: q.x + (q.w - dw) / 2, y: q.y + (q.h - dh) / 2, w: dw, h: dh };
  }
  function openMorph(el, inner, origin, pieces, cover) {
    M.stop();
    const reduce = REDUCE.matches;
    M.run(scrim, [{ opacity: 0 }, { opacity: 1 }], { duration: reduce ? 150 : 200, easing: 'ease-out' });
    const canMorph = !reduce && origin && onScreen(origin);
    if (!canMorph) {
      M.main = M.run(el, [{ opacity: 0, transform: reduce ? 'none' : 'scale(.98)' }, { opacity: 1, transform: 'none' }], { duration: reduce ? 150 : 250, easing: reduce ? 'ease-out' : EASE });
      staged(pieces, reduce);
      return M.main.finished.catch(() => {});
    }
    origin.classList.add('opened');
    // 所有目標框都在動畫開始前量，開始後細節頁已經縮到卡的位置，量到的會是錯的
    const from = rect(origin), to = rect(el);
    const hasGhost = cover && cover.from && cover.to && cover.src;
    const gFrom = hasGhost ? rect(cover.from) : null, gTo = hasGhost ? drawnRect(cover.to, cover.w, cover.h) : null;
    const f = flipFrames(from, to, false);
    M.main = M.run(el, f.outer, { duration: 550, easing: 'linear' });
    M.run(inner, f.inner, { duration: 550, easing: 'linear' });
    M.run(el, [{ boxShadow: '0 0 0 0 rgba(0,0,0,0)' }, { boxShadow: getComputedStyle(el).boxShadow }], { duration: 550, easing: EASE });
    if (hasGhost) {
      cover.to.style.opacity = '0';
      ghostImage(gFrom, gTo, cover.src, getComputedStyle(cover.from).borderRadius, '0px');
    }
    staged(pieces, false);
    return M.main.finished.then(() => {
      M.ghosts.forEach((x) => x.remove()); M.ghosts = [];
      if (hasGhost) cover.to.style.opacity = '';
    }).catch(() => {});
  }
  // 關：原卡還在畫面上就縮回去（同一條曲線，320ms），不在就縮到 96% 淡出；開到一半就直接倒放
  function closeMorph(el, inner, origin, done) {
    const reduce = REDUCE.matches;
    if (M.running()) { M.anims.forEach((a) => { if (a.playState === 'running') a.reverse(); }); M.main.finished.then(done).catch(done); return; }
    M.stop();
    M.run(scrim, [{ opacity: 1 }, { opacity: 0 }], { duration: reduce ? 150 : 200, easing: 'ease-out', fill: 'forwards' });
    if (reduce || !origin || !onScreen(origin) || !origin.classList.contains('opened')) {
      M.main = M.run(el, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: reduce ? 'none' : 'scale(.96)' }], { duration: reduce ? 150 : 320, easing: EASE, fill: 'forwards' });
    } else {
      const f = flipFrames(rect(origin), rect(el), true);
      M.main = M.run(el, f.outer, { duration: 320, easing: 'linear', fill: 'forwards' });
      M.run(inner, f.inner, { duration: 320, easing: 'linear', fill: 'forwards' });
      M.run(inner, [{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'ease-out', fill: 'forwards' });
      M.run(el, [{ boxShadow: getComputedStyle(el).boxShadow }, { boxShadow: '0 0 0 0 rgba(0,0,0,0)' }], { duration: 320, easing: EASE, fill: 'forwards' });
    }
    M.main.finished.then(done).catch(done);
  }

  let at = -1;
  let originCard = null;
  function open(i) {
    while (i >= drawn && drawn < shown.length) more();
    const c = shown[i];
    if (!c) return;
    at = i;
    const pin = $('pin');
    let media = '';
    if (c.video) media = `<video src="${esc(srcOf(c.video_hd || c.video))}" poster="${esc(srcOf(c.image.src))}" controls loop muted playsinline autoplay></video>`;
    else if (c.gif) media = `<img src="${esc(srcOf(c.gif))}" alt="">`;
    else if (c.image) media = `<img src="${esc(srcOf(c.image.src))}" width="${c.image.w}" height="${c.image.h}" alt="">`;
    else media = `<div class="none">${esc(c.kind === 'note' ? c.title : ((c.quotes && c.quotes[0] && c.quotes[0].text) || c.title))}</div>`;

    const initials = (c.source || c.tool || '筆').replace(/^@/, '').slice(0, 1).toUpperCase();
    const who = c.kind === 'ref' ? c.source : [c.tool, c.project].filter(Boolean).join(' · ');
    let side = `<div class="who"><span class="av">${esc(initials)}</span><span>${esc(who)}</span><time>${day(c.date)}</time></div>`
      + (c.origin ? `<div class="origin">來源　${esc(c.origin)}</div>` : '');
    const first = c.kind === 'ref' ? ALL.find((x) => x.group === c.group) : null;
    if (c.kind === 'ref') {
      side += `<h2>${esc(c.group_title)}${c.title !== c.group_title ? '　' + esc(c.title) : ''}</h2><p class="lede">${esc(c.note)}</p>`;
      if (first.points.length) side += `<h3>可以照用的做法</h3><ul>${first.points.map((p) => `<li>${sw(p)}</li>`).join('')}</ul>`;
      if (c.score) side += `<div class="ai">AI 看圖打分 ${c.score} 分${c.palette && c.palette.length ? ' ' + c.palette.map((h) => `<span class="sw" style="background:${esc(h)}"></span>`).join('') : ''}</div>`;
      if (c.dropped_at) side += `<div class="origin">貼進來　${esc(c.dropped_at.replace('T', ' ').slice(0, 16))}</div>`;
      if (c.status === 'pending') side += '<p class="warn">還在抓圖打分，稍後重新整理</p>';
      if (c.status === 'error') side += `<p class="warn">打分失敗：${esc(c.error || '')}</p>`;
      if (c.apiId && KEY) side += `<div class="chips admin">${[['hide', '藏起來']].map(([k, t]) => `<button type="button" data-act="${k}" data-api="${esc(c.apiId)}">${t}</button>`).join('')}</div>`;
      if (c.tags.length) side += `<h3>標籤</h3><div class="chips">${c.tags.map((t) => `<button type="button" data-c="${esc(t)}">${esc(t)}</button>`).join('')}</div>`;
      if (c.replica_url) side += `<a class="go" href="${esc(c.replica_url)}" target="_blank" rel="noopener">看我們的復刻 →</a>`;
      if (c.url) side += `<a class="go" href="${esc(c.url)}" target="_blank" rel="noopener">打開來源</a>`;
      if (c.video_url) side += `<a class="go ghost" href="${esc(c.video_url)}" target="_blank" rel="noopener">看影片</a>`;
    } else if (c.kind === 'lesson') {
      side += `<span class="verdict"><span class="dot" data-p="規則"></span>規則</span><h2>${esc(c.title)}</h2>`;
      if (c.note) side += `<p class="lede">檢查：${esc(c.note)}</p>`;
      c.quotes.forEach((x) => { side += `<p class="hero">「${esc(x.text)}」</p><p class="lede">${esc(x.note)}</p>`; });
      if (c.cats.length) side += `<h3>相關</h3><div class="chips">${c.cats.map((t) => `<button type="button" data-c="${esc(t)}">${esc(t)}</button>`).join('')}</div>`;
      c.links.forEach((l, j) => { side += `<a class="go${j ? ' ghost' : ''}" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`; });
      c.videos.filter((x) => x.url).forEach((x) => { side += `<a class="go ghost" href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.caption || '看影片')}</a>`; });
      side += `<div class="id">原圖　${esc(c.source_dir)}</div>`;
    } else if (c.kind === 'mine') {
      side += `<span class="verdict"><span class="dot" data-p="${esc(c.pol)}"></span>${esc(c.pol)}</span>`;
      c.quotes.forEach((x) => { side += `<p class="hero">「${esc(x.text)}」</p><p class="lede">${esc(x.note)}</p>`; });
      const chips = (c.cats || []).map((t) => `<button type="button" data-c="${esc(t)}">${esc(t)}</button>`)
        .concat((c.refs || []).filter((r) => !/^https?:/.test(r)).map((r) => `<button type="button" data-s="${esc(r)}">${esc(r)}</button>`));
      if (chips.length) side += `<h3>相關</h3><div class="chips">${chips.join('')}</div>`;
      (c.refs || []).filter((r) => /^https?:/.test(r)).forEach((r) => { side += `<a class="go ghost" href="${esc(r)}" target="_blank" rel="noopener">${esc(r.replace(/^https?:\/\/(www\.)?/, '').slice(0, 30))}</a>`; });
      if (c.drafted) side += '<p class="warn">這段文字是 agent 起草、牆主送出執行的，不是口述原句</p>';
      side += `<div class="id">${esc(c.id)}</div>`;
    } else {
      side += `<span class="verdict"><span class="dot" data-p="${esc(c.pol)}"></span>${esc(c.pol)}</span><h2>${esc(c.title)}</h2>`;
      if (c.note) side += `<p class="lede">${esc(c.note)}</p>`;
      side += `<h3>相關</h3><div class="chips">${(c.cats || []).map((t) => `<button type="button" data-c="${esc(t)}">${esc(t)}</button>`).join('')}</div>`;
      side += '<p class="warn">這是 agent 寫的筆記，不是牆主的逐字原話</p>';
      side += `<div class="id">${esc(c.source)}</div>`;
    }

    let below = '';
    if (c.kind === 'lesson') {
      below += c.pairs.map((p) => `<section class="pair"><h4>${esc(p.caption)}</h4><div class="ba">${[['改前', p.before], ['改後', p.after]].map(([t, m]) => `<figure><img loading="lazy" width="${m.w}" height="${m.h}" src="${esc(BASE + m.src)}" alt="${esc(p.caption + ' ' + t)}"><figcaption>${t}</figcaption></figure>`).join('')}</div></section>`).join('');
      below += c.videos.filter((x) => x.src).map((x) => `<section class="pair"><h4>${esc(x.caption)}</h4><video src="${esc(BASE + x.src)}" controls loop muted playsinline></video></section>`).join('');
    }
    const kin = c.kind === 'lesson' ? [] : c.kind === 'ref'
      ? ALL.filter((x) => x.group === c.group && x !== c)
      : ALL.filter((x) => x !== c && x.kind === 'mine' && x.image && (x.cats || [])[0] === (c.cats || [])[0]).slice(0, 6);
    if (c.kind === 'mine' && c.more && c.more.length) below += `<h3>同一則訊息的其他截圖</h3><div class="kin">${c.more.map((m) => `<button type="button" data-src="${esc(BASE + m.src)}"><img loading="lazy" src="${esc(BASE + m.src)}" alt=""></button>`).join('')}</div>`;
    if (kin.length) below += `<h3>${c.kind === 'ref' ? '同一來源' : '同樣在講' + esc((c.cats || [])[0])}</h3><div class="kin">${kin.map((x) => `<button type="button" data-id="${esc(x.id)}" title="${esc(x.title)}"><img loading="lazy" src="${esc(srcOf(x.image.src))}" alt=""></button>`).join('')}</div>`;
    if (first && first.strips.length) below += first.strips.map((s) => `<section class="strip"><h4>${esc(s.title)}</h4><div class="frames">${s.frames.map((f) => `<figure><img loading="lazy" width="${f.w}" height="${f.h}" src="${esc(BASE + f.src)}" alt=""><figcaption>${esc(f.t)}</figcaption></figure>`).join('')}</div></section>`).join('');

    const wasOpen = !sheet.hidden;
    pin.innerHTML = `<div class="pin-in"><div class="spread"><div class="media">${media}</div><div class="side">${side}</div></div>` + (below ? `<div class="below">${below}</div>` : '') + '</div>';
    sheet.hidden = false;
    scrim.hidden = false;
    document.body.style.overflow = 'hidden';
    sheet.scrollTop = 0;
    history.replaceState(null, '', '#' + encodeURIComponent(c.id));
    $('prev').disabled = i === 0; $('next').disabled = i === shown.length - 1;
    sheet.focus({ preventScroll: true });
    const inner = pin.firstElementChild;
    if (wasOpen) {
      // 左右換卡、同來源跳卡：不再從卡飛一次（方向鍵會連按），內容交叉淡入就好
      M.stop();
      if (originCard) originCard.classList.remove('opened');
      originCard = wall.querySelector(`.card[data-i="${i}"]`);
      if (originCard && !REDUCE.matches) originCard.classList.add('opened');
      M.run(inner, [{ opacity: 0 }, { opacity: 1 }], { duration: REDUCE.matches ? 150 : 180, easing: 'ease-out' });
      return;
    }
    originCard = wall.querySelector(`.card[data-i="${i}"]`);
    const sideEls = [...inner.querySelectorAll('.side > *')], belowEls = [...inner.querySelectorAll('.below > *')];
    const mediaEl = inner.querySelector('.media');
    const useGhost = !!(originCard && c.image && !c.video && !c.gif && originCard.querySelector('img'));
    const pieces = [[useGhost ? null : mediaEl, 150, false], [sideEls[0], 150, false], [sideEls[1], 250, false],
      ...sideEls.slice(2).concat(belowEls).map((x, j) => [x, 320 + Math.min(j, 8) * 40, true])];
    openMorph(pin, inner, originCard, pieces, useGhost ? { from: originCard.querySelector('img'), to: mediaEl.querySelector('img'), src: srcOf(c.image.src), w: c.image.w, h: c.image.h } : null);
  }
  function shut(opts = {}) {
    if (sheet.hidden) return;
    const origin = originCard;
    originCard = null;
    const done = () => {
      M.stop();
      sheet.hidden = true;
      scrim.hidden = true;
      $('pin').textContent = '';
      document.body.style.overflow = '';
      if (origin) origin.classList.remove('opened');
      if (origin && origin.isConnected) origin.focus({ preventScroll: true });
    };
    history.replaceState(null, '', location.pathname + location.search);
    at = -1;
    if (opts.instant) { done(); return; }
    closeMorph($('pin'), $('pin').firstElementChild, origin, done);
  }
  function jump(id) {
    const c = ALL.find((x) => x.id === id);
    if (!c) return;
    if (!shown.includes(c)) { const v = VIEWS.find((x) => x.test(c)); state.view = v ? v.key : state.view; state.tag = ''; state.pol = ''; state.text = ''; q.value = ''; render(); }
    open(shown.indexOf(c));
  }

  function save() { try { localStorage.setItem('wall-state', JSON.stringify({ view: state.view })); } catch (e) { /* 忽略 */ } }

  wall.addEventListener('click', (e) => { const b = e.target.closest('.card'); if (b) open(+b.dataset.i); });
  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.view = b.dataset.v; state.tag = ''; state.pol = ''; state.text = ''; q.value = '';
    save(); render(); window.scrollTo(0, 0);
  });
  $('filters').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.all) { state.tag = ''; state.pol = ''; }
    if (b.dataset.c) state.tag = state.tag === b.dataset.c ? '' : b.dataset.c;
    if (b.dataset.p) state.pol = state.pol === b.dataset.p ? '' : b.dataset.p;
    render();
  });
  $('pin').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.act) { act(b.dataset.api, b.dataset.act); return; }
    if (b.dataset.id) { jump(b.dataset.id); return; }
    if (b.dataset.src) { $('pin').querySelector('.media').innerHTML = `<img src="${esc(b.dataset.src)}" alt="">`; sheet.scrollTop = 0; return; }
    if (b.dataset.c) { state.tag = b.dataset.c; state.pol = ''; state.text = ''; q.value = ''; }
    if (b.dataset.s) { state.text = b.dataset.s; q.value = b.dataset.s; state.tag = ''; state.pol = ''; }
    shut({ instant: true }); render(); window.scrollTo(0, 0);
  });
  sheet.addEventListener('click', (e) => { if (e.target === sheet) shut(); });
  scrim.addEventListener('click', () => shut());
  let t;
  q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { state.text = q.value.trim(); render(); }, 120); });
  $('close').addEventListener('click', shut);
  $('prev').addEventListener('click', () => open(Math.max(0, at - 1)));
  $('next').addEventListener('click', () => open(Math.min(shown.length - 1, at + 1)));
  document.addEventListener('keydown', (e) => {
    if (!sheet.hidden) {
      if (e.key === 'Escape') shut();
      if (e.key === 'ArrowRight' && at < shown.length - 1) open(at + 1);
      if (e.key === 'ArrowLeft' && at > 0) open(at - 1);
      return;
    }
    if (e.key === '/' && document.activeElement !== q) { e.preventDefault(); q.focus(); }
    if (e.key === 'Escape' && document.activeElement === q) { q.value = ''; state.text = ''; q.blur(); render(); }
  });
  let rt;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (colCount() !== cols) render(); }, 150); });

  // 外掛收進來的圖在 Cloudflare 資料庫，載入後併進牆裡；沒藏起來的全部顯示，打分只拿來排序
  function fromApi(r) {
    let host = '';
    try { host = new URL(r.page_url).hostname.replace(/^www\./, ''); } catch (e) { /* 沒網址 */ }
    const t = r.page_title || host || '收藏';
    return {
      id: 'in-' + r.id, apiId: r.id, kind: 'ref', group: 'in-' + r.id, title: t, group_title: t, note: r.reason || '',
      tags: [r.kind, ...(r.tags || [])].filter(Boolean), date: (r.dropped_at || r.created_at || '').slice(0, 10).replace(/-/g, ''),
      source: host, origin: r.source === 'drop' || r.source === 'iphone' ? '手機貼進來' : '外掛收藏', url: r.page_url || '', video: '', gif: '', video_url: '', points: [], teardown: '', strips: [],
      image: r.image_key ? { src: API + '/media/' + r.image_key, w: r.w || 800, h: r.h || 600 } : null, score: r.score, palette: r.palette || [],
      quotes: r.image_key ? undefined : [{ text: [t, host !== t ? host : '', r.text].filter(Boolean).join('\n') }],
      verdict: 'wall', status: r.status, error: r.error, dropped_at: r.dropped_at || '', replica_url: r.replica_url || '',
    };
  }
  async function loadApi() {
    try {
      const res = await fetch(API + '/api/items', { headers: KEY ? { Authorization: 'Bearer ' + KEY } : {} });
      if (!res.ok) return;
      const rows = (await res.json()).filter((r) => !r.hidden);
      for (let i = ALL.length - 1; i >= 0; i--) if (ALL[i].apiId) ALL.splice(i, 1);
      rows.map(fromApi).forEach((c) => { hay(c); ALL.push(c); });
      sortAll(); render();
    } catch (e) { /* 本機離線或 API 沒回應，照常顯示靜態卡片 */ }
  }
  async function act(id, what) {
    const body = what === 'hide' ? { hidden: true } : { verdict: what };
    await fetch(API + '/api/items/' + id, { method: 'POST', headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    shut({ instant: true }); loadApi();
  }

  render();
  loadApi();
  const want = decodeURIComponent(location.hash.slice(1));
  if (want) jump(want);
})();
