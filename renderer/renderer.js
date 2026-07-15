(function () {
  const api = window.akakceAPI;
  const MAX_SELLER_ENRICH = 10;
  const MAX_SELLERS_SHOWN = 5;

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

  function isMatch(term, title) {
    const nTerm = normalize(term);
    const nTitle = normalize(title);
    if (!nTerm || !nTitle) return false;
    if (nTitle.includes(nTerm)) return true;
    const tokens = nTerm.split(' ').filter((t) => t.length > 1);
    if (tokens.length === 0) return false;
    return tokens.every((t) => nTitle.includes(t));
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

  function renderSellersInto(listEl, result) {
    listEl.innerHTML = '';
    const appendMsg = (text, cls) => {
      const li = document.createElement('li');
      li.className = cls;
      li.textContent = text;
      listEl.appendChild(li);
    };
    if (result.sellersLoading) {
      appendMsg('Satıcılar yükleniyor…', 'sellers-loading');
      return;
    }
    if (result.sellersError) {
      appendMsg('Satıcı bilgisi alınamadı', 'sellers-empty');
      return;
    }
    const sellers = result.sellers || [];
    if (sellers.length === 0) {
      appendMsg('Satıcı bulunamadı', 'sellers-empty');
      return;
    }
    sellers.slice(0, MAX_SELLERS_SHOWN).forEach((seller, i) => {
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
    if (result.isMatch) {
      node.querySelector('.badge-match').hidden = false;
      node.classList.add('is-match');
    }
    renderSellersInto(node.querySelector('.sellers-list'), result);
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
    renderSellersInto(row.querySelector('.sellers-list'), result);
  }

  async function enrichSellers(results, containerEl) {
    const limit = Math.min(results.length, MAX_SELLER_ENRICH);
    for (let i = 0; i < limit; i++) {
      const result = results[i];
      if (!result.detailUrl) continue;
      result.sellersLoading = true;
      updateSellerRowInPlace(containerEl, i, result);
      try {
        const res = await api.getSellers(result.detailUrl);
        result.sellers = res.sellers || [];
        result.sellersLoading = false;
        result.sellersError = !!(res.cloudflareBlocked && result.sellers.length === 0);
      } catch (e) {
        result.sellersLoading = false;
        result.sellersError = true;
      }
      updateSellerRowInPlace(containerEl, i, result);
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
      chips.push(
        first.isMatch
          ? { text: 'İlk sonuçta aranan değer eşleşti', type: 'success' }
          : { text: 'İlk sonuçta aranan değer eşleşmedi', type: 'danger' }
      );
    }
    if (results.slice(1).some((r) => r.isMatch)) {
      chips.push({ text: 'Aranan değer başka sonuçlarda da geçiyor', type: 'default' });
    }
    const nonMatching = results.filter((r) => !r.isMatch).length;
    if (nonMatching > 0) {
      chips.push({ text: `${nonMatching} farklı/eşleşmeyen ürün listelendi`, type: 'default' });
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
    const results = (response.results || []).map((r) => ({
      ...r,
      isMatch: isMatch(term, r.title),
      sellers: [],
      sellersLoading: false,
      sellersError: false,
    }));
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
        enrichSellers(outcome.results, singleResultsEl);
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
          await enrichSellers(outcome.results, group.bodyResultsEl);
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
