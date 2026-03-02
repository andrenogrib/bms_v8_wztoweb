(() => {
  "use strict";

  const DEFAULTS = {
    activeTab: "ALL",
    cashFilter: "all",
    minLevel: "",
    sortBy: "id-asc",
    viewMode: "cards",
    query: "",
  };

  const state = {
    manifest: Array.isArray(window.GM_MANIFEST) ? window.GM_MANIFEST.slice() : [],
    tabs: [],
    tabCounts: { ALL: 0 },
    allRows: [],
    filteredRows: [],
    activeTab: DEFAULTS.activeTab,
    cashFilter: DEFAULTS.cashFilter,
    minLevel: DEFAULTS.minLevel,
    sortBy: DEFAULTS.sortBy,
    viewMode: DEFAULTS.viewMode,
    query: DEFAULTS.query,
    pageSize: 180,
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
    renderControlValues();
    renderTabs();
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
    elements.cashFilter = byId("cashFilter");
    elements.minLevelInput = byId("minLevelInput");
    elements.sortSelect = byId("sortSelect");
    elements.cardsViewBtn = byId("cardsViewBtn");
    elements.tableViewBtn = byId("tableViewBtn");
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
    const cash = asText(params.get("cash")).trim();
    const minlvl = asText(params.get("minlvl")).trim();
    const sort = asText(params.get("sort")).trim();
    const view = asText(params.get("view")).trim();

    state.query = query || DEFAULTS.query;
    state.activeTab = tab || DEFAULTS.activeTab;
    state.cashFilter = ["all", "cash", "non-cash"].includes(cash) ? cash : DEFAULTS.cashFilter;
    state.minLevel = /^\d+$/.test(minlvl) ? minlvl : DEFAULTS.minLevel;
    state.sortBy = [
      "id-asc",
      "id-desc",
      "name-asc",
      "name-desc",
      "level-desc",
      "level-asc",
    ].includes(sort)
      ? sort
      : DEFAULTS.sortBy;
    state.viewMode = ["cards", "table"].includes(view) ? view : DEFAULTS.viewMode;
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
    for (const tab of tabs) {
      state.tabCounts[tab] = 0;
    }
  }

  function bindEvents() {
    const onSearch = debounce((value) => {
      state.query = asText(value).trim();
      applyFilters({ resetVisible: true, keepSelection: true });
    }, 130);

    elements.searchInput.addEventListener("input", (event) => {
      onSearch(event.target.value);
    });

    elements.cashFilter.addEventListener("change", (event) => {
      state.cashFilter = asText(event.target.value) || DEFAULTS.cashFilter;
      applyFilters({ resetVisible: true, keepSelection: true });
    });

    const onLevel = debounce((value) => {
      const clean = asText(value).trim();
      state.minLevel = /^\d+$/.test(clean) ? clean : "";
      elements.minLevelInput.value = state.minLevel;
      applyFilters({ resetVisible: true, keepSelection: true });
    }, 160);

    elements.minLevelInput.addEventListener("input", (event) => {
      onLevel(event.target.value);
    });

    elements.sortSelect.addEventListener("change", (event) => {
      state.sortBy = asText(event.target.value) || DEFAULTS.sortBy;
      applyFilters({ resetVisible: true, keepSelection: true });
    });

    elements.cardsViewBtn.addEventListener("click", () => {
      if (state.viewMode !== "cards") {
        state.viewMode = "cards";
        renderViewToggle();
        renderResults();
        syncUrlState();
      }
    });

    elements.tableViewBtn.addEventListener("click", () => {
      if (state.viewMode !== "table") {
        state.viewMode = "table";
        renderViewToggle();
        renderResults();
        syncUrlState();
      }
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
      throw new Error("manifest.js does not expose GM_MANIFEST entries.");
    }

    await loadScriptsWithConcurrency(state.manifest, 4, setLoadingProgress);
    const normalizedRows = normalizeAllRows(window.GM_EXPORTS || {});
    state.allRows = normalizedRows;
    state.tabCounts = buildTabCounts(normalizedRows, state.tabs);

    if (state.activeTab !== "ALL" && !state.tabCounts[state.activeTab]) {
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
    const fallbackName = fields.Name || fields.MapName || fields.StreetName || id || "Unnamed";
    const name = asText(rawRow.name || fallbackName);
    const preview = asText(rawRow.preview || firstImagePath(rawRow.images));
    const infoRaw = asText(fields.Info || "");
    const parsedInfo = parseInfoPairs(infoRaw);
    const reqLevel = toNumber(parsedInfo.map.reqLevel);
    const cashValue = toNumber(parsedInfo.map.cash);
    const isCash = cashValue === 1;
    const description = asText(fields.Description || fields.Speak || "");

    const searchCorpus = [
      tab,
      id,
      name,
      asText(rawRow.search),
      description,
      asText(fields.Name),
      asText(fields.MapName),
      asText(fields.StreetName),
      asText(fields.Level),
      infoRaw,
    ]
      .join(" ")
      .toLowerCase();

    return {
      key: tab + "|" + id + "|" + index,
      tab,
      id,
      name,
      fields,
      preview,
      hasPreview: Boolean(preview),
      infoMap: parsedInfo.map,
      infoNotes: parsedInfo.notes,
      reqLevel,
      isCash,
      description,
      searchCorpus,
    };
  }

  function buildTabCounts(rows, tabs) {
    const counts = { ALL: rows.length };
    for (const tab of tabs) {
      counts[tab] = 0;
    }
    for (const row of rows) {
      if (!counts[row.tab]) {
        counts[row.tab] = 0;
      }
      counts[row.tab] += 1;
    }
    return counts;
  }

  function applyFilters(options) {
    const resetVisible = Boolean(options && options.resetVisible);
    const keepSelection = !(options && options.keepSelection === false);
    const previousSelection = state.selectedKey;
    const query = state.query.toLowerCase();
    const minimumLevel = state.minLevel === "" ? null : Number(state.minLevel);

    const filtered = [];
    for (const row of state.allRows) {
      if (state.activeTab !== "ALL" && row.tab !== state.activeTab) {
        continue;
      }
      if (state.cashFilter === "cash" && !row.isCash) {
        continue;
      }
      if (state.cashFilter === "non-cash" && row.isCash) {
        continue;
      }
      if (minimumLevel !== null) {
        const level = row.reqLevel === null ? 0 : row.reqLevel;
        if (level < minimumLevel) {
          continue;
        }
      }
      if (query && !row.searchCorpus.includes(query)) {
        continue;
      }
      filtered.push(row);
    }

    state.filteredRows = sortRows(filtered, state.sortBy);

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

  function sortRows(rows, mode) {
    const sorted = rows.slice();
    sorted.sort((a, b) => {
      if (mode === "id-desc") {
        return compareIds(b.id, a.id);
      }
      if (mode === "name-asc") {
        return a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" }) || compareIds(a.id, b.id);
      }
      if (mode === "name-desc") {
        return b.name.localeCompare(a.name, "pt-BR", { sensitivity: "base" }) || compareIds(a.id, b.id);
      }
      if (mode === "level-desc") {
        const levelA = a.reqLevel === null ? -1 : a.reqLevel;
        const levelB = b.reqLevel === null ? -1 : b.reqLevel;
        return levelB - levelA || compareIds(a.id, b.id);
      }
      if (mode === "level-asc") {
        const levelA = a.reqLevel === null ? -1 : a.reqLevel;
        const levelB = b.reqLevel === null ? -1 : b.reqLevel;
        return levelA - levelB || compareIds(a.id, b.id);
      }
      return compareIds(a.id, b.id);
    });
    return sorted;
  }

  function renderTabs() {
    const fragment = document.createDocumentFragment();
    fragment.appendChild(createTabButton("ALL", "All tabs", state.tabCounts.ALL || 0));
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
    button.textContent = label + " (" + formatNumber(count) + ")";
    return button;
  }

  function renderControlValues() {
    elements.searchInput.value = state.query;
    elements.cashFilter.value = state.cashFilter;
    elements.minLevelInput.value = state.minLevel;
    elements.sortSelect.value = state.sortBy;
    renderViewToggle();
  }

  function renderViewToggle() {
    const cards = state.viewMode === "cards";
    elements.cardsViewBtn.classList.toggle("is-active", cards);
    elements.tableViewBtn.classList.toggle("is-active", !cards);
  }

  function renderResults() {
    const total = state.filteredRows.length;
    const shown = Math.min(state.visibleCount, total);
    const tabLabel = state.activeTab === "ALL" ? "All tabs" : state.activeTab;

    elements.resultsMeta.textContent =
      formatNumber(total) + " results in " + tabLabel + ". Showing " + formatNumber(shown) + ".";

    if (!total) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "No records found with current filters.";
      elements.resultsRoot.replaceChildren(empty);
      elements.loadMoreBtn.hidden = true;
      return;
    }

    const visibleRows = state.filteredRows.slice(0, shown);
    if (state.viewMode === "table") {
      renderTable(visibleRows);
    } else {
      renderCards(visibleRows);
    }

    const pending = total - shown;
    elements.loadMoreBtn.hidden = pending <= 0;
    if (pending > 0) {
      const nextChunk = Math.min(state.pageSize, pending);
      elements.loadMoreBtn.textContent = "Load more (" + formatNumber(nextChunk) + ")";
    }
  }

  function renderCards(rows) {
    const grid = document.createElement("div");
    grid.className = "result-grid";

    rows.forEach((row, index) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "result-card" + (row.key === state.selectedKey ? " is-active" : "");
      card.setAttribute("data-key", row.key);
      card.style.setProperty("--delay", String((index % 14) * 16) + "ms");

      const thumb = createThumbNode(row.preview, "result-thumb");
      card.appendChild(thumb);

      const body = document.createElement("div");
      const meta = document.createElement("p");
      meta.className = "card-meta";
      meta.textContent = row.tab + " | " + (row.id || "No ID");

      const title = document.createElement("h3");
      title.className = "card-title";
      title.textContent = row.name || "(Unnamed)";

      const snippet = document.createElement("p");
      snippet.className = "card-snippet";
      snippet.textContent = buildSnippet(row);

      const chips = document.createElement("div");
      chips.className = "chip-row";
      chips.appendChild(createChip(row.isCash ? "Cash" : "Non-cash", row.isCash ? "cash" : "non-cash"));
      if (row.reqLevel !== null) {
        chips.appendChild(createChip("Req Lv " + row.reqLevel, "level"));
      }
      if (!row.hasPreview) {
        chips.appendChild(createChip("No Icon", "note"));
      }

      body.append(meta, title, snippet, chips);
      card.appendChild(body);
      grid.appendChild(card);
    });

    elements.resultsRoot.replaceChildren(grid);
  }

  function renderTable(rows) {
    const wrapper = document.createElement("div");
    wrapper.className = "result-table-wrap";

    const table = document.createElement("table");
    table.className = "result-table";

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    const headers = ["Icon", "ID", "Name", "Tab", "Req Lv", "Cash", "Summary"];
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
      iconCell.appendChild(createThumbNode(row.preview, "result-thumb table-thumb"));

      const idCell = document.createElement("td");
      idCell.className = "table-id";
      idCell.textContent = row.id || "-";

      const nameCell = document.createElement("td");
      nameCell.textContent = row.name || "-";

      const tabCell = document.createElement("td");
      tabCell.className = "table-muted";
      tabCell.textContent = row.tab;

      const levelCell = document.createElement("td");
      levelCell.textContent = row.reqLevel === null ? "-" : String(row.reqLevel);

      const cashCell = document.createElement("td");
      cashCell.textContent = row.isCash ? "Cash" : "No";

      const summaryCell = document.createElement("td");
      summaryCell.className = "table-muted";
      summaryCell.textContent = buildSnippet(row);

      tr.append(iconCell, idCell, nameCell, tabCell, levelCell, cashCell, summaryCell);
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
      title.textContent = "Item Details";
      const text = document.createElement("p");
      text.textContent = "Select an item to inspect all exported fields.";
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
    name.textContent = selected.name || "(Unnamed)";

    const id = document.createElement("p");
    id.className = "details-id";
    id.textContent = "ID: " + (selected.id || "-");

    const chips = document.createElement("div");
    chips.className = "chip-row";
    chips.appendChild(createChip(selected.isCash ? "Cash" : "Non-cash", selected.isCash ? "cash" : "non-cash"));
    if (selected.reqLevel !== null) {
      chips.appendChild(createChip("Req Lv " + selected.reqLevel, "level"));
    }
    if (!selected.hasPreview) {
      chips.appendChild(createChip("No Icon", "note"));
    }

    headBody.append(tab, name, id, chips);
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

    const infoEntries = sortInfoEntries(selected.infoMap);
    if (infoEntries.length) {
      wrapper.appendChild(createDetailsSection("Parsed Info", infoEntries));
    }

    const rawEntries = objectEntries(selected.fields);
    if (rawEntries.length) {
      wrapper.appendChild(createDetailsSection("Raw Fields", rawEntries));
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

    for (const entry of entries) {
      const dt = document.createElement("dt");
      dt.textContent = entry[0];

      const dd = document.createElement("dd");
      dd.textContent = entry[1];

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
    state.cashFilter = DEFAULTS.cashFilter;
    state.minLevel = DEFAULTS.minLevel;
    state.sortBy = DEFAULTS.sortBy;
    state.viewMode = DEFAULTS.viewMode;
    state.query = DEFAULTS.query;
    renderControlValues();
    applyFilters({ resetVisible: true, keepSelection: false });
  }

  function setLoadingProgress(done, total, source) {
    const progress = total > 0 ? Math.round((done / total) * 100) : 100;
    elements.loadingBar.style.width = progress + "%";

    if (total <= 0) {
      elements.loadingText.textContent = "No data scripts found in manifest.";
      return;
    }

    const tab = asText(source).split("/")[0];
    const tabLabel = tab ? " | " + tab : "";
    elements.loadingText.textContent =
      "Loading data " + done + "/" + total + tabLabel + " (" + progress + "%)";
  }

  function hideLoadingScreen() {
    window.setTimeout(() => {
      elements.loadingScreen.classList.add("is-hidden");
    }, 180);
  }

  function handleFatalError(error) {
    console.error(error);
    const message = "Failed to load data: " + asText(error && error.message ? error.message : error);
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
    title.textContent = "Load Error";
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
              reject(new Error("Could not load script: " + src + " | " + err.message));
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
        reject(new Error("Network or path error"));
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

  function createChip(label, tone) {
    const chip = document.createElement("span");
    chip.className = "chip " + tone;
    chip.textContent = label;
    return chip;
  }

  function buildSnippet(row) {
    const primary =
      asText(row.fields.Description) ||
      asText(row.fields.Speak) ||
      asText(row.fields.MapName) ||
      asText(row.fields.Info);
    return truncate(primary || "No short description.", 160);
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

  function sortInfoEntries(infoMap) {
    const priority = [
      "reqLevel",
      "reqJob",
      "cash",
      "price",
      "tuc",
      "incSTR",
      "incDEX",
      "incINT",
      "incLUK",
      "incPAD",
      "incMAD",
      "incPDD",
      "incMDD",
      "incMHP",
      "incMMP",
      "timeLimited",
      "tradeBlock",
      "only",
      "islot",
      "vslot",
    ];

    const entries = [];
    const used = new Set();
    for (const key of priority) {
      if (Object.prototype.hasOwnProperty.call(infoMap, key)) {
        entries.push([key, asText(infoMap[key])]);
        used.add(key);
      }
    }
    const remaining = Object.keys(infoMap).filter((key) => !used.has(key)).sort();
    for (const key of remaining) {
      entries.push([key, asText(infoMap[key])]);
    }
    return entries;
  }

  function objectEntries(input) {
    if (!input || typeof input !== "object") {
      return [];
    }
    const rows = [];
    const keys = Object.keys(input);
    for (const key of keys) {
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

  function toNumber(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }
    const clean = String(value).replace(/[^\d.-]/g, "");
    if (!clean) {
      return null;
    }
    const number = Number(clean);
    return Number.isFinite(number) ? number : null;
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
    if (state.cashFilter !== DEFAULTS.cashFilter) {
      params.set("cash", state.cashFilter);
    }
    if (state.minLevel !== DEFAULTS.minLevel) {
      params.set("minlvl", state.minLevel);
    }
    if (state.sortBy !== DEFAULTS.sortBy) {
      params.set("sort", state.sortBy);
    }
    if (state.viewMode !== DEFAULTS.viewMode) {
      params.set("view", state.viewMode);
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
