(function () {
  const api = window.akakceAPI;
  const MATCH_THRESHOLD = 80;
  const SETTINGS_STORAGE_KEY = 'akakce-app-settings';
  const DEFAULT_SETTINGS = {
    maxProducts: 10,
    maxSellers: 5,
    skipTitleThreshold: 50,
    defaultSort: 'rank',
    hideBelowEnabled: true,
    hideBelowThreshold: 30,
  };

  let appSettings = loadAppSettings();

  function clampNumber(value, min, max, fallback) {
    const num = parseInt(value, 10);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, num));
  }

  function loadAppSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (!raw) return { ...DEFAULT_SETTINGS };
      const parsed = JSON.parse(raw);
      return {
        maxProducts: clampNumber(parsed.maxProducts, 1, 40, DEFAULT_SETTINGS.maxProducts),
        maxSellers: clampNumber(parsed.maxSellers, 1, 30, DEFAULT_SETTINGS.maxSellers),
        skipTitleThreshold: clampNumber(parsed.skipTitleThreshold, 0, 100, DEFAULT_SETTINGS.skipTitleThreshold),
        defaultSort: ['rank', 'similarity-desc', 'price-asc', 'price-desc'].includes(parsed.defaultSort)
          ? parsed.defaultSort
          : DEFAULT_SETTINGS.defaultSort,
        hideBelowEnabled: typeof parsed.hideBelowEnabled === 'boolean'
          ? parsed.hideBelowEnabled
          : DEFAULT_SETTINGS.hideBelowEnabled,
        hideBelowThreshold: clampNumber(
          parsed.hideBelowThreshold,
          0,
          100,
          DEFAULT_SETTINGS.hideBelowThreshold
        ),
      };
    } catch (e) {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveAppSettings(nextSettings) {
    appSettings = {
      maxProducts: clampNumber(nextSettings.maxProducts, 1, 40, DEFAULT_SETTINGS.maxProducts),
      maxSellers: clampNumber(nextSettings.maxSellers, 1, 30, DEFAULT_SETTINGS.maxSellers),
      skipTitleThreshold: clampNumber(nextSettings.skipTitleThreshold, 0, 100, DEFAULT_SETTINGS.skipTitleThreshold),
      defaultSort: ['rank', 'similarity-desc', 'price-asc', 'price-desc'].includes(nextSettings.defaultSort)
        ? nextSettings.defaultSort
        : DEFAULT_SETTINGS.defaultSort,
      hideBelowEnabled:
        typeof nextSettings.hideBelowEnabled === 'boolean'
          ? nextSettings.hideBelowEnabled
          : DEFAULT_SETTINGS.hideBelowEnabled,
      hideBelowThreshold: clampNumber(
        nextSettings.hideBelowThreshold,
        0,
        100,
        DEFAULT_SETTINGS.hideBelowThreshold
      ),
    };
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(appSettings));
    applyAppSettingsToUi();
  }

  function updateSkipOptionLabel() {
    const labelEl = document.getElementById('opt-skip-low-content-label');
    if (labelEl) {
      labelEl.textContent = `Düşük yakınlıkta detay taramasını atla (başlık < %${getSkipTitleThreshold()})`;
    }
  }

  function reapplySkipRulesToResults(results) {
    if (!Array.isArray(results)) return;
    for (const result of results) {
      if (shouldSkipDetailScan(result)) {
        markDetailScanSkipped(result);
      } else {
        result.sellersSkipped = false;
      }
    }
  }

  function getHideBelowThreshold() {
    return appSettings.hideBelowThreshold;
  }

  function updateHideBelowLabel() {
    const labelEl = document.getElementById('single-hide-below-label');
    if (labelEl) {
      labelEl.textContent = `%${getHideBelowThreshold()} altını gizle`;
    }
  }

  function syncHideBelowFromSavedSettings() {
    appSettings = loadAppSettings();
    updateHideBelowLabel();
    if (singleHideBelowEl) singleHideBelowEl.checked = appSettings.hideBelowEnabled;
    if (settingsHideBelowEnabledEl) settingsHideBelowEnabledEl.checked = appSettings.hideBelowEnabled;
    if (settingsHideBelowThresholdEl) {
      settingsHideBelowThresholdEl.value = String(appSettings.hideBelowThreshold);
    }
  }

  function applyAppSettingsToUi() {
    updateSkipOptionLabel();
    updateHideBelowLabel();
    if (settingsMaxProductsEl) settingsMaxProductsEl.value = String(appSettings.maxProducts);
    if (settingsMaxSellersEl) settingsMaxSellersEl.value = String(appSettings.maxSellers);
    if (settingsSkipThresholdEl) settingsSkipThresholdEl.value = String(appSettings.skipTitleThreshold);
    if (settingsDefaultSortEl) settingsDefaultSortEl.value = appSettings.defaultSort;
    if (settingsHideBelowEnabledEl) settingsHideBelowEnabledEl.checked = appSettings.hideBelowEnabled;
    if (settingsHideBelowThresholdEl) {
      settingsHideBelowThresholdEl.value = String(appSettings.hideBelowThreshold);
    }
    if (singleHideBelowEl) singleHideBelowEl.checked = appSettings.hideBelowEnabled;
  }

  function readSettingsFormValues() {
    return {
      maxProducts: settingsMaxProductsEl ? settingsMaxProductsEl.value : DEFAULT_SETTINGS.maxProducts,
      maxSellers: settingsMaxSellersEl ? settingsMaxSellersEl.value : DEFAULT_SETTINGS.maxSellers,
      skipTitleThreshold: settingsSkipThresholdEl ? settingsSkipThresholdEl.value : DEFAULT_SETTINGS.skipTitleThreshold,
      defaultSort: settingsDefaultSortEl ? settingsDefaultSortEl.value : DEFAULT_SETTINGS.defaultSort,
      hideBelowEnabled: settingsHideBelowEnabledEl
        ? settingsHideBelowEnabledEl.checked
        : DEFAULT_SETTINGS.hideBelowEnabled,
      hideBelowThreshold: settingsHideBelowThresholdEl
        ? settingsHideBelowThresholdEl.value
        : DEFAULT_SETTINGS.hideBelowThreshold,
    };
  }

  function showSettingsStatus(message, isError) {
    if (!settingsStatusEl) return;
    settingsStatusEl.textContent = message;
    settingsStatusEl.hidden = !message;
    settingsStatusEl.classList.toggle('is-error', !!isError);
  }

  function getMaxProducts() {
    return appSettings.maxProducts;
  }

  function getMaxSellersShown() {
    return appSettings.maxSellers;
  }

  function getSkipTitleThreshold() {
    return appSettings.skipTitleThreshold;
  }

  function getDefaultSort() {
    return appSettings.defaultSort;
  }

  const scanOptions = {
    skipLowContentScan: true,
  };

  let singleScanContext = null;
  let multiOutcomes = [];
  let singleScanControl = null;
  let multiScanControl = null;

  function createScanController() {
    return { paused: false, cancelled: false };
  }

  async function awaitScanControl(ctrl) {
    if (!ctrl) return;
    while (ctrl.paused && !ctrl.cancelled) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  function isScanCancelled(ctrl) {
    return !!(ctrl && ctrl.cancelled);
  }

  function updateScanControlUi(ctrl, buttons) {
    const { primaryBtn, pauseBtn, resumeBtn, cancelBtn, extraDisable } = buttons;
    const running = !!ctrl && !ctrl.cancelled;
    if (primaryBtn) primaryBtn.disabled = running;
    if (extraDisable) extraDisable.forEach((el) => { if (el) el.disabled = running; });
    if (!running) {
      if (pauseBtn) pauseBtn.hidden = true;
      if (resumeBtn) resumeBtn.hidden = true;
      if (cancelBtn) cancelBtn.hidden = true;
      return;
    }
    if (cancelBtn) cancelBtn.hidden = false;
    if (ctrl.paused) {
      if (pauseBtn) pauseBtn.hidden = true;
      if (resumeBtn) resumeBtn.hidden = false;
    } else {
      if (pauseBtn) pauseBtn.hidden = false;
      if (resumeBtn) resumeBtn.hidden = true;
    }
  }

  // ------------------------------------------------------------------ //
  // Yardımcılar
  // ------------------------------------------------------------------ //
  function normalize(text) {
    if (!text) return '';
    return text
      .toLocaleLowerCase('tr-TR')
      .replace(/İ/g, 'i')
      .replace(/ı/g, 'i')
      .replace(/ş/g, 's')
      .replace(/ğ/g, 'g')
      .replace(/ü/g, 'u')
      .replace(/ö/g, 'o')
      .replace(/ç/g, 'c')
      .replace(
        /(\d+(?:[.,]\d+)?)\s*(ghz|mhz|gb|tb|mb|mm|cm|inch|w|v|mah)\b/g,
        (_, num, unit) => num.replace(/[.,]/g, '') + unit
      )
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function tokenizeForSimilarity(text) {
    return normalize(text).split(' ').filter(Boolean);
  }

  function isSignificantToken(token) {
    if (!token) return false;
    if (token.length >= 3) return true;
    return /[a-z]\d|\d[a-z]/.test(token);
  }

  function tokenWeight(token) {
    if (/\d{3,}/.test(token)) return 3;
    if (/\d/.test(token) && /[a-z]/.test(token)) return 2.5;
    if (/\d/.test(token)) return 2;
    if (token.length >= 4) return 1.2;
    return 1;
  }

  function isSafeFuzzyTokenMatch(a, b) {
    if (a === b) return true;
    const shorter = a.length <= b.length ? a : b;
    const longer = a.length <= b.length ? b : a;
    if (shorter.length < 3) return false;
    if (/^\d+$/.test(shorter)) return false;
    if (/\d/.test(shorter) && /\d/.test(longer)) {
      if (!longer.includes(shorter)) return false;
      return shorter.length / longer.length >= 0.65;
    }
    if (shorter.length >= 4 && longer.includes(shorter)) return true;
    if (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a))) return true;
    return false;
  }

  function tokenMatches(termToken, titleTokens) {
    if (titleTokens.includes(termToken)) return true;
    if (!isSignificantToken(termToken)) return false;
    if (/^\d+$/.test(termToken)) return false;
    return titleTokens.some((tt) => isSafeFuzzyTokenMatch(termToken, tt));
  }

  function weightedTokenOverlapScore(termTokens, titleTokens) {
    const significant = termTokens.filter(isSignificantToken);
    if (significant.length === 0) return 0;
    let matchedWeight = 0;
    let totalWeight = 0;
    for (const token of significant) {
      const weight = tokenWeight(token);
      totalWeight += weight;
      if (tokenMatches(token, titleTokens)) matchedWeight += weight;
    }
    return totalWeight > 0 ? matchedWeight / totalWeight : 0;
  }

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function parsePriceNumber(priceText) {
    if (!priceText) return NaN;
    const cleaned = String(priceText).replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.');
    const num = parseFloat(cleaned);
    return Number.isFinite(num) ? num : NaN;
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const totalSec = Math.ceil(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    if (min <= 0) return `~${sec} sn kaldı`;
    return `~${min} dk ${sec} sn kaldı`;
  }

  function sellerName(seller) {
    if (!seller) return '';
    return typeof seller === 'string' ? seller : seller.name || '';
  }

  function sellerPrice(seller) {
    if (!seller || typeof seller === 'string') return '';
    return seller.price || '';
  }

  function mergeRanges(ranges) {
    if (ranges.length === 0) return [];
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [ranges[0]];
    for (let i = 1; i < ranges.length; i++) {
      const last = merged[merged.length - 1];
      const cur = ranges[i];
      if (cur[0] <= last[1]) {
        last[1] = Math.max(last[1], cur[1]);
      } else {
        merged.push(cur);
      }
    }
    return merged;
  }

  function highlightTitle(term, title) {
    const safeTitle = title || '(Başlık bulunamadı)';
    if (!term || !safeTitle) return escapeHtml(safeTitle);
    const tokens = [...new Set(term.split(/\s+/).map((t) => t.trim()).filter((t) => t.length >= 2))];
    if (tokens.length === 0) return escapeHtml(safeTitle);

    const lowerTitle = safeTitle.toLocaleLowerCase('tr-TR');
    const ranges = [];
    for (const token of tokens) {
      const lowerToken = token.toLocaleLowerCase('tr-TR');
      let idx = 0;
      while ((idx = lowerTitle.indexOf(lowerToken, idx)) !== -1) {
        ranges.push([idx, idx + token.length]);
        idx += 1;
      }
    }
    const merged = mergeRanges(ranges);
    if (merged.length === 0) return escapeHtml(safeTitle);

    let html = '';
    let cursor = 0;
    for (const [start, end] of merged) {
      html += escapeHtml(safeTitle.slice(cursor, start));
      html += `<mark>${escapeHtml(safeTitle.slice(start, end))}</mark>`;
      cursor = end;
    }
    html += escapeHtml(safeTitle.slice(cursor));
    return html;
  }

  function levenshteinDistance(a, b) {
    const m = a.length;
    const n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const dp = new Array(n + 1);
    for (let j = 0; j <= n; j++) dp[j] = j;
    for (let i = 1; i <= m; i++) {
      let prev = dp[0];
      dp[0] = i;
      for (let j = 1; j <= n; j++) {
        const temp = dp[j];
        dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
        prev = temp;
      }
    }
    return dp[n];
  }

  function levenshteinSimilarity(a, b) {
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1;
    return 1 - levenshteinDistance(a, b) / maxLen;
  }

  function tokenOverlapScore(termTokens, titleTokens) {
    return weightedTokenOverlapScore(termTokens, titleTokens);
  }

  function computeSimilarity(term, title) {
    const nTerm = normalize(term);
    const nTitle = normalize(title);
    if (!nTerm || !nTitle) return 0;
    if (nTitle.includes(nTerm)) return 100;

    const termTokens = tokenizeForSimilarity(term);
    const titleTokens = tokenizeForSimilarity(title);
    const tokenScore = weightedTokenOverlapScore(termTokens, titleTokens);

    const termCore = termTokens.filter(isSignificantToken).join(' ');
    const titleCore = titleTokens.filter(isSignificantToken).join(' ');
    let bestWindowScore = 0;
    if (termCore && titleCore) {
      if (titleCore.length <= termCore.length) {
        bestWindowScore = levenshteinSimilarity(termCore, titleCore);
      } else {
        const winLen = termCore.length;
        for (let i = 0; i + winLen <= titleCore.length; i++) {
          const score = levenshteinSimilarity(termCore, titleCore.slice(i, i + winLen));
          if (score > bestWindowScore) bestWindowScore = score;
        }
      }
    }

    let combined = Math.max(tokenScore * 0.95, 0.55 * tokenScore + 0.45 * bestWindowScore);

    const modelNumbers = termTokens.filter((t) => /\d{3,}/.test(t));
    if (
      modelNumbers.length > 0 &&
      modelNumbers.every((model) => titleTokens.some((tt) => tt === model || tt.includes(model)))
    ) {
      combined = Math.max(combined, tokenScore >= 0.55 ? 0.82 : combined);
    }

    return Math.round(Math.min(1, Math.max(0, combined)) * 100);
  }

  function similarityTier(percent) {
    if (percent >= MATCH_THRESHOLD) return 'high';
    if (percent >= 50) return 'medium';
    return 'low';
  }

  function applySimilarityBadge(similarityBadge, result, row) {
    similarityBadge.classList.remove('badge-high', 'badge-medium', 'badge-low', 'badge-loading');
    similarityBadge.title = '';

    const tier = similarityTier(result.similarity);
    const label = result.similarityUsesContent
      ? `%${result.similarity} yakınlık (içerik)`
      : `%${result.similarity} yakınlık`;
    similarityBadge.textContent = result.contentScanPending ? `${label} · taranıyor` : label;

    if (result.similarityScannedContent || result.similarityContent > 0) {
      similarityBadge.title = `Başlık: %${result.similarityTitle ?? result.similarity}, detay içeriği: %${result.similarityContent ?? 0}`;
    }

    similarityBadge.classList.add('badge-' + tier);
    if (row) row.classList.toggle('is-match', tier === 'high');
  }

  function initTitleSimilarity(term, result) {
    const titleSim = computeSimilarity(term, result.title || '');
    result.similarity = titleSim;
    result.similarityTitle = titleSim;
    result.similarityContent = 0;
    result.similarityUsesContent = false;
    result.similarityScannedContent = false;
    result.contentScanPending = !!result.detailUrl;
    result.sellersSkipped = false;
  }

  function enhanceSimilarityFromContent(term, result, contentText) {
    const titleSim = result.similarityTitle ?? computeSimilarity(term, result.title || '');
    result.similarityTitle = titleSim;
    const contentSim = contentText ? computeSimilarity(term, contentText) : 0;
    result.similarityContent = contentSim;
    result.contentScanPending = false;
    result.similarityScannedContent = !!contentText;

    if (contentSim > titleSim) {
      const canUseContentBoost =
        titleSim >= getSkipTitleThreshold() || contentSim >= 75;
      if (canUseContentBoost) {
        const capped = Math.min(contentSim, titleSim + 15);
        result.similarity = Math.max(titleSim, capped);
        result.similarityUsesContent = result.similarity > titleSim;
      } else {
        result.similarity = titleSim;
        result.similarityUsesContent = false;
      }
    } else {
      result.similarity = titleSim;
      result.similarityUsesContent = false;
    }
  }

  function shouldSkipDetailScan(result) {
    if (!scanOptions.skipLowContentScan) return false;
    const titleSim = result.similarityTitle ?? result.similarity ?? 0;
    return titleSim < getSkipTitleThreshold();
  }

  function markDetailScanSkipped(result) {
    result.sellersSkipped = true;
    result.sellersLoading = false;
    result.contentScanPending = false;
    result.sellersError = false;
  }

  function getSellerCountNumber(result) {
    if (result.sellersTotalCount) return result.sellersTotalCount;
    const text = result.sellerCountText || '';
    const match = text.match(/(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  }

  function hasMultipleSellers(result) {
    if (result.sellersTotalCount > 1) return true;
    if (result.sellersTotalCount === 1) return false;
    if (Array.isArray(result.sellers) && result.sellers.length > 1) return true;
    if (Array.isArray(result.sellers) && result.sellers.length === 1) return false;
    if (!result.detailUrl) return false;
    return getSellerCountNumber(result) > 1;
  }

  function hasPrefetchedSellers(result) {
    return Array.isArray(result.sellers) && result.sellers.length > 0;
  }

  function isComparisonDetailUrl(url) {
    return /,\d+\.html(?:[?#]|$)/i.test(url || '');
  }

  function isRedirectDetailUrl(url) {
    return /\/c\/\?/i.test(url || '');
  }

  function looksLikeSingleOffer(result) {
    return !!(
      result.singleOffer ||
      result.sellerCountText === '1 Satıcı' ||
      result.sellersTotalCount === 1 ||
      /TEK\s*F[İI]YAT/i.test(result.price || '')
    );
  }

  function shouldUsePrefetchedSellers(result) {
    if (!hasPrefetchedSellers(result)) return false;
    return (
      looksLikeSingleOffer(result) ||
      !isComparisonDetailUrl(result.detailUrl) ||
      isRedirectDetailUrl(result.detailUrl)
    );
  }

  function getFilterSortSettings(prefix) {
    const sortEl = document.getElementById(`${prefix}-sort`);
    const simEl = document.getElementById(`${prefix}-filter-sim`);
    const multiEl = document.getElementById(`${prefix}-filter-multi-seller`);
    return {
      sort: sortEl ? sortEl.value : 'rank',
      minSimilarity: simEl ? parseInt(simEl.value, 10) : 0,
      multiSellerOnly: multiEl ? multiEl.checked : false,
      hideBelowEnabled: singleHideBelowEl
        ? singleHideBelowEl.checked
        : appSettings.hideBelowEnabled,
      hideBelowThreshold: getHideBelowThreshold(),
    };
  }

  function filterAndSortResults(results, settings) {
    let list = results.map((r, idx) => ({ ...r, akakceRank: r.akakceRank ?? idx + 1 }));
    if (settings.minSimilarity > 0) {
      list = list.filter((r) => r.similarity >= settings.minSimilarity);
    }
    if (settings.hideBelowEnabled && settings.hideBelowThreshold > 0) {
      list = list.filter((r) => r.similarity >= settings.hideBelowThreshold);
    }
    if (settings.multiSellerOnly) {
      list = list.filter((r) => hasMultipleSellers(r));
    }
    switch (settings.sort) {
      case 'similarity-desc':
        list.sort((a, b) => b.similarity - a.similarity || a.akakceRank - b.akakceRank);
        break;
      case 'price-asc':
        list.sort((a, b) => {
          const pa = parsePriceNumber(a.price);
          const pb = parsePriceNumber(b.price);
          if (Number.isNaN(pa) && Number.isNaN(pb)) return a.akakceRank - b.akakceRank;
          if (Number.isNaN(pa)) return 1;
          if (Number.isNaN(pb)) return -1;
          return pa - pb || a.akakceRank - b.akakceRank;
        });
        break;
      case 'price-desc':
        list.sort((a, b) => {
          const pa = parsePriceNumber(a.price);
          const pb = parsePriceNumber(b.price);
          if (Number.isNaN(pa) && Number.isNaN(pb)) return a.akakceRank - b.akakceRank;
          if (Number.isNaN(pa)) return 1;
          if (Number.isNaN(pb)) return -1;
          return pb - pa || a.akakceRank - b.akakceRank;
        });
        break;
      default:
        list.sort((a, b) => a.akakceRank - b.akakceRank);
    }
    return list;
  }

  function findBestMatch(results) {
    if (!results || results.length === 0) return null;
    let best = results[0];
    let bestIdx = 0;
    for (let i = 1; i < results.length; i++) {
      if (results[i].similarity > best.similarity) {
        best = results[i];
        bestIdx = i;
      }
    }
    return { result: best, rank: bestIdx + 1 };
  }

  function buildExportRows(outcomes) {
    const sellerCols = getMaxSellersShown() * 2;
    const header = [
      'Terim',
      'Akakçe Sırası',
      'Ürün',
      'Yakınlık %',
      'Fiyat',
      'Satıcı Sayısı',
      ...Array.from({ length: getMaxSellersShown() }, (_, i) => [`${i + 1}. Satıcı`, `${i + 1}. Fiyat`]).flat(),
      'Durum',
    ];
    const rows = [header];

    for (const outcome of outcomes) {
      const status = outcome.statusText || (outcome.cloudflareBlocked ? 'Cloudflare engeli' : 'Tamam');
      if (!outcome.results || outcome.results.length === 0) {
        rows.push([outcome.term, '', '', '', '', '', ...Array(sellerCols).fill(''), status]);
        continue;
      }
      outcome.results.forEach((result, idx) => {
        const sellers = (result.sellers || []).slice(0, getMaxSellersShown());
        const sellerCells = [];
        for (let i = 0; i < getMaxSellersShown(); i++) {
          const s = sellers[i];
          sellerCells.push(sellerName(s), sellerPrice(s));
        }
        rows.push([
          outcome.term,
          result.akakceRank ?? idx + 1,
          result.title || '',
          result.similarity ?? '',
          result.price || '',
          result.sellerCountText || result.sellersTotalCount || '',
          ...sellerCells,
          status,
        ]);
      });
    }
    return rows;
  }

  async function exportOutcomes(outcomes, defaultName) {
    if (!outcomes || outcomes.length === 0) return;
    const rows = buildExportRows(outcomes);
    const res = await api.exportExcel({ rows, defaultName });
    if (res && res.error) {
      alert('Dışa aktarma başarısız: ' + res.error);
    }
  }

  // ------------------------------------------------------------------ //
  // Başlık çubuğu kontrolleri
  // ------------------------------------------------------------------ //
  document.getElementById('btn-minimize').addEventListener('click', () => api.windowMinimize());
  document.getElementById('btn-close').addEventListener('click', () => api.windowClose());

  // ------------------------------------------------------------------ //
  // Görünüm (view) yönetimi
  // ------------------------------------------------------------------ //
  const views = {
    single: document.getElementById('view-single'),
    multi: document.getElementById('view-multi'),
    settings: document.getElementById('view-settings'),
    detail: document.getElementById('view-detail'),
  };
  const navButtons = Array.from(document.querySelectorAll('.nav-btn'));
  let activeView = 'single';
  let viewBeforeDetail = 'single';

  function showView(name) {
    Object.keys(views).forEach((key) => {
      views[key].hidden = key !== name;
    });
    activeView = name;
    navButtons.forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.view === name);
    });
    if (name !== 'detail') {
      teardownDetailBounds();
    }
  }

  navButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (activeView === 'detail') {
        closeDetailBrowser();
      }
      showView(btn.dataset.view);
    });
  });

  // ------------------------------------------------------------------ //
  // Sonuç satırı / satıcı tablosu render'ı
  // ------------------------------------------------------------------ //
  const rowTemplate = document.getElementById('tpl-result-row');

  function renderSellersInto(wrapperEl, result) {
    const titleEl = wrapperEl.querySelector('.sellers-title');
    const listEl = wrapperEl.querySelector('.sellers-list');
    listEl.innerHTML = '';
    const appendMsg = (text, cls) => {
      const li = document.createElement('li');
      li.className = cls;
      li.textContent = text;
      listEl.appendChild(li);
    };
    if (result.sellersLoading) {
      titleEl.textContent = 'Satıcılar';
      appendMsg('Satıcılar yükleniyor…', 'sellers-loading');
      return;
    }
    if (shouldSkipDetailScan(result)) {
      titleEl.textContent = 'Satıcılar';
      appendMsg(`Detay taraması atlandı (başlık yakınlığı <%${getSkipTitleThreshold()})`, 'sellers-empty');
      return;
    }
    if (result.sellersSkipped) {
      titleEl.textContent = 'Satıcılar';
      appendMsg(`Detay taraması atlandı (başlık yakınlığı <%${getSkipTitleThreshold()})`, 'sellers-empty');
      return;
    }
    if (result.sellersError) {
      titleEl.textContent = 'Satıcılar';
      appendMsg('Satıcı bilgisi alınamadı', 'sellers-empty');
      return;
    }
    const sellers = result.sellers || [];
    if (sellers.length === 0) {
      titleEl.textContent = 'Satıcılar';
      appendMsg(result.detailUrl ? 'Satıcı bulunamadı' : 'Satıcı bilgisi bulunamadı', 'sellers-empty');
      return;
    }
    const shown = sellers.slice(0, getMaxSellersShown());
    if (result.singleOffer || shown.length === 1) {
      titleEl.textContent = 'Satıcılar (tek teklif)';
    } else if (result.sellersTotalCount) {
      titleEl.textContent = `Satıcılar (ilk ${shown.length} / ${result.sellersTotalCount})`;
    } else {
      titleEl.textContent = `Satıcılar (ilk ${shown.length})`;
    }
    shown.forEach((seller, i) => {
      const li = document.createElement('li');
      const name = sellerName(seller);
      const price = sellerPrice(seller);
      li.innerHTML = `${i + 1}. Satıcı — <span class="seller-name">${escapeHtml(name)}</span>${
        price ? ` <span class="seller-price">— ${escapeHtml(price)}</span>` : ''
      }`;
      listEl.appendChild(li);
    });
  }

  function createResultRow(result, displayIndex, term) {
    const node = rowTemplate.content.firstElementChild.cloneNode(true);
    const rankLabel = result.akakceRank ? `#${result.akakceRank}` : `#${displayIndex + 1}`;
    node.querySelector('.result-rank').textContent = rankLabel;
    const titleEl = node.querySelector('.result-title');
    titleEl.innerHTML = highlightTitle(term, result.title || '(Başlık bulunamadı)');
    titleEl.title = result.title || '';
    const similarityBadge = node.querySelector('.badge-similarity');
    applySimilarityBadge(similarityBadge, result, node);
    renderSellersInto(node.querySelector('.result-sellers'), result);
    const detailBtn = node.querySelector('.btn-detail');
    if (result.detailUrl) {
      detailBtn.addEventListener('click', () => openDetailBrowser(result.detailUrl, activeView));
    } else {
      detailBtn.disabled = true;
    }
    return node;
  }

  function renderResultsList(containerEl, results, term, settings) {
    containerEl.innerHTML = '';
    const displayResults = settings ? filterAndSortResults(results, settings) : results;
    if (!displayResults || displayResults.length === 0) {
      const div = document.createElement('div');
      div.className = 'state-message';
      div.textContent = results && results.length > 0 ? 'Filtreye uygun sonuç yok.' : 'Sonuç bulunamadı.';
      containerEl.appendChild(div);
      return;
    }
    displayResults.forEach((result, index) => {
      containerEl.appendChild(createResultRow(result, index, term));
    });
  }

  function findResultRowIndex(containerEl, akakceRank) {
    const rows = containerEl.querySelectorAll('.result-row');
    for (let i = 0; i < rows.length; i++) {
      const rankEl = rows[i].querySelector('.result-rank');
      if (rankEl && rankEl.textContent === `#${akakceRank}`) return i;
    }
    return -1;
  }

  function updateSellerRowInPlace(containerEl, result, settings, term) {
    const rowIdx = findResultRowIndex(containerEl, result.akakceRank);
    if (rowIdx < 0) {
      if (settings && term) {
        renderResultsList(containerEl, containerEl._sourceResults || [result], term, settings);
      }
      return;
    }
    const rows = containerEl.querySelectorAll('.result-row');
    renderSellersInto(rows[rowIdx].querySelector('.result-sellers'), result);
  }

  function updateSimilarityRowInPlace(containerEl, result, settings, term) {
    const rowIdx = findResultRowIndex(containerEl, result.akakceRank);
    if (rowIdx < 0) {
      if (settings && term) {
        renderResultsList(containerEl, containerEl._sourceResults || [result], term, settings);
      }
      return;
    }
    const rows = containerEl.querySelectorAll('.result-row');
    const row = rows[rowIdx];
    const similarityBadge = row.querySelector('.badge-similarity');
    if (!similarityBadge) return;
    applySimilarityBadge(similarityBadge, result, row);
  }

  function finalizeStuckSimilarity(term, results, containerEl, summaryEl, settings) {
    let changed = false;
    for (const result of results) {
      if (!result.contentScanPending || shouldSkipDetailScan(result)) continue;
      enhanceSimilarityFromContent(term, result, '');
      updateSimilarityRowInPlace(containerEl, result, settings, term);
      changed = true;
    }
    if (changed && summaryEl) {
      renderSummary(summaryEl, buildSummary(results, false));
    }
  }

  async function enrichSellers(results, containerEl, options = {}) {
    const { term, summaryEl, settings, scanControl, onResultUpdated } = options;
    const shouldStop = () => isScanCancelled(scanControl);

    for (const result of results) {
      await awaitScanControl(scanControl);
      if (shouldStop()) break;

      if (shouldSkipDetailScan(result)) {
        markDetailScanSkipped(result);
        updateSellerRowInPlace(containerEl, result, settings, term);
        continue;
      }

      const canFetch = !!result.detailUrl && isComparisonDetailUrl(result.detailUrl);
      const usePrefetchOnly = shouldUsePrefetchedSellers(result);
      if (!canFetch && !usePrefetchOnly) continue;
      if (canFetch) {
        result.sellersLoading = true;
        updateSellerRowInPlace(containerEl, result, settings, term);
      }
    }

    for (const result of results) {
      await awaitScanControl(scanControl);
      if (shouldStop()) break;

      if (shouldSkipDetailScan(result)) {
        markDetailScanSkipped(result);
        if (term) {
          enhanceSimilarityFromContent(term, result, '');
          updateSimilarityRowInPlace(containerEl, result, settings, term);
        }
        updateSellerRowInPlace(containerEl, result, settings, term);
        if (onResultUpdated) onResultUpdated(result);
        continue;
      }

      if (shouldUsePrefetchedSellers(result)) {
        result.sellersLoading = false;
        result.contentScanPending = false;
        if (term) {
          enhanceSimilarityFromContent(term, result, '');
          updateSimilarityRowInPlace(containerEl, result, settings, term);
        }
        updateSellerRowInPlace(containerEl, result, settings, term);
        if (onResultUpdated) onResultUpdated(result);
        continue;
      }

      if (!result.detailUrl || !isComparisonDetailUrl(result.detailUrl)) {
        result.sellersLoading = false;
        if (hasPrefetchedSellers(result)) {
          updateSellerRowInPlace(containerEl, result, settings, term);
        } else if (looksLikeSingleOffer(result)) {
          result.sellersError = false;
          updateSellerRowInPlace(containerEl, result, settings, term);
        }
        continue;
      }

      result.sellersLoading = true;
      updateSellerRowInPlace(containerEl, result, settings, term);
      const backupSellers = (result.sellers || []).map((s) =>
        typeof s === 'string' ? { name: s, price: '' } : { ...s }
      );
      try {
        const res = await api.getSellers(result.detailUrl);
        if ((res.sellers || []).length > 0) {
          result.sellers = res.sellers;
          result.sellersTotalCount = res.totalCount || res.sellers.length;
        } else if (backupSellers.length > 0) {
          result.sellers = backupSellers;
          result.sellersTotalCount = result.sellersTotalCount || backupSellers.length;
        } else {
          result.sellers = [];
          result.sellersTotalCount = 0;
        }
        result.sellersLoading = false;
        result.sellersError = !!(
          res.cloudflareBlocked && !hasPrefetchedSellers(result) && result.sellers.length === 0
        );
        if (term) {
          enhanceSimilarityFromContent(term, result, res.contentText || '');
          updateSimilarityRowInPlace(containerEl, result, settings, term);
        }
      } catch (e) {
        result.sellersLoading = false;
        if (backupSellers.length > 0) {
          result.sellers = backupSellers;
          result.sellersError = false;
        } else {
          result.sellersError = true;
        }
        if (term) {
          enhanceSimilarityFromContent(term, result, '');
          updateSimilarityRowInPlace(containerEl, result, settings, term);
        }
      }
      updateSellerRowInPlace(containerEl, result, settings, term);
      if (onResultUpdated) onResultUpdated(result);
    }

    if (term && summaryEl) {
      renderSummary(summaryEl, buildSummary(results, false));
    }
  }

  // ------------------------------------------------------------------ //
  // Özet çipleri
  // ------------------------------------------------------------------ //
  function buildSummary(results, cloudflareBlocked) {
    const chips = [];
    if (cloudflareBlocked) {
      chips.push({ text: 'Cloudflare doğrulaması geçilemedi, otomatik yeniden denendi', type: 'danger' });
      return chips;
    }
    chips.push({ text: `${results.length} sonuç bulundu`, type: 'default' });
    const first = results[0];
    if (first) {
      if (first.contentScanPending) {
        chips.push({
          text: `İlk sonuç başlıkta %${first.similarity} — detay içeriği taranıyor…`,
          type: 'default',
        });
      } else {
        chips.push(
          first.similarity >= MATCH_THRESHOLD
            ? {
                text: first.similarityUsesContent
                  ? `İlk sonuç detay içeriğinde %${first.similarity} oranında eşleşti (başlık: %${first.similarityTitle})`
                  : `İlk sonuç %${first.similarity} oranında eşleşti`,
                type: 'success',
              }
            : {
                text: first.similarityUsesContent
                  ? `İlk sonuç detay içeriğinde %${first.similarity} oranında eşleşti (başlık: %${first.similarityTitle})`
                  : `İlk sonuç yalnızca %${first.similarity} oranında eşleşti`,
                type: 'danger',
              }
        );
      }
    }
    if (results.some((r) => r.contentScanPending)) {
      chips.push({ text: 'Bazı sonuçların detay içeriği taranıyor…', type: 'default' });
    }
    if (results.some((r) => r.sellersSkipped || shouldSkipDetailScan(r))) {
      chips.push({ text: 'Düşük yakınlıklı sonuçlarda detay taraması atlandı', type: 'default' });
    }
    if (results.slice(1).some((r) => !r.contentScanPending && r.similarity >= MATCH_THRESHOLD)) {
      chips.push({ text: 'Aranan değer başka sonuçlarda da geçiyor', type: 'default' });
    }
    const finalized = results.filter((r) => !r.contentScanPending);
    const nonMatching = finalized.filter((r) => r.similarity < MATCH_THRESHOLD).length;
    if (nonMatching > 0) {
      chips.push({ text: `${nonMatching} farklı/düşük yakınlıklı ürün listelendi`, type: 'default' });
    }
    return chips;
  }

  function renderSummary(containerEl, chips) {
    containerEl.innerHTML = '';
    if (!chips || chips.length === 0) {
      containerEl.hidden = true;
      return;
    }
    containerEl.hidden = false;
    chips.forEach((chip) => {
      const span = document.createElement('span');
      span.className =
        'chip' + (chip.type === 'success' ? ' chip-success' : chip.type === 'danger' ? ' chip-danger' : '');
      span.textContent = chip.text;
      containerEl.appendChild(span);
    });
  }

  // ------------------------------------------------------------------ //
  // Ortak arama çağrısı
  // ------------------------------------------------------------------ //
  async function performSearch(term) {
    const response = await api.search(term);
    const results = (response.results || []).slice(0, getMaxProducts()).map((r, idx) => {
      const prefetchedSellers = Array.isArray(r.sellers) ? r.sellers : [];
      const base = {
        ...r,
        akakceRank: idx + 1,
        sellers: prefetchedSellers,
        sellersTotalCount: r.sellersTotalCount || prefetchedSellers.length || 0,
        sellersLoading: false,
        sellersError: false,
        sellersSkipped: false,
        similarityUsesContent: false,
        similarityScannedContent: false,
        contentScanPending: false,
      };
      const result = { ...base };
      initTitleSimilarity(term, result);
      if (shouldSkipDetailScan(result)) {
        markDetailScanSkipped(result);
      } else if (hasPrefetchedSellers(result)) {
        result.contentScanPending = !!result.detailUrl && !result.singleOffer && isComparisonDetailUrl(result.detailUrl);
      } else if (looksLikeSingleOffer(result)) {
        result.sellersLoading = true;
      }
      return result;
    });
    return {
      term,
      results,
      cloudflareBlocked: !!response.cloudflareBlocked,
      error: response.error || null,
      retriesUsed: response.retriesUsed || 0,
    };
  }

  // ------------------------------------------------------------------ //
  // Tek Ürün Tarama
  // ------------------------------------------------------------------ //
  const singleForm = document.getElementById('single-search-form');
  const singleInput = document.getElementById('single-search-input');
  const singleBtn = document.getElementById('single-search-btn');
  const singlePauseBtn = document.getElementById('single-pause-btn');
  const singleResumeBtn = document.getElementById('single-resume-btn');
  const singleCancelBtn = document.getElementById('single-cancel-btn');
  const singleSummaryEl = document.getElementById('single-summary');
  const singleResultsEl = document.getElementById('single-results');
  const singleToolbarEl = document.getElementById('single-toolbar');
  const singleSortEl = document.getElementById('single-sort');
  const singleFilterSimEl = document.getElementById('single-filter-sim');
  const singleFilterMultiEl = document.getElementById('single-filter-multi-seller');
  const singleHideBelowEl = document.getElementById('single-hide-below');
  const singleExportBtn = document.getElementById('single-export-btn');
  const optSkipLowContentEl = document.getElementById('opt-skip-low-content');

  let singleStatusEl = null;

  function syncSingleScanControls() {
    updateScanControlUi(singleScanControl, {
      primaryBtn: singleBtn,
      pauseBtn: singlePauseBtn,
      resumeBtn: singleResumeBtn,
      cancelBtn: singleCancelBtn,
    });
    if (singleStatusEl && singleScanControl) {
      if (singleScanControl.cancelled) {
        singleStatusEl.textContent = 'Tarama iptal edildi.';
      } else if (singleScanControl.paused) {
        singleStatusEl.textContent = 'Tarama duraklatıldı. Devam Et ile sürdürebilirsiniz.';
      }
    }
  }

  singlePauseBtn.addEventListener('click', () => {
    if (singleScanControl) singleScanControl.paused = true;
    syncSingleScanControls();
  });
  singleResumeBtn.addEventListener('click', () => {
    if (singleScanControl) singleScanControl.paused = false;
    if (singleStatusEl) singleStatusEl.textContent = 'Satıcılar taranıyor…';
    syncSingleScanControls();
  });
  singleCancelBtn.addEventListener('click', () => {
    if (singleScanControl) {
      singleScanControl.cancelled = true;
      singleScanControl.paused = false;
    }
    syncSingleScanControls();
  });

  function resetSingleToolbarFilters() {
    if (singleSortEl) singleSortEl.value = getDefaultSort();
    if (singleFilterSimEl) singleFilterSimEl.value = 'all';
    if (singleFilterMultiEl) singleFilterMultiEl.checked = false;
    // Yakınlık eşiği ayarlardan kalıcıdır; sıralama ve diğer filtreler gibi sıfırlanmaz.
    updateHideBelowLabel();
  }

  function refreshSingleResultsView() {
    if (!singleScanContext) return;
    const settings = getFilterSortSettings('single');
    singleResultsEl._sourceResults = singleScanContext.results;
    renderResultsList(singleResultsEl, singleScanContext.results, singleScanContext.term, settings);
  }

  [singleSortEl, singleFilterSimEl, singleFilterMultiEl].forEach((el) => {
    el.addEventListener('change', refreshSingleResultsView);
  });
  singleFilterMultiEl.addEventListener('change', refreshSingleResultsView);

  if (singleHideBelowEl) {
    singleHideBelowEl.addEventListener('change', () => {
      appSettings.hideBelowEnabled = singleHideBelowEl.checked;
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(appSettings));
      if (settingsHideBelowEnabledEl) settingsHideBelowEnabledEl.checked = appSettings.hideBelowEnabled;
      refreshSingleResultsView();
    });
  }

  if (optSkipLowContentEl) {
    optSkipLowContentEl.addEventListener('change', () => {
      scanOptions.skipLowContentScan = optSkipLowContentEl.checked;
      if (singleScanContext && singleScanContext.results) {
        for (const result of singleScanContext.results) {
          if (shouldSkipDetailScan(result)) {
            markDetailScanSkipped(result);
          } else {
            result.sellersSkipped = false;
          }
        }
        refreshSingleResultsView();
        renderSummary(singleSummaryEl, buildSummary(singleScanContext.results, singleScanContext.cloudflareBlocked));
      }
    });
    scanOptions.skipLowContentScan = optSkipLowContentEl.checked;
  }

  // ------------------------------------------------------------------ //
  // Ayarlar
  // ------------------------------------------------------------------ //
  const settingsForm = document.getElementById('settings-form');
  const settingsMaxProductsEl = document.getElementById('setting-max-products');
  const settingsMaxSellersEl = document.getElementById('setting-max-sellers');
  const settingsSkipThresholdEl = document.getElementById('setting-skip-threshold');
  const settingsDefaultSortEl = document.getElementById('setting-default-sort');
  const settingsHideBelowEnabledEl = document.getElementById('setting-hide-below-enabled');
  const settingsHideBelowThresholdEl = document.getElementById('setting-hide-below-threshold');
  const settingsResetBtn = document.getElementById('settings-reset-btn');
  const settingsStatusEl = document.getElementById('settings-status');

  if (settingsForm) {
    applyAppSettingsToUi();

    settingsForm.addEventListener('submit', (event) => {
      event.preventDefault();
      saveAppSettings(readSettingsFormValues());
      if (singleScanContext && singleScanContext.results) {
        reapplySkipRulesToResults(singleScanContext.results);
        refreshSingleResultsView();
        renderSummary(singleSummaryEl, buildSummary(singleScanContext.results, singleScanContext.cloudflareBlocked));
      }
      for (const outcome of multiOutcomes) {
        if (outcome.results) reapplySkipRulesToResults(outcome.results);
      }
      showSettingsStatus('Ayarlar kaydedildi.', false);
    });

    if (settingsResetBtn) {
      settingsResetBtn.addEventListener('click', () => {
        saveAppSettings({ ...DEFAULT_SETTINGS });
        if (singleScanContext && singleScanContext.results) {
          reapplySkipRulesToResults(singleScanContext.results);
          refreshSingleResultsView();
          renderSummary(singleSummaryEl, buildSummary(singleScanContext.results, singleScanContext.cloudflareBlocked));
        }
        for (const outcome of multiOutcomes) {
          if (outcome.results) reapplySkipRulesToResults(outcome.results);
        }
        showSettingsStatus('Varsayılan ayarlara döndürüldü.', false);
      });
    }
  } else {
    updateSkipOptionLabel();
    updateHideBelowLabel();
    if (singleHideBelowEl) singleHideBelowEl.checked = appSettings.hideBelowEnabled;
  }

  singleExportBtn.addEventListener('click', () => {
    if (!singleScanContext) return;
    const settings = getFilterSortSettings('single');
    const filteredResults = filterAndSortResults(singleScanContext.results || [], settings);
    if (filteredResults.length === 0) {
      alert('Dışa aktarılacak filtrelenmiş sonuç yok.');
      return;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    exportOutcomes(
      [
        {
          term: singleScanContext.term,
          results: filteredResults,
          cloudflareBlocked: singleScanContext.cloudflareBlocked,
          statusText: 'Tamam',
        },
      ],
      `akakce-${singleScanContext.term.replace(/[^\w.-]+/g, '_')}-${stamp}.xlsx`
    );
  });

  singleForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const term = singleInput.value.trim();
    if (!term) return;

    syncHideBelowFromSavedSettings();
    resetSingleToolbarFilters();

    singleScanControl = createScanController();
    syncSingleScanControls();
    singleSummaryEl.hidden = true;
    singleToolbarEl.hidden = true;
    singleResultsEl.innerHTML = '';
    const loadingMsg = document.createElement('div');
    loadingMsg.className = 'state-message';
    loadingMsg.textContent = 'Aranıyor, Cloudflare doğrulaması bekleniyor olabilir…';
    singleResultsEl.appendChild(loadingMsg);
    singleStatusEl = loadingMsg;

    try {
      const outcome = await performSearch(term);
      if (isScanCancelled(singleScanControl)) {
        singleScanContext = outcome;
        singleResultsEl.innerHTML = '';
        const div = document.createElement('div');
        div.className = 'state-message';
        div.textContent = 'Tarama iptal edildi.';
        singleResultsEl.appendChild(div);
        return;
      }

      singleScanContext = outcome;
      const settings = getFilterSortSettings('single');
      singleResultsEl._sourceResults = outcome.results;
      renderResultsList(singleResultsEl, outcome.results, term, settings);
      renderSummary(singleSummaryEl, buildSummary(outcome.results, outcome.cloudflareBlocked));
      singleToolbarEl.hidden = outcome.results.length === 0;
      singleStatusEl = null;

      if (!outcome.cloudflareBlocked && outcome.results.length > 0) {
        await enrichSellers(outcome.results, singleResultsEl, {
          term,
          summaryEl: singleSummaryEl,
          settings,
          scanControl: singleScanControl,
          onResultUpdated: refreshSingleResultsView,
        });
        refreshSingleResultsView();
        if (isScanCancelled(singleScanControl)) {
          const chips = buildSummary(outcome.results, false);
          chips.push({ text: 'Satıcı taraması iptal edildi (kısmi sonuçlar gösteriliyor)', type: 'danger' });
          renderSummary(singleSummaryEl, chips);
        }
      } else {
        finalizeStuckSimilarity(term, outcome.results, singleResultsEl, singleSummaryEl, settings);
      }
    } catch (err) {
      singleScanContext = null;
      singleResultsEl.innerHTML = '';
      const div = document.createElement('div');
      div.className = 'state-message is-error';
      div.textContent = 'Tarama sırasında bir hata oluştu: ' + err.message;
      singleResultsEl.appendChild(div);
    } finally {
      singleScanControl = null;
      singleStatusEl = null;
      syncSingleScanControls();
    }
  });

  // ------------------------------------------------------------------ //
  // Çoklu Ürün Tarama
  // ------------------------------------------------------------------ //
  const multiPickBtn = document.getElementById('multi-pick-file-btn');
  const multiFileInfo = document.getElementById('multi-file-info');
  const multiStartBtn = document.getElementById('multi-start-btn');
  const multiPauseBtn = document.getElementById('multi-pause-btn');
  const multiResumeBtn = document.getElementById('multi-resume-btn');
  const multiCancelBtn = document.getElementById('multi-cancel-btn');
  const multiExportBtn = document.getElementById('multi-export-btn');
  const multiProgressEl = document.getElementById('multi-progress');
  const multiProgressFill = document.getElementById('multi-progress-fill');
  const multiProgressLabel = document.getElementById('multi-progress-label');
  const multiEtaEl = document.getElementById('multi-eta');
  const multiOverviewEl = document.getElementById('multi-overview');
  const multiOverviewBody = document.getElementById('multi-overview-body');
  const multiGroupsEl = document.getElementById('multi-groups');

  let loadedTerms = [];

  function renderOverviewRow(outcome) {
    const tr = document.createElement('tr');
    tr.dataset.term = outcome.term;

    if (outcome.cloudflareBlocked || outcome.error) {
      tr.innerHTML = `
        <td class="cell-term">${escapeHtml(outcome.term)}</td>
        <td class="cell-match">—</td>
        <td>—</td>
        <td>—</td>
        <td>—</td>
        <td>—</td>
        <td class="cell-status-err">${escapeHtml(outcome.statusText || 'Hata')}</td>
      `;
      return tr;
    }

    const best = findBestMatch(outcome.results);
    if (!best) {
      tr.innerHTML = `
        <td class="cell-term">${escapeHtml(outcome.term)}</td>
        <td class="cell-match">Sonuç yok</td>
        <td>—</td>
        <td>—</td>
        <td>—</td>
        <td>—</td>
        <td class="cell-status-err">Sonuç yok</td>
      `;
      return tr;
    }

    const { result, rank } = best;
    const simClass =
      result.similarity >= MATCH_THRESHOLD
        ? 'cell-sim-high'
        : result.similarity >= 50
          ? 'cell-sim-medium'
          : 'cell-sim-low';

    tr.innerHTML = `
      <td class="cell-term">${escapeHtml(outcome.term)}</td>
      <td class="cell-match" title="${escapeHtml(result.title || '')}">${escapeHtml(result.title || '—')}</td>
      <td>#${rank}</td>
      <td class="${simClass}">%${result.similarity}</td>
      <td>${escapeHtml(result.price || '—')}</td>
      <td>${escapeHtml(result.sellerCountText || String(result.sellersTotalCount || '—'))}</td>
      <td class="cell-status-ok">${escapeHtml(outcome.statusText || 'Tamam')}</td>
    `;
    return tr;
  }

  function upsertOverviewRow(outcome) {
    const rows = Array.from(multiOverviewBody.querySelectorAll('tr'));
    const existing = rows.find((r) => r.dataset.term === outcome.term);
    const row = renderOverviewRow(outcome);
    if (existing) {
      existing.replaceWith(row);
    } else {
      multiOverviewBody.appendChild(row);
    }
  }

  function addOverviewPendingRow(term) {
    const tr = document.createElement('tr');
    tr.dataset.term = term;
    tr.innerHTML = `
      <td class="cell-term">${escapeHtml(term)}</td>
      <td class="cell-match">Taranıyor…</td>
      <td>—</td>
      <td>—</td>
      <td>—</td>
      <td>—</td>
      <td>Taranıyor…</td>
    `;
    multiOverviewBody.appendChild(tr);
  }

  multiPickBtn.addEventListener('click', async () => {
    const res = await api.pickFile();
    if (!res) return;
    if (res.error) {
      multiFileInfo.textContent = 'Dosya okunamadı: ' + res.error;
      multiStartBtn.disabled = true;
      return;
    }
    loadedTerms = res.terms || [];
    const fileName = res.filePath.split(/[\\/]/).pop();
    multiFileInfo.textContent = `${loadedTerms.length} arama terimi yüklendi (${fileName})`;
    multiStartBtn.disabled = loadedTerms.length === 0;
  });

  multiExportBtn.addEventListener('click', () => {
    if (multiOutcomes.length === 0) return;
    const stamp = new Date().toISOString().slice(0, 10);
    exportOutcomes(multiOutcomes, `akakce-coklu-${stamp}.xlsx`);
  });

  function syncMultiScanControls() {
    updateScanControlUi(multiScanControl, {
      primaryBtn: multiStartBtn,
      pauseBtn: multiPauseBtn,
      resumeBtn: multiResumeBtn,
      cancelBtn: multiCancelBtn,
      extraDisable: [multiPickBtn],
    });
    if (multiScanControl && multiScanControl.paused && multiProgressLabel.dataset.baseLabel) {
      const base = multiProgressLabel.dataset.baseLabel;
      if (!multiProgressLabel.textContent.includes('duraklatıldı')) {
        multiProgressLabel.textContent = `${base} — duraklatıldı`;
      }
    }
  }

  multiPauseBtn.addEventListener('click', () => {
    if (multiScanControl) {
      multiScanControl.paused = true;
      multiProgressLabel.dataset.baseLabel = multiProgressLabel.textContent.replace(/ — duraklatıldı$/, '');
    }
    syncMultiScanControls();
  });
  multiResumeBtn.addEventListener('click', () => {
    if (multiScanControl) multiScanControl.paused = false;
    if (multiProgressLabel.dataset.baseLabel) {
      multiProgressLabel.textContent = multiProgressLabel.dataset.baseLabel;
    }
    syncMultiScanControls();
  });
  multiCancelBtn.addEventListener('click', () => {
    if (multiScanControl) {
      multiScanControl.cancelled = true;
      multiScanControl.paused = false;
    }
    syncMultiScanControls();
  });

  function buildScanGroup(term) {
    const details = document.createElement('details');
    details.className = 'scan-group';
    details.open = true;

    const summary = document.createElement('summary');
    const termSpan = document.createElement('span');
    termSpan.className = 'scan-term';
    termSpan.textContent = term;
    const statusSpan = document.createElement('span');
    statusSpan.className = 'scan-status';
    statusSpan.textContent = 'Taranıyor…';
    summary.appendChild(termSpan);
    summary.appendChild(statusSpan);
    details.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'scan-group-body';
    const summaryEl = document.createElement('div');
    summaryEl.className = 'scan-summary';
    summaryEl.hidden = true;
    const resultsEl = document.createElement('div');
    resultsEl.className = 'results-list';
    body.appendChild(summaryEl);
    body.appendChild(resultsEl);
    details.appendChild(body);

    return {
      el: details,
      summaryEl,
      bodyResultsEl: resultsEl,
      setStatus(text, type) {
        statusSpan.textContent = text;
        statusSpan.classList.remove('is-success', 'is-error');
        if (type === 'success') statusSpan.classList.add('is-success');
        if (type === 'error') statusSpan.classList.add('is-error');
      },
    };
  }

  multiStartBtn.addEventListener('click', async () => {
    if (loadedTerms.length === 0) return;
    multiScanControl = createScanController();
    syncMultiScanControls();
    multiExportBtn.hidden = true;
    multiGroupsEl.innerHTML = '';
    multiOverviewBody.innerHTML = '';
    multiOverviewEl.hidden = false;
    multiProgressEl.hidden = false;
    multiOutcomes = [];

    const scanStartedAt = Date.now();

    for (let i = 0; i < loadedTerms.length; i++) {
      await awaitScanControl(multiScanControl);
      if (isScanCancelled(multiScanControl)) break;

      const term = loadedTerms[i];
      const progressPct = Math.round((i / loadedTerms.length) * 100);
      multiProgressFill.style.width = `${progressPct}%`;
      const progressText = `${i + 1}/${loadedTerms.length} taranıyor: ${term}`;
      multiProgressLabel.textContent = progressText;
      multiProgressLabel.dataset.baseLabel = progressText;

      if (i > 0) {
        const elapsed = Date.now() - scanStartedAt;
        const avgPerTerm = elapsed / i;
        const remainingMs = avgPerTerm * (loadedTerms.length - i);
        multiEtaEl.textContent = formatDuration(remainingMs);
      } else {
        multiEtaEl.textContent = '';
      }

      addOverviewPendingRow(term);
      const group = buildScanGroup(term);
      multiGroupsEl.appendChild(group.el);

      const outcome = {
        term,
        results: [],
        cloudflareBlocked: false,
        error: null,
        statusText: 'Taranıyor…',
      };

      try {
        const searchOutcome = await performSearch(term);
        if (isScanCancelled(multiScanControl)) {
          outcome.statusText = 'İptal edildi';
          group.setStatus('İptal edildi', 'error');
          multiOutcomes.push(outcome);
          upsertOverviewRow(outcome);
          break;
        }

        outcome.results = searchOutcome.results;
        outcome.cloudflareBlocked = searchOutcome.cloudflareBlocked;
        outcome.error = searchOutcome.error;

        renderResultsList(group.bodyResultsEl, searchOutcome.results, term);
        group.bodyResultsEl._sourceResults = searchOutcome.results;
        renderSummary(group.summaryEl, buildSummary(searchOutcome.results, searchOutcome.cloudflareBlocked));

        if (searchOutcome.cloudflareBlocked) {
          outcome.statusText = 'Cloudflare engeli';
          group.setStatus('Cloudflare engeli', 'error');
        } else if (searchOutcome.results.length === 0) {
          outcome.statusText = 'Sonuç yok';
          group.setStatus('Sonuç yok', 'error');
        } else {
          group.setStatus(`${searchOutcome.results.length} sonuç`, 'success');
          await enrichSellers(searchOutcome.results, group.bodyResultsEl, {
            term,
            summaryEl: group.summaryEl,
            scanControl: multiScanControl,
          });
          if (isScanCancelled(multiScanControl)) {
            outcome.statusText = 'İptal edildi (kısmi)';
            group.setStatus('İptal edildi', 'error');
          } else {
            outcome.statusText = 'Tamam';
          }
        }
      } catch (err) {
        outcome.error = err.message;
        outcome.statusText = 'Hata: ' + err.message;
        group.setStatus('Hata: ' + err.message, 'error');
      }

      multiOutcomes.push(outcome);
      upsertOverviewRow(outcome);

      if (isScanCancelled(multiScanControl)) break;
    }

    multiProgressFill.style.width = '100%';
    if (isScanCancelled(multiScanControl)) {
      multiProgressLabel.textContent = `İptal edildi: ${multiOutcomes.length}/${loadedTerms.length} terim tarandı`;
      multiEtaEl.textContent = '';
    } else {
      multiProgressLabel.textContent = `Tamamlandı: ${loadedTerms.length}/${loadedTerms.length}`;
      multiEtaEl.textContent = '';
    }

    multiScanControl = null;
    syncMultiScanControls();
    if (multiOutcomes.length > 0) {
      multiExportBtn.hidden = false;
    }
  });

  // ------------------------------------------------------------------ //
  // Detay: gömülü tarayıcı (BrowserView)
  // ------------------------------------------------------------------ //
  const detailContainer = document.getElementById('detail-browser-container');
  const detailUrlEl = document.getElementById('detail-url');
  const detailBackAppBtn = document.getElementById('detail-back-app');
  const detailNavBackBtn = document.getElementById('detail-nav-back');
  const detailNavForwardBtn = document.getElementById('detail-nav-forward');
  const detailNavReloadBtn = document.getElementById('detail-nav-reload');

  let resizeObserver = null;
  let boundsRafPending = false;

  function scheduleBoundsUpdate() {
    if (boundsRafPending) return;
    boundsRafPending = true;
    requestAnimationFrame(() => {
      boundsRafPending = false;
      const rect = detailContainer.getBoundingClientRect();
      api.setDetailBounds({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
    });
  }

  function setupDetailBounds() {
    scheduleBoundsUpdate();
    resizeObserver = new ResizeObserver(scheduleBoundsUpdate);
    resizeObserver.observe(detailContainer);
    window.addEventListener('resize', scheduleBoundsUpdate);
  }

  function teardownDetailBounds() {
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    window.removeEventListener('resize', scheduleBoundsUpdate);
  }

  async function openDetailBrowser(url, returnView) {
    if (!url) return;
    viewBeforeDetail = returnView && returnView !== 'detail' ? returnView : viewBeforeDetail;
    showView('detail');
    detailUrlEl.textContent = url;
    setupDetailBounds();
    try {
      await api.openDetail(url);
    } finally {
      scheduleBoundsUpdate();
    }
  }

  async function closeDetailBrowser() {
    teardownDetailBounds();
    await api.closeDetail();
  }

  detailBackAppBtn.addEventListener('click', async () => {
    await closeDetailBrowser();
    showView(viewBeforeDetail);
  });

  detailNavBackBtn.addEventListener('click', () => api.detailBack());
  detailNavForwardBtn.addEventListener('click', () => api.detailForward());
  detailNavReloadBtn.addEventListener('click', () => api.detailReload());

  api.onDetailNavChanged((state) => {
    detailUrlEl.textContent = state.url || '';
    detailNavBackBtn.disabled = !state.canGoBack;
    detailNavForwardBtn.disabled = !state.canGoForward;
  });

  // ------------------------------------------------------------------ //
  // Başlangıç
  // ------------------------------------------------------------------ //
  showView('single');
})();
