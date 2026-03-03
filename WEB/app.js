(() => {
  "use strict";

  const REWARD_DROP_INDEX_PATH = "Reward/drop-index.json";
  const MAP_LINK_INDEX_PATH = "Map/map-links.json";

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
    itemPreviewById: {},
    mobLookupById: {},
    mapRowKeyById: {},
    mobRowKeyById: {},
    npcRowKeyById: {},
    rewardDropsByMob: null,
    rewardDropsByItem: null,
    rewardMeta: null,
    rewardStatus: "idle",
    rewardError: "",
    rewardPromise: null,
    mapLinksByMap: null,
    mapLinksByMob: null,
    mapLinksByNpc: null,
    mapLinksMeta: null,
    mapLinksStatus: "idle",
    mapLinksError: "",
    mapLinksPromise: null,
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
    elements.detailsPanel.addEventListener("click", onDetailsNavigationClick);
    elements.detailsPanel.addEventListener("keydown", onDetailsNavigationKeyboard);
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
    state.itemPreviewById = buildItemPreviewIndex(rows);
    state.mobLookupById = buildMobLookup(rows);
    const navLookups = buildNavigationLookups(rows);
    state.mapRowKeyById = navLookups.mapById;
    state.mobRowKeyById = navLookups.mobById;
    state.npcRowKeyById = navLookups.npcById;

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

  function buildItemPreviewIndex(rows) {
    const index = {};
    for (const row of rows) {
      const id = asText(row && row.id).trim();
      if (!/^\d{8}$/.test(id)) {
        continue;
      }
      const preview = asText(row && row.preview).trim();
      if (!preview) {
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(index, id)) {
        index[id] = preview;
      }
    }
    return index;
  }

  function buildMobLookup(rows) {
    const index = {};
    for (const row of rows) {
      if (!row || row.tab !== "Mob") {
        continue;
      }
      const id = normalizeMobId(row.id);
      if (!id) {
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(index, id)) {
        index[id] = {
          id,
          name: asText(row.name) || id,
          preview: asText(row.preview) || "",
          level: parseIntOrNull(row.infoMap && row.infoMap["info.level"]),
          exp: parseIntOrNull(row.infoMap && row.infoMap["info.exp"]),
        };
      }
    }
    return index;
  }

  function buildNavigationLookups(rows) {
    const mapById = {};
    const mobById = {};
    const npcById = {};

    for (const row of rows) {
      if (!row) {
        continue;
      }

      if (row.tab === "Mob") {
        const mobId = normalizeMobId(row.id);
        if (mobId && !Object.prototype.hasOwnProperty.call(mobById, mobId)) {
          mobById[mobId] = row.key;
        }
        continue;
      }

      if (row.tab === "Npc") {
        const npcId = normalizeMobId(row.id);
        if (npcId && !Object.prototype.hasOwnProperty.call(npcById, npcId)) {
          npcById[npcId] = row.key;
        }
        continue;
      }

      if (isMapTab(row.tab)) {
        const mapId = normalizeMapId(row.id);
        if (mapId && !Object.prototype.hasOwnProperty.call(mapById, mapId)) {
          mapById[mapId] = row.key;
        }
      }
    }

    return { mapById, mobById, npcById };
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
      if (row.tab === "Mob") {
        const nameMain = document.createElement("div");
        nameMain.className = "table-name";
        nameMain.textContent = row.name || "-";
        nameCell.appendChild(nameMain);

        const mobMetaText = formatMobListMeta(row);
        if (mobMetaText) {
          const meta = document.createElement("div");
          meta.className = "table-submeta";
          meta.textContent = mobMetaText;
          nameCell.appendChild(meta);
        }
      } else {
        nameCell.textContent = row.name || "-";
      }

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

    if (isMapTab(selected.tab)) {
      wrapper.appendChild(createMapContentsSection(selected));
    }

    if (selected.tab === "Mob") {
      wrapper.appendChild(createMobMapSection(selected));
    }

    if (selected.tab === "Npc") {
      wrapper.appendChild(createNpcMapSection(selected));
    }

    if (selected.tab === "Mob") {
      wrapper.appendChild(createMobDropSection(selected));
    }

    if (isDropItemCandidate(selected)) {
      wrapper.appendChild(createItemDropSection(selected));
    }

    elements.detailsPanel.replaceChildren(wrapper);
  }

  function createMapContentsSection(selected) {
    const section = document.createElement("section");
    section.className = "details-section maplink-section";

    const heading = document.createElement("h3");
    heading.textContent = "Conteudo do mapa";
    section.appendChild(heading);

    if (!ensureMapLinksReady(section)) {
      return section;
    }

    const mapNode = getMapLinksForMap(selected.id);
    if (!mapNode) {
      const text = document.createElement("p");
      text.className = "maplink-state";
      text.textContent = "Sem referencia de mobs/NPCs para este mapa.";
      section.appendChild(text);
      return section;
    }

    const meta = document.createElement("p");
    meta.className = "maplink-state";
    meta.textContent =
      "Mobs: " + formatNumber(mapNode.mobCount) + " | NPCs: " + formatNumber(mapNode.npcCount) + ".";
    section.appendChild(meta);

    const grid = document.createElement("div");
    grid.className = "maplink-grid";
    grid.append(
      createMapEntityBlock("Mobs", mapNode.mobs, "Mob", "Nenhum mob registrado neste mapa."),
      createMapEntityBlock("NPCs", mapNode.npcs, "Npc", "Nenhum NPC registrado neste mapa.")
    );
    section.appendChild(grid);

    return section;
  }

  function createMobMapSection(selected) {
    const section = document.createElement("section");
    section.className = "details-section maplink-section";

    const heading = document.createElement("h3");
    heading.textContent = "Aparece em mapas";
    section.appendChild(heading);

    if (!ensureMapLinksReady(section)) {
      return section;
    }

    const refs = getMapRefsForMob(selected.id);
    if (!refs.length) {
      const text = document.createElement("p");
      text.className = "maplink-state";
      text.textContent = "Sem referencia de mapa para este mob.";
      section.appendChild(text);
      return section;
    }

    const meta = document.createElement("p");
    meta.className = "maplink-state";
    meta.textContent = formatNumber(refs.length) + " mapa(s).";
    section.appendChild(meta);

    section.appendChild(createMapReferenceTable(refs));
    return section;
  }

  function createNpcMapSection(selected) {
    const section = document.createElement("section");
    section.className = "details-section maplink-section";

    const heading = document.createElement("h3");
    heading.textContent = "Aparece em mapas";
    section.appendChild(heading);

    if (!ensureMapLinksReady(section)) {
      return section;
    }

    const refs = getMapRefsForNpc(selected.id);
    if (!refs.length) {
      const text = document.createElement("p");
      text.className = "maplink-state";
      text.textContent = "Sem referencia de mapa para este NPC.";
      section.appendChild(text);
      return section;
    }

    const meta = document.createElement("p");
    meta.className = "maplink-state";
    meta.textContent = formatNumber(refs.length) + " mapa(s).";
    section.appendChild(meta);

    section.appendChild(createMapReferenceTable(refs));
    return section;
  }

  function createMapEntityBlock(title, rows, navTab, emptyText) {
    const block = document.createElement("article");
    block.className = "maplink-block";

    const head = document.createElement("h4");
    head.className = "maplink-block-title";
    head.textContent = title + " (" + formatNumber(Array.isArray(rows) ? rows.length : 0) + ")";
    block.appendChild(head);

    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) {
      const empty = document.createElement("p");
      empty.className = "maplink-empty";
      empty.textContent = emptyText;
      block.appendChild(empty);
      return block;
    }

    const wrap = document.createElement("div");
    wrap.className = "maplink-table-wrap";

    const table = document.createElement("table");
    table.className = "maplink-table";

    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    for (const label of ["#", "ICO", "ID", "Nome", "Info"]) {
      const th = document.createElement("th");
      th.textContent = label;
      hr.appendChild(th);
    }
    thead.appendChild(hr);

    const tbody = document.createElement("tbody");
    for (let i = 0; i < list.length; i += 1) {
      const row = list[i];
      const tr = document.createElement("tr");

      const idx = document.createElement("td");
      idx.textContent = String(i + 1);

      const ico = document.createElement("td");
      ico.className = "drop-ico-cell";
      ico.appendChild(createThumbNode(asText(row && row.preview), "drop-thumb"));

      const idCell = document.createElement("td");
      idCell.className = "table-id";
      idCell.textContent = asText(row && row.id) || "-";

      const nameCell = document.createElement("td");
      const label = asText(row && row.name) || "(" + navTab.toLowerCase() + " desconhecido)";
      nameCell.appendChild(createDetailsNavButton(navTab, asText(row && row.id), label));

      const infoCell = document.createElement("td");
      infoCell.className = "maplink-info";
      const infoText = navTab === "Mob" ? formatMobMeta(row) : "";
      infoCell.textContent = infoText || "-";

      tr.append(idx, ico, idCell, nameCell, infoCell);
      tbody.appendChild(tr);
    }

    table.append(thead, tbody);
    wrap.appendChild(table);
    block.appendChild(wrap);
    return block;
  }

  function createMapReferenceTable(rows) {
    const wrap = document.createElement("div");
    wrap.className = "maplink-table-wrap";

    const table = document.createElement("table");
    table.className = "maplink-table";

    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    for (const label of ["#", "ICO", "Map ID", "Mapa", "Info"]) {
      const th = document.createElement("th");
      th.textContent = label;
      hr.appendChild(th);
    }
    thead.appendChild(hr);

    const tbody = document.createElement("tbody");
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const tr = document.createElement("tr");

      const idx = document.createElement("td");
      idx.textContent = String(i + 1);

      const ico = document.createElement("td");
      ico.className = "drop-ico-cell";
      ico.appendChild(createThumbNode(asText(row && row.preview), "drop-thumb"));

      const mapId = normalizeMapId(row && row.mapId);
      const mapIdCell = document.createElement("td");
      mapIdCell.className = "table-id";
      mapIdCell.textContent = mapId || "-";

      const mapCell = document.createElement("td");
      const mapName = asText(row && row.mapName) || mapId || "(mapa desconhecido)";
      mapCell.appendChild(createDetailsNavButton("Map", mapId, mapName));
      const street = asText(row && row.streetName);
      if (street) {
        const streetMeta = document.createElement("div");
        streetMeta.className = "maplink-sub";
        streetMeta.textContent = street;
        mapCell.appendChild(streetMeta);
      }

      const infoCell = document.createElement("td");
      infoCell.className = "maplink-info";
      infoCell.textContent = formatMapRefMeta(row);

      tr.append(idx, ico, mapIdCell, mapCell, infoCell);
      tbody.appendChild(tr);
    }

    table.append(thead, tbody);
    wrap.appendChild(table);
    return wrap;
  }

  function createDetailsNavButton(tab, id, label) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "details-nav-btn";
    button.setAttribute("data-nav-tab", asText(tab));
    button.setAttribute("data-nav-id", asText(id));
    button.textContent = label;
    button.title = label;
    return button;
  }

  function ensureMapLinksReady(section) {
    if (state.mapLinksStatus === "idle") {
      ensureMapLinksLoaded();
    }

    if (state.mapLinksStatus === "loading" || state.mapLinksStatus === "idle") {
      const text = document.createElement("p");
      text.className = "maplink-state";
      text.textContent = "Carregando dados de mapa...";
      section.appendChild(text);
      return false;
    }

    if (state.mapLinksStatus === "error") {
      const text = document.createElement("p");
      text.className = "maplink-state is-error";
      text.textContent = "Nao foi possivel carregar " + MAP_LINK_INDEX_PATH + ".";
      section.appendChild(text);
      if (state.mapLinksError) {
        const detail = document.createElement("p");
        detail.className = "maplink-state-detail";
        detail.textContent = state.mapLinksError;
        section.appendChild(detail);
      }
      return false;
    }

    return true;
  }

  function createMobDropSection(selected) {
    const section = document.createElement("section");
    section.className = "details-section reward-section";

    const heading = document.createElement("h3");
    heading.textContent = "Drops (Reward.img)";
    section.appendChild(heading);

    if (state.rewardStatus === "idle") {
      ensureRewardDropsLoaded();
    }

    if (state.rewardStatus === "loading" || state.rewardStatus === "idle") {
      const text = document.createElement("p");
      text.className = "reward-state";
      text.textContent = "Carregando dados de drop...";
      section.appendChild(text);
      return section;
    }

    if (state.rewardStatus === "error") {
      const text = document.createElement("p");
      text.className = "reward-state is-error";
      text.textContent = "Nao foi possivel carregar " + REWARD_DROP_INDEX_PATH + ".";
      section.appendChild(text);
      if (state.rewardError) {
        const detail = document.createElement("p");
        detail.className = "reward-state-detail";
        detail.textContent = state.rewardError;
        section.appendChild(detail);
      }
      return section;
    }

    const drops = getRewardDropsForMob(selected.id);
    if (!drops.length) {
      const text = document.createElement("p");
      text.className = "reward-state";
      text.textContent = "Sem referencia de drop para este mob.";
      section.appendChild(text);
      return section;
    }

    const meta = document.createElement("p");
    meta.className = "reward-state";
    meta.textContent = formatNumber(drops.length) + " entrada(s) de drop.";
    section.appendChild(meta);

    const wrap = document.createElement("div");
    wrap.className = "drop-table-wrap";

    const table = document.createElement("table");
    table.className = "drop-table";

    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    for (const header of ["#", "Tipo", "ICO", "Drop", "Chance", "Qtd", "Info"]) {
      const th = document.createElement("th");
      th.textContent = header;
      hr.appendChild(th);
    }
    thead.appendChild(hr);

    const tbody = document.createElement("tbody");
    for (const drop of drops) {
      const tr = document.createElement("tr");

      const idx = document.createElement("td");
      idx.textContent = String(Number(drop.index) + 1);

      const kind = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = "drop-kind " + (drop.type === "meso" ? "is-meso" : "is-item");
      badge.textContent = drop.type === "meso" ? "Meso" : "Item";
      kind.appendChild(badge);

      const ico = document.createElement("td");
      ico.className = "drop-ico-cell";
      ico.appendChild(createThumbNode(getDropIconPath(drop), "drop-thumb"));

      const dropCell = document.createElement("td");
      if (drop.type === "meso") {
        dropCell.textContent = formatNumber(toNumber(drop.meso)) + " mesos";
      } else {
        const itemName = asText(drop.itemName) || "(item desconhecido)";
        const itemId = asText(drop.itemId);
        dropCell.textContent = itemName + (itemId ? " (" + itemId + ")" : "");
      }

      const chance = document.createElement("td");
      chance.textContent = formatDropChance(drop.prob, drop.probRaw);

      const qty = document.createElement("td");
      qty.textContent = formatDropQuantity(drop);

      const info = document.createElement("td");
      info.className = "drop-info";
      info.textContent = formatDropExtra(drop);

      tr.append(idx, kind, ico, dropCell, chance, qty, info);
      tbody.appendChild(tr);
    }

    table.append(thead, tbody);
    wrap.appendChild(table);
    section.appendChild(wrap);
    return section;
  }

  function createItemDropSection(selected) {
    const section = document.createElement("section");
    section.className = "details-section reward-section";

    const heading = document.createElement("h3");
    heading.textContent = "Dropa de";
    section.appendChild(heading);

    if (state.rewardStatus === "idle") {
      ensureRewardDropsLoaded();
    }

    if (state.rewardStatus === "loading" || state.rewardStatus === "idle") {
      const text = document.createElement("p");
      text.className = "reward-state";
      text.textContent = "Carregando dados de drop...";
      section.appendChild(text);
      return section;
    }

    if (state.rewardStatus === "error") {
      const text = document.createElement("p");
      text.className = "reward-state is-error";
      text.textContent = "Nao foi possivel carregar " + REWARD_DROP_INDEX_PATH + ".";
      section.appendChild(text);
      if (state.rewardError) {
        const detail = document.createElement("p");
        detail.className = "reward-state-detail";
        detail.textContent = state.rewardError;
        section.appendChild(detail);
      }
      return section;
    }

    const itemDrops = getRewardItemDropsForItem(selected.id);
    if (!itemDrops.length) {
      const text = document.createElement("p");
      text.className = "reward-state";
      text.textContent = "Sem referencia de drop para este item.";
      section.appendChild(text);
      return section;
    }

    const uniqueMobCount = countUniqueMobs(itemDrops);
    const meta = document.createElement("p");
    meta.className = "reward-state";
    meta.textContent =
      "Dropa de " +
      formatNumber(uniqueMobCount) +
      " mob(s), com " +
      formatNumber(itemDrops.length) +
      " registro(s) de chance.";
    section.appendChild(meta);

    const wrap = document.createElement("div");
    wrap.className = "drop-table-wrap";

    const table = document.createElement("table");
    table.className = "drop-table";

    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    for (const header of ["#", "ICO", "Monster ID", "Mob", "Chance", "Qtd", "Info"]) {
      const th = document.createElement("th");
      th.textContent = header;
      hr.appendChild(th);
    }
    thead.appendChild(hr);

    const tbody = document.createElement("tbody");
    for (let i = 0; i < itemDrops.length; i += 1) {
      const drop = itemDrops[i];
      const tr = document.createElement("tr");

      const idx = document.createElement("td");
      idx.textContent = String(i + 1);

      const ico = document.createElement("td");
      ico.className = "drop-ico-cell";
      ico.appendChild(createThumbNode(getMobIconPath(drop.mobId), "drop-thumb"));

      const mobIdCell = document.createElement("td");
      mobIdCell.className = "table-id";
      mobIdCell.textContent = asText(drop.mobId) || "-";

      const mobCell = document.createElement("td");
      const mobName = document.createElement("div");
      mobName.className = "drop-mob-name";
      mobName.textContent = asText(drop.mobName) || "(mob desconhecido)";
      mobCell.appendChild(mobName);

      const mobMetaText = formatMobMeta(drop);
      if (mobMetaText) {
        const mobMeta = document.createElement("div");
        mobMeta.className = "drop-mob-meta";
        mobMeta.textContent = mobMetaText;
        mobCell.appendChild(mobMeta);
      }

      const chance = document.createElement("td");
      chance.textContent = formatDropChance(drop.prob, drop.probRaw);

      const qty = document.createElement("td");
      qty.textContent = formatDropQuantity(drop);

      const info = document.createElement("td");
      info.className = "drop-info";
      info.textContent = formatItemDropExtra(drop);

      tr.append(idx, ico, mobIdCell, mobCell, chance, qty, info);
      tbody.appendChild(tr);
    }

    table.append(thead, tbody);
    wrap.appendChild(table);
    section.appendChild(wrap);
    return section;
  }

  function ensureMapLinksLoaded() {
    if (state.mapLinksStatus === "ready") {
      return Promise.resolve();
    }
    if (state.mapLinksStatus === "loading" && state.mapLinksPromise) {
      return state.mapLinksPromise;
    }
    if (state.mapLinksStatus === "error") {
      return Promise.reject(new Error(state.mapLinksError || "load failed"));
    }

    state.mapLinksStatus = "loading";
    state.mapLinksError = "";

    state.mapLinksPromise = fetch(MAP_LINK_INDEX_PATH, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) {
          throw new Error("HTTP " + response.status);
        }
        return response.json();
      })
      .then((payload) => {
        const mapMap = payload && typeof payload.maps === "object" && payload.maps ? payload.maps : {};
        const mobMap = payload && typeof payload.mobs === "object" && payload.mobs ? payload.mobs : {};
        const npcMap = payload && typeof payload.npcs === "object" && payload.npcs ? payload.npcs : {};
        state.mapLinksByMap = mapMap;
        state.mapLinksByMob = mobMap;
        state.mapLinksByNpc = npcMap;
        state.mapLinksMeta = payload && payload.meta ? payload.meta : null;
        state.mapLinksStatus = "ready";
      })
      .catch((error) => {
        state.mapLinksByMap = null;
        state.mapLinksByMob = null;
        state.mapLinksByNpc = null;
        state.mapLinksMeta = null;
        state.mapLinksStatus = "error";
        state.mapLinksError = asText(error && error.message ? error.message : error);
        throw error;
      })
      .finally(() => {
        state.mapLinksPromise = null;
        renderDetails();
      });

    return state.mapLinksPromise;
  }

  function getMapLinksForMap(mapId) {
    if (state.mapLinksStatus !== "ready" || !state.mapLinksByMap) {
      return null;
    }
    const normalized = normalizeMapId(mapId);
    const node = state.mapLinksByMap[normalized];
    return node && typeof node === "object" ? node : null;
  }

  function getMapRefsForMob(mobId) {
    if (state.mapLinksStatus !== "ready" || !state.mapLinksByMob) {
      return [];
    }
    const normalized = normalizeMobId(mobId);
    const refs = state.mapLinksByMob[normalized];
    return Array.isArray(refs) ? refs : [];
  }

  function getMapRefsForNpc(npcId) {
    if (state.mapLinksStatus !== "ready" || !state.mapLinksByNpc) {
      return [];
    }
    const normalized = normalizeMobId(npcId);
    const refs = state.mapLinksByNpc[normalized];
    return Array.isArray(refs) ? refs : [];
  }

  function ensureRewardDropsLoaded() {
    if (state.rewardStatus === "ready") {
      return Promise.resolve();
    }
    if (state.rewardStatus === "loading" && state.rewardPromise) {
      return state.rewardPromise;
    }
    if (state.rewardStatus === "error") {
      return Promise.reject(new Error(state.rewardError || "load failed"));
    }

    state.rewardStatus = "loading";
    state.rewardError = "";

    state.rewardPromise = fetch(REWARD_DROP_INDEX_PATH, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) {
          throw new Error("HTTP " + response.status);
        }
        return response.json();
      })
      .then((payload) => {
        const mobMap = payload && typeof payload.mobs === "object" && payload.mobs ? payload.mobs : {};
        const itemMap = payload && typeof payload.items === "object" && payload.items ? payload.items : {};
        state.rewardDropsByMob = mobMap;
        state.rewardDropsByItem = itemMap;
        state.rewardMeta = payload && payload.meta ? payload.meta : null;
        state.rewardStatus = "ready";
      })
      .catch((error) => {
        state.rewardDropsByMob = null;
        state.rewardDropsByItem = null;
        state.rewardMeta = null;
        state.rewardStatus = "error";
        state.rewardError = asText(error && error.message ? error.message : error);
        throw error;
      })
      .finally(() => {
        state.rewardPromise = null;
        renderDetails();
      });

    return state.rewardPromise;
  }

  function getRewardDropsForMob(mobId) {
    if (state.rewardStatus !== "ready" || !state.rewardDropsByMob) {
      return [];
    }
    const normalized = normalizeMobId(mobId);
    const drops = state.rewardDropsByMob[normalized];
    return Array.isArray(drops) ? drops : [];
  }

  function getRewardItemDropsForItem(itemId) {
    if (state.rewardStatus !== "ready" || !state.rewardDropsByItem) {
      return [];
    }
    const normalized = normalizeItemId(itemId);
    const node = state.rewardDropsByItem[normalized];
    if (!node) {
      return [];
    }

    if (Array.isArray(node)) {
      return sortItemDropRows(node);
    }

    if (node && Array.isArray(node.drops)) {
      return sortItemDropRows(node.drops);
    }

    return [];
  }

  function sortItemDropRows(rows) {
    return rows.slice().sort((a, b) => {
      const aProb = toNumber(a && a.prob);
      const bProb = toNumber(b && b.prob);
      if (Number.isFinite(aProb) && Number.isFinite(bProb) && aProb !== bProb) {
        return bProb - aProb;
      }
      const aMob = asText(a && a.mobId);
      const bMob = asText(b && b.mobId);
      return aMob.localeCompare(bMob, "en", { numeric: true, sensitivity: "base" });
    });
  }

  function getDropIconPath(drop) {
    if (!drop || drop.type !== "item") {
      return "";
    }
    const itemId = asText(drop.itemId).trim();
    if (!itemId) {
      return "";
    }
    return asText(state.itemPreviewById[itemId] || "");
  }

  function getMobIconPath(mobId) {
    const normalized = normalizeMobId(mobId);
    const mob = state.mobLookupById && state.mobLookupById[normalized];
    return asText((mob && mob.preview) || "");
  }

  function countUniqueMobs(itemDrops) {
    const seen = new Set();
    for (const row of itemDrops) {
      const mobId = normalizeMobId(row && row.mobId);
      if (mobId) {
        seen.add(mobId);
      }
    }
    return seen.size;
  }

  function formatMobMeta(drop) {
    const extras = [];
    const level = parseIntOrNull(drop && drop.mobLevel);
    const exp = parseIntOrNull(drop && drop.mobExp);
    if (level !== null) {
      extras.push("Lv " + formatNumber(level));
    }
    if (exp !== null) {
      extras.push("EXP " + formatNumber(exp));
    }
    return extras.join(" | ");
  }

  function formatItemDropExtra(drop) {
    const extras = [];
    const premium = toNumber(drop && drop.premium);
    if (Number.isFinite(premium) && premium > 0) {
      extras.push("premium " + premium);
    }
    const period = toNumber(drop && drop.period);
    if (Number.isFinite(period) && period > 0) {
      extras.push("periodo " + period + "d");
    }
    const dateExpire = formatDropDateExpire(drop && drop.dateExpire);
    if (dateExpire) {
      extras.push("expira " + dateExpire);
    }
    return extras.length ? extras.join(" | ") : "-";
  }

  function formatMapRefMeta(ref) {
    const extras = [];
    const tab = asText(ref && ref.tab);
    if (tab) {
      extras.push("tab " + tab);
    }

    const mobCount = parseIntOrNull(ref && ref.mobCount);
    if (mobCount !== null) {
      extras.push("mobs " + formatNumber(mobCount));
    }

    const npcCount = parseIntOrNull(ref && ref.npcCount);
    if (npcCount !== null) {
      extras.push("npcs " + formatNumber(npcCount));
    }

    return extras.length ? extras.join(" | ") : "-";
  }

  function formatMobListMeta(row) {
    if (!row || row.tab !== "Mob") {
      return "";
    }
    const level = parseIntOrNull(row.infoMap && row.infoMap["info.level"]);
    const exp = parseIntOrNull(row.infoMap && row.infoMap["info.exp"]);
    const extras = [];
    if (level !== null) {
      extras.push("Lv " + formatNumber(level));
    }
    if (exp !== null) {
      extras.push("EXP " + formatNumber(exp));
    }
    return extras.join(" | ");
  }

  function isDropItemCandidate(selected) {
    if (!selected || selected.tab === "Mob") {
      return false;
    }
    const id = asText(selected.id).trim();
    return /^\d{8}$/.test(id);
  }

  function normalizeMobId(id) {
    const raw = asText(id).trim();
    if (!/^\d+$/.test(raw)) {
      return raw;
    }
    return raw.padStart(7, "0");
  }

  function normalizeMapId(id) {
    const raw = asText(id).trim();
    if (!/^\d+$/.test(raw)) {
      return raw;
    }
    return raw.padStart(9, "0");
  }

  function normalizeItemId(id) {
    const raw = asText(id).trim();
    if (!/^\d+$/.test(raw)) {
      return raw;
    }
    return raw.padStart(8, "0");
  }

  function isMapTab(tab) {
    return /^Map\d+$/i.test(asText(tab).trim());
  }

  function formatDropChance(prob, probRaw) {
    const n = toNumber(prob);
    if (!Number.isFinite(n)) {
      return asText(probRaw) || "-";
    }
    const percent = n * 100;
    const fixed = percent >= 1 ? 2 : percent >= 0.1 ? 3 : 4;
    return trimDecimal(percent.toFixed(fixed)) + "%";
  }

  function formatDropQuantity(drop) {
    const min = toNumber(drop.min);
    const max = toNumber(drop.max);
    if (Number.isFinite(min) && Number.isFinite(max)) {
      if (min === max) {
        return formatNumber(min);
      }
      return formatNumber(min) + " - " + formatNumber(max);
    }
    if (Number.isFinite(min)) {
      return ">= " + formatNumber(min);
    }
    if (Number.isFinite(max)) {
      return "<= " + formatNumber(max);
    }
    return "1";
  }

  function formatDropExtra(drop) {
    const extras = [];
    if (asText(drop.itemTab)) {
      extras.push("tab " + drop.itemTab);
    }
    const premium = toNumber(drop.premium);
    if (Number.isFinite(premium) && premium > 0) {
      extras.push("premium " + premium);
    }
    const period = toNumber(drop.period);
    if (Number.isFinite(period) && period > 0) {
      extras.push("periodo " + period + "d");
    }
    const dateExpire = formatDropDateExpire(drop.dateExpire);
    if (dateExpire) {
      extras.push("expira " + dateExpire);
    }
    return extras.length ? extras.join(" | ") : "-";
  }

  function formatDropDateExpire(value) {
    const text = asText(value).trim();
    if (!text || !/^\d{8,10}$/.test(text)) {
      return "";
    }
    const yyyy = text.slice(0, 4);
    const mm = text.slice(4, 6);
    const dd = text.slice(6, 8);
    if (text.length >= 10) {
      const hh = text.slice(8, 10);
      return yyyy + "-" + mm + "-" + dd + " " + hh + ":00";
    }
    return yyyy + "-" + mm + "-" + dd;
  }

  function trimDecimal(text) {
    return asText(text).replace(/\.?0+$/, "");
  }

  function toNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
  }

  function parseIntOrNull(value) {
    const n = Number.parseInt(asText(value).trim(), 10);
    return Number.isFinite(n) ? n : null;
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

  function onDetailsNavigationClick(event) {
    const target = event.target.closest("button[data-nav-tab][data-nav-id]");
    if (!target || !elements.detailsPanel.contains(target)) {
      return;
    }
    const tab = asText(target.getAttribute("data-nav-tab"));
    const id = asText(target.getAttribute("data-nav-id"));
    if (!tab || !id) {
      return;
    }
    navigateToLinkedRecord(tab, id);
  }

  function onDetailsNavigationKeyboard(event) {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    const target = event.target.closest("button[data-nav-tab][data-nav-id]");
    if (!target || !elements.detailsPanel.contains(target)) {
      return;
    }
    const tab = asText(target.getAttribute("data-nav-tab"));
    const id = asText(target.getAttribute("data-nav-id"));
    if (!tab || !id) {
      return;
    }
    event.preventDefault();
    navigateToLinkedRecord(tab, id);
  }

  function navigateToLinkedRecord(tab, id) {
    const tabName = asText(tab).trim();
    const rawId = asText(id).trim();
    let key = "";

    if (tabName === "Map") {
      key = asText(state.mapRowKeyById[normalizeMapId(rawId)]);
    } else if (tabName === "Mob") {
      key = asText(state.mobRowKeyById[normalizeMobId(rawId)]);
    } else if (tabName === "Npc") {
      key = asText(state.npcRowKeyById[normalizeMobId(rawId)]);
    }

    if (!key) {
      return;
    }

    let targetRow = null;
    for (const row of state.allRows) {
      if (row.key === key) {
        targetRow = row;
        break;
      }
    }
    if (!targetRow) {
      return;
    }

    state.activeTab = targetRow.tab;
    state.query = "";
    state.selectedKey = key;
    renderControlValues();
    applyFilters({ resetVisible: true, keepSelection: true });
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
