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
// NOT: Akakçe sayfaları Astro framework'ü ile üretiliyor ve her sayfada
// `<astro-island props="...">` elementleri içinde, sayfanın kendi React/Vue
// bileşenlerine aktardığı TAM YAPILANDIRILMIŞ JSON veri (ürün listesi / satıcı
// listesi) bulunuyor. Bu veri CSS class isimlerinden çok daha kararlı olduğu
// için birincil kaynak olarak kullanılıyor; DOM seçicileri yalnızca yedek
// (fallback) stratejidir. Akakçe bu veri yapısını değiştirirse önce
// EXTRACT_* betiklerindeki "Astro island" stratejisini güncellemek gerekir.

const { BrowserWindow, session } = require('electron');
const { SESSION_PARTITION, USER_AGENT, AKAKCE_ORIGIN } = require('./constants');

const CHALLENGE_TIMEOUT_MS = 25000;
const POLL_INTERVAL_MS = 500;
const GRACE_AFTER_LOAD_MS = 1500;

function searchUrl(term) {
  return `${AKAKCE_ORIGIN}/arama/?q=${encodeURIComponent(term)}`;
}

// Akakçe'nin Astro island'larında kullandığı serileştirme biçimini geri
// çözer: her değer [tag, value] şeklinde saklanır (tag 0 = düz değer/nesne,
// tag 1 = dizi). Nesnelerin ve dizilerin içindeki her alan da aynı şekilde
// sarmalanmış olduğundan işlem özyinelemeli yapılır.
const DESERIALIZE_HELPERS_JS = `
  function deserializeValue(node) {
    if (Array.isArray(node) && node.length === 2 && (node[0] === 0 || node[0] === 1)) {
      const tag = node[0];
      const value = node[1];
      if (tag === 1) {
        return Array.isArray(value) ? value.map(deserializeValue) : value;
      }
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const out = {};
        for (const key of Object.keys(value)) out[key] = deserializeValue(value[key]);
        return out;
      }
      return value;
    }
    return node;
  }
  function deserializeRoot(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const out = {};
    for (const key of Object.keys(obj)) out[key] = deserializeValue(obj[key]);
    return out;
  }
  function readIslandData() {
    const islands = Array.from(document.querySelectorAll('astro-island[props]'));
    const parsed = [];
    for (const el of islands) {
      try {
        parsed.push(deserializeRoot(JSON.parse(el.getAttribute('props'))));
      } catch (e) {}
    }
    return parsed;
  }
`;

const EXTRACT_SEARCH_RESULTS_JS = `(() => {
  ${DESERIALIZE_HELPERS_JS}
  function absUrl(href) {
    if (!href) return '';
    try { return new URL(href, location.origin).href; } catch (e) { return href; }
  }
  function textOf(el) { return (el && el.textContent || '').replace(/\\s+/g, ' ').trim(); }
  function formatPrice(n) {
    if (typeof n !== 'number') return '';
    return n.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' TL';
  }

  const results = [];

  // Strateji 1 (birincil): sayfaya gömülü Astro island JSON verisi
  try {
    const islands = readIslandData();
    for (const root of islands) {
      const products =
        root && root.searchData && root.searchData.productList && root.searchData.productList.products;
      if (Array.isArray(products) && products.length > 0) {
        for (const p of products) {
          if (!p || !p.name) continue;
          results.push({
            title: p.name,
            detailUrl: p.url ? absUrl(p.url) : '',
            price: formatPrice(p.price),
            sellerCountText: p.countOfPrices ? (p.countOfPrices + ' Satıcı') : '',
            source: 'astro-island',
          });
        }
        break;
      }
    }
  } catch (e) {}

  // Strateji 2 (yedek): JSON-LD yapısal verisi
  if (results.length === 0) {
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
  }

  // Strateji 3 (yedek): bilinen DOM seçicileri
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

  // Strateji 4 (son çare): genel bağlantı sezgisi
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
  ${DESERIALIZE_HELPERS_JS}
  function textOf(el) { return (el && el.textContent || '').replace(/\\s+/g, ' ').trim(); }

  let sellers = [];
  let totalCount = 0;
  const contentParts = [];

  // Strateji 1 (birincil): sayfaya gömülü Astro island JSON verisi.
  // Ürün detay sayfasındaki "initialPgList" alanı, tüm satıcı tekliflerini
  // fiyata göre artan sırada (yani ekranda görünen 1./2./3. satıcı sırasıyla
  // aynı) içerir.
  try {
    const islands = readIslandData();
    for (const root of islands) {
      if (Array.isArray(root.initialPgList) && root.initialPgList.length > 0) {
        sellers = root.initialPgList.map((o) => (o && o.vdName) || '').filter(Boolean);
        for (const o of root.initialPgList) {
          if (o && o.pgName) contentParts.push(o.pgName);
          if (o && o.vdName) contentParts.push(o.vdName);
          if (o && o.pgNick) contentParts.push(o.pgNick);
        }
      }
      if (root.metadata && typeof root.metadata.countOfPrCode === 'number') {
        totalCount = root.metadata.countOfPrCode;
      }
      if (root.metadata) {
        const m = root.metadata;
        ['name', 'h1', 'descriptiveText', 'descriptiveTextShort', 'mkName', 'title'].forEach((k) => {
          if (m[k]) contentParts.push(String(m[k]));
        });
      }
      if (root.spotPg && root.spotPg.pgName) contentParts.push(root.spotPg.pgName);
      if (root.spotPg && root.spotPg.vdName) contentParts.push(root.spotPg.vdName);
    }
  } catch (e) {}

  const h1 = document.querySelector('#pd_v8 h1, .pdt_v8 h1, h1');
  if (h1) contentParts.push(textOf(h1));

  const contentText = contentParts.join(' ');

  // Strateji 2 (yedek): görsel alt metni + satır bağlamı sezgisi
  if (sellers.length === 0) {
    const seen = new Set();
    const imgs = Array.from(document.querySelectorAll('img[alt]'));
    for (const img of imgs) {
      const alt = (img.getAttribute('alt') || '').trim();
      if (!alt || alt.length < 2 || alt.length > 40 || /^\\d+$/.test(alt)) continue;
      if (/akak[cç]e|logo|icon|fiyat grafi/i.test(alt)) continue;
      const row =
        img.closest('li, tr, div[class*="satici"], div[class*="shop"], div[class*="offer"], div[class*="slc"]') ||
        img.parentElement;
      if (!row) continue;
      const rowText = textOf(row);
      const looksLikeOfferRow =
        /sat[ıi]c[ıi]ya git|sepete ekle|\\d+[.,]\\d{2}\\s*TL/i.test(rowText) ||
        !!row.querySelector('a[href*="akakce.com/c/"], a[href*="/r/"]');
      if (!looksLikeOfferRow || seen.has(alt)) continue;
      seen.add(alt);
      sellers.push(alt);
    }
  }

  return { sellers: sellers.slice(0, 30), totalCount, contentText };
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
        `document.querySelector('astro-island[props], #APL, .search_v8') || document.body.innerText.length > 800`
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
        return { detailUrl, sellers: [], totalCount: 0, contentText: '', cloudflareBlocked: false, error: e.message };
      }
      const waitResult = await this._waitForReadyState(`document.body.innerText.length > 800`);
      let data = { sellers: [], totalCount: 0, contentText: '' };
      try {
        data = await win.webContents.executeJavaScript(EXTRACT_SELLERS_JS);
      } catch (e) {
        data = { sellers: [], totalCount: 0, contentText: '' };
      }
      const sellers = data.sellers || [];
      return {
        detailUrl,
        sellers,
        totalCount: data.totalCount || 0,
        contentText: data.contentText || '',
        cloudflareBlocked: !waitResult.ok && sellers.length === 0,
      };
    });
  }
}

module.exports = new AkakceScraper();
