(() => {
  "use strict";

  const DEFAULTS = {
    activeTab: "ALL",
    query: "",
  };

  const state = {
    manifest: Array.isArray(window.GM_MANIFEST) ? window.GM_MANIFEST.slice() : [],
    tabs: [],
    tabCounts: { ALL: 0 },
    tabPreviews: {},
    allRows: [],
    filteredRows: [],
    activeTab: DEFAULTS.activeTab,
    query: DEFAULTS.query,
    pageSize: 250,
    visibleCount: 0,
    selectedKey: "",
    loadedScripts: new Set(),
  };

  const elements = {};
  const numberFormatter = new Intl.NumberFormat("pt-BR");

  document.addEventListener("DOMContentLoaded", boot);

  function boot() {
    cacheElements();
    hydrateStateFromUrl();
    initializeTabsFromManifest();
    bindEvents();
    renderTabs();
    renderControlValues();
    updateMetrics();
    setLoadingProgress(0, state.manifest.length, "");
    loadAllData().catch(handleFatalError);
  }

  function cacheElements() {
    elements.loadingScreen = byId("loadingScreen");
    elements.loadingBar = byId("loadingBar");
    elements.loadingText = byId("loadingText");

    elements.metricTotal = byId("metricTotal");
    elements.metricTabs = byId("metricTabs");
    elements.metricFiltered = byId("metricFiltered");

    elements.tabStrip = byId("tabStrip");
    elements.searchInput = byId("searchInput");
    elements.resetFiltersBtn = byId("resetFiltersBtn");

    elements.resultsMeta = byId("resultsMeta");
    elements.resultsRoot = byId("resultsRoot");
    elements.loadMoreBtn = byId("loadMoreBtn");
    elements.detailsPanel = byId("detailsPanel");
  }

  function hydrateStateFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const query = asText(params.get("q")).trim();
    const tab = asText(params.get("tab")).trim();

    state.query = query || DEFAULTS.query;
    state.activeTab = tab || DEFAULTS.activeTab;
  }

  function initializeTabsFromManifest() {
    const seen = new Set();
    const tabs = [];

    for (const entry of state.manifest) {
      const src = asText(entry);
      const tab = src.split("/")[0];
      if (!tab || seen.has(tab)) {
        continue;
      }
      seen.add(tab);
      tabs.push(tab);
    }

    state.tabs = tabs;
    state.tabCounts = { ALL: 0 };
    state.tabPreviews = {};
    for (const tab of tabs) {
      state.tabCounts[tab] = 0;
      state.tabPreviews[tab] = "";
    }
  }

  function bindEvents() {
    const onSearch = debounce((value) => {
      state.query = asText(value).trim();
      applyFilters({ resetVisible: true, keepSelection: true });
    }, 120);

    elements.searchInput.addEventListener("input", (event) => {
      onSearch(event.target.value);
    });

    elements.resetFiltersBtn.addEventListener("click", () => {
      resetFilters();
    });

    elements.loadMoreBtn.addEventListener("click", () => {
      if (state.visibleCount >= state.filteredRows.length) {
        return;
      }
      state.visibleCount = Math.min(state.visibleCount + state.pageSize, state.filteredRows.length);
      renderResults();
    });

    elements.tabStrip.addEventListener("click", (event) => {
      const target = event.target.closest("button[data-tab]");
      if (!target) {
        return;
      }
      const tab = asText(target.getAttribute("data-tab"));
      if (!tab || tab === state.activeTab) {
        return;
      }
      state.activeTab = tab;
      applyFilters({ resetVisible: true, keepSelection: true });
    });

    elements.resultsRoot.addEventListener("click", onResultSelection);
    elements.resultsRoot.addEventListener("keydown", onResultSelectionKeyboard);
  }

  async function loadAllData() {
    if (!state.manifest.length) {
      throw new Error("manifest.js nao contem entradas em GM_MANIFEST.");
    }

    await loadScriptsWithConcurrency(state.manifest, 4, setLoadingProgress);
    const rows = normalizeAllRows(window.GM_EXPORTS || {});
    state.allRows = rows;
    state.tabCounts = buildTabCounts(rows, state.tabs);
    state.tabPreviews = buildTabPreviews(rows, state.tabs);

    if (state.activeTab !== "ALL" && !Object.prototype.hasOwnProperty.call(state.tabCounts, state.activeTab)) {
      state.activeTab = "ALL";
    }

    applyFilters({ resetVisible: true, keepSelection: false });
    hideLoadingScreen();
  }

  function normalizeAllRows(rawExports) {
    const rows = [];
    let index = 0;

    for (const tab of state.tabs) {
      const sourceRows = Array.isArray(rawExports[tab]) ? rawExports[tab] : [];
      for (const row of sourceRows) {
        rows.push(normalizeRow(row, tab, index));
        index += 1;
      }
    }
    return rows;
  }

  function normalizeRow(rawRow, fallbackTab, index) {
    const fields = rawRow && typeof rawRow.fields === "object" ? rawRow.fields : {};
    const tab = asText(rawRow.tab || fallbackTab || "Unknown");
    const id = asText(rawRow.id || fields.ID || "");
    const fallbackName = fields.Name || fields.MapName || fields.StreetName || id || "Sem nome";
    const name = asText(rawRow.name || fallbackName);
    const preview = asText(rawRow.preview || firstImagePath(rawRow.images));
    const infoRaw = asText(fields.Info || "");
    const parsedInfo = parseInfoPairs(infoRaw);

    const description =
      asText(fields.Description) ||
      asText(fields.Speak) ||
      asText(fields.MapName) ||
      asText(fields.StreetName) ||
      asText(fields.Info);

    const searchCorpus = [id, name, asText(fields.Name), asText(fields.MapName), asText(fields.StreetName)]
      .join(" ")
      .toLowerCase();

    return {
      key: tab + "|" + id + "|" + index,
      tab,
      id,
      name,
      fields,
      preview,
      description,
      infoMap: parsedInfo.map,
      infoNotes: parsedInfo.notes,
      searchCorpus,
    };
  }

  function buildTabCounts(rows, tabs) {
    const counts = { ALL: rows.length };
    for (const tab of tabs) {
      counts[tab] = 0;
    }
    for (const row of rows) {
      if (!Object.prototype.hasOwnProperty.call(counts, row.tab)) {
        counts[row.tab] = 0;
      }
      counts[row.tab] += 1;
    }
    return counts;
  }

  function buildTabPreviews(rows, tabs) {
    const previews = {};
    for (const tab of tabs) {
      previews[tab] = "";
    }
    for (const row of rows) {
      if (!row.preview) {
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(previews, row.tab)) {
        previews[row.tab] = row.preview;
        continue;
      }
      if (!previews[row.tab]) {
        previews[row.tab] = row.preview;
      }
    }
    return previews;
  }

  function applyFilters(options) {
    const resetVisible = Boolean(options && options.resetVisible);
    const keepSelection = !(options && options.keepSelection === false);
    const previousSelection = state.selectedKey;
    const query = state.query.toLowerCase();

    const filtered = [];
    for (const row of state.allRows) {
      if (state.activeTab !== "ALL" && row.tab !== state.activeTab) {
        continue;
      }
      if (query && !row.searchCorpus.includes(query)) {
        continue;
      }
      filtered.push(row);
    }

    state.filteredRows = sortRows(filtered);
    if (resetVisible) {
      state.visibleCount = Math.min(state.pageSize, state.filteredRows.length);
    } else {
      state.visibleCount = Math.min(Math.max(state.pageSize, state.visibleCount), state.filteredRows.length);
    }

    if (keepSelection && previousSelection && containsKey(state.filteredRows, previousSelection)) {
      state.selectedKey = previousSelection;
      const selectedIndex = indexOfKey(state.filteredRows, state.selectedKey);
      if (selectedIndex >= state.visibleCount) {
        state.visibleCount = Math.min(state.filteredRows.length, selectedIndex + 1);
      }
    } else {
      state.selectedKey = state.filteredRows.length ? state.filteredRows[0].key : "";
    }

    renderTabs();
    renderResults();
    renderDetails();
    updateMetrics();
    syncUrlState();
  }

  function sortRows(rows) {
    return rows.slice().sort((a, b) => compareIds(a.id, b.id));
  }

  function renderTabs() {
    const fragment = document.createDocumentFragment();
    fragment.appendChild(createTabButton("ALL", "Todas", state.tabCounts.ALL || 0));
    for (const tab of state.tabs) {
      fragment.appendChild(createTabButton(tab, tab, state.tabCounts[tab] || 0));
    }
    elements.tabStrip.replaceChildren(fragment);
  }

  function createTabButton(tab, label, count) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tab-btn" + (tab === state.activeTab ? " is-active" : "");
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", tab === state.activeTab ? "true" : "false");
    button.setAttribute("data-tab", tab);

    if (tab === "ALL") {
      button.textContent = label + " (" + formatNumber(count) + ")";
      return button;
    }

    button.classList.add("with-icon");
    const content = document.createElement("span");
    content.className = "tab-content";

    const icon = createTabIconNode(state.tabPreviews[tab] || "");

    const labelWrap = document.createElement("span");
    labelWrap.className = "tab-label";

    const nameEl = document.createElement("span");
    nameEl.className = "tab-name";
    nameEl.textContent = label;

    const countEl = document.createElement("span");
    countEl.className = "tab-count";
    countEl.textContent = "(" + formatNumber(count) + ")";

    labelWrap.append(nameEl, countEl);
    content.append(icon, labelWrap);
    button.appendChild(content);
    return button;
  }

  function createTabIconNode(path) {
    if (!path) {
      return createTabIconPlaceholder();
    }

    const image = document.createElement("img");
    image.className = "tab-icon";
    image.src = path;
    image.alt = "";
    image.decoding = "async";
    image.loading = "lazy";
    image.addEventListener("error", () => {
      const fallback = createTabIconPlaceholder();
      if (image.parentNode) {
        image.parentNode.replaceChild(fallback, image);
      }
    });
    return image;
  }

  function createTabIconPlaceholder() {
    const placeholder = document.createElement("span");
    placeholder.className = "tab-icon is-empty";
    placeholder.textContent = "";
    return placeholder;
  }

  function renderControlValues() {
    elements.searchInput.value = state.query;
  }

  function renderResults() {
    const total = state.filteredRows.length;
    const shown = Math.min(state.visibleCount, total);
    const tabLabel = state.activeTab === "ALL" ? "Todas as abas" : state.activeTab;

    elements.resultsMeta.textContent =
      formatNumber(total) + " registro(s) em " + tabLabel + ". Exibindo " + formatNumber(shown) + ".";

    if (!total) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "Nenhum registro encontrado para esta busca.";
      elements.resultsRoot.replaceChildren(empty);
      elements.loadMoreBtn.hidden = true;
      return;
    }

    renderTable(state.filteredRows.slice(0, shown));

    const pending = total - shown;
    elements.loadMoreBtn.hidden = pending <= 0;
    if (pending > 0) {
      const nextChunk = Math.min(state.pageSize, pending);
      elements.loadMoreBtn.textContent = "Carregar mais (" + formatNumber(nextChunk) + ")";
    }
  }

  function renderTable(rows) {
    const wrapper = document.createElement("div");
    wrapper.className = "result-table-wrap";

    const table = document.createElement("table");
    table.className = "result-table";

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    const headers = ["Icone", "ID", "Nome", "Aba", "Descricao"];
    for (const headerLabel of headers) {
      const th = document.createElement("th");
      th.textContent = headerLabel;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);

    const tbody = document.createElement("tbody");
    for (const row of rows) {
      const tr = document.createElement("tr");
      tr.setAttribute("data-key", row.key);
      tr.tabIndex = 0;
      if (row.key === state.selectedKey) {
        tr.classList.add("is-active");
      }

      const iconCell = document.createElement("td");
      iconCell.appendChild(createThumbNode(row.preview, "result-thumb"));

      const idCell = document.createElement("td");
      idCell.className = "table-id";
      idCell.textContent = row.id || "-";

      const nameCell = document.createElement("td");
      nameCell.textContent = row.name || "-";

      const tabCell = document.createElement("td");
      tabCell.className = "table-muted";
      tabCell.textContent = row.tab || "-";

      const descCell = document.createElement("td");
      descCell.className = "table-muted";
      descCell.textContent = truncate(row.description || "Sem descricao.", 220);

      tr.append(iconCell, idCell, nameCell, tabCell, descCell);
      tbody.appendChild(tr);
    }

    table.append(thead, tbody);
    wrapper.appendChild(table);
    elements.resultsRoot.replaceChildren(wrapper);
  }

  function renderDetails() {
    const selected = findSelectedRow();
    if (!selected) {
      const empty = document.createElement("div");
      empty.className = "details-empty";
      const title = document.createElement("h2");
      title.textContent = "Detalhes";
      const text = document.createElement("p");
      text.textContent = "Selecione um registro para ver as informacoes completas.";
      empty.append(title, text);
      elements.detailsPanel.replaceChildren(empty);
      return;
    }

    const wrapper = document.createElement("div");
    wrapper.className = "details-wrap";

    const head = document.createElement("header");
    head.className = "details-head";
    const thumb = createThumbNode(selected.preview, "details-thumb");
    const headBody = document.createElement("div");

    const tab = document.createElement("p");
    tab.className = "details-tab";
    tab.textContent = selected.tab;

    const name = document.createElement("h2");
    name.className = "details-name";
    name.textContent = selected.name || "Sem nome";

    const id = document.createElement("p");
    id.className = "details-id";
    id.textContent = "ID: " + (selected.id || "-");

    const desc = document.createElement("p");
    desc.className = "details-desc";
    desc.textContent = selected.description || "Sem descricao.";

    headBody.append(tab, name, id, desc);
    head.append(thumb, headBody);
    wrapper.appendChild(head);

    if (selected.infoNotes.length) {
      for (const note of selected.infoNotes) {
        const noteParagraph = document.createElement("p");
        noteParagraph.className = "details-note";
        noteParagraph.textContent = note;
        wrapper.appendChild(noteParagraph);
      }
    }

    const infoEntries = sortObjectEntries(selected.infoMap);
    if (infoEntries.length) {
      wrapper.appendChild(createDetailsSection("Info parseada", infoEntries));
    }

    const rawEntries = objectEntries(selected.fields);
    if (rawEntries.length) {
      wrapper.appendChild(createDetailsSection("Campos brutos", rawEntries));
    }

    elements.detailsPanel.replaceChildren(wrapper);
  }

  function createDetailsSection(title, entries) {
    const section = document.createElement("section");
    section.className = "details-section";

    const heading = document.createElement("h3");
    heading.textContent = title;

    const grid = document.createElement("dl");
    grid.className = "kv-grid";

    for (const [key, value] of entries) {
      const dt = document.createElement("dt");
      dt.textContent = key;

      const dd = document.createElement("dd");
      dd.textContent = value;

      grid.append(dt, dd);
    }

    section.append(heading, grid);
    return section;
  }

  function updateMetrics() {
    elements.metricTotal.textContent = formatNumber(state.allRows.length);
    elements.metricTabs.textContent = String(state.tabs.length);
    elements.metricFiltered.textContent = formatNumber(state.filteredRows.length);
  }

  function onResultSelection(event) {
    const target = event.target.closest("[data-key]");
    if (!target || !elements.resultsRoot.contains(target)) {
      return;
    }
    const key = asText(target.getAttribute("data-key"));
    if (!key) {
      return;
    }
    selectRow(key);
  }

  function onResultSelectionKeyboard(event) {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    const target = event.target.closest("tr[data-key]");
    if (!target) {
      return;
    }
    event.preventDefault();
    const key = asText(target.getAttribute("data-key"));
    if (key) {
      selectRow(key);
    }
  }

  function selectRow(key) {
    if (key === state.selectedKey) {
      return;
    }
    state.selectedKey = key;
    const idx = indexOfKey(state.filteredRows, key);
    if (idx >= state.visibleCount) {
      state.visibleCount = Math.min(state.filteredRows.length, idx + 1);
    }
    renderResults();
    renderDetails();
  }

  function findSelectedRow() {
    if (!state.selectedKey) {
      return null;
    }
    for (const row of state.filteredRows) {
      if (row.key === state.selectedKey) {
        return row;
      }
    }
    return null;
  }

  function resetFilters() {
    state.activeTab = DEFAULTS.activeTab;
    state.query = DEFAULTS.query;
    renderControlValues();
    applyFilters({ resetVisible: true, keepSelection: false });
  }

  function setLoadingProgress(done, total, source) {
    const progress = total > 0 ? Math.round((done / total) * 100) : 100;
    elements.loadingBar.style.width = progress + "%";

    if (total <= 0) {
      elements.loadingText.textContent = "Nenhum arquivo encontrado no manifest.";
      return;
    }

    const tab = asText(source).split("/")[0];
    const tabLabel = tab ? " (" + tab + ")" : "";
    elements.loadingText.textContent = "Carregando " + done + "/" + total + tabLabel + "...";
  }

  function hideLoadingScreen() {
    window.setTimeout(() => {
      elements.loadingScreen.classList.add("is-hidden");
    }, 150);
  }

  function handleFatalError(error) {
    console.error(error);
    const message = "Falha ao carregar dados: " + asText(error && error.message ? error.message : error);
    elements.loadingBar.style.width = "100%";
    elements.loadingText.textContent = message;
    elements.loadingScreen.classList.add("is-hidden");

    const failure = document.createElement("div");
    failure.className = "empty-state";
    failure.textContent = message;
    elements.resultsRoot.replaceChildren(failure);
    elements.loadMoreBtn.hidden = true;

    const details = document.createElement("div");
    details.className = "details-empty";
    const title = document.createElement("h2");
    title.textContent = "Erro de carregamento";
    const text = document.createElement("p");
    text.textContent = message;
    details.append(title, text);
    elements.detailsPanel.replaceChildren(details);
  }

  function loadScriptsWithConcurrency(sources, limit, onProgress) {
    let done = 0;
    let index = 0;
    let inFlight = 0;
    let failed = false;

    return new Promise((resolve, reject) => {
      const launchNext = () => {
        if (failed) {
          return;
        }

        if (done >= sources.length && inFlight === 0) {
          resolve();
          return;
        }

        while (inFlight < limit && index < sources.length) {
          const src = asText(sources[index]);
          index += 1;
          inFlight += 1;

          loadScript(src)
            .then(() => {
              inFlight -= 1;
              done += 1;
              onProgress(done, sources.length, src);
              launchNext();
            })
            .catch((err) => {
              if (failed) {
                return;
              }
              failed = true;
              reject(new Error("Nao foi possivel carregar " + src + ": " + err.message));
            });
        }
      };

      launchNext();
    });
  }

  function loadScript(src) {
    if (state.loadedScripts.has(src)) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.onload = () => {
        state.loadedScripts.add(src);
        resolve();
      };
      script.onerror = () => {
        reject(new Error("erro de rede ou caminho"));
      };
      document.head.appendChild(script);
    });
  }

  function createThumbNode(path, className) {
    if (!path) {
      const placeholder = document.createElement("div");
      placeholder.className = className + " is-empty";
      placeholder.textContent = "NO ICON";
      return placeholder;
    }

    const image = document.createElement("img");
    image.className = className;
    image.src = path;
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    image.addEventListener("error", () => {
      const placeholder = document.createElement("div");
      placeholder.className = className + " is-empty";
      placeholder.textContent = "NO ICON";
      if (image.parentNode) {
        image.parentNode.replaceChild(placeholder, image);
      }
    });
    return image;
  }

  function parseInfoPairs(rawInfo) {
    const map = {};
    const notes = [];
    if (!rawInfo) {
      return { map, notes };
    }

    const parts = String(rawInfo).split(",");
    for (const part of parts) {
      const token = part.trim();
      if (!token) {
        continue;
      }
      const idx = token.indexOf("=");
      if (idx === -1) {
        notes.push(token);
        continue;
      }
      const key = token.slice(0, idx).trim();
      const value = token.slice(idx + 1).trim();
      if (!key) {
        notes.push(token);
        continue;
      }
      map[key] = value;
    }

    return { map, notes };
  }

  function sortObjectEntries(input) {
    return Object.keys(input)
      .sort((a, b) => a.localeCompare(b, "pt-BR"))
      .map((key) => [key, asText(input[key])]);
  }

  function objectEntries(input) {
    if (!input || typeof input !== "object") {
      return [];
    }
    const rows = [];
    for (const key of Object.keys(input)) {
      rows.push([key, asText(input[key])]);
    }
    return rows;
  }

  function firstImagePath(images) {
    if (!images || typeof images !== "object") {
      return "";
    }
    const keys = Object.keys(images);
    if (!keys.length) {
      return "";
    }
    return asText(images[keys[0]]);
  }

  function containsKey(rows, key) {
    for (const row of rows) {
      if (row.key === key) {
        return true;
      }
    }
    return false;
  }

  function indexOfKey(rows, key) {
    for (let i = 0; i < rows.length; i += 1) {
      if (rows[i].key === key) {
        return i;
      }
    }
    return -1;
  }

  function compareIds(a, b) {
    return asText(a).localeCompare(asText(b), "en", { numeric: true, sensitivity: "base" });
  }

  function truncate(text, limit) {
    const value = asText(text).replace(/\s+/g, " ").trim();
    if (value.length <= limit) {
      return value;
    }
    return value.slice(0, Math.max(0, limit - 1)).trimEnd() + "...";
  }

  function asText(value) {
    if (value === null || value === undefined) {
      return "";
    }
    return String(value);
  }

  function formatNumber(value) {
    return numberFormatter.format(Number.isFinite(value) ? value : 0);
  }

  function syncUrlState() {
    const params = new URLSearchParams();
    if (state.activeTab !== DEFAULTS.activeTab) {
      params.set("tab", state.activeTab);
    }
    if (state.query) {
      params.set("q", state.query);
    }

    const queryString = params.toString();
    const nextUrl = window.location.pathname + (queryString ? "?" + queryString : "");
    window.history.replaceState(null, "", nextUrl);
  }

  function debounce(fn, waitMs) {
    let timer = null;
    return (...args) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => fn(...args), waitMs);
    };
  }

  function byId(id) {
    return document.getElementById(id);
  }
})();
