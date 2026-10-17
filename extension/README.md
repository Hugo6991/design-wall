# 存到設計牆（Chrome 外掛）

在任何網頁按 Option+Shift+S，或點工具列的圖示，就把目前畫面截下來存進設計牆。對圖片按右鍵選「存這張圖到設計牆」，只存那張圖

存進去後 Cloudflare 那端會看圖打分，大約 20 到 40 秒後跳通知告訴你幾分、上牆還是待審

## 安裝（要你自己在 Chrome 裡點）

1. 網址列打 `chrome://extensions`
2. 右上角打開「開發人員模式」
3. 按「載入未封裝項目」，選這個資料夾 `<this repo>/extension`
4. 想換快捷鍵：到 `chrome://extensions/shortcuts`

`config.js` 裡有收件密鑰，不進 git，也不要傳給別人。換密鑰的方法：重新產生 `../.env.ingest-token`，跑 `npx wrangler secret put INGEST_TOKEN`，再改 `config.js`

## 在牆上管理收進來的東西

在自己的瀏覽器開一次 `https://design-wall.YOUR-SUBDOMAIN.workers.dev/#key=<密鑰>`，之後這台瀏覽器就看得到待審和失敗的，點開卡片有「上牆、待審、藏起來」三個按鈕。沒有密鑰的訪客只看得到 7 分以上的

## 已知瑕疵

- verified：2026-09-30 用 Playwright 載入外掛實測兩條路（截畫面、存單張圖），都存進去並打完分
- verified：沒在日常用的 Chrome 裡裝過，通知和快捷鍵只在測試瀏覽器裡跑過
- inferred：有些網站擋直接抓圖，會自動退回截整個畫面
- inferred：截整個畫面會連同頁面上的私人資訊一起送出。7 分以上會出現在公開牆上，存私人頁面前要注意
