// Akakçe.com arama sonuçlarını ve ürün satıcı listelerini gizli bir Electron
// penceresi (gerçek Chromium motoru) ile tarayan modül.
//
// Neden gizli bir BrowserWindow?
//   - Cloudflare'in JS challenge'ı gerçek bir tarayıcı motoru gerektirir;
//     düz HTTP istekleri (axios/fetch) çoğunlukla 403 ile engellenir.
//   - Electron'un Chromium motoru normal bir tarayıcı gibi JS çalıştırır,
//     bu sayede challenge kendiliğinden çözülür ve `cf_clearance` çerezi
//     kalıcı session partition'da saklanır (sonraki taramalar daha hızlı olur).
//
// NOT: Akakçe'nin HTML yapısı zaman zaman değişebilir. Aşağıdaki seçiciler
// bilinen/gözlemlenen yapıya göre çoklu-strateji (JSON-LD -> bilinen CSS
// seçicileri -> genel bağlantı sezgisi) ile yazılmıştır. Tarama sonuç
// vermezse önce bu dosyadaki EXTRACT_* betiklerini güncel sayfa yapısına
// göre güncellemek gerekir.

const { BrowserWindow, session } = require('electron');
const { SESSION_PARTITION, USER_AGENT, AKAKCE_ORIGIN } = require('./constants');

const CHALLENGE_TIMEOUT_MS = 25000;
const POLL_INTERVAL_MS = 500;
const GRACE_AFTER_LOAD_MS = 1500;

function searchUrl(term) {
  return `${AKAKCE_ORIGIN}/arama/?q=${encodeURIComponent(term)}`;
}

const EXTRACT_SEARCH_RESULTS_JS = `(() => {
  function absUrl(href) {
    try { return new URL(href, location.origin).href; } catch (e) { return href; }
  }
  function textOf(el) { return (el && el.textContent || '').replace(/\\s+/g, ' ').trim(); }

  const results = [];

  try {
    const ldScripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
    for (const s of ldScripts) {
      let json;
      try { json = JSON.parse(s.textContent); } catch (e) { continue; }
      const items = Array.isArray(json) ? json : (json.itemListElement || [json]);
      for (const it of items) {
        const item = (it && it.item) || it;
        if (item && (item['@type'] === 'Product' || item.name)) {
          const offers = item.offers || {};
          results.push({
            title: item.name || '',
            detailUrl: item.url ? absUrl(item.url) : '',
            price: offers.price || offers.lowPrice || '',
            sellerCountText: offers.offerCount ? (offers.offerCount + ' Satıcı') : '',
            source: 'jsonld',
          });
        }
      }
    }
  } catch (e) {}

  if (results.length === 0) {
    const items = Array.from(document.querySelectorAll('#APL > li, .search_v8 li, ul.pl_v9 > li, ul[id="APL"] li'));
    for (const li of items) {
      const link = li.querySelector('a[href]');
      if (!link) continue;
      const href = link.getAttribute('href') || '';
      if (!href) continue;
      const titleEl = li.querySelector('[class*="pb_v"], [class*="name"], h3, .pn');
      const title = link.getAttribute('title') || textOf(titleEl) || textOf(link);
      if (!title) continue;
      const priceEl = li.querySelector('[class*="pt_v"], [class*="price"], .pt');
      const priceText = textOf(priceEl);
      const bodyText = textOf(li);
      const sellerMatch = bodyText.match(/(\\d+)\\s*Sat[ıi]c[ıi]/i);
      results.push({
        title,
        detailUrl: absUrl(href),
        price: priceText,
        sellerCountText: sellerMatch ? sellerMatch[0] : '',
        source: 'dom',
      });
    }
  }

  if (results.length === 0) {
    const anchors = Array.from(document.querySelectorAll('a[href*=","][href$=".html"]'));
    const seen = new Set();
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      if (!href || seen.has(href)) continue;
      const title = a.getAttribute('title') || textOf(a);
      if (!title || title.length < 3) continue;
      seen.add(href);
      const container = a.closest('li, div') || a;
      const bodyText = textOf(container);
      const sellerMatch = bodyText.match(/(\\d+)\\s*Sat[ıi]c[ıi]/i);
      const priceMatch = bodyText.match(/([\\d.]+,[\\d]{2})\\s*TL/i);
      results.push({
        title,
        detailUrl: absUrl(href),
        price: priceMatch ? priceMatch[0] : '',
        sellerCountText: sellerMatch ? sellerMatch[0] : '',
        source: 'anchor-fallback',
      });
    }
  }

  return {
    pageTitle: document.title,
    results: results.slice(0, 40),
  };
})()`;

const EXTRACT_SELLERS_JS = `(() => {
  function textOf(el) { return (el && el.textContent || '').replace(/\\s+/g, ' ').trim(); }
  const sellers = [];
  const seen = new Set();

  const imgs = Array.from(document.querySelectorAll('img[alt]'));
  for (const img of imgs) {
    const alt = (img.getAttribute('alt') || '').trim();
    if (!alt || alt.length < 2 || alt.length > 40) continue;
    if (/akak[cç]e|logo|icon/i.test(alt)) continue;
    const row = img.closest('li, tr, div[class*="satici"], div[class*="shop"], div[class*="offer"], div[class*="slc"]') || img.parentElement;
    if (!row) continue;
    const rowText = textOf(row);
    const looksLikeOfferRow =
      /sat[ıi]c[ıi]ya git|sepete ekle|\\d+[.,]\\d{2}\\s*TL/i.test(rowText) ||
      !!row.querySelector('a[href*="akakce.com/c/"], a[href*="/r/"]');
    if (!looksLikeOfferRow) continue;
    if (seen.has(alt)) continue;
    seen.add(alt);
    sellers.push(alt);
  }

  if (sellers.length === 0) {
    const nameEls = Array.from(
      document.querySelectorAll('[class*="satici"], [class*="shop_name"], [class*="store"], [class*="mn_v"]')
    );
    for (const el of nameEls) {
      const t = textOf(el);
      if (t && t.length > 1 && t.length < 40 && !seen.has(t)) {
        seen.add(t);
        sellers.push(t);
      }
    }
  }

  return sellers.slice(0, 30);
})()`;

class AkakceScraper {
  constructor() {
    this._win = null;
    this._queue = Promise.resolve();
  }

  _getWindow() {
    if (this._win && !this._win.isDestroyed()) return this._win;
    this._win = new BrowserWindow({
      show: false,
      width: 1366,
      height: 1024,
      webPreferences: {
        session: session.fromPartition(SESSION_PARTITION),
      },
    });
    this._win.webContents.setUserAgent(USER_AGENT);
    return this._win;
  }

  // Tüm tarama işlemlerini tek bir gizli pencere üzerinden sıraya alır,
  // böylece aynı anda birden çok navigasyon birbirine karışmaz.
  _enqueue(task) {
    const run = this._queue.then(task, task);
    this._queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async _waitForReadyState(readyExpr) {
    const win = this._getWindow();
    const start = Date.now();
    let lastState = { isChallenge: true, ready: false };
    while (Date.now() - start < CHALLENGE_TIMEOUT_MS) {
      try {
        lastState = await win.webContents.executeJavaScript(`(() => {
          const title = document.title || '';
          const isChallenge = /just a moment/i.test(title) ||
            !!document.querySelector('#challenge-form, #cf-challenge-running, .cf-browser-verification, #challenge-stage');
          let ready = false;
          try { ready = !!(${readyExpr}); } catch (e) { ready = false; }
          return { isChallenge, ready };
        })()`);
      } catch (e) {
        lastState = { isChallenge: true, ready: false };
      }
      if (!lastState.isChallenge && lastState.ready) {
        await new Promise((r) => setTimeout(r, GRACE_AFTER_LOAD_MS));
        return { ok: true };
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    return { ok: false, lastState };
  }

  async searchProduct(term) {
    return this._enqueue(async () => {
      const url = searchUrl(term);
      const win = this._getWindow();
      try {
        await win.loadURL(url);
      } catch (e) {
        return { term, url, cloudflareBlocked: false, error: e.message, results: [] };
      }
      const waitResult = await this._waitForReadyState(
        `document.querySelector('#APL, .search_v8') || document.body.innerText.length > 800`
      );
      let data = { results: [] };
      try {
        data = await win.webContents.executeJavaScript(EXTRACT_SEARCH_RESULTS_JS);
      } catch (e) {
        data = { results: [] };
      }
      return {
        term,
        url,
        cloudflareBlocked: !waitResult.ok && (!data.results || data.results.length === 0),
        results: data.results || [],
      };
    });
  }

  async getSellers(detailUrl) {
    return this._enqueue(async () => {
      const win = this._getWindow();
      try {
        await win.loadURL(detailUrl);
      } catch (e) {
        return { detailUrl, sellers: [], cloudflareBlocked: false, error: e.message };
      }
      const waitResult = await this._waitForReadyState(`document.body.innerText.length > 800`);
      let sellers = [];
      try {
        sellers = await win.webContents.executeJavaScript(EXTRACT_SELLERS_JS);
      } catch (e) {
        sellers = [];
      }
      return {
        detailUrl,
        sellers,
        cloudflareBlocked: !waitResult.ok && sellers.length === 0,
      };
    });
  }
}

module.exports = new AkakceScraper();
