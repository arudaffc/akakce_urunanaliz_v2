(function () {
  const api = window.akakceAPI;
  const MAX_SELLERS_SHOWN = 5;
  const MATCH_THRESHOLD = 80;

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
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  // Levenshtein (düzenleme) uzaklığı — iki dize arasında birini diğerine
  // çevirmek için gereken minimum ekleme/silme/değiştirme sayısı.
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

  // Aranan terimin token'larının (kelime/kod parçalarının) başlıkta ne
  // ölçüde geçtiğini ölçer (tam veya alt-dize olarak).
  function tokenOverlapScore(termTokens, titleTokens) {
    if (termTokens.length === 0) return 0;
    let matched = 0;
    for (const t of termTokens) {
      if (titleTokens.includes(t)) {
        matched += 1;
      } else if (titleTokens.some((tt) => tt.length > 1 && (tt.includes(t) || t.includes(tt)))) {
        matched += 0.7;
      }
    }
    return Math.min(1, matched / termTokens.length);
  }

  // Aranan değer ile bir sonuç başlığı arasındaki yakınlık derecesini
  // 0-100 arası bir yüzde olarak hesaplar (tam içerme, token örtüşmesi ve
  // en iyi hizalanan alt-dizenin düzenleme uzaklığı benzerliğinin birleşimi).
  function computeSimilarity(term, title) {
    const nTerm = normalize(term);
    const nTitle = normalize(title);
    if (!nTerm || !nTitle) return 0;
    if (nTitle.includes(nTerm)) return 100;

    const termTokens = nTerm.split(' ').filter(Boolean);
    const titleTokens = nTitle.split(' ').filter(Boolean);
    const tokenScore = tokenOverlapScore(termTokens, titleTokens);

    let bestWindowScore = 0;
    if (nTitle.length <= nTerm.length) {
      bestWindowScore = levenshteinSimilarity(nTerm, nTitle);
    } else {
      const winLen = nTerm.length;
      for (let i = 0; i + winLen <= nTitle.length; i++) {
        const score = levenshteinSimilarity(nTerm, nTitle.slice(i, i + winLen));
        if (score > bestWindowScore) bestWindowScore = score;
      }
    }

    const combined = Math.max(tokenScore * 0.9, 0.5 * tokenScore + 0.5 * bestWindowScore);
    return Math.round(Math.min(1, Math.max(0, combined)) * 100);
  }

  function similarityTier(percent) {
    if (percent >= MATCH_THRESHOLD) return 'high';
    if (percent >= 50) return 'medium';
    return 'low';
  }

  // Başlık yakınlığı ile ürün detay sayfası içeriğindeki yakınlığın
  // en yüksek değerini kullan (içerikte kod/ad geçiyorsa yükselir).
  function recomputeSimilarity(term, result, contentText) {
    const titleSim = computeSimilarity(term, result.title || '');
    const contentSim = contentText ? computeSimilarity(term, contentText) : 0;
    result.similarityTitle = titleSim;
    result.similarityContent = contentSim;
    result.similarity = Math.max(titleSim, contentSim);
    result.similarityUsesContent = contentSim > titleSim;
  }

  function applySimilarityBadge(similarityBadge, result, row) {
    similarityBadge.classList.remove('badge-high', 'badge-medium', 'badge-low', 'badge-loading');
    similarityBadge.title = '';

    if (result.similarityLoading) {
      similarityBadge.textContent = 'Yakınlık Yükleniyor';
      similarityBadge.classList.add('badge-loading');
      if (row) row.classList.remove('is-match');
      return;
    }

    const tier = similarityTier(result.similarity);
    similarityBadge.textContent = result.similarityScannedContent
      ? `%${result.similarity} yakınlık (içerik)`
      : `%${result.similarity} yakınlık`;
    similarityBadge.title = result.similarityScannedContent
      ? `Başlık: %${result.similarityTitle ?? result.similarity}, detay içeriği: %${result.similarityContent ?? 0}`
      : '';
    similarityBadge.classList.add('badge-' + tier);
    if (row) row.classList.toggle('is-match', tier === 'high');
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
  // Sonuç satırı / satıcı tablosu render'ı (Tek + Çoklu tarama ortak)
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
    if (!result.detailUrl) {
      titleEl.textContent = 'Satıcılar';
      appendMsg('Bu üründe akakçe karşılaştırma sayfası yok (tek teklif)', 'sellers-empty');
      return;
    }
    if (result.sellersLoading) {
      titleEl.textContent = 'Satıcılar';
      appendMsg('Satıcılar yükleniyor…', 'sellers-loading');
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
      appendMsg('Satıcı bulunamadı', 'sellers-empty');
      return;
    }
    const shown = sellers.slice(0, MAX_SELLERS_SHOWN);
    titleEl.textContent = result.sellersTotalCount
      ? `Satıcılar (ilk ${shown.length} / ${result.sellersTotalCount})`
      : `Satıcılar (ilk ${shown.length})`;
    shown.forEach((seller, i) => {
      const li = document.createElement('li');
      li.textContent = `${i + 1}. Satıcı — ${seller}`;
      listEl.appendChild(li);
    });
  }

  function createResultRow(result, index) {
    const node = rowTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector('.result-rank').textContent = '#' + (index + 1);
    node.querySelector('.result-title').textContent = result.title || '(Başlık bulunamadı)';
    node.querySelector('.result-title').title = result.title || '';
    node.querySelector('.result-price').textContent = result.price || '—';
    node.querySelector('.result-seller-count').textContent = result.sellerCountText || '';
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

  function renderResultsList(containerEl, results) {
    containerEl.innerHTML = '';
    if (!results || results.length === 0) {
      const div = document.createElement('div');
      div.className = 'state-message';
      div.textContent = 'Sonuç bulunamadı.';
      containerEl.appendChild(div);
      return;
    }
    results.forEach((result, index) => {
      containerEl.appendChild(createResultRow(result, index));
    });
  }

  function updateSellerRowInPlace(containerEl, index, result) {
    const rows = containerEl.querySelectorAll('.result-row');
    const row = rows[index];
    if (!row) return;
    renderSellersInto(row.querySelector('.result-sellers'), result);
  }

  function updateSimilarityRowInPlace(containerEl, index, result) {
    const rows = containerEl.querySelectorAll('.result-row');
    const row = rows[index];
    if (!row) return;
    const similarityBadge = row.querySelector('.badge-similarity');
    if (!similarityBadge) return;
    applySimilarityBadge(similarityBadge, result, row);
  }

  function finalizeSimilarity(term, result, contentText) {
    result.similarityScannedContent = true;
    if (contentText) {
      recomputeSimilarity(term, result, contentText);
    } else {
      result.similarity = computeSimilarity(term, result.title || '');
      result.similarityTitle = result.similarity;
      result.similarityContent = 0;
      result.similarityUsesContent = false;
    }
    result.similarityLoading = false;
  }

  function finalizeStuckSimilarity(term, results, containerEl, summaryEl) {
    let changed = false;
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (!result.similarityLoading) continue;
      finalizeSimilarity(term, result, '');
      updateSimilarityRowInPlace(containerEl, i, result);
      changed = true;
    }
    if (changed && summaryEl) {
      renderSummary(summaryEl, buildSummary(results, false));
    }
  }

  async function enrichSellers(results, containerEl, options = {}) {
    const { term, summaryEl } = options;

    for (let i = 0; i < results.length; i++) {
      if (results[i].detailUrl) {
        results[i].sellersLoading = true;
        results[i].similarityLoading = true;
        updateSellerRowInPlace(containerEl, i, results[i]);
        updateSimilarityRowInPlace(containerEl, i, results[i]);
      }
    }

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (!result.detailUrl) continue;
      result.sellersLoading = true;
      updateSellerRowInPlace(containerEl, i, result);
      try {
        const res = await api.getSellers(result.detailUrl);
        result.sellers = res.sellers || [];
        result.sellersTotalCount = res.totalCount || 0;
        result.sellersLoading = false;
        result.sellersError = !!(res.cloudflareBlocked && result.sellers.length === 0);
        if (term) {
          finalizeSimilarity(term, result, res.contentText || '');
          updateSimilarityRowInPlace(containerEl, i, result);
        }
      } catch (e) {
        result.sellersLoading = false;
        result.sellersError = true;
        if (term) {
          finalizeSimilarity(term, result, '');
          updateSimilarityRowInPlace(containerEl, i, result);
        }
      }
      updateSellerRowInPlace(containerEl, i, result);
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
      chips.push({ text: 'Cloudflare doğrulaması geçilemedi, lütfen tekrar deneyin', type: 'danger' });
      return chips;
    }
    chips.push({ text: `${results.length} sonuç bulundu`, type: 'default' });
    const first = results[0];
    if (first) {
      if (first.similarityLoading) {
        chips.push({ text: 'İlk sonuç yakınlığı hesaplanıyor…', type: 'default' });
      } else {
        chips.push(
          first.similarity >= MATCH_THRESHOLD
            ? {
                text: first.similarityScannedContent
                  ? `İlk sonuç detay içeriğinde %${first.similarity} oranında eşleşti`
                  : `İlk sonuç %${first.similarity} oranında eşleşti`,
                type: 'success',
              }
            : {
                text: first.similarityScannedContent
                  ? `İlk sonuç detay içeriğinde yalnızca %${first.similarity} oranında eşleşti`
                  : `İlk sonuç yalnızca %${first.similarity} oranında eşleşti`,
                type: 'danger',
              }
        );
      }
    }
    if (results.some((r) => r.similarityLoading)) {
      chips.push({ text: 'Bazı sonuçların yakınlığı hesaplanıyor…', type: 'default' });
    }
    if (results.slice(1).some((r) => !r.similarityLoading && r.similarity >= MATCH_THRESHOLD)) {
      chips.push({ text: 'Aranan değer başka sonuçlarda da geçiyor', type: 'default' });
    }
    const finalized = results.filter((r) => !r.similarityLoading);
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
    const results = (response.results || []).map((r) => {
      const base = {
        ...r,
        sellers: [],
        sellersLoading: false,
        sellersError: false,
        similarityUsesContent: false,
        similarityScannedContent: false,
      };
      // Detay sayfası olan tüm sonuçlarda yakınlık, içerik taranana kadar bekletilir.
      if (r.detailUrl) {
        return { ...base, similarityLoading: true, similarity: 0 };
      }
      return {
        ...base,
        similarityLoading: false,
        similarity: computeSimilarity(term, r.title),
      };
    });
    return {
      term,
      results,
      cloudflareBlocked: !!response.cloudflareBlocked,
      error: response.error || null,
    };
  }

  // ------------------------------------------------------------------ //
  // Tek Ürün Tarama
  // ------------------------------------------------------------------ //
  const singleForm = document.getElementById('single-search-form');
  const singleInput = document.getElementById('single-search-input');
  const singleBtn = document.getElementById('single-search-btn');
  const singleSummaryEl = document.getElementById('single-summary');
  const singleResultsEl = document.getElementById('single-results');

  singleForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const term = singleInput.value.trim();
    if (!term) return;

    singleBtn.disabled = true;
    singleSummaryEl.hidden = true;
    singleResultsEl.innerHTML = '';
    const loadingMsg = document.createElement('div');
    loadingMsg.className = 'state-message';
    loadingMsg.textContent = 'Aranıyor, Cloudflare doğrulaması bekleniyor olabilir…';
    singleResultsEl.appendChild(loadingMsg);

    try {
      const outcome = await performSearch(term);
      renderResultsList(singleResultsEl, outcome.results);
      renderSummary(singleSummaryEl, buildSummary(outcome.results, outcome.cloudflareBlocked));
      if (!outcome.cloudflareBlocked && outcome.results.length > 0) {
        await enrichSellers(outcome.results, singleResultsEl, { term, summaryEl: singleSummaryEl });
      } else {
        finalizeStuckSimilarity(term, outcome.results, singleResultsEl, singleSummaryEl);
      }
    } catch (err) {
      singleResultsEl.innerHTML = '';
      const div = document.createElement('div');
      div.className = 'state-message is-error';
      div.textContent = 'Tarama sırasında bir hata oluştu: ' + err.message;
      singleResultsEl.appendChild(div);
    } finally {
      singleBtn.disabled = false;
    }
  });

  // ------------------------------------------------------------------ //
  // Çoklu Ürün Tarama
  // ------------------------------------------------------------------ //
  const multiPickBtn = document.getElementById('multi-pick-file-btn');
  const multiFileInfo = document.getElementById('multi-file-info');
  const multiStartBtn = document.getElementById('multi-start-btn');
  const multiProgressEl = document.getElementById('multi-progress');
  const multiProgressFill = document.getElementById('multi-progress-fill');
  const multiProgressLabel = document.getElementById('multi-progress-label');
  const multiGroupsEl = document.getElementById('multi-groups');

  let loadedTerms = [];

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
    multiStartBtn.disabled = true;
    multiPickBtn.disabled = true;
    multiGroupsEl.innerHTML = '';
    multiProgressEl.hidden = false;

    for (let i = 0; i < loadedTerms.length; i++) {
      const term = loadedTerms[i];
      multiProgressFill.style.width = `${Math.round((i / loadedTerms.length) * 100)}%`;
      multiProgressLabel.textContent = `${i + 1}/${loadedTerms.length} taranıyor: ${term}`;

      const group = buildScanGroup(term);
      multiGroupsEl.appendChild(group.el);

      try {
        const outcome = await performSearch(term);
        renderResultsList(group.bodyResultsEl, outcome.results);
        renderSummary(group.summaryEl, buildSummary(outcome.results, outcome.cloudflareBlocked));
        group.setStatus(
          outcome.cloudflareBlocked ? 'Cloudflare engeli' : `${outcome.results.length} sonuç`,
          outcome.cloudflareBlocked ? 'error' : 'success'
        );
        if (!outcome.cloudflareBlocked && outcome.results.length > 0) {
          await enrichSellers(outcome.results, group.bodyResultsEl, { term, summaryEl: group.summaryEl });
        } else {
          finalizeStuckSimilarity(term, outcome.results, group.bodyResultsEl, group.summaryEl);
        }
      } catch (err) {
        group.setStatus('Hata: ' + err.message, 'error');
      }
    }

    multiProgressFill.style.width = '100%';
    multiProgressLabel.textContent = `Tamamlandı: ${loadedTerms.length}/${loadedTerms.length}`;
    multiStartBtn.disabled = false;
    multiPickBtn.disabled = false;
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
