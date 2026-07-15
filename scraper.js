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
const GRACE_AFTER_LOAD_MS = 2000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2000;

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
    if (typeof n !== 'number' || !Number.isFinite(n)) return '';
    return n.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' TL';
  }
  function normKey(s) {
    return (s || '').toLocaleLowerCase('tr-TR').replace(/\\s+/g, ' ').trim();
  }
  function formatSellerLabel(offer) {
    if (!offer) return '';
    const platform = String(offer.vdName || '').trim();
    const store = String(offer.pgNick || offer.pgName || '').trim();
    if (platform && store && normKey(platform) !== normKey(store)) {
      return platform + ' / ' + store;
    }
    return platform || store;
  }
  function formatSellerEntry(offer, fallbackPrice) {
    const name = formatSellerLabel(offer);
    if (!name) return null;
    const rawPrice = offer && (offer.price ?? offer.minPrice ?? offer.spotPrice);
    let price = typeof rawPrice === 'number' ? formatPrice(rawPrice) : '';
    if (!price && typeof fallbackPrice === 'number') price = formatPrice(fallbackPrice);
    return { name, price };
  }
  function pickProductUrl(p) {
    if (!p) return '';
    const candidates = [
      p.url, p.link, p.productUrl, p.detailUrl, p.href,
      p.spotPg && p.spotPg.url,
      p.spotPg && p.spotPg.pgUrl,
      p.spotPg && p.spotPg.offerUrl,
    ];
    for (const c of candidates) {
      if (c) return absUrl(c);
    }
    return '';
  }
  function extractSellersFromProduct(p) {
    const sellers = [];
    const seen = new Set();
    const add = (offer, fallbackPrice) => {
      const entry = formatSellerEntry(offer, fallbackPrice ?? p.price);
      if (!entry) return;
      const key = normKey(entry.name);
      if (seen.has(key)) return;
      seen.add(key);
      sellers.push(entry);
    };
    const offerLists = [p.initialPgList, p.pgList, p.spotPgList, p.offers, p.priceList];
    for (const list of offerLists) {
      if (Array.isArray(list)) {
        for (const o of list) add(o);
      }
    }
    if (p.spotPg) add(p.spotPg, p.price);
    if (p.cheapestPg) add(p.cheapestPg, p.price);
    if (p.bestPg) add(p.bestPg, p.price);
    if (p.pgNick || p.vdName || p.pgName) {
      add({ vdName: p.vdName, pgNick: p.pgNick, pgName: p.pgName, price: p.price });
    }
    return sellers;
  }
  function collectProductsFromIslands(islands) {
    const products = [];
    const seenIds = new Set();
    for (const root of islands) {
      const lists = [
        root && root.searchData && root.searchData.productList && root.searchData.productList.products,
        root && root.productList && root.productList.products,
        root && root.products,
      ];
      for (const list of lists) {
        if (!Array.isArray(list)) continue;
        for (const p of list) {
          if (!p || !p.name) continue;
          const id = String(p.id || p.code || p.name);
          if (seenIds.has(id)) continue;
          seenIds.add(id);
          products.push(p);
        }
      }
    }
    return products;
  }
  function cleanPriceText(raw) {
    return (raw || '').replace(/\\s*TEK\\s*F[İI]YAT.*$/i, '').replace(/\\s*\\+\\d+\\s*F[İI]YAT.*$/i, '').trim();
  }
  function extractSellerFromCard(container, priceText) {
    const sellers = [];
    const seen = new Set();
    const normalizedPrice = cleanPriceText(priceText);
    const add = (name, price) => {
      const label = (name || '').trim();
      if (!label || label.length < 2 || label.length > 60) return;
      if (/^(fiyat grafiği|ürüne git|alarm kur|en ucuz|kargo dahil|yetkili satıcı)/i.test(label)) return;
      if (/dahil en$/i.test(label)) return;
      if (/akak[cç]e|logo|icon|grafik|incele|sepete|alarm|favori/i.test(label)) return;
      if (/^\\d+[.,]?\\d*\\s*TL$/i.test(label)) return;
      if (/^\\d{3,7}$/.test(label)) return;
      const key = normKey(label);
      if (seen.has(key)) return;
      seen.add(key);
      sellers.push({ name: label, price: cleanPriceText(price) || normalizedPrice });
    };
    const extractKargoSeller = (text) => {
      if (!text) return '';
      const paid = text.match(/[+\\d.,\\s]*TL\\s*[Kk]argo\\s*([A-Za-zğüşıöçĞÜŞİÖÇ][A-Za-z0-9ğüşıöçĞÜŞİÖÇ._& -]{1,38})\\s*$/);
      if (paid) return paid[1].trim();
      const tail = text.match(/(?:Ücretsiz\\s+)?[Kk]argo\\s*([A-Za-zğüşıöçĞÜŞİÖÇ][A-Za-z0-9ğüşıöçĞÜŞİÖÇ._& -]{1,38})\\s*$/);
      if (tail) return tail[1].trim();
      const inline = text.match(/(?:Ücretsiz\\s+)?[+\\d.,\\s]*TL\\s*[Kk]argo\\s*([A-Za-zğüşıöçĞÜŞİÖÇ][A-Za-z0-9ğüşıöçĞÜŞİÖÇ._& -]{1,38})(?=\\s|$)/);
      if (inline) return inline[1].trim();
      const plain = text.match(/[Kk]argo\\s*([A-Za-zğüşıöçĞÜŞİÖÇ][A-Za-z0-9ğüşıöçĞÜŞİÖÇ._& -]{1,38})\\s*$/);
      return plain ? plain[1].trim() : '';
    };
    const KNOWN_VENDORS = {
      '786': 'TeknoBiyotik',
      '12088': 'hepsiburada',
      '152': 'n11',
      '297': 'pttavm',
      '7860': 'MediaMarkt',
      '10001': 'Amazon',
      '11281': 'pttavm',
      '5460': 'n11',
    };
    const vendorFromHref = (href) => {
      const m = (href || '').match(/[?&]v=(\\d+)/);
      return m ? (KNOWN_VENDORS[m[1]] || '') : '';
    };
    const vendorFromRedirect = () => {
      const a = container.querySelector('a[href*="/c/"]');
      return a ? vendorFromHref(a.getAttribute('href') || '') : '';
    };
    const extractMultiSellerOffers = () => {
      const offers = [];
      const offerLinks = container.querySelectorAll(
        'div.p_w_v9 a.iC, div[class*="p_w"] a[class*="iC"], a.iC[title*="Satıcıya"]'
      );
      for (const a of offerLinks) {
        const priceEl = a.querySelector('[class*="pt_v"], .pt_v8, .pt_v9');
        let price = textOf(priceEl);
        if (!price) {
          const pm = textOf(a).match(/([\\d.]+,\\d{2})\\s*TL/i);
          if (pm) price = pm[0];
        }
        let name = textOf(a.querySelector('span.l b, .l b'));
        if (!name) {
          const img = a.querySelector('span.l img[alt], .l img[alt]');
          const alt = img ? (img.getAttribute('alt') || '').trim() : '';
          if (alt && !/^\\d{3,7}$/.test(alt)) name = alt;
          else if (alt) name = KNOWN_VENDORS[alt] || '';
        }
        if (!name) name = vendorFromHref(a.getAttribute('href') || '');
        if (name) offers.push({ name, price: cleanPriceText(price) });
      }
      return offers;
    };
    const bodyText = textOf(container);
    const slashMatch = bodyText.match(/Sat[ıi]c[ıi]ya Git\\s+([^\\d/]+?)\\s*\\/\\s*([A-Za-z0-9ğüşıöçĞÜŞİÖÇ._ -]{2,40})/i);
    if (slashMatch) {
      add(slashMatch[1].trim() + ' / ' + slashMatch[2].trim(), normalizedPrice);
      return sellers;
    }
    const multiOffers = extractMultiSellerOffers();
    if (multiOffers.length > 0) {
      for (const offer of multiOffers) add(offer.name, offer.price);
      if (sellers.length > 0) return sellers;
    }
    const fromBody = extractKargoSeller(bodyText);
    if (fromBody) add(fromBody, normalizedPrice);
    const storeLinks = Array.from(container.querySelectorAll(
      'a[href*="magaza"], a[href*="satici"], a[href*="yönlendir"], a[href*="yonlendir"], a[class*="seller"], a[class*="vd"], a[class*="pg"]'
    ));
    for (const a of storeLinks) {
      const label = textOf(a);
      const fromLink = extractKargoSeller(label) || label;
      if (fromLink) add(fromLink, normalizedPrice);
    }
    const allLinks = Array.from(container.querySelectorAll('a[href]'));
    for (const a of allLinks) {
      const href = (a.getAttribute('href') || '').trim();
      const label = textOf(a);
      if (!label || label.length < 2 || label.length > 80) continue;
      const fromKargo = extractKargoSeller(label);
      if (fromKargo) {
        add(fromKargo, normalizedPrice);
        continue;
      }
      if (/\\d+[.,]\\d{2}\\s*TL|TL\\s*\\d|fiyat|ücretsiz|ürüne git|incele|detay|alarm/i.test(label)) continue;
      if (/kargo/i.test(label)) continue;
      if (/,.+\\.html$/i.test(href)) continue;
      add(label, normalizedPrice);
    }
    const storeEls = container.querySelectorAll(
      '[class*="vd_"], [class*="pg_n"], [class*="seller"], [class*="store"], [class*="merchant"], span.l b, .l b, a.iC b'
    );
    for (const el of storeEls) {
      add(textOf(el), normalizedPrice);
    }
    const buttons = Array.from(container.querySelectorAll('button'));
    for (const btn of buttons) {
      const label = textOf(btn);
      if (label && label.length >= 2 && label.length <= 40) add(label, normalizedPrice);
    }
    if (sellers.length === 0) {
      const vd = vendorFromRedirect();
      if (vd) add(vd, normalizedPrice);
    }
    const imgs = Array.from(container.querySelectorAll('img[alt]'));
    for (const img of imgs) {
      const alt = (img.getAttribute('alt') || '').trim();
      if (!alt || /nvidia|rtx|geforce|ekran|kart|product|ürün|fiyat grafi/i.test(alt)) continue;
      if (/^\\d{3,7}$/.test(alt)) continue;
      add(alt, normalizedPrice);
    }
    return sellers;
  }
  function normalizeCardTitle(raw) {
    return (raw || '').replace(/\\s*-\\s*Sat[ıi]c[ıi]ya Git\\s*$/i, '').replace(/\\s+/g, ' ').trim();
  }
  function isProductListItem(li) {
    const bodyText = textOf(li);
    if (!/\\d+[.,]\\d{2}\\s*TL/i.test(bodyText)) return false;
    if (bodyText.length < 25) return false;
    return true;
  }
  function pickCardDetailUrl(li) {
    const comparison = li.querySelector('a[href*=","][href$=".html"]');
    if (comparison) return absUrl(comparison.getAttribute('href') || '');
    const redirect = li.querySelector(
      'a.iC[href*="/c/"], a[href*="/c/"][href*="v="], a[href*="/c/"][title*="Satıcıya"]'
    );
    if (redirect) return absUrl(redirect.getAttribute('href') || '');
    const titled = li.querySelector('a[title][href]');
    if (titled) return absUrl(titled.getAttribute('href') || '');
    const any = li.querySelector('a[href]');
    return any ? absUrl(any.getAttribute('href') || '') : '';
  }
  function pickCardTitle(li) {
    const titled = Array.from(li.querySelectorAll('a[title]'))
      .map((a) => normalizeCardTitle(a.getAttribute('title') || ''))
      .filter((t) => t.length >= 8 && !/^sat[ıi]c[ıi]ya git$/i.test(t))
      .sort((a, b) => b.length - a.length);
    if (titled.length > 0) return titled[0];
    const titleEl = li.querySelector('[class*="pb_v"], [class*="name"], h3, .pn');
    const fromEl = textOf(titleEl);
    if (fromEl.length >= 8) return fromEl;
    const link = li.querySelector('a[href]');
    return link ? normalizeCardTitle(link.getAttribute('title') || textOf(link)) : '';
  }
  function titleKey(t) {
    return (t || '').toLocaleLowerCase('tr-TR').replace(/\\s+/g, ' ').trim();
  }
  function productCodeKey(value) {
    const m = String(value || '').match(/(\\d{6,})/);
    return m ? m[1] : '';
  }
  function findCardForResult(result, cards) {
    const rKey = titleKey(result.title);
    const rCode = String(result.code || productCodeKey(result.title) || '');
    let card = cards.find((c) => {
      const cKey = titleKey(c.title);
      if (!cKey || !rKey) return false;
      return cKey.includes(rKey.slice(0, 35)) || rKey.includes(cKey.slice(0, 35));
    });
    if (!card && rCode) {
      card = cards.find((c) => productCodeKey(c.detailUrl) === rCode || productCodeKey(c.title) === rCode);
    }
    return card;
  }
  function collectDomProductCards() {
    const items = Array.from(document.querySelectorAll(
      '#APL > li, .search_v8 li, ul.pl_v9 > li, ul[id="APL"] li, li[class*="product"], article[class*="product"], div[class*="wlv"], div[class*="product-card"]'
    ));
    const cards = [];
    for (const li of items) {
      if (!isProductListItem(li)) continue;
      const title = pickCardTitle(li);
      if (!title || title.length < 8) continue;
      const priceEl = li.querySelector('[class*="pt_v"], [class*="price"], .pt');
      let priceText = textOf(priceEl);
      const bodyText = textOf(li);
      if (!priceText) {
        const priceMatch = bodyText.match(/([\\d.]+,[\\d]{2})\\s*TL/i);
        if (priceMatch) priceText = priceMatch[0];
      }
      const sellerMatch = bodyText.match(/(\\d+)\\s*Sat[ıi]c[ıi]/i);
      const sellers = extractSellerFromCard(li, priceText);
      const sellerCount = sellerMatch ? parseInt(sellerMatch[1], 10) : (sellers.length || ( /TEK FİYAT/i.test(bodyText) ? 1 : 0));
      cards.push({
        title,
        detailUrl: pickCardDetailUrl(li),
        price: cleanPriceText(priceText),
        sellers,
        sellersTotalCount: sellerCount || sellers.length,
        singleOffer: !sellerMatch && (sellers.length === 1 || /TEK FİYAT/i.test(bodyText)),
      });
    }
    return cards;
  }
  function enrichResultsFromDom(results) {
    const cards = collectDomProductCards();
    if (cards.length === 0) return;
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      let card = cards[i];
      const rKey = titleKey(result.title);
      if (!card || !rKey || !(titleKey(card.title).includes(rKey.slice(0, 35)) || rKey.includes(titleKey(card.title).slice(0, 35)))) {
        card = findCardForResult(result, cards);
      }
      if (!card) continue;
      if ((!result.sellers || result.sellers.length === 0) && card.sellers.length > 0) {
        result.sellers = card.sellers;
        result.sellersTotalCount = card.sellersTotalCount || card.sellers.length;
        result.singleOffer = card.singleOffer || (card.sellers.length === 1 && (card.sellersTotalCount <= 1 || !card.sellersTotalCount));
        if (card.sellers.length === 1) result.sellerCountText = '1 Satıcı';
      }
      if (!result.detailUrl && card.detailUrl) result.detailUrl = card.detailUrl;
      if ((!result.price || result.price === '') && card.price) result.price = card.price;
      if (card.singleOffer && !result.singleOffer) result.singleOffer = true;
    }
  }
  function buildResultFromProduct(p) {
    const sellers = extractSellersFromProduct(p);
    const detailUrl = pickProductUrl(p);
    const count = p.countOfPrices || sellers.length || 0;
    const isSingle = count <= 1 || sellers.length === 1;
    return {
      title: p.name,
      detailUrl,
      price: formatPrice(p.price),
      code: p.code || p.id || '',
      sellerCountText: count > 1 ? (count + ' Satıcı') : (isSingle ? '1 Satıcı' : ''),
      sellers,
      sellersTotalCount: count || sellers.length,
      singleOffer: isSingle,
      source: 'astro-island',
    };
  }

  const results = [];

  // Strateji 1 (birincil): sayfaya gömülü Astro island JSON verisi
  try {
    const islands = readIslandData();
    const products = collectProductsFromIslands(islands);
    for (const p of products) {
      results.push(buildResultFromProduct(p));
    }
    if (results.length > 0) enrichResultsFromDom(results);
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
            const sellers = [];
            if (offers.seller && offers.seller.name) {
              sellers.push({
                name: offers.seller.name,
                price: offers.price || offers.lowPrice || '',
              });
            }
            results.push({
              title: item.name || '',
              detailUrl: item.url ? absUrl(item.url) : '',
              price: offers.price || offers.lowPrice || '',
              sellerCountText: offers.offerCount ? (offers.offerCount + ' Satıcı') : (sellers.length ? '1 Satıcı' : ''),
              sellers,
              sellersTotalCount: offers.offerCount || sellers.length || 0,
              singleOffer: sellers.length === 1,
              source: 'jsonld',
            });
          }
        }
      }
    } catch (e) {}
  }

  // Strateji 3 (yedek): bilinen DOM seçicileri
  if (results.length === 0) {
    const items = Array.from(document.querySelectorAll('#APL > li, .search_v8 li, ul.pl_v9 > li, ul[id="APL"] li, li[class*="product"], div[class*="product-card"]'));
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
      const sellers = extractSellerFromCard(li, priceText);
      results.push({
        title,
        detailUrl: absUrl(href),
        price: cleanPriceText(priceText),
        sellerCountText: sellerMatch ? sellerMatch[0] : (sellers.length === 1 ? '1 Satıcı' : ''),
        sellers,
        sellersTotalCount: sellerMatch ? parseInt(sellerMatch[1], 10) : sellers.length,
        singleOffer: sellers.length === 1 && (!sellerMatch || sellerMatch[1] === '1'),
        source: 'dom',
      });
    }
  }

  // Strateji 4 (son çare): genel bağlantı sezgisi
  if (results.length === 0) {
    const anchors = Array.from(document.querySelectorAll('a[href$=".html"]'));
    const seen = new Set();
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      if (!href || seen.has(href)) continue;
      if (!/\\/(arama|magaza|satici|c|fiyati|fiyatlari)\\//i.test(href) && !/,/.test(href)) continue;
      const title = a.getAttribute('title') || textOf(a);
      if (!title || title.length < 3) continue;
      seen.add(href);
      const container = a.closest('li, article, div') || a;
      const bodyText = textOf(container);
      const sellerMatch = bodyText.match(/(\\d+)\\s*Sat[ıi]c[ıi]/i);
      const priceMatch = bodyText.match(/([\\d.]+,[\\d]{2})\\s*TL/i);
      const priceText = priceMatch ? priceMatch[0] : '';
      const sellers = extractSellerFromCard(container, priceText);
      results.push({
        title,
        detailUrl: absUrl(href),
        price: cleanPriceText(priceText),
        sellerCountText: sellerMatch ? sellerMatch[0] : (sellers.length === 1 ? '1 Satıcı' : ''),
        sellers,
        sellersTotalCount: sellerMatch ? parseInt(sellerMatch[1], 10) : sellers.length,
        singleOffer: sellers.length === 1,
        source: 'anchor-fallback',
      });
    }
  }

  // Tek teklifli ürünlerde karşılaştırma URL'si olmayabilir; satıcı bilgisi
  // arama/kategori sayfasının kendisindedir — mevcut sayfayı yedek URL yap.
  if (results.length === 1) {
    const only = results[0];
    if (!only.detailUrl) only.detailUrl = location.href;
    if (only.sellers && only.sellers.length > 0) {
      only.singleOffer = true;
    } else if (!only.sellerCountText || /^1\\s*Sat/i.test(only.sellerCountText)) {
      only.singleOffer = true;
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

  function normKey(s) {
    return (s || '').toLocaleLowerCase('tr-TR').replace(/\\s+/g, ' ').trim();
  }

  function formatPrice(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '';
    return n.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' TL';
  }

  // Pazaryeri (vdName) ile mağaza adını (pgNick) birleştirir.
  // Akakçe arayüzünde "n11 / teknobiyotik" şeklinde gösterildiği gibi.
  function formatSellerLabel(offer) {
    if (!offer) return '';
    const platform = String(offer.vdName || '').trim();
    const store = String(offer.pgNick || offer.pgName || '').trim();
    if (platform && store && normKey(platform) !== normKey(store)) {
      return platform + ' / ' + store;
    }
    return platform || store;
  }

  function formatSellerEntry(offer) {
    const name = formatSellerLabel(offer);
    if (!name) return null;
    const rawPrice = offer && (offer.price ?? offer.minPrice ?? offer.spotPrice);
    const price = typeof rawPrice === 'number' ? formatPrice(rawPrice) : '';
    return { name, price };
  }

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
        sellers = root.initialPgList.map((o) => formatSellerEntry(o)).filter(Boolean);
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
      if (root.spotPg && root.spotPg.pgNick) contentParts.push(root.spotPg.pgNick);
      // Tek teklifli ürünler: karşılaştırma listesi yok, spotPg tek satıcıdır.
      if (sellers.length === 0 && root.spotPg) {
        const entry = formatSellerEntry(root.spotPg);
        if (entry) {
          sellers = [entry];
          totalCount = 1;
        }
      }
    }
  } catch (e) {}

  const h1 = document.querySelector('#pd_v8 h1, .pdt_v8 h1, h1');
  if (h1) contentParts.push(textOf(h1));

  const contentText = contentParts.join(' ');

  // Strateji 2 (yedek): teklif satırı metninden platform / mağaza adı
  if (sellers.length === 0) {
    const seen = new Set();
    const rows = Array.from(document.querySelectorAll('li, tr, div[class*="offer"], div[class*="slc"]'));
    for (const row of rows) {
      const rowText = textOf(row);
      if (!/sat[ıi]c[ıi]ya git|sepete ekle|\\d+[.,]\\d{2}\\s*TL/i.test(rowText)) continue;
      const slashMatch = rowText.match(/Sat[ıi]c[ıi]ya Git\\s+([^\\d]+?)\\s*\\/\\s*([A-Za-z0-9ğüşıöçĞÜŞİÖÇ._ -]{2,40})/i);
      const priceMatch = rowText.match(/([\\d.]+,[\\d]{2})\\s*TL/i);
      const priceText = priceMatch ? priceMatch[0] : '';
      if (slashMatch) {
        const label = slashMatch[1].trim() + ' / ' + slashMatch[2].trim();
        if (!seen.has(normKey(label))) {
          seen.add(normKey(label));
          sellers.push({ name: label, price: priceText });
        }
        continue;
      }
      const img = row.querySelector('img[alt]');
      const alt = img ? (img.getAttribute('alt') || '').trim() : '';
      if (!alt || alt.length < 2 || alt.length > 40 || /^\\d+$/.test(alt)) continue;
      if (/akak[cç]e|logo|icon|fiyat grafi/i.test(alt)) continue;
      if (!seen.has(normKey(alt))) {
        seen.add(normKey(alt));
        sellers.push({ name: alt, price: priceText });
      }
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

  async _runWithRetry(task, { retryOnEmpty = false } = {}) {
    let lastResult = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      lastResult = await task();
      const blocked = !!lastResult.cloudflareBlocked;
      const hasError = !!lastResult.error;
      const emptyResults = Array.isArray(lastResult.results) && lastResult.results.length === 0;
      const shouldRetry =
        attempt < MAX_RETRIES && (blocked || hasError || (retryOnEmpty && emptyResults));
      if (!shouldRetry) {
        lastResult.retriesUsed = attempt;
        return lastResult;
      }
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
    return lastResult;
  }

  async _searchOnce(term) {
    const url = searchUrl(term);
    const win = this._getWindow();
    try {
      await win.loadURL(url);
    } catch (e) {
      return { term, url, cloudflareBlocked: false, error: e.message, results: [] };
    }
    const waitResult = await this._waitForReadyState(
      `(function() {
        const hasIsland = !!document.querySelector('astro-island[props]');
        const cards = document.querySelectorAll('#APL > li, ul[id="APL"] li, .search_v8 li');
        let priced = 0;
        let withSeller = 0;
        for (const li of cards) {
          const text = (li.textContent || '').replace(/\\s+/g, ' ');
          if (/\\d+[.,]\\d{2}\\s*TL/i.test(text)) priced += 1;
          if (/kargo/i.test(text) || li.querySelector('a.iC, span.l b, .l b')) withSeller += 1;
        }
        return hasIsland && priced > 0 && (withSeller > 0 || priced >= 2);
      })()`
    );
    const extractResults = async () => {
      try {
        return await win.webContents.executeJavaScript(EXTRACT_SEARCH_RESULTS_JS);
      } catch (e) {
        return { results: [] };
      }
    };
    let data = await extractResults();
    const needsSellerRetry = (results) =>
      Array.isArray(results) &&
      results.some((r) => {
        const likelySingle =
          r.singleOffer || r.sellerCountText === '1 Satıcı' || /TEK\\s*F[Iİ]YAT/i.test(r.price || '');
        const missingSellers = !Array.isArray(r.sellers) || r.sellers.length === 0;
        return likelySingle && missingSellers;
      });
    if (needsSellerRetry(data.results)) {
      await new Promise((r) => setTimeout(r, 2000));
      data = await extractResults();
    }
    return {
      term,
      url,
      cloudflareBlocked: !waitResult.ok && (!data.results || data.results.length === 0),
      results: data.results || [],
    };
  }

  async _getSellersOnce(detailUrl) {
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
  }

  async searchProduct(term) {
    return this._enqueue(() => this._runWithRetry(() => this._searchOnce(term), { retryOnEmpty: true }));
  }

  async getSellers(detailUrl) {
    return this._enqueue(() => this._runWithRetry(() => this._getSellersOnce(detailUrl)));
  }
}

module.exports = new AkakceScraper();
