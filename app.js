/* ==========================================================================
   Реєстр граніту — логіка застосунку
   Дані живуть у файлі data.json у GitHub-репозиторії користувача.
   Запис виконується за схемою "прочитати останню версію -> внести зміну ->
   записати з поточним sha", з автоматичним повтором при конфлікті версій
   (GitHub API сам відхиляє запис, якщо sha застаріле — це і є захист від
   того, що двоє людей одночасно перезапишуть роботу одне одного).
   ========================================================================== */

const CONFIG_KEY = "graniteInventory.config.v1";
const CACHE_KEY = "graniteInventory.cache.v1";

let state = {
  config: null,        // {userName, owner, repo, branch, path, token}
  items: [],
  sha: null,
  sort: { field: "type", dir: 1 },
  filters: { search: "", type: "", location: "" },
  editingId: null,
};

// ---------- utils ----------

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function b64EncodeUnicode(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

function b64DecodeUnicode(b64) {
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function fmtMoney(n) {
  if (n === undefined || n === null || n === "") return "—";
  return Number(n).toLocaleString("uk-UA", { maximumFractionDigits: 2 }) + " грн";
}

function fmtDate(d) {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(dt)) return d;
  return dt.toLocaleDateString("uk-UA");
}

function showBanner(type, text, timeout = 4000) {
  const el = document.getElementById("banner");
  el.innerHTML = `<div class="banner banner-${type}">${text}</div>`;
  if (timeout) {
    clearTimeout(showBanner._t);
    showBanner._t = setTimeout(() => (el.innerHTML = ""), timeout);
  }
}

function setSync(statusClass, text) {
  document.getElementById("syncDot").className = "sync-dot " + statusClass;
  document.getElementById("syncText").textContent = text;
}

// ---------- config ----------

function loadConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function saveConfig(cfg) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  state.config = cfg;
}

function isConfigured() {
  const c = state.config;
  return !!(c && c.owner && c.repo && c.token);
}

function apiUrl() {
  const c = state.config;
  const branch = c.branch || "main";
  const path = c.path || "data.json";
  return `https://api.github.com/repos/${c.owner}/${c.repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${encodeURIComponent(branch)}`;
}

function authHeaders() {
  return {
    Authorization: `Bearer ${state.config.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

// ---------- local cache (offline fallback for reading) ----------

function cacheWrite(items) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ items, savedAt: Date.now() }));
  } catch (e) {}
}

function cacheRead() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

// ---------- GitHub read/write ----------

async function fetchLatest() {
  if (!isConfigured()) return false;
  setSync("busy", "Синхронізація...");
  try {
    const res = await fetch(apiUrl(), { headers: authHeaders() });
    if (res.status === 404) {
      // File doesn't exist yet — start empty, sha stays null until first save creates it.
      state.items = [];
      state.sha = null;
      setSync("ok", "Файл ще не створено — додайте першу позицію");
      return true;
    }
    if (!res.ok) throw new Error(`GitHub API: ${res.status} ${res.statusText}`);
    const json = await res.json();
    const text = b64DecodeUnicode(json.content.replace(/\n/g, ""));
    const parsed = JSON.parse(text || '{"items":[]}');
    state.items = Array.isArray(parsed.items) ? parsed.items : [];
    state.sha = json.sha;
    cacheWrite(state.items);
    const stamp = new Date().toLocaleTimeString("uk-UA");
    setSync("ok", `Синхронізовано о ${stamp}`);
    return true;
  } catch (err) {
    console.error(err);
    const cached = cacheRead();
    if (cached) {
      state.items = cached.items;
      setSync("error", "Немає зв'язку — показано збережену копію");
    } else {
      setSync("error", "Помилка з'єднання з GitHub");
    }
    return false;
  }
}

async function pushCurrent(commitMessage) {
  const body = {
    message: commitMessage,
    content: b64EncodeUnicode(JSON.stringify({ items: state.items, updatedAt: new Date().toISOString() }, null, 2)),
    branch: state.config.branch || "main",
  };
  if (state.sha) body.sha = state.sha;
  const name = state.config.userName || "Реєстр граніту";
  body.committer = { name, email: `${name.replace(/\s+/g, "-").toLowerCase() || "user"}@granite-inventory.local` };

  const res = await fetch(apiUrl().split("?")[0], {
    method: "PUT",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.status === 409 || res.status === 422) {
    const errJson = await res.json().catch(() => ({}));
    const conflict = new Error("conflict");
    conflict.isConflict = true;
    conflict.detail = errJson.message;
    throw conflict;
  }
  if (!res.ok) {
    const errJson = await res.json().catch(() => ({}));
    throw new Error(errJson.message || `GitHub API: ${res.status}`);
  }
  const json = await res.json();
  state.sha = json.content.sha;
  cacheWrite(state.items);
}

/**
 * Read-modify-write with automatic retry on version conflict.
 * `mutator(itemsArray)` mutates state.items in place (add/edit/delete one record).
 */
async function performUpdate(mutator, commitMessage) {
  if (!isConfigured()) {
    showBanner("error", "Спочатку налаштуйте підключення до GitHub (кнопка «Налаштування»).");
    openSettingsModal();
    return false;
  }
  setSync("busy", "Збереження...");
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await fetchLatest();
    else if (state.sha === null && state.items.length === 0) await fetchLatest();
    mutator(state.items);
    try {
      await pushCurrent(commitMessage);
      const stamp = new Date().toLocaleTimeString("uk-UA");
      setSync("ok", `Збережено о ${stamp}`);
      return true;
    } catch (err) {
      if (err.isConflict && attempt < 2) {
        continue; // reload latest + reapply mutation
      }
      console.error(err);
      setSync("error", "Не вдалося зберегти");
      showBanner("error", "Помилка збереження: " + (err.message || err) + ". Спробуйте «Оновити» і повторити.");
      return false;
    }
  }
  return false;
}

// ---------- rendering ----------

function uniqueValues(field) {
  return [...new Set(state.items.map((i) => i[field]).filter(Boolean))].sort();
}

function refreshFilterOptions() {
  const typeSel = document.getElementById("filterType");
  const locSel = document.getElementById("filterLocation");
  const locList = document.getElementById("locationOptions");

  const types = uniqueValues("type");
  const locations = uniqueValues("location");

  const curType = typeSel.value, curLoc = locSel.value;
  typeSel.innerHTML = '<option value="">Усі типи</option>' + types.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join("");
  locSel.innerHTML = '<option value="">Усі локації</option>' + locations.map((l) => `<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`).join("");
  typeSel.value = curType; locSel.value = curLoc;
  locList.innerHTML = locations.map((l) => `<option value="${escapeHtml(l)}">`).join("");
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function getFilteredSorted() {
  const { search, type, location } = state.filters;
  let list = state.items.filter((it) => {
    if (type && it.type !== type) return false;
    if (location && it.location !== location) return false;
    if (search) {
      const hay = [it.type, it.material, it.color, it.notes].join(" ").toLowerCase();
      if (!hay.includes(search.toLowerCase())) return false;
    }
    return true;
  });
  const { field, dir } = state.sort;
  list.sort((a, b) => {
    let av = a[field], bv = b[field];
    if (field === "quantity" || field === "price") { av = Number(av) || 0; bv = Number(bv) || 0; }
    else { av = (av ?? "").toString().toLowerCase(); bv = (bv ?? "").toString().toLowerCase(); }
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });
  return list;
}

function renderTable() {
  refreshFilterOptions();
  const list = getFilteredSorted();
  const tbody = document.getElementById("tableBody");
  const empty = document.getElementById("emptyState");

  if (list.length === 0) {
    tbody.innerHTML = "";
    empty.style.display = "block";
  } else {
    empty.style.display = "none";
    tbody.innerHTML = list.map(rowHtml).join("");
  }

  // sort arrows
  document.querySelectorAll("th[data-sort]").forEach((th) => {
    const arrow = th.querySelector(".arrow");
    arrow.textContent = th.dataset.sort === state.sort.field ? (state.sort.dir === 1 ? "▲" : "▼") : "";
  });

  // row actions
  tbody.querySelectorAll("[data-edit]").forEach((btn) => btn.addEventListener("click", () => openItemModal(btn.dataset.edit)));
}

function rowHtml(it) {
  const low = it.minQuantity !== undefined && it.minQuantity !== null && it.minQuantity !== "" && Number(it.quantity) <= Number(it.minQuantity);
  const qtyClass = low ? "qty-low" : "qty-ok";
  return `
    <tr>
      <td data-label="Тип"><span class="badge">${escapeHtml(it.type || "—")}</span></td>
      <td data-label="Матеріал"><div class="cell-name">${escapeHtml(it.material || "—")}</div><div class="cell-sub">${escapeHtml(it.color || "")}</div></td>
      <td data-label="Розміри">${escapeHtml(it.dimensions || "—")}</td>
      <td data-label="Кількість" class="${qtyClass}">${it.quantity ?? 0} ${escapeHtml(it.unit || "")}</td>
      <td data-label="Ціна">${fmtMoney(it.price)}</td>
      <td data-label="Локація">${escapeHtml(it.location || "—")}</td>
      <td data-label="Надходження">${fmtDate(it.receivedDate)}</td>
      <td class="row-actions"><button data-edit="${it.id}" title="Редагувати">✎</button></td>
    </tr>`;
}

// ---------- item modal ----------

function openItemModal(id) {
  state.editingId = id || null;
  const it = id ? state.items.find((i) => i.id === id) : null;

  document.getElementById("itemModalTitle").textContent = it ? "Редагувати позицію" : "Нова позиція";
  document.getElementById("itemDeleteBtn").style.display = it ? "inline-flex" : "none";

  document.getElementById("f_type").value = it?.type || "";
  document.getElementById("f_material").value = it?.material || "";
  document.getElementById("f_color").value = it?.color || "";
  document.getElementById("f_dimensions").value = it?.dimensions || "";
  document.getElementById("f_quantity").value = it?.quantity ?? "";
  document.getElementById("f_unit").value = it?.unit || "шт";
  document.getElementById("f_price").value = it?.price ?? "";
  document.getElementById("f_minQuantity").value = it?.minQuantity ?? "";
  document.getElementById("f_location").value = it?.location || "";
  document.getElementById("f_receivedDate").value = it?.receivedDate || "";
  document.getElementById("f_notes").value = it?.notes || "";

  document.getElementById("itemModalBackdrop").style.display = "flex";
  document.getElementById("f_type").focus();
}

function closeItemModal() {
  document.getElementById("itemModalBackdrop").style.display = "none";
  state.editingId = null;
}

function readItemForm() {
  return {
    type: document.getElementById("f_type").value.trim(),
    material: document.getElementById("f_material").value.trim(),
    color: document.getElementById("f_color").value.trim(),
    dimensions: document.getElementById("f_dimensions").value.trim(),
    quantity: parseFloat(document.getElementById("f_quantity").value) || 0,
    unit: document.getElementById("f_unit").value.trim() || "шт",
    price: document.getElementById("f_price").value === "" ? null : parseFloat(document.getElementById("f_price").value),
    minQuantity: document.getElementById("f_minQuantity").value === "" ? null : parseFloat(document.getElementById("f_minQuantity").value),
    location: document.getElementById("f_location").value.trim(),
    receivedDate: document.getElementById("f_receivedDate").value,
    notes: document.getElementById("f_notes").value.trim(),
  };
}

async function handleItemSave() {
  const data = readItemForm();
  if (!data.type) { showBanner("error", "Вкажіть тип позиції."); return; }

  const editingId = state.editingId;
  const saveBtn = document.getElementById("itemSaveBtn");
  saveBtn.disabled = true;

  const ok = await performUpdate((items) => {
    if (editingId) {
      const idx = items.findIndex((i) => i.id === editingId);
      if (idx >= 0) items[idx] = { ...items[idx], ...data };
      else items.push({ id: editingId, ...data });
    } else {
      items.push({ id: uid(), ...data });
    }
  }, editingId ? `Оновлено позицію (${data.type})` : `Додано позицію (${data.type})`);

  saveBtn.disabled = false;
  if (ok) {
    closeItemModal();
    renderTable();
    showBanner("success", "Збережено.");
  }
}

async function handleItemDelete() {
  const editingId = state.editingId;
  if (!editingId) return;
  if (!confirm("Видалити цю позицію зі складу?")) return;

  const ok = await performUpdate((items) => {
    const idx = items.findIndex((i) => i.id === editingId);
    if (idx >= 0) items.splice(idx, 1);
  }, "Видалено позицію");

  if (ok) {
    closeItemModal();
    renderTable();
    showBanner("success", "Видалено.");
  }
}

// ---------- settings modal ----------

function openSettingsModal() {
  const c = state.config || {};
  document.getElementById("s_userName").value = c.userName || "";
  document.getElementById("s_owner").value = c.owner || "";
  document.getElementById("s_repo").value = c.repo || "";
  document.getElementById("s_branch").value = c.branch || "main";
  document.getElementById("s_path").value = c.path || "data.json";
  document.getElementById("s_token").value = c.token || "";
  document.getElementById("settingsModalBackdrop").style.display = "flex";
}

function closeSettingsModal() {
  document.getElementById("settingsModalBackdrop").style.display = "none";
}

async function handleSettingsSave() {
  const cfg = {
    userName: document.getElementById("s_userName").value.trim(),
    owner: document.getElementById("s_owner").value.trim(),
    repo: document.getElementById("s_repo").value.trim(),
    branch: document.getElementById("s_branch").value.trim() || "main",
    path: document.getElementById("s_path").value.trim() || "data.json",
    token: document.getElementById("s_token").value.trim(),
  };
  if (!cfg.owner || !cfg.repo || !cfg.token) {
    showBanner("error", "Заповніть власника репозиторію, назву репозиторію та токен.");
    return;
  }
  saveConfig(cfg);
  closeSettingsModal();
  await fetchLatest();
  renderTable();
}

// ---------- events ----------

function wireEvents() {
  document.getElementById("addBtn").addEventListener("click", () => openItemModal(null));
  document.getElementById("refreshBtn").addEventListener("click", async () => { await fetchLatest(); renderTable(); });

  document.getElementById("settingsBtn").addEventListener("click", openSettingsModal);
  document.getElementById("settingsModalClose").addEventListener("click", closeSettingsModal);
  document.getElementById("settingsCancelBtn").addEventListener("click", closeSettingsModal);
  document.getElementById("settingsSaveBtn").addEventListener("click", handleSettingsSave);

  document.getElementById("itemModalClose").addEventListener("click", closeItemModal);
  document.getElementById("itemCancelBtn").addEventListener("click", closeItemModal);
  document.getElementById("itemSaveBtn").addEventListener("click", handleItemSave);
  document.getElementById("itemDeleteBtn").addEventListener("click", handleItemDelete);
  document.getElementById("itemForm").addEventListener("submit", (e) => { e.preventDefault(); handleItemSave(); });

  document.getElementById("searchInput").addEventListener("input", (e) => { state.filters.search = e.target.value; renderTable(); });
  document.getElementById("filterType").addEventListener("change", (e) => { state.filters.type = e.target.value; renderTable(); });
  document.getElementById("filterLocation").addEventListener("change", (e) => { state.filters.location = e.target.value; renderTable(); });

  document.querySelectorAll("th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const field = th.dataset.sort;
      if (state.sort.field === field) state.sort.dir *= -1;
      else state.sort = { field, dir: 1 };
      renderTable();
    });
  });

  [document.getElementById("itemModalBackdrop"), document.getElementById("settingsModalBackdrop")].forEach((bd) => {
    bd.addEventListener("click", (e) => { if (e.target === bd) bd.style.display = "none"; });
  });
}

// ---------- init ----------

async function init() {
  wireEvents();
  state.config = loadConfig();

  const cached = cacheRead();
  if (cached) { state.items = cached.items; renderTable(); }

  if (isConfigured()) {
    await fetchLatest();
    renderTable();
  } else {
    setSync("error", "Не підключено до GitHub");
    showBanner("info", "Щоб почати, натисніть «Налаштування» і вкажіть свій GitHub-репозиторій та токен.", 0);
    openSettingsModal();
  }
}

document.addEventListener("DOMContentLoaded", init);
