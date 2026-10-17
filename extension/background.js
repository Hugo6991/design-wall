// 存到設計牆：工具列按鈕或快捷鍵截目前畫面，右鍵可以只存某張圖
// 圖先在這裡縮到長邊 1600 再送出，收件端存好後背景打分，這裡輪詢拿分數跳通知
import { ENDPOINT, TOKEN } from './config.js';

const MAX = 1600;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'save-image', title: '存這張圖到設計牆', contexts: ['image'] });
  chrome.contextMenus.create({ id: 'save-shot', title: '截這個畫面存到設計牆', contexts: ['page', 'selection', 'link', 'video'] });
});

chrome.action.onClicked.addListener((tab) => saveShot(tab));
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'save-image' && info.srcUrl) saveImage(info.srcUrl, tab, info.selectionText);
  else saveShot(tab, info.selectionText);
});

async function saveShot(tab, text = '') {
  await badge(tab, '…', '#888');
  try {
    const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const blob = await (await fetch(shot)).blob();
    await send(tab, blob, 'extension-shot', text);
  } catch (e) { fail(tab, e); }
}

async function saveImage(url, tab, text = '') {
  await badge(tab, '…', '#888');
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`抓不到圖（${res.status}）`);
    await send(tab, await res.blob(), 'extension-image', text);
  } catch (e) {
    // 有些網站擋直接抓圖，退回截整個畫面
    try { const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }); await send(tab, await (await fetch(shot)).blob(), 'extension-shot', text); }
    catch (e2) { fail(tab, e2); }
  }
}

async function shrink(blob) {
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
  const cv = new OffscreenCanvas(w, h);
  cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
  const out = await cv.convertToBlob({ type: 'image/jpeg', quality: 0.86 });
  const buf = new Uint8Array(await out.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { image: 'data:image/jpeg;base64,' + btoa(s), w, h };
}

async function send(tab, blob, source, text) {
  const img = await shrink(blob);
  const res = await fetch(ENDPOINT + '/api/ingest', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...img, source, page_url: tab.url, page_title: tab.title, text: text || '' }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.id) throw new Error(d.error || `收件端回 ${res.status}`);
  await badge(tab, '✓', '#1a7f37');
  notify('已存進設計牆', '正在看圖打分…');
  poll(d.id, tab);
}

async function poll(id, tab) {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const r = await fetch(`${ENDPOINT}/api/items/${id}`, { headers: { Authorization: 'Bearer ' + TOKEN } }).then((x) => x.json()).catch(() => null);
    if (!r || r.status === 'pending') continue;
    if (r.status === 'error') { notify('存了，但打分失敗', String(r.error || '').slice(0, 120)); return; }
    const where = r.verdict === 'wall' ? '上牆' : r.verdict === 'review' ? '放待審' : '分數太低，不上牆';
    notify(`${r.score} 分，${where}`, r.reason || '');
    setTimeout(() => badge(tab, '', '#888'), 3000);
    return;
  }
  notify('存了，打分還沒回來', '晚點到牆上的待審看');
}

function fail(tab, e) {
  badge(tab, '!', '#b3261e');
  notify('沒存成功', String(e && e.message || e).slice(0, 150));
}

async function badge(tab, text, color) {
  try { await chrome.action.setBadgeBackgroundColor({ color, tabId: tab.id }); await chrome.action.setBadgeText({ text, tabId: tab.id }); } catch (e) { /* 分頁已關 */ }
}

function notify(title, message) {
  chrome.notifications.create({ type: 'basic', iconUrl: 'icon.png', title, message: message || ' ' });
}

// 自動測試用：Playwright 從 service worker 直接呼叫
self.__wall = { saveShot, saveImage };
