import { LocalProvider, ServerProvider, saveServerSettings, validateBackup } from './providers.js';
import { getSecureSetting, clearServerCredentials } from './db.js';

const CLIENT_VERSION = 'v4';

const state = {
  config: { appName: 'Maker Inventar', version: 'v2', buildTarget: 'pages', defaultMode: null, defaultServerUrl: '', dockerWebUrl: '' },
  mode: null,
  provider: null,
  data: { categories: [], locations: [], items: [], projects: [], project_items: [] },
  view: localStorage.getItem('maker-inventar-view') || 'inventory',
  lowOnly: false,
  swRegistration: null,
  updateReady: false,
};

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c]));
const nfmt = (value) => Number(value || 0).toLocaleString('de-CH', { maximumFractionDigits: 3 });
const labelStatus = { planned: 'Geplant', active: 'Aktiv', done: 'Fertig' };

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hidden'), 2600);
}

function setConnectionWarning(message = '') {
  const el = $('connection-warning');
  el.textContent = message;
  el.classList.toggle('hidden', !message);
}

async function loadConfig() {
  try {
    const response = await fetch('config.json', { cache: 'no-store' });
    if (!response.ok) throw new Error();
    state.config = { ...state.config, ...(await response.json()) };
  } catch {
    // Cached app shell may still run; defaults keep local mode usable.
  }
  if (state.config.buildTarget === 'docker' && !state.config.defaultServerUrl) state.config.defaultServerUrl = window.location.origin;
  document.title = state.config.appName || 'Maker Inventar';
  $('app-version').textContent = CLIENT_VERSION;
  if (state.config.dockerWebUrl) {
    $('docker-fallback').href = state.config.dockerWebUrl;
    $('docker-fallback').classList.remove('hidden');
  }
}

function currentMode() {
  return localStorage.getItem('maker-inventar-mode') || state.config.defaultMode || null;
}

async function switchMode(mode, { firstRun = false } = {}) {
  if (!['local', 'server'].includes(mode)) return;
  localStorage.setItem('maker-inventar-mode', mode);
  state.mode = mode;
  state.provider = mode === 'local' ? new LocalProvider() : new ServerProvider(state.config);
  renderMode();
  if (firstRun && $('first-run-dialog').open) $('first-run-dialog').close();
  await loadData();
}

function renderMode() {
  const label = state.mode === 'local' ? 'Lokal' : 'Server';
  const badgeLabel = $('mode-badge').querySelector('span:last-child');
  if (badgeLabel) badgeLabel.textContent = label; else $('mode-badge').textContent = label;
  if ($('project-mode-badge')) $('project-mode-badge').textContent = label;
  $('choose-local').classList.toggle('selected', state.mode === 'local');
  $('choose-server').classList.toggle('selected', state.mode === 'server');
  $('server-settings').classList.toggle('hidden', state.mode !== 'server');
  $('local-data-warning').classList.toggle('hidden', state.mode !== 'local');
  $('mode-explanation').textContent = state.mode === 'local'
    ? 'Aktiv ist nur der lokale Datenspeicher dieses Geräts. Ein Wechsel auf Server überträgt nichts automatisch.'
    : 'Aktiv ist das Docker-Backend. Lokale IndexedDB-Daten bleiben getrennt und werden nicht automatisch synchronisiert.';
}
async function loadData() {
  setConnectionWarning('');
  try {
    state.data = await state.provider.bootstrap();
  } catch (error) {
    state.data = { categories: [], locations: [], items: [], projects: [], project_items: [] };
    setConnectionWarning(error.message || 'Daten konnten nicht geladen werden.');
  }
  renderAll();
}

function byId(store, id) { return state.data[store].find(row => row.id === id); }
function catName(id) { return byId('categories', id)?.name || 'Ohne Kategorie'; }
function locName(id) { return byId('locations', id)?.name || 'Ohne Lagerort'; }
function itemName(id) { return byId('items', id)?.name || 'Unbekanntes Bauteil'; }

function isLow(item) { return Number(item.min_quantity) > 0 && Number(item.quantity) < Number(item.min_quantity); }

function itemGlyph(item) {
  const hay = `${item?.name || ''} ${item?.value_text || ''} ${item ? catName(item.category_id) : ''}`.toLowerCase();
  if (/esp|arduino|mikrocontroller|microcontroller/.test(hay)) return '▦';
  if (/sensor|bme|temperatur|feuchte/.test(hay)) return '◈';
  if (/oled|display|lcd/.test(hay)) return '▤';
  if (/led|ws2812|neopixel/.test(hay)) return '✦';
  if (/kabel|cable|dupont|jumper/.test(hay)) return '⌁';
  if (/widerstand|resistor/.test(hay)) return 'Ω';
  if (/kondensator|capacitor/.test(hay)) return '◒';
  if (/gehäuse|mechanik|case|enclosure/.test(hay)) return '⬡';
  return '◇';
}

function shortUnit(unit) {
  const value = String(unit || 'Stk');
  return value.toLowerCase() === 'stk' ? 'St' : value;
}

function itemSubtitle(item) {
  const parts = [];
  if (item.value_text) parts.push(item.value_text);
  const category = catName(item.category_id);
  if (category && category !== 'Ohne Kategorie') parts.push(category);
  if (!parts.length && item.part_number) parts.push(item.part_number);
  return parts.join(' · ') || 'Bauteil';
}

function tagHtml(item) {
  const tags = String(item.tags || '').split(',').map(v => v.trim()).filter(Boolean).slice(0, 2);
  return tags.map(tag => `<span class="pill">#${esc(tag.replace(/^#/, ''))}</span>`).join('');
}
function renderAll() {
  renderInventory();
  renderProjects();
  renderShortage();
  renderSetupLists();
  fillSelects();
  showView(state.view);
}

function renderInventory() {
  const query = $('search').value.trim().toLowerCase();
  let items = [...state.data.items];
  if (query) items = items.filter(item => [item.name, item.value_text, item.tags, item.part_number, item.manufacturer, catName(item.category_id), locName(item.location_id)].join(' ').toLowerCase().includes(query));
  if (state.lowOnly) items = items.filter(isLow);
  items.sort((a,b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }));
  const low = state.data.items.filter(isLow).length;
  $('inventory-summary').innerHTML = `
    <div class="summary-card"><span class="summary-icon">◇</span><strong>${state.data.items.length}</strong><span>Teile</span></div>
    <div class="summary-card"><span class="summary-icon">▱</span><strong>${state.data.categories.length}</strong><span>Kategorien</span></div>
    <div class="summary-card"><span class="summary-icon">△</span><strong class="${low ? 'low' : ''}">${low}</strong><span>Knapp</span></div>`;
  $('item-list').innerHTML = items.map(item => `
    <article class="item-card">
      <div class="item-thumb" aria-hidden="true">${itemGlyph(item)}</div>
      <button class="item-open" data-id="${esc(item.id)}" type="button">
        <div class="item-copy">
          <h3>${esc(item.name)}</h3>
          <p class="item-subtitle">${esc(itemSubtitle(item))}</p>
          <div class="meta"><span class="meta-plain">▣ ${esc(locName(item.location_id))}</span>${tagHtml(item)}${!item.tags && item.part_number ? `<span class="meta-plain">${esc(item.part_number)}</span>` : ''}</div>
        </div>
      </button>
      <div class="qty ${isLow(item) ? 'low' : ''}"><strong>${nfmt(item.quantity)} ${esc(shortUnit(item.unit))}</strong>${isLow(item) ? '<span class="low-indicator" title="Unter Mindestbestand">▲</span>' : ''}</div>
    </article>`).join('');
  $('inventory-empty').classList.toggle('hidden', items.length > 0 || Boolean(query) || state.lowOnly);
}
function projectStats(project) {
  const lines = state.data.project_items.filter(row => row.project_id === project.id);
  const enough = lines.filter(line => Number(byId('items', line.item_id)?.quantity || 0) >= Number(line.required_quantity || 0)).length;
  return { lines, enough, total: lines.length, percent: lines.length ? Math.round((enough / lines.length) * 100) : 0 };
}

function renderProjects() {
  const projects = [...state.data.projects].sort((a,b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  $('project-list').innerHTML = projects.map(project => {
    const stats = projectStats(project);
    const ready = stats.total > 0 && stats.enough === stats.total;
    return `<article class="project-card"><button class="project-open" data-id="${esc(project.id)}" type="button">
      <div class="project-top"><div><h3>${esc(project.name)}</h3><div class="meta"><span class="pill">${esc(labelStatus[project.status] || project.status)}</span>${ready ? '<span class="pill">Baubar</span>' : ''}</div></div><span class="project-count">${stats.enough} / ${stats.total} vorhanden</span></div>
      <progress class="project-progress" max="100" value="${stats.percent}">${stats.percent}%</progress>
      <div class="project-stats"><span>Benötigte Positionen vorhanden</span><span>${stats.percent} %</span></div>
    </button></article>`;
  }).join('');
  $('projects-empty').classList.toggle('hidden', projects.length > 0);
}
function renderShortage() {
  const items = state.data.items.filter(isLow).sort((a,b) => (Number(a.quantity)-Number(a.min_quantity)) - (Number(b.quantity)-Number(b.min_quantity)));
  $('shortage-list').innerHTML = items.map(item => `<article class="item-card"><div class="item-thumb" aria-hidden="true">${itemGlyph(item)}</div><button class="item-open" data-id="${esc(item.id)}" type="button"><div class="item-copy"><h3>${esc(item.name)}</h3><p class="item-subtitle">${esc(itemSubtitle(item))}</p><div class="meta"><span class="meta-plain">▣ ${esc(locName(item.location_id))}</span><span class="meta-plain">Minimum ${nfmt(item.min_quantity)} ${esc(shortUnit(item.unit))}</span></div></div></button><div class="qty low"><strong>${nfmt(item.quantity)} ${esc(shortUnit(item.unit))}</strong><span class="low-indicator">▲</span></div></article>`).join('');
  $('shortage-empty').classList.toggle('hidden', items.length > 0);
}
function renderSetupLists() {
  $('category-list').innerHTML = [...state.data.categories].sort((a,b)=>a.name.localeCompare(b.name,'de')).map(row => `<div class="manage-row"><span>${esc(row.name)}</span><button type="button" class="delete-category" data-id="${esc(row.id)}" aria-label="Kategorie löschen">×</button></div>`).join('');
  $('location-list').innerHTML = [...state.data.locations].sort((a,b)=>a.name.localeCompare(b.name,'de')).map(row => `<div class="manage-row"><span>${esc(row.name)}</span><button type="button" class="delete-location" data-id="${esc(row.id)}" aria-label="Lagerort löschen">×</button></div>`).join('');
}

function fillSelects() {
  const optionList = (rows, blank) => `<option value="">${esc(blank)}</option>` + [...rows].sort((a,b)=>a.name.localeCompare(b.name,'de')).map(r=>`<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
  $('item-category').innerHTML = optionList(state.data.categories, 'Ohne Kategorie');
  $('item-location').innerHTML = optionList(state.data.locations, 'Ohne Lagerort');
  $('bom-item').innerHTML = [...state.data.items].sort((a,b)=>a.name.localeCompare(b.name,'de')).map(r=>`<option value="${esc(r.id)}">${esc(r.name)} · ${nfmt(r.quantity)} ${esc(r.unit)}</option>`).join('');
}

function showView(view) {
  if (!['inventory','projects','shortage','setup'].includes(view)) view = 'inventory';
  state.view = view;
  localStorage.setItem('maker-inventar-view', view);
  document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el.dataset.view === view));
  document.querySelectorAll('.nav-button').forEach(el => el.classList.toggle('active', el.dataset.target === view));
  const titles = { inventory: 'Inventar', projects: 'Projekte', shortage: 'Knapp', setup: 'Setup' };
  $('view-title').textContent = titles[view];
  $('quick-add').classList.toggle('hidden', view === 'setup' || view === 'shortage');
  $('main').focus({ preventScroll: true });
}

function openItem(id = '') {
  const item = id ? byId('items', id) : null;
  $('item-form').reset();
  $('item-id').value = item?.id || '';
  $('item-name').value = item?.name || '';
  $('item-quantity').value = item?.quantity ?? 1;
  $('item-unit').value = item?.unit || 'Stk';
  $('item-min').value = item?.min_quantity ?? 0;
  $('item-value').value = item?.value_text || '';
  $('item-category').value = item?.category_id || '';
  $('item-location').value = item?.location_id || '';
  $('item-manufacturer').value = item?.manufacturer || '';
  $('item-part-number').value = item?.part_number || '';
  $('item-package').value = item?.package || '';
  $('item-tags').value = item?.tags || '';
  $('item-source-url').value = item?.source_url || '';
  $('item-notes').value = item?.notes || '';
  $('item-dialog-title').textContent = item ? 'Bauteil bearbeiten' : 'Bauteil anlegen';
  $('delete-item').classList.toggle('hidden', !item);
  $('item-dialog').showModal();
}

function itemFormData() {
  return {
    name: $('item-name').value,
    quantity: $('item-quantity').value,
    unit: $('item-unit').value,
    min_quantity: $('item-min').value,
    value_text: $('item-value').value,
    category_id: $('item-category').value || null,
    location_id: $('item-location').value || null,
    manufacturer: $('item-manufacturer').value,
    part_number: $('item-part-number').value,
    package: $('item-package').value,
    tags: $('item-tags').value,
    source_url: $('item-source-url').value,
    notes: $('item-notes').value,
  };
}

async function saveItem(event) {
  event.preventDefault();
  const id = $('item-id').value;
  try {
    if (id) await state.provider.update('items', id, itemFormData()); else await state.provider.create('items', itemFormData());
    $('item-dialog').close();
    await loadData();
    toast('Bauteil gespeichert.');
  } catch (error) { toast(error.message); }
}

function setProjectEditMode(editing, isNew = false) {
  $('project-overview').classList.toggle('hidden', editing || isNew);
  $('project-edit-fields').classList.toggle('hidden', !editing && !isNew);
  $('cancel-project-edit').classList.toggle('hidden', isNew || !editing);
}

function openProject(id = '') {
  const project = id ? byId('projects', id) : null;
  $('project-form').reset();
  $('project-id').value = project?.id || '';
  $('project-name').value = project?.name || '';
  $('project-status').value = project?.status || 'planned';
  $('project-notes').value = project?.notes || '';
  $('project-dialog-title').textContent = project ? 'Projekt' : 'Projekt anlegen';
  $('delete-project').classList.toggle('hidden', !project);
  $('project-bom-area').classList.add('hidden');
  $('project-mode-badge').textContent = state.mode === 'local' ? 'Lokal' : 'Server';
  if (project) {
    $('project-display-name').textContent = project.name;
    setProjectEditMode(false, false);
    renderBom(project.id);
  } else {
    $('project-display-name').textContent = '';
    $('project-bom-list').replaceChildren();
    $('project-detail-progress').replaceChildren();
    setProjectEditMode(true, true);
  }
  $('project-dialog').showModal();
}

function renderBom(projectId) {
  const project = byId('projects', projectId);
  if (!project) return;
  const stats = projectStats(project);
  $('project-display-name').textContent = project.name;
  $('project-detail-progress').innerHTML = `<div class="detail-progress-top"><span class="detail-available-badge">${stats.enough} / ${stats.total} vorhanden</span></div><div class="detail-progress-line"><progress class="project-progress" max="100" value="${stats.percent}">${stats.percent}%</progress><strong>${stats.percent} %</strong></div>`;
  const rows = state.data.project_items.filter(r => r.project_id === projectId);
  $('project-bom-list').innerHTML = rows.length ? rows.map(row => {
    const item = byId('items', row.item_id);
    const enough = Number(item?.quantity || 0) >= Number(row.required_quantity || 0);
    return `<article class="project-part-row">
      <div class="project-part-thumb" aria-hidden="true">${itemGlyph(item)}</div>
      <div class="project-part-copy"><strong>${esc(itemName(row.item_id))}</strong><small>${esc(item ? itemSubtitle(item) : 'Bauteil')}</small><div class="bom-actions"><button class="edit-bom" data-id="${esc(row.id)}" type="button" aria-label="Projektposition bearbeiten">✎</button><button class="delete-bom" data-id="${esc(row.id)}" type="button" aria-label="Projektposition entfernen">×</button></div></div>
      <div class="project-part-status ${enough ? '' : 'low'}"><span>${nfmt(item?.quantity || 0)} / ${nfmt(row.required_quantity)}</span><span class="${enough ? 'status-check' : 'status-warn'}">${enough ? '✓' : '!'}</span></div>
    </article>`;
  }).join('') : '<div class="empty compact-empty"><p>Noch keine benötigten Bauteile hinterlegt.</p></div>';
}

async function saveProject(event) {
  event.preventDefault();
  const id = $('project-id').value;
  const data = { name: $('project-name').value, status: $('project-status').value, notes: $('project-notes').value };
  try {
    const saved = id ? await state.provider.update('projects', id, data) : await state.provider.create('projects', data);
    await loadData();
    $('project-id').value = saved.id;
    $('delete-project').classList.remove('hidden');
    $('project-dialog-title').textContent = 'Projekt';
    setProjectEditMode(false, false);
    renderBom(saved.id);
    toast(id ? 'Projekt gespeichert.' : 'Projekt angelegt. Jetzt kannst du Teile hinzufügen.');
  } catch (error) { toast(error.message); }
}
function openBom(rowId = '') {
  const row = rowId ? byId('project_items', rowId) : null;
  const projectId = row?.project_id || $('project-id').value;
  if (!projectId) return;
  $('bom-form').reset();
  $('bom-id').value = row?.id || '';
  $('bom-project-id').value = projectId;
  $('bom-item').disabled = Boolean(row);
  $('bom-item').value = row?.item_id || state.data.items[0]?.id || '';
  $('bom-quantity').value = row?.required_quantity ?? 1;
  $('bom-notes').value = row?.notes || '';
  $('bom-dialog').showModal();
}

async function saveBom(event) {
  event.preventDefault();
  const rowId = $('bom-id').value;
  const data = { project_id: $('bom-project-id').value, item_id: $('bom-item').value, required_quantity: $('bom-quantity').value, notes: $('bom-notes').value };
  try {
    if (rowId) await state.provider.update('project_items', rowId, data); else await state.provider.create('project_items', data);
    $('bom-dialog').close();
    await loadData();
    renderBom(data.project_id);
    toast('Projektbedarf gespeichert.');
  } catch (error) { toast(error.message); }
}

function confirmAction(title, text, { dangerLabel = 'Fortfahren', extraBuilder = null } = {}) {
  return new Promise(resolve => {
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text;
    $('confirm-ok').textContent = dangerLabel;
    const extra = $('confirm-extra');
    extra.replaceChildren();
    if (extraBuilder) extraBuilder(extra);
    const done = value => { $('confirm-dialog').close(); cleanup(); resolve(value); };
    const yes = () => done(true); const no = () => done(false);
    const cleanup = () => { $('confirm-ok').removeEventListener('click', yes); $('confirm-cancel').removeEventListener('click', no); };
    $('confirm-ok').addEventListener('click', yes); $('confirm-cancel').addEventListener('click', no);
    $('confirm-dialog').showModal();
  });
}

async function deleteCurrentItem() {
  const id = $('item-id').value;
  if (!id) return;
  if (!await confirmAction('Bauteil löschen?', 'Das Bauteil wird auch aus Projektbedarfen entfernt. Diese Aktion kann nicht rückgängig gemacht werden.', { dangerLabel: 'Löschen' })) return;
  try { await state.provider.delete('items', id); $('item-dialog').close(); await loadData(); toast('Bauteil gelöscht.'); } catch (error) { toast(error.message); }
}

async function deleteCurrentProject() {
  const id = $('project-id').value;
  if (!id) return;
  if (!await confirmAction('Projekt löschen?', 'Das Projekt und seine Bedarfsliste werden gelöscht. Inventarbestände bleiben unverändert.', { dangerLabel: 'Löschen' })) return;
  try { await state.provider.delete('projects', id); $('project-dialog').close(); await loadData(); toast('Projekt gelöscht.'); } catch (error) { toast(error.message); }
}

async function manageDelete(store, id, label) {
  if (!await confirmAction(`${label} löschen?`, `Bestehende Bauteile behalten ihren Datensatz; die Zuordnung zu dieser ${label.toLowerCase()} wird entfernt.`, { dangerLabel: 'Löschen' })) return;
  try { await state.provider.delete(store, id); await loadData(); toast(`${label} gelöscht.`); } catch (error) { toast(error.message); }
}

async function loadServerSettingsIntoForm() {
  const backend = await getSecureSetting('backendUrl');
  const clientId = await getSecureSetting('cfClientId');
  const storedDockerWebUrl = await getSecureSetting('dockerWebUrl');
  const hasSecret = Boolean(await getSecureSetting('cfClientSecret'));
  const hasToken = Boolean(await getSecureSetting('appApiToken'));
  $('backend-url').value = backend || state.config.defaultServerUrl || '';
  $('docker-web-url').value = storedDockerWebUrl || state.config.dockerWebUrl || '';
  $('cf-client-id').value = clientId || '';
  $('cf-client-secret').value = '';
  $('cf-client-secret').placeholder = hasSecret ? 'Secret ist auf diesem Gerät gespeichert' : 'Cloudflare Service Secret';
  $('app-api-token').value = '';
  $('app-api-token').placeholder = hasToken ? 'App API Token ist gespeichert' : 'nur falls AUTH_ENABLED=true';
  const fallbackUrl = storedDockerWebUrl || state.config.dockerWebUrl || '';
  if (fallbackUrl) { $('docker-fallback').href = fallbackUrl; $('docker-fallback').classList.remove('hidden'); } else { $('docker-fallback').classList.add('hidden'); }
}

async function saveConnection() {
  try {
    await saveServerSettings({ backendUrl: $('backend-url').value, dockerWebUrl: $('docker-web-url').value, cfClientId: $('cf-client-id').value, cfClientSecret: $('cf-client-secret').value, appApiToken: $('app-api-token').value });
    $('cf-client-secret').value = '';
    $('app-api-token').value = '';
    await loadServerSettingsIntoForm();
    toast('Verbindung lokal auf diesem Gerät gespeichert.');
    if (state.mode === 'server') await loadData();
  } catch (error) { toast(error.message); }
}

async function testServer() {
  try {
    await saveServerSettings({ backendUrl: $('backend-url').value, dockerWebUrl: $('docker-web-url').value, cfClientId: $('cf-client-id').value, cfClientSecret: $('cf-client-secret').value, appApiToken: $('app-api-token').value });
    const result = await new ServerProvider(state.config).testConnection();
    toast(result?.status === 'ok' ? 'Server erreichbar.' : 'Server antwortet.');
  } catch (error) { toast(error.message); }
}

async function clearConnection() {
  if (!await confirmAction('Zugangsdaten löschen?', 'Backend URL, Cloudflare Service Token und optionaler App-Token werden nur auf diesem Gerät entfernt.', { dangerLabel: 'Zugangsdaten löschen' })) return;
  await clearServerCredentials();
  await loadServerSettingsIntoForm();
  toast('Zugangsdaten gelöscht.');
}

function backupCountsText(counts) {
  return `${counts.items} Bauteile, ${counts.projects} Projekte, ${counts.project_items} Projektpositionen, ${counts.categories} Kategorien und ${counts.locations} Lagerorte`;
}

function conflictText(preview) {
  const conflicts = preview?.conflicts;
  if (!conflicts) return 'Keine Konfliktprüfung verfügbar.';
  if (conflicts.hard_count) return `${conflicts.hard_count} Eindeutigkeitskonflikt(e) erkannt; Zusammenführen ist blockiert, bis sie gelöst sind. ${conflicts.overwrite_count || 0} Datensatz-ID(s) würden aktualisiert.`;
  if (conflicts.overwrite_count) return `Keine harten Konflikte. ${conflicts.overwrite_count} Datensatz-ID(s) würden beim Zusammenführen aktualisiert.`;
  return 'Keine Konflikte mit bestehenden IDs oder eindeutigen Zuordnungen erkannt.';
}

async function shareOrDownloadJson(backup, prefix = 'maker-inventar-backup') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = new File([JSON.stringify(backup, null, 2)], `${prefix}-${stamp}.json`, { type: 'application/json' });
  if (navigator.share && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Maker Inventar Backup' }); return; } catch (error) { if (error.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a'); a.href = url; a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function exportBackup() {
  try { const backup = await state.provider.exportData(); await shareOrDownloadJson(backup); toast('Backup erstellt.'); } catch (error) { toast(error.message); }
}

function chooseStrategy(title, text) {
  let select;
  return confirmAction(title, text, {
    dangerLabel: 'Import starten',
    extraBuilder: extra => {
      const label = document.createElement('label'); label.textContent = 'Vorgehen'; label.className = 'settings-form';
      select = document.createElement('select');
      select.innerHTML = '<option value="replace">Ersetzen – Zielbestand vollständig ersetzen</option><option value="merge">Zusammenführen – gleiche IDs überschreiben</option>';
      label.appendChild(select); extra.appendChild(label);
    }
  }).then(ok => ok ? select.value : null);
}

async function importSelectedFile(file) {
  try {
    const backup = JSON.parse(await file.text());
    const counts = validateBackup(backup);
    const preview = state.provider.previewImport ? await state.provider.previewImport(backup) : null;
    const strategy = await chooseStrategy('Backup importieren?', `Validiertes Backup: ${backupCountsText(counts)}. ${conflictText(preview)} Vor einem Ersetzen wird im Server-Modus automatisch ein SQLite-Sicherheitsbackup erstellt.`);
    if (!strategy) return;
    if (state.mode === 'local' && strategy === 'replace') {
      const current = await new LocalProvider().exportData();
      await shareOrDownloadJson(current, 'maker-inventar-vor-restore');
    }
    await state.provider.importData(backup, strategy);
    await loadData(); toast('Import abgeschlossen.');
  } catch (error) { toast(error.message); }
}

async function transferLocalToServer() {
  try {
    const local = new LocalProvider(); const server = new ServerProvider(state.config);
    const backup = await local.exportData(); const counts = validateBackup(backup);
    await server.testConnection(); const preview = await server.previewImport(backup);
    const strategy = await chooseStrategy('Lokale Daten auf Server übertragen?', `${backupCountsText(counts)} werden bewusst zum Server übertragen. ${conflictText(preview)} Keine automatische Synchronisation. Vor dem Server-Import erstellt das Backend ein SQLite-Backup.`);
    if (!strategy) return;
    await server.importData(backup, strategy);
    if (state.mode === 'server') await loadData();
    toast('Lokale Daten wurden auf den Server übertragen.');
  } catch (error) { toast(error.message); }
}

async function transferServerToLocal() {
  try {
    const server = new ServerProvider(state.config); const local = new LocalProvider();
    const backup = await server.exportData(); const counts = validateBackup(backup);
    const preview = await local.previewImport(backup);
    const strategy = await chooseStrategy('Serverdaten lokal übernehmen?', `${backupCountsText(counts)} werden in den lokalen Datenspeicher übernommen. ${conflictText(preview)} Bei Ersetzen wird vorher ein lokales Sicherheitsbackup exportiert.`);
    if (!strategy) return;
    if (strategy === 'replace') await shareOrDownloadJson(await local.exportData(), 'maker-inventar-lokal-vor-uebernahme');
    await local.importData(backup, strategy);
    if (state.mode === 'local') await loadData();
    toast('Serverdaten wurden lokal übernommen.');
  } catch (error) { toast(error.message); }
}

async function checkHosting() {
  if (state.config.buildTarget !== 'pages') return;
  try {
    const response = await fetch(`config.json?network-check=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error();
    $('hosting-warning').classList.add('hidden');
  } catch { $('hosting-warning').classList.remove('hidden'); }
}

function updateUiReady() {
  state.updateReady = true;
  $('update-banner').classList.remove('hidden');
  $('update-status').textContent = 'Neue Version verfügbar';
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) { $('update-status').textContent = 'Service Worker nicht unterstützt'; return; }
  try {
    const registration = await navigator.serviceWorker.register('service-worker.js', { scope: './' });
    state.swRegistration = registration;
    if (registration.waiting) updateUiReady(); else $('update-status').textContent = 'Aktuell';
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) updateUiReady();
      });
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (sessionStorage.getItem('maker-inventar-manual-update') === '1' && !sessionStorage.getItem('maker-inventar-reloaded')) {
        sessionStorage.setItem('maker-inventar-reloaded', '1');
        sessionStorage.removeItem('maker-inventar-manual-update');
        window.location.reload();
      }
    });
    setTimeout(() => registration.update().catch(() => {}), 1200);
  } catch { $('update-status').textContent = 'Update-Prüfung nicht verfügbar'; }
}

function applyUpdate() {
  const worker = state.swRegistration?.waiting;
  if (!worker) { toast('Kein wartendes Update gefunden.'); return; }
  localStorage.setItem('maker-inventar-view', state.view);
  sessionStorage.removeItem('maker-inventar-reloaded');
  sessionStorage.setItem('maker-inventar-manual-update', '1');
  worker.postMessage({ type: 'SKIP_WAITING' });
}

async function checkUpdate() {
  try {
    if (!state.swRegistration) throw new Error('Service Worker nicht verfügbar.');
    $('update-status').textContent = 'Prüfung läuft …';
    await state.swRegistration.update();
    setTimeout(() => { if (!state.updateReady) $('update-status').textContent = 'Aktuell'; }, 700);
  } catch (error) { $('update-status').textContent = 'Prüfung fehlgeschlagen'; toast(error.message); }
}

function bindEvents() {
  document.querySelectorAll('.nav-button').forEach(btn => btn.addEventListener('click', () => showView(btn.dataset.target)));
  $('quick-add').addEventListener('click', () => state.view === 'projects' ? openProject() : openItem());
  $('empty-add-item').addEventListener('click', () => openItem());
  $('add-project').addEventListener('click', () => openProject());
  $('search').addEventListener('input', renderInventory);
  $('filter-low').addEventListener('click', () => { state.lowOnly = !state.lowOnly; $('filter-low').setAttribute('aria-pressed', String(state.lowOnly)); renderInventory(); });
  $('item-form').addEventListener('submit', saveItem);
  $('project-form').addEventListener('submit', saveProject);
  $('bom-form').addEventListener('submit', saveBom);
  $('delete-item').addEventListener('click', deleteCurrentItem);
  $('delete-project').addEventListener('click', deleteCurrentProject);
  $('add-project-item').addEventListener('click', () => openBom());
  $('toggle-project-edit').addEventListener('click', () => setProjectEditMode(true, false));
  $('cancel-project-edit').addEventListener('click', () => { const project = byId('projects', $('project-id').value); if (project) { $('project-name').value = project.name; $('project-status').value = project.status; $('project-notes').value = project.notes || ''; setProjectEditMode(false, false); } });
  document.addEventListener('click', async event => {
    const item = event.target.closest('.item-open'); if (item) openItem(item.dataset.id);
    const project = event.target.closest('.project-open'); if (project) openProject(project.dataset.id);
    const editBom = event.target.closest('.edit-bom'); if (editBom) openBom(editBom.dataset.id);
    const deleteBom = event.target.closest('.delete-bom'); if (deleteBom) {
      const row = byId('project_items', deleteBom.dataset.id); if (row && await confirmAction('Projektposition entfernen?', 'Nur diese Bedarfsliste-Zeile wird entfernt.', { dangerLabel: 'Entfernen' })) { await state.provider.delete('project_items', row.id); await loadData(); renderBom(row.project_id); }
    }
    const dc = event.target.closest('.delete-category'); if (dc) manageDelete('categories', dc.dataset.id, 'Kategorie');
    const dl = event.target.closest('.delete-location'); if (dl) manageDelete('locations', dl.dataset.id, 'Lagerort');
    const closer = event.target.closest('[data-close]'); if (closer) $(closer.dataset.close).close();
  });
  $('category-form').addEventListener('submit', async event => { event.preventDefault(); try { await state.provider.create('categories', { name: $('new-category').value }); $('new-category').value=''; await loadData(); } catch(e){toast(e.message);} });
  $('location-form').addEventListener('submit', async event => { event.preventDefault(); try { await state.provider.create('locations', { name: $('new-location').value }); $('new-location').value=''; await loadData(); } catch(e){toast(e.message);} });
  $('choose-local').addEventListener('click', () => switchMode('local'));
  $('choose-server').addEventListener('click', () => switchMode('server'));
  $('first-local').addEventListener('click', () => switchMode('local', { firstRun: true }));
  $('first-server').addEventListener('click', async () => { await switchMode('server', { firstRun: true }); showView('setup'); });
  $('save-server-settings').addEventListener('click', saveConnection);
  $('test-server').addEventListener('click', testServer);
  $('clear-server-settings').addEventListener('click', clearConnection);
  $('export-backup').addEventListener('click', exportBackup);
  $('import-backup').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', async () => { const file = $('import-file').files?.[0]; if (file) await importSelectedFile(file); $('import-file').value=''; });
  $('transfer-local-server').addEventListener('click', transferLocalToServer);
  $('transfer-server-local').addEventListener('click', transferServerToLocal);
  $('apply-update').addEventListener('click', applyUpdate);
  $('check-update').addEventListener('click', checkUpdate);
}

async function init() {
  bindEvents();
  await loadConfig();
  state.mode = currentMode();
  if (!state.mode && state.config.buildTarget === 'docker') state.mode = 'server';
  if (!state.mode) {
    $('first-run-dialog').showModal();
    state.mode = 'local';
    state.provider = new LocalProvider();
    renderMode();
    await loadData();
  } else {
    await switchMode(state.mode);
  }
  await loadServerSettingsIntoForm();
  await registerServiceWorker();
  checkHosting();
  setInterval(checkHosting, 5 * 60 * 1000);
}

init().catch(error => { setConnectionWarning(error.message || 'App konnte nicht initialisiert werden.'); });
