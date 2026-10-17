import { PRIVATE } from './private-terms.js';
// 設計牆的收件端：外掛把圖送進來，存 R2、記 D1，背景用 Workers AI 看圖打分
// 其餘路徑交給靜態圖牆（dist-public）
import { SYSTEM } from './prompt.js';

const KINDS = ['UI', '網站', '動效', '影片', '3D', '生成視覺', '圖表', '品牌', '字體', '插畫', '攝影', '其他'];
const SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: KINDS },
    score: { type: 'integer' },
    reason: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    palette: { type: 'array', items: { type: 'string' } },
    taste_match: { type: 'string' },
  },
  required: ['kind', 'score', 'reason', 'tags', 'palette', 'taste_match'],
};
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } });
const authed = (req, env) => !!env.INGEST_TOKEN && req.headers.get('Authorization') === `Bearer ${env.INGEST_TOKEN}`;

function toBytes(dataUrl) {
  const m = /^data:(image\/[a-z+]+);base64,(.+)$/.exec(dataUrl || '');
  if (!m) return null;
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { type: m[1], bytes };
}

async function runModel(env, model, dataUrl, meta) {
    const info = [meta.page_title && `頁面標題：${meta.page_title}`, meta.page_url && `網址：${meta.page_url}`, meta.text && `附帶文字：${meta.text.slice(0, 600)}`].filter(Boolean).join('\n') || '沒有附文字';
    const r = await env.AI.run(model, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl } }, { type: 'text', text: info + '\n\n只回 JSON' }] },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'verdict', schema: SCHEMA } },
      temperature: 0.2,
      max_tokens: 4000,
    });
    let out = r.response ?? r.choices?.[0]?.message?.content ?? r;
    if (typeof out === 'string') {
      const t = out.replace(/^```(json)?|```$/g, '').trim();
      try { out = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)); } catch (e) { throw new Error('模型回的不是 JSON：' + JSON.stringify(r).slice(0, 300)); }
    }
    return out;
}

async function analyze(env, id, dataUrl, meta) {
  const model = env.INTAKE_MODEL || '@cf/zai-org/glm-5.3-flash';
  try {
    // 模型偶爾回空或回壞 JSON；碰到每分鐘上限就等一下。最多試三次再記失敗
    let out, last;
    for (let i = 0; i < 3 && !out; i++) {
      try { out = await runModel(env, model, dataUrl, meta); } catch (e) {
        last = e;
        if (/rate/i.test(String(e))) await new Promise((r) => setTimeout(r, 5000 * (i + 1)));   // waitUntil 只有 30 秒，等太久會被砍，剩下的交給 reap
      }
    }
    if (!out) throw last;
    const score = Math.max(1, Math.min(10, parseInt(out.score, 10) || 1));
    // 2026-10-05 起沒有審核流程：全部上牆，分數只拿來排序；要藏用 hidden
    const verdict = 'wall';
    await env.DB.prepare('UPDATE items SET status=?, kind=?, score=?, verdict=?, reason=?, tags=?, palette=?, taste_match=?, model=?, error=NULL WHERE id=?')
      .bind('done', KINDS.includes(out.kind) ? out.kind : '其他', score, verdict, String(out.reason || ''), JSON.stringify(out.tags || []), JSON.stringify(out.palette || []), String(out.taste_match || ''), model, id).run();
  } catch (e) {
    // 失敗要看得到：狀態記 error，牆上的待審分頁會列出來
    await env.DB.prepare('UPDATE items SET status=?, error=?, model=? WHERE id=?').bind('error', String(e).slice(0, 500), model, id).run();
  }
}

async function ingest(req, env, ctx) {
  if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);
  const b = await req.json().catch(() => null);
  const img = toBytes(b && b.image);
  if (!img) return json({ error: 'image 要是 data:image/...;base64 格式' }, 400);
  if (img.bytes.length > 8e6) return json({ error: '圖太大，上限 8MB' }, 413);
  const id = crypto.randomUUID();
  const key = `in/${id}.${img.type.split('/')[1].replace('jpeg', 'jpg')}`;
  await env.MEDIA.put(key, img.bytes, { httpMetadata: { contentType: img.type } });
  const meta = { source: String(b.source || 'api').slice(0, 40), page_url: String(b.page_url || '').slice(0, 2000), page_title: String(b.page_title || '').slice(0, 300), text: String(b.text || '').slice(0, 2000) };
  await env.DB.prepare('INSERT INTO items (id, created_at, source, page_url, page_title, text, image_key, w, h) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(id, new Date().toISOString(), meta.source, meta.page_url, meta.page_title, meta.text, key, b.w | 0, b.h | 0).run();
  ctx.waitUntil(analyze(env, id, b.image, meta));
  return json({ ok: true, id });
}


// ---------- 貼連結就上牆（手機看到什麼貼給它，先記下幾點幾分貼的，再自己抓圖分析上牆） ----------
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
function cleanUrl(u) {
  try {
    const x = new URL(u);
    if (/(^|\.)(x|twitter)\.com$/.test(x.hostname)) x.search = '';
    if (x.hostname === 'youtu.be') return `https://www.youtube.com/watch?v=${x.pathname.slice(1).split('/')[0]}`;
    if (/(^|\.)youtube\.com$/.test(x.hostname) && x.searchParams.get('v')) return `https://www.youtube.com/watch?v=${x.searchParams.get('v')}`;
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'igshid', 'ref_src', 'ref_url'].forEach((k) => x.searchParams.delete(k));
    return x.toString();
  } catch (e) { return u; }
}
// 只讀檔頭拿寬高，Worker 裡不解碼整張圖
function imageSize(b) {
  const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b[0] === 0x89 && b[1] === 0x50) return { w: d.getUint32(16), h: d.getUint32(20) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i < b.length - 9) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { h: d.getUint16(i + 5), w: d.getUint16(i + 7) };
      i += 2 + d.getUint16(i + 2);
    }
  }
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) {
    const t = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (t === 'VP8X') return { w: 1 + (b[24] | b[25] << 8 | b[26] << 16), h: 1 + (b[27] | b[28] << 8 | b[29] << 16) };
    if (t === 'VP8 ') return { w: d.getUint16(26, true) & 0x3fff, h: d.getUint16(28, true) & 0x3fff };
    if (t === 'VP8L') { const x = d.getUint32(21, true); return { w: 1 + (x & 0x3fff), h: 1 + ((x >> 14) & 0x3fff) }; }
  }
  return { w: 0, h: 0 };
}
// 依來源找一張代表圖：X 走 fxtwitter 公開 API，YouTube 用封面，其餘讀 og:image
async function findImage(url) {
  const x = new URL(url);
  const host = x.hostname.replace(/^www\./, '').replace(/^mobile\./, '');
  if (/^(x|twitter)\.com$/.test(host)) {
    const m = /^\/([^/]+)\/status\/(\d+)/.exec(x.pathname);
    if (m) {
      const r = await fetch(`https://api.fxtwitter.com/${m[1]}/status/${m[2]}`, { headers: { 'User-Agent': UA } });
      if (!r.ok) throw new Error(`fxtwitter ${r.status}`);
      const t = (await r.json()).tweet || {};
      const media = ((t.media && t.media.all) || [])[0];
      const img = media && (media.type === 'photo' ? media.url : media.thumbnail_url);
      return { image: img || '', title: `@${m[1]}`, text: t.text || '', method: media ? (media.type === 'photo' ? 'fxtwitter-photo' : 'fxtwitter-video-thumb') : 'fxtwitter-no-media' };
    }
  }
  if (/^(youtube\.com|youtu\.be)$/.test(host)) {
    const id = host === 'youtu.be' ? x.pathname.slice(1) : x.searchParams.get('v') || (/\/(shorts|embed)\/([^/?]+)/.exec(x.pathname) || [])[2];
    if (id) {
      let title = '';
      try { const o = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, { headers: { 'User-Agent': UA } }); if (o.ok) { const j = await o.json(); title = [j.title, j.author_name].filter(Boolean).join(' · '); } } catch (e) { /* 沒標題也能上牆 */ }
      return { image: `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`, fallback: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, title, text: '', method: 'youtube-thumb' };
    }
  }
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' }, redirect: 'follow' });
  if (!r.ok) throw new Error(`頁面回 ${r.status}`);
  const html = (await r.text()).slice(0, 400000);
  const meta = (names) => { for (const n of names) { const m = new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]+content=["']([^"']+)["']`, 'i').exec(html) || new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${n}["']`, 'i').exec(html); if (m) return m[1]; } return ''; };
  const title = meta(['og:title', 'twitter:title']) || ((/<title[^>]*>([^<]*)<\/title>/i.exec(html) || [])[1] || '').trim();
  let img = meta(['og:image', 'og:image:url', 'twitter:image', 'twitter:image:src']);
  if (img) img = new URL(img.replace(/&amp;/g, '&'), r.url).toString();
  return { image: img, title, text: meta(['og:description', 'description']), method: img ? 'og-image' : 'no-og-image' };
}
async function resolveDrop(env, id, url, note) {
  try {
    const found = await findImage(url);
    const title = (found.title || '').slice(0, 300);
    if (!found.image) {
      await env.DB.prepare("UPDATE items SET status='done', kind='其他', verdict='wall', page_title=?, reason=?, tags='[]', palette='[]', model='none' WHERE id=?")
        .bind(title, `只存了連結，抓不到代表圖（${found.method}）。下次例行整理時用 MacBook 截圖補上`, id).run();
      return;
    }
    let ir = await fetch(found.image, { headers: { 'User-Agent': UA, Referer: url } });
    if (!ir.ok && found.fallback) ir = await fetch(found.fallback, { headers: { 'User-Agent': UA } });
    if (!ir.ok) throw new Error(`圖片回 ${ir.status}`);
    const type = (ir.headers.get('Content-Type') || 'image/jpeg').split(';')[0];
    const bytes = new Uint8Array(await ir.arrayBuffer());
    if (bytes.length > 8e6) throw new Error('圖太大，上限 8MB');
    const { w, h } = imageSize(bytes);
    const key = `in/${id}.${(type.split('/')[1] || 'jpg').replace('jpeg', 'jpg')}`;
    await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: type } });
    await env.DB.prepare('UPDATE items SET image_key=?, w=?, h=?, page_title=?, text=? WHERE id=?').bind(key, w, h, title, [note, found.text].filter(Boolean).join('\n').slice(0, 2000), id).run();
    let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    await analyze(env, id, `data:${type};base64,${btoa(s)}`, { page_url: url, page_title: title, text: [note, found.text].filter(Boolean).join('\n') });
  } catch (e) {
    await env.DB.prepare("UPDATE items SET status='error', error=? WHERE id=?").bind(String(e).slice(0, 500), id).run();
  }
}
// 背景工作被 Workers 的 30 秒上限砍掉時，狀態會停在 pending；每次有人來看或貼，順手把超過 2 分鐘的撿起來重跑一筆
async function reap(env) {
  const cutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const row = await env.DB.prepare("SELECT * FROM items WHERE status='pending' AND created_at < ? ORDER BY created_at ASC LIMIT 1").bind(cutoff).first();
  if (!row) return;
  if (row.image_key) {
    const obj = await env.MEDIA.get(row.image_key);
    if (!obj) { await env.DB.prepare("UPDATE items SET status='error', error='R2 裡沒有這張圖，重貼一次' WHERE id=?").bind(row.id).run(); return; }
    const buf = new Uint8Array(await obj.arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    await analyze(env, row.id, `data:${obj.httpMetadata.contentType};base64,${btoa(s)}`, row);
  } else if (row.page_url) {
    await resolveDrop(env, row.id, row.page_url, row.text || '');
  } else {
    await env.DB.prepare("UPDATE items SET status='error', error='沒圖也沒網址' WHERE id=?").bind(row.id).run();
  }
}
async function drop(req, env, ctx) {
  if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);
  const b = await req.json().catch(() => null);
  const raw = String((b && b.url) || '').trim();
  const m = /https?:\/\/[^\s<>"']+/.exec(raw);
  if (!m) return json({ error: '要有一個 http 開頭的網址' }, 400);
  const url = cleanUrl(m[0]);
  const note = String((b && b.text) || '').slice(0, 1000);
  const dropped = String((b && b.dropped_at) || '').slice(0, 40) || new Date().toISOString();
  const dup = await env.DB.prepare('SELECT id, status FROM items WHERE page_url=? AND hidden=0 ORDER BY created_at DESC LIMIT 1').bind(url).first();
  if (dup) return json({ ok: true, id: dup.id, duplicate: true, status: dup.status });
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO items (id, created_at, source, page_url, page_title, text, image_key, w, h, dropped_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(id, new Date().toISOString(), String((b && b.source) || 'drop').slice(0, 40), url, '', note, '', 0, 0, dropped).run();
  ctx.waitUntil(resolveDrop(env, id, url, note).then(() => reap(env)));
  return json({ ok: true, id, url, dropped_at: dropped });
}


// ---------- X wall：所有按讚的推文先全收（文字、作者、圖、影片），再用規則決定要不要進設計牆 ----------
const X_MAX_VIDEO = 25e6;
const X_WALL_RULE = (score, kind) => score >= 6 && kind !== '其他';   // 進設計牆的規則：看圖打分 6 以上且判得出類型
function parseTweetRef(s) {
  const m = /(?:x|twitter)\.com\/([^/]+)\/status\/(\d+)/.exec(s || '') || /^(\d{8,})$/.exec(String(s || '').trim());
  return m ? { id: m[2] || m[1], handle: m[2] ? m[1] : '' } : null;
}
async function xLike(req, env, ctx) {
  if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);
  const b = await req.json().catch(() => null);
  const rows = Array.isArray(b && b.tweets) ? b.tweets.slice(0, 500) : [];
  if (!rows.length) return json({ error: 'tweets 要是陣列' }, 400);
  let inserted = 0;
  const now = new Date().toISOString();
  const stmts = [];
  for (const r of rows) {
    const ref = parseTweetRef(r.url || r.id);
    if (!ref) continue;
    stmts.push(env.DB.prepare('INSERT OR IGNORE INTO tweets (id, url, liked_at, tweet_at, author, handle, text, media, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .bind(ref.id, `https://x.com/${ref.handle || 'i'}/status/${ref.id}`, String(r.liked_at || now).slice(0, 40), String(r.tweet_at || '').slice(0, 40), String(r.author || '').slice(0, 120), String(r.handle || ref.handle || '').slice(0, 60), String(r.text || '').slice(0, 4000), '[]', 'pending', now));
  }
  for (let i = 0; i < stmts.length; i += 50) {
    const res = await env.DB.batch(stmts.slice(i, i + 50));
    inserted += res.reduce((n, r) => n + (r.meta.changes || 0), 0);
  }
  ctx.waitUntil(xProcess(env, 4, 20000).catch(() => {}));
  return json({ ok: true, received: rows.length, inserted });
}
// 抓一則：fxtwitter 拿文字與媒體，圖與影片縮圖存 R2，影片 25MB 以下也存；有圖就看圖打分，過規則就進設計牆
async function xFetchOne(env, row) {
  try {
    const r = await fetch(`https://api.fxtwitter.com/status/${row.id}`, { headers: { 'User-Agent': UA } });
    if (r.status === 404) { await env.DB.prepare("UPDATE tweets SET status='gone', error='推文已刪除或不公開', fetched_at=? WHERE id=?").bind(new Date().toISOString(), row.id).run(); return; }
    if (!r.ok) throw new Error(`fxtwitter ${r.status}`);
    const t = (await r.json()).tweet || {};
    const media = [];
    const all = ((t.media && t.media.all) || []).slice(0, 4);
    for (let i = 0; i < all.length; i++) {
      const m = all[i];
      const entry = { type: m.type, w: m.width || 0, h: m.height || 0, src: m.url || '', thumb_src: m.thumbnail_url || '' };
      const imgUrl = m.type === 'photo' ? m.url : m.thumbnail_url;
      if (imgUrl) {
        const ir = await fetch(imgUrl, { headers: { 'User-Agent': UA } });
        if (ir.ok) {
          const type = (ir.headers.get('Content-Type') || 'image/jpeg').split(';')[0];
          const bytes = new Uint8Array(await ir.arrayBuffer());
          if (bytes.length <= 8e6) {
            const key = `x/${row.id}-${i}.${(type.split('/')[1] || 'jpg').replace('jpeg', 'jpg')}`;
            await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: type } });
            entry.key = key; entry.ctype = type; entry.bytes = bytes;
            if (!entry.w) { const d = imageSize(bytes); entry.w = d.w; entry.h = d.h; }
          }
        }
      }
      if ((m.type === 'video' || m.type === 'gif') && m.url) {
        const vr = await fetch(m.url, { headers: { 'User-Agent': UA } });
        const len = parseInt(vr.headers.get('Content-Length') || '0', 10);
        if (vr.ok && len && len <= X_MAX_VIDEO) {
          const vkey = `x/${row.id}-${i}.mp4`;
          await env.MEDIA.put(vkey, vr.body, { httpMetadata: { contentType: 'video/mp4' } });
          entry.video_key = vkey;
        } else if (vr.body) { try { await vr.body.cancel(); } catch (e) { /* 不存 */ } }
        entry.duration = m.duration || 0;
      }
      media.push(entry);
    }
    const author = (t.author && t.author.name) || row.author || '';
    const handle = (t.author && t.author.screen_name) || row.handle || '';
    const text = t.text || row.text || '';
    const tweetAt = t.created_at ? new Date(t.created_at).toISOString() : row.tweet_at || '';
    const counts = [t.likes | 0, t.replies | 0, t.retweets | 0, t.views | 0];
    // 看圖打分：第一張有存到的圖
    let score = null, kind = null, reason = '', itemId = null;
    const first = media.find((m) => m.bytes);
    if (first) {
      try {
        let s = ''; for (let i = 0; i < first.bytes.length; i += 0x8000) s += String.fromCharCode(...first.bytes.subarray(i, i + 0x8000));
        const out = await runModel(env, env.INTAKE_MODEL || '@cf/zai-org/glm-5.3-flash', `data:${first.ctype};base64,${btoa(s)}`, { page_url: row.url, page_title: `@${handle}`, text });
        score = Math.max(1, Math.min(10, parseInt(out.score, 10) || 1)); kind = KINDS.includes(out.kind) ? out.kind : '其他'; reason = String(out.reason || '');
        if (X_WALL_RULE(score, kind)) {
          const url = `https://x.com/${handle}/status/${row.id}`;
          const dup = await env.DB.prepare('SELECT id FROM items WHERE page_url=? ORDER BY created_at LIMIT 1').bind(url).first();
          if (dup) itemId = dup.id;
          else {
            itemId = crypto.randomUUID();
            await env.DB.prepare('INSERT INTO items (id, created_at, source, page_url, page_title, text, image_key, w, h, status, kind, score, verdict, reason, tags, palette, taste_match, model, dropped_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
              .bind(itemId, new Date().toISOString(), 'x-like', url, `@${handle} 的推文`, text.slice(0, 2000), first.key, first.w, first.h, 'done', kind, score, 'wall', reason, JSON.stringify(out.tags || []), JSON.stringify(out.palette || []), String(out.taste_match || ''), env.INTAKE_MODEL || '', row.liked_at).run();
          }
        }
      } catch (e) { reason = '打分失敗：' + String(e).slice(0, 200); }
    }
    const slim = media.map(({ bytes, ctype, ...rest }) => rest);
    await env.DB.prepare("UPDATE tweets SET status='done', url=?, author=?, handle=?, text=?, tweet_at=?, media=?, score=?, kind=?, reason=?, item_id=?, fetched_at=?, error=NULL, likes=?, replies=?, reposts=?, views=? WHERE id=?")
      .bind(`https://x.com/${handle || 'i'}/status/${row.id}`, author, handle, text, tweetAt, JSON.stringify(slim), score, kind, reason, itemId, new Date().toISOString(), ...counts, row.id).run();
  } catch (e) {
    await env.DB.prepare("UPDATE tweets SET status='error', error=?, fetched_at=? WHERE id=?").bind(String(e).slice(0, 300), new Date().toISOString(), row.id).run();
  }
}
// 一次處理幾則 pending，時間到就停；排程每兩分鐘叫一次，MacBook 推進來時也會順手叫
async function xProcess(env, n = 8, budgetMs = 50000) {
  const t0 = Date.now();
  const { results } = await env.DB.prepare("SELECT * FROM tweets WHERE status='pending' ORDER BY liked_at DESC LIMIT ?").bind(n).all();
  let done = 0;
  // 四則一起抓（都是等網路），一批 12 則約 20 秒
  for (let i = 0; i < results.length; i += 8) {
    if (Date.now() - t0 > budgetMs) break;
    const chunk = results.slice(i, i + 8);
    await env.DB.batch(chunk.map((row) => env.DB.prepare("UPDATE tweets SET status='fetching' WHERE id=?").bind(row.id)));
    await Promise.all(chunk.map((row) => xFetchOne(env, row)));
    done += chunk.length;
  }
  // 卡在 fetching 超過 5 分鐘的（被砍掉）放回 pending
  await env.DB.prepare("UPDATE tweets SET status='pending' WHERE status='fetching' AND fetched_at IS NULL AND created_at < ?").bind(new Date(Date.now() - 5 * 60000).toISOString()).run();
  return done;
}
// 直接讀 IFTTT 寫的 Google Sheet（「知道連結就能讀」，表的 id 就是門禁，放在 wrangler 的 var）：新列就排進佇列，按讚時間用第一次看到的時間
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
async function xPullSheet(env) {
  const sid = env.X_LIKES_SHEET_ID;
  if (!sid) { await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('sheet', ?)").bind(JSON.stringify({ at: new Date().toISOString(), error: '沒設 X_LIKES_SHEET_ID' })).run(); return; }
  try {
    const r = await fetch(`https://docs.google.com/spreadsheets/d/${sid}/export?format=csv`, { headers: { 'User-Agent': UA }, redirect: 'follow' });
    if (!r.ok) throw new Error(`sheet 回 ${r.status}`);
    const rows = parseCsv(await r.text()).filter((c) => c.length >= 4);
    const now = new Date().toISOString();
    const stmts = [];
    for (const c of rows) {
      const ref = parseTweetRef(c[3]);
      if (!ref) continue;
      let tweetAt = ''; const d = new Date(String(c[0]).replace(' at ', ' ')); if (!isNaN(d)) tweetAt = d.toISOString();
      stmts.push(env.DB.prepare('INSERT OR IGNORE INTO tweets (id, url, liked_at, tweet_at, author, handle, text, media, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .bind(ref.id, `https://x.com/${ref.handle || 'i'}/status/${ref.id}`, now, tweetAt, '', (c[1] || '').trim().replace(/^@/, '') || ref.handle, String(c[2] || '').slice(0, 4000), '[]', 'pending', now));
    }
    let inserted = 0;
    for (let i = 0; i < stmts.length; i += 50) { const res = await env.DB.batch(stmts.slice(i, i + 50)); inserted += res.reduce((n, x) => n + (x.meta.changes || 0), 0); }
    const warn = rows.length >= 1800 ? `這張表已 ${rows.length} 列，IFTTT 寫到 2000 會另開新表，到時要換 X_LIKES_SHEET_ID` : '';
    await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('sheet', ?)").bind(JSON.stringify({ at: now, rows: rows.length, inserted, warn })).run();
  } catch (e) {
    await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('sheet', ?)").bind(JSON.stringify({ at: new Date().toISOString(), error: String(e).slice(0, 300) })).run();
  }
}
// 補打分：抓完但沒分數（模型逾時、額度用完）的，從 R2 把第一張圖拿回來再打一次，過規則就進設計牆
async function xRescore(env, n = 8, budgetMs = 25000) {
  const t0 = Date.now();
  const { results } = await env.DB.prepare("SELECT * FROM tweets WHERE status='done' AND score IS NULL AND media LIKE '%\"key\"%' ORDER BY liked_at DESC LIMIT ?").bind(n).all();
  let done = 0, failed = 0;
  const one = async (row) => {
    try {
      const media = JSON.parse(row.media || '[]'); const first = media.find((m) => m.key);
      const obj = first && await env.MEDIA.get(first.key);
      if (!obj) throw new Error('R2 沒有這張圖');
      const bytes = new Uint8Array(await obj.arrayBuffer());
      let b64 = ''; for (let i = 0; i < bytes.length; i += 0x8000) b64 += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const out = await runModel(env, env.INTAKE_MODEL || '@cf/zai-org/glm-5.3-flash', `data:${obj.httpMetadata.contentType || 'image/jpeg'};base64,${btoa(b64)}`, { page_url: row.url, page_title: `@${row.handle}`, text: row.text });
      const score = Math.max(1, Math.min(10, parseInt(out.score, 10) || 1)); const kind = KINDS.includes(out.kind) ? out.kind : '其他'; const reason = String(out.reason || '');
      let itemId = row.item_id;
      if (!itemId && X_WALL_RULE(score, kind)) {
        const dup = await env.DB.prepare('SELECT id FROM items WHERE page_url=? ORDER BY created_at LIMIT 1').bind(row.url).first();
        if (dup) itemId = dup.id;
        else {
          itemId = crypto.randomUUID();
          await env.DB.prepare('INSERT INTO items (id, created_at, source, page_url, page_title, text, image_key, w, h, status, kind, score, verdict, reason, tags, palette, taste_match, model, dropped_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
            .bind(itemId, new Date().toISOString(), 'x-like', row.url, `@${row.handle} 的推文`, (row.text || '').slice(0, 2000), first.key, first.w || 0, first.h || 0, 'done', kind, score, 'wall', reason, JSON.stringify(out.tags || []), JSON.stringify(out.palette || []), String(out.taste_match || ''), env.INTAKE_MODEL || '', row.liked_at).run();
        }
      }
      await env.DB.prepare('UPDATE tweets SET score=?, kind=?, reason=?, item_id=? WHERE id=?').bind(score, kind, reason, itemId, row.id).run(); done++;
    } catch (e) {
      failed++;
      await env.DB.prepare('UPDATE tweets SET reason=? WHERE id=?').bind('打分失敗：' + String(e).slice(0, 200), row.id).run();
    }
  };
  for (let i = 0; i < results.length; i += 4) {
    if (Date.now() - t0 > budgetMs) break;
    await Promise.all(results.slice(i, i + 4).map(one));
  }
  return { done, failed, remaining: results.length - done - failed };
}
function shapeTweet(r) {
  const media = JSON.parse(r.media || '[]').map((m) => ({ type: m.type, w: m.w, h: m.h, img: m.key ? `/media/${m.key}` : (m.type === 'photo' ? m.src : m.thumb_src), video: m.video_key ? `/media/${m.video_key}` : (m.type !== 'photo' ? m.src : ''), duration: m.duration || 0 }));
  // 沒圖沒影片的推文：用推文本身的截圖當媒體（MacBook 的 x_shots.py 截的）
  if (!media.length && r.shot_key) media.push({ type: 'shot', w: r.shot_w || 0, h: r.shot_h || 0, img: `/media/${r.shot_key}`, video: '' });
  const { media: _m, shot_key, shot_w, shot_h, ...rest } = r;
  return { ...rest, media, on_wall: !!r.item_id, has_shot: !!r.shot_key };
}
// 截圖的工作清單與上傳
async function xNeedShot(req, env) {
  if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);
  const u = new URL(req.url);
  const limit = Math.min(100, parseInt(u.searchParams.get('limit') || '20', 10) || 20);
  const shards = Math.max(1, parseInt(u.searchParams.get('shards') || '1', 10) || 1), shard = parseInt(u.searchParams.get('shard') || '0', 10) || 0;
  // 幾台一起截時用 id 尾數分片，彼此不撞
  const { results } = await env.DB.prepare("SELECT id, url, handle, likes, replies, reposts, views FROM tweets WHERE status='done' AND hidden=0 AND media='[]' AND shot_key IS NULL AND (CAST(substr(id, -2) AS INTEGER) % ?) = ? ORDER BY liked_at DESC LIMIT ?").bind(shards, shard, limit).all();
  const c = await env.DB.prepare("SELECT COUNT(*) n FROM tweets WHERE status='done' AND hidden=0 AND media='[]' AND shot_key IS NULL").first();
  return json({ rows: results, remaining: c ? c.n : 0 });
}
async function xShot(req, env) {
  if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);
  const b = await req.json().catch(() => null);
  if (b && b.heartbeat) { await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('shots', ?)").bind(JSON.stringify({ at: new Date().toISOString(), host: String(b.host || '').slice(0, 60), note: String(b.note || '').slice(0, 200) })).run(); return json({ ok: true }); }
  if (!b || !/^\d{8,}$/.test(String(b.id || ''))) return json({ error: 'id 要是推文 id' }, 400);
  if (b.failed) { await env.DB.prepare("UPDATE tweets SET shot_key='' , reason=COALESCE(reason,'') WHERE id=?").bind(b.id).run(); return json({ ok: true, skipped: true }); }
  const img = toBytes(b.image);
  if (!img) return json({ error: 'image 要是 data:image/...;base64' }, 400);
  const key = `x/${b.id}-shot.${img.type.split('/')[1].replace('jpeg', 'jpg')}`;
  await env.MEDIA.put(key, img.bytes, { httpMetadata: { contentType: img.type } });
  const { w, h } = b.w && b.h ? { w: b.w | 0, h: b.h | 0 } : imageSize(img.bytes);
  await env.DB.prepare('UPDATE tweets SET shot_key=?, shot_w=?, shot_h=?, likes=COALESCE(?, likes), replies=COALESCE(?, replies), reposts=COALESCE(?, reposts), views=COALESCE(?, views) WHERE id=?')
    .bind(key, w, h, b.likes ?? null, b.replies ?? null, b.reposts ?? null, b.views ?? null, b.id).run();
  return json({ ok: true, key });
}
// 補讚數：舊資料沒存，重讀 fxtwitter 的數字
async function xCounts(env, n = 8) {
  const { results } = await env.DB.prepare("SELECT id FROM tweets WHERE status='done' AND likes IS NULL ORDER BY liked_at DESC LIMIT ?").bind(n).all();
  let done = 0;
  await Promise.all(results.map(async (row) => {
    try {
      const r = await fetch(`https://api.fxtwitter.com/status/${row.id}`, { headers: { 'User-Agent': UA } });
      if (!r.ok) { await env.DB.prepare('UPDATE tweets SET likes=0, replies=0, reposts=0, views=0 WHERE id=?').bind(row.id).run(); return; }
      const t = (await r.json()).tweet || {};
      await env.DB.prepare('UPDATE tweets SET likes=?, replies=?, reposts=?, views=? WHERE id=?').bind(t.likes | 0, t.replies | 0, t.retweets | 0, t.views | 0, row.id).run(); done++;
    } catch (e) { /* 下次再補 */ }
  }));
  return { done, batch: results.length };
}
// IFTTT 直接打進來（按讚 → Webhooks「Make a web request」）：IFTTT 不能加自訂標頭，所以密鑰放在網址 ?key=，用另一把 IFTTT_KEY
// 內容只要 {"url":"{{LinkToTweet}}"}，文字、作者、媒體都由 fxtwitter 補，按讚時間＝收到的時間（分鐘級）
async function xIfttt(req, env, ctx) {
  const u = new URL(req.url);
  if (!env.IFTTT_KEY || u.searchParams.get('key') !== env.IFTTT_KEY) return json({ error: 'unauthorized' }, 401);
  const raw = await req.text();
  const refs = [...raw.matchAll(/(?:x|twitter)\.com\/[^/\s"]+\/status\/\d+/g)].map((m) => parseTweetRef(m[0])).filter(Boolean);
  if (!refs.length) return json({ error: '內容裡沒有推文網址', got: raw.slice(0, 200) }, 400);
  const now = new Date().toISOString();
  let inserted = 0;
  for (const ref of refs) {
    const r = await env.DB.prepare('INSERT OR IGNORE INTO tweets (id, url, liked_at, tweet_at, author, handle, text, media, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .bind(ref.id, `https://x.com/${ref.handle || 'i'}/status/${ref.id}`, now, '', '', ref.handle, '', '[]', 'pending', now).run();
    inserted += r.meta.changes || 0;
  }
  await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('ifttt', ?)").bind(JSON.stringify({ at: now, inserted, ids: refs.map((r) => r.id) })).run();
  ctx.waitUntil(xProcess(env, 4, 20000).catch(() => {}));
  return json({ ok: true, inserted, ids: refs.map((r) => r.id) });
}
async function xList(req, env) {
  const u = new URL(req.url);
  const limit = Math.min(120, parseInt(u.searchParams.get('limit') || '60', 10) || 60);
  const before = u.searchParams.get('before') || '';
  const q = (u.searchParams.get('q') || '').trim().slice(0, 80);
  const filter = u.searchParams.get('filter') || '';
  const where = ["hidden=0", "status IN ('done','pending','fetching')"];
  const args = [];
  // 游標＝按讚時間＋id：同一批抄進來的幾百則時間完全一樣，只比時間會整批跳過
  if (before) { const [bt, bid] = before.split('|'); if (bid) { where.push('(liked_at < ? OR (liked_at = ? AND id < ?))'); args.push(bt, bt, bid); } else { where.push('liked_at < ?'); args.push(bt); } }
  if (q) { where.push('(text LIKE ? OR author LIKE ? OR handle LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (filter === 'wall') where.push('item_id IS NOT NULL');
  if (filter === 'media') where.push("media LIKE '%\"key\"%'");
  if (filter === 'video') where.push("media LIKE '%\"video\"%' OR media LIKE '%\"gif\"%'");
  if (filter === 'text') where.push("media = '[]'");
  const { results } = await env.DB.prepare(`SELECT id, url, liked_at, tweet_at, author, handle, text, media, status, score, kind, item_id, likes, replies, reposts, views, shot_key, shot_w, shot_h FROM tweets WHERE ${where.join(' AND ')} ORDER BY liked_at DESC, id DESC LIMIT ?`).bind(...args, limit).all();
  const all = authed(req, env);
  const isPrivate = (r) => { const h = [r.text, r.author, r.handle].join(' ').toLowerCase(); return PRIVATE.some((t) => h.includes(t)); };
  const rows = (all ? results : results.filter((r) => !isPrivate(r))).map(shapeTweet);
  const last = results[results.length - 1];
  return json({ rows, next: results.length === limit && last ? `${last.liked_at}|${last.id}` : null });
}
async function xStatus(env) {
  const r = await env.DB.prepare("SELECT COUNT(*) total, SUM(status='done') done, SUM(status='pending' OR status='fetching') pending, SUM(status='error') error, SUM(status='gone') gone, SUM(item_id IS NOT NULL) on_wall, SUM(score IS NOT NULL) scored, MAX(liked_at) last_liked, MAX(fetched_at) last_fetched FROM tweets WHERE hidden=0").first();
  const m = await env.DB.prepare("SELECT v FROM meta WHERE k='sheet'").first();
  let sheet = null; try { sheet = m ? JSON.parse(m.v) : null; } catch (e) { /* 壞掉就不顯示 */ }
  const im = await env.DB.prepare("SELECT v FROM meta WHERE k='ifttt'").first();
  let ifttt = null; try { ifttt = im ? JSON.parse(im.v) : null; } catch (e) { /* 同上 */ }
  const sm = await env.DB.prepare("SELECT v FROM meta WHERE k='shots'").first();
  let shots = null; try { shots = sm ? JSON.parse(sm.v) : null; } catch (e) { /* 同上 */ }
  const ns = await env.DB.prepare("SELECT COUNT(*) n FROM tweets WHERE status='done' AND hidden=0 AND media='[]' AND shot_key IS NULL").first();
  return json({ ...(r || {}), sheet, ifttt, shots: { ...(shots || {}), need: ns ? ns.n : 0 } });
}

async function items(req, env) {
  // 公開訪客看到所有打完分、沒被藏起來的；帶收件密鑰的人連失敗的也看得到
  const all = authed(req, env);
  const q = all
    ? 'SELECT * FROM items ORDER BY created_at DESC LIMIT 2000'
    : "SELECT * FROM items WHERE status='done' AND hidden=0 ORDER BY created_at DESC LIMIT 2000";
  const { results } = await env.DB.prepare(q).all();
  // 工作相關（refs/private-terms.txt）只給帶密鑰的人看，公開訪客一律排除
  const isPrivate = (r) => { const h = [r.page_url, r.page_title, r.text, r.reason, r.tags, r.taste_match].join(' ').toLowerCase(); return PRIVATE.some((t) => h.includes(t)); };
  const rows = all ? results : results.filter((r) => !isPrivate(r));
  return json(rows.map((r) => ({ ...r, tags: JSON.parse(r.tags || '[]'), palette: JSON.parse(r.palette || '[]'), text: all ? r.text : '' })));
}

async function patch(req, env, id) {
  if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);
  const b = await req.json().catch(() => ({}));
  if ('hidden' in b) await env.DB.prepare('UPDATE items SET hidden=? WHERE id=?').bind(b.hidden ? 1 : 0, id).run();
  if ('replica_url' in b) await env.DB.prepare('UPDATE items SET replica_url=? WHERE id=?').bind(String(b.replica_url || '').slice(0, 500), id).run();   // 牆上的參考 → 看板 Lab 的復刻
  // 補圖：抓不到 og:image 的連結，由 MacBook 或 mini 截圖後貼上來，再打一次分
  if (b.image) {
    const img = toBytes(b.image);
    if (!img) return json({ error: 'image 要是 data:image/...;base64 格式' }, 400);
    const key = `in/${id}.${img.type.split('/')[1].replace('jpeg', 'jpg')}`;
    await env.MEDIA.put(key, img.bytes, { httpMetadata: { contentType: img.type } });
    const { w, h } = imageSize(img.bytes);
    await env.DB.prepare('UPDATE items SET image_key=?, w=?, h=?, status=? WHERE id=?').bind(key, b.w | 0 || w, b.h | 0 || h, 'pending', id).run();
    const row = await env.DB.prepare('SELECT * FROM items WHERE id=?').bind(id).first();
    await analyze(env, id, b.image, row);
  }
  if (['wall', 'review', 'drop'].includes(b.verdict)) await env.DB.prepare('UPDATE items SET verdict=? WHERE id=?').bind(b.verdict, id).run();
  if (b.reanalyze) {
    const row = await env.DB.prepare('SELECT * FROM items WHERE id=?').bind(id).first();
    const obj = row && await env.MEDIA.get(row.image_key);
    if (!obj) return json({ error: 'not found' }, 404);
    const buf = new Uint8Array(await obj.arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    await analyze(env, id, `data:${obj.httpMetadata.contentType};base64,${btoa(s)}`, row);
  }
  return json({ ok: true, item: await env.DB.prepare('SELECT * FROM items WHERE id=?').bind(id).first() });
}

export default {
  async scheduled(event, env, ctx) {
    // 每兩分鐘把 pending 的推文抓一批；把卡住的 drop 撿一筆
    ctx.waitUntil(xPullSheet(env).catch(() => {}).then(() => Promise.all([xProcess(env, 48, 100000).then((n) => (n < 48 ? Promise.all([xRescore(env, 8, 40000), xCounts(env, 16)]) : null)), reap(env).catch(() => {})])));
  },
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (url.pathname === '/api/ingest' && req.method === 'POST') return ingest(req, env, ctx);
    if (url.pathname === '/api/drop' && req.method === 'POST') return drop(req, env, ctx);
    if (url.pathname === '/api/x/like' && req.method === 'POST') return xLike(req, env, ctx);
    if (url.pathname === '/api/x/ifttt' && req.method === 'POST') return xIfttt(req, env, ctx);
    if (url.pathname === '/api/x' && req.method === 'GET') return xList(req, env);
    if (url.pathname === '/api/x/status' && req.method === 'GET') return xStatus(env);
    const xm = /^\/api\/x\/(\d{8,})$/.exec(url.pathname);
    if (xm && req.method === 'GET') {
      const r = await env.DB.prepare("SELECT id, url, liked_at, tweet_at, author, handle, text, media, status, score, kind, reason, item_id, likes, replies, reposts, views, shot_key, shot_w, shot_h FROM tweets WHERE id=? AND hidden=0").bind(xm[1]).first();
      if (!r) return json({ error: 'not found' }, 404);
      return json(shapeTweet(r));
    }
    if (url.pathname === '/api/x/rescore' && req.method === 'POST') { if (!authed(req, env)) return json({ error: 'unauthorized' }, 401); return json({ ok: true, ...(await xRescore(env, parseInt(url.searchParams.get('n') || '8', 10))) }); }
    if (url.pathname === '/api/x/needshot' && req.method === 'GET') return xNeedShot(req, env);
    if (url.pathname === '/api/x/shot' && req.method === 'POST') return xShot(req, env);
    if (url.pathname === '/api/x/counts' && req.method === 'POST') { if (!authed(req, env)) return json({ error: 'unauthorized' }, 401); return json({ ok: true, ...(await xCounts(env, parseInt(url.searchParams.get('n') || '8', 10))) }); }
    if (url.pathname === '/api/x/pull' && req.method === 'POST') { if (!authed(req, env)) return json({ error: 'unauthorized' }, 401); await xPullSheet(env); return xStatus(env); }
    if (url.pathname === '/api/x/process' && req.method === 'POST') { if (!authed(req, env)) return json({ error: 'unauthorized' }, 401); return json({ ok: true, processed: await xProcess(env, parseInt(url.searchParams.get('n') || '8', 10), 25000) }); }
    if (url.pathname === '/api/items' && req.method === 'GET') { ctx.waitUntil(reap(env).catch(() => {})); return items(req, env); }
    if (url.pathname === '/api/try' && req.method === 'POST') {
      // 校準用：同一張圖丟給指定模型，直接回模型結果，不寫資料庫
      if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);
      const b = await req.json();
      const t0 = Date.now();
      try { return json({ ok: true, ms: Date.now() - t0, out: await runModel(env, b.model, b.image, b), took: Date.now() - t0 }); } catch (e) { return json({ ok: false, error: String(e), took: Date.now() - t0 }); }
    }
    const m = /^\/api\/items\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (m && req.method === 'POST') return patch(req, env, m[1]);
    if (m && req.method === 'GET') {
      // 外掛存完會來查這一筆，拿分數做通知
      if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);
      const row = await env.DB.prepare('SELECT id, status, score, verdict, reason, kind, error, page_url, page_title, dropped_at, image_key, w, h FROM items WHERE id=?').bind(m[1]).first();
      return row ? json(row) : json({ error: 'not found' }, 404);
    }
    if (url.pathname.startsWith('/media/in/') || url.pathname.startsWith('/media/x/')) {
      const range = req.headers.get('Range');
      const obj = await env.MEDIA.get(url.pathname.slice(7), range ? { range: req.headers } : undefined);
      if (!obj) return new Response('not found', { status: 404 });
      const h = { 'Content-Type': obj.httpMetadata.contentType || 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable', 'Accept-Ranges': 'bytes', ...CORS };
      if (range && obj.range) { const { offset, length } = obj.range; h['Content-Range'] = `bytes ${offset}-${offset + length - 1}/${obj.size}`; h['Content-Length'] = String(length); return new Response(obj.body, { status: 206, headers: h }); }
      h['Content-Length'] = String(obj.size);
      return new Response(obj.body, { headers: h });
    }
    return env.ASSETS.fetch(req);
  },
};
