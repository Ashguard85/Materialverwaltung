import { LocalProvider, ServerProvider, saveServerSettings, validateBackup } from './providers.js';
import { getSecureSetting, clearServerCredentials } from './db.js';
import { createZip, readZip } from './zip.js';

const CLIENT_VERSION = 'v13';

const state = {
  config: { appName: 'Maker Inventar', version: 'v13', buildTarget: 'pages', defaultMode: null, defaultServerUrl: '', dockerWebUrl: '', sameOriginServer: false, authEnabled: false },
  mode: null,
  provider: null,
  data: { categories: [], locations: [], items: [], projects: [], project_items: [], project_files: [] },
  view: localStorage.getItem('maker-inventar-view') || 'inventory',
  lowOnly: false,
  swRegistration: null,
  updateReady: false,
  publishedVersion: '',
  lastUpdateCheck: 0,
  imageUrls: new Map(),
  itemImageChange: null,
  itemPreviewUrl: '',
  editingItemHadImage: false,
  projectImageUrls: new Map(),
  projectImageChange: null,
  projectPreviewUrl: '',
  editingProjectHadImage: false,
  updateWaitingWorker: null,
  updateReloadIssued: false,
  updateReloadTimer: null,
  criticalOperations: 0,
  setupDirty: false,
};

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c]));
const nfmt = (value) => Number(value || 0).toLocaleString('de-CH', { maximumFractionDigits: 3 });
const labelStatus = { planned: 'Geplant', active: 'Aktiv', done: 'Fertig' };

const icon = (name, extraClass = '') => `<svg class="ui-icon${extraClass ? ` ${extraClass}` : ''}" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;

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
  if (state.config.buildTarget === 'docker') { state.config.sameOriginServer = true; state.config.defaultMode = 'server'; state.config.defaultServerUrl = window.location.origin; }
  document.documentElement.dataset.buildTarget = state.config.buildTarget;
  document.title = state.config.appName || 'Maker Inventar';
  $('app-version').textContent = CLIENT_VERSION;
  if (state.config.dockerWebUrl) {
    $('docker-fallback').href = state.config.dockerWebUrl;
    $('docker-fallback').classList.remove('hidden');
  }
}

function currentMode() {
  if (state.config.buildTarget === 'docker') return 'server';
  return localStorage.getItem('maker-inventar-mode') || state.config.defaultMode || null;
}

async function switchMode(mode, { firstRun = false } = {}) {
  if (state.config.buildTarget === 'docker') mode = 'server';
  if (!['local', 'server'].includes(mode)) return;
  clearImageCache();
  localStorage.setItem('maker-inventar-mode', mode);
  state.mode = mode;
  state.provider = mode === 'local' ? new LocalProvider() : new ServerProvider(state.config);
  renderMode();
  if (firstRun && $('first-run-dialog').open) $('first-run-dialog').close();
  await loadData();
}

function renderBuildTargetUi() {
  const isDocker = state.config.buildTarget === 'docker';
  const modeChoice = document.querySelector('.mode-choice');
  const serverCard = $('server-settings');
  const integrated = $('docker-integrated-server');
  if (modeChoice) modeChoice.classList.toggle('hidden', isDocker);
  if (integrated) {
    integrated.classList.toggle('hidden', !isDocker);
    const origin = $('docker-origin'); if (origin) origin.textContent = window.location.origin;
  }
  if (serverCard) {
    const heading = serverCard.querySelector('h2'); if (heading) heading.textContent = isDocker ? 'Integriertes Backend' : 'Serververbindung';
  }
  for (const id of ['backend-url','docker-web-url','cf-client-id','cf-client-secret']) {
    const row = $(id)?.closest('.settings-row'); if (row) row.classList.toggle('hidden', isDocker);
  }
  const tokenRow = $('app-api-token')?.closest('.settings-row');
  if (tokenRow) tokenRow.classList.toggle('hidden', isDocker && !state.config.authEnabled);
  $('save-server-settings')?.classList.toggle('hidden', isDocker && !state.config.authEnabled);
  $('clear-server-settings')?.classList.toggle('hidden', isDocker && !state.config.authEnabled);
  $('transfer-local-server')?.classList.toggle('hidden', isDocker);
  $('transfer-server-local')?.classList.toggle('hidden', isDocker);
}

function renderMode() {
  const label = state.mode === 'local' ? 'Lokal' : 'Server';
  const badge = $('mode-badge');
  const badgeLabel = badge.querySelector('.badge-label');
  const badgeUse = badge.querySelector('use');
  if (badgeLabel) badgeLabel.textContent = label;
  if (badgeUse) badgeUse.setAttribute('href', state.mode === 'local' ? '#i-device' : '#i-server');
  const projectBadge = $('project-mode-badge');
  if (projectBadge) {
    const projectLabel = projectBadge.querySelector('.badge-label');
    const projectUse = projectBadge.querySelector('use');
    if (projectLabel) projectLabel.textContent = label;
    if (projectUse) projectUse.setAttribute('href', state.mode === 'local' ? '#i-device' : '#i-server');
  }
  $('choose-local').classList.toggle('selected', state.mode === 'local');
  $('choose-server').classList.toggle('selected', state.mode === 'server');
  $('server-settings').classList.toggle('hidden', state.mode !== 'server');
  $('local-data-warning').classList.toggle('hidden', state.mode !== 'local');
  $('mode-explanation').textContent = state.config.buildTarget === 'docker'
    ? 'Die Docker-App verwendet automatisch ihr integriertes Backend über dieselbe Adresse. Keine Backend-URL oder Cloudflare-Service-Zugangsdaten nötig.'
    : state.mode === 'local'
      ? 'Aktiv ist nur der lokale Datenspeicher dieses Geräts. Ein Wechsel auf Server überträgt nichts automatisch.'
      : 'Aktiv ist das Docker-Backend. Lokale IndexedDB-Daten bleiben getrennt und werden nicht automatisch synchronisiert.';
  renderBuildTargetUi();
}
async function loadData() {
  setConnectionWarning('');
  try {
    state.data = await state.provider.bootstrap();
  } catch (error) {
    state.data = { categories: [], locations: [], items: [], projects: [], project_items: [], project_files: [] };
    setConnectionWarning(error.message || 'Daten konnten nicht geladen werden.');
  }
  renderAll();
}

function byId(store, id) { return state.data[store].find(row => row.id === id); }
function catName(id) { return byId('categories', id)?.name || 'Ohne Kategorie'; }
function locName(id) { return byId('locations', id)?.name || 'Ohne Lagerort'; }
function itemName(id) { return byId('items', id)?.name || 'Unbekanntes Bauteil'; }

function isLow(item) { return Number(item.min_quantity) > 0 && Number(item.quantity) < Number(item.min_quantity); }

function itemIconName(item) {
  const hay = `${item?.name || ''} ${item?.value_text || ''} ${item ? catName(item.category_id) : ''}`.toLowerCase();
  if (/esp|arduino|mikrocontroller|microcontroller/.test(hay)) return 'chip';
  if (/sensor|bme|temperatur|feuchte/.test(hay)) return 'sensor';
  if (/oled|display|lcd/.test(hay)) return 'display';
  if (/led|ws2812|neopixel/.test(hay)) return 'led';
  if (/kabel|cable|dupont|jumper/.test(hay)) return 'cable';
  if (/widerstand|resistor/.test(hay)) return 'resistor';
  if (/kondensator|capacitor/.test(hay)) return 'capacitor';
  if (/gehäuse|mechanik|case|enclosure/.test(hay)) return 'case';
  return 'cube';
}

function shortUnit(unit) {
  const value = String(unit || 'Stk');
  return value.toLowerCase() === 'stk' ? 'St' : value;
}


function itemThumbHtml(item, className = 'item-thumb') {
  const hasImage = Boolean(item?.image_updated_at);
  const attrs = hasImage ? ` data-item-image="${esc(item.id)}" data-image-version="${esc(item.image_updated_at)}"` : '';
  return `<div class="${className}" aria-hidden="true"${attrs}><img alt=""${hasImage ? '' : ' class="hidden"'}><span class="thumb-fallback">${icon(itemIconName(item), 'thumb-icon')}</span></div>`;
}

function clearImageCache() {
  for (const entry of state.imageUrls.values()) URL.revokeObjectURL(entry.url);
  state.imageUrls.clear();
  for (const entry of state.projectImageUrls.values()) URL.revokeObjectURL(entry.url);
  state.projectImageUrls.clear();
}
function invalidateItemImage(itemId) {
  const entry = state.imageUrls.get(itemId);
  if (entry) URL.revokeObjectURL(entry.url);
  state.imageUrls.delete(itemId);
}
async function hydrateItemImages(root = document) {
  const nodes = [...root.querySelectorAll('[data-item-image]')];
  await Promise.all(nodes.map(async node => {
    const itemId = node.dataset.itemImage;
    const version = node.dataset.imageVersion || '';
    const cached = state.imageUrls.get(itemId);
    let url = cached?.key === `${state.mode}:${version}` ? cached.url : '';
    if (!url) {
      if (cached) { URL.revokeObjectURL(cached.url); state.imageUrls.delete(itemId); }
      try {
        const blob = await state.provider.getItemImage(itemId);
        if (!blob) return;
        url = URL.createObjectURL(blob);
        state.imageUrls.set(itemId, { key: `${state.mode}:${version}`, url });
      } catch { return; }
    }
    const img = node.querySelector('img');
    if (img) { img.classList.remove('hidden'); img.src = url; node.classList.add('has-image'); }
  }));
}

function revokeEditorPreview() {
  if (state.itemPreviewUrl) URL.revokeObjectURL(state.itemPreviewUrl);
  state.itemPreviewUrl = '';
}
function showItemPhotoBlob(blob) {
  revokeEditorPreview();
  const img = $('item-photo-img');
  if (!blob) {
    img.removeAttribute('src'); img.classList.add('hidden'); $('item-photo-placeholder').classList.remove('hidden');
    return;
  }
  state.itemPreviewUrl = URL.createObjectURL(blob);
  img.src = state.itemPreviewUrl; img.classList.remove('hidden'); $('item-photo-placeholder').classList.add('hidden');
}
async function processItemImage(file) {
  if (!file || !file.type.startsWith('image/')) throw new Error('Bitte eine Bilddatei auswählen.');
  if (file.size > 25 * 1024 * 1024) throw new Error('Das ausgewählte Bild ist zu groß.');
  let source; let cleanup = () => {};
  try {
    source = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    const url = URL.createObjectURL(file); cleanup = () => URL.revokeObjectURL(url);
    source = await new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error('Bild konnte nicht gelesen werden.')); img.src = url; });
  }
  const width = source.width || source.naturalWidth; const height = source.height || source.naturalHeight;
  const scale = Math.min(1, 1600 / Math.max(width, height));
  const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d', { alpha: false }); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  if (source.close) source.close(); cleanup();
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.86));
  if (!blob) throw new Error('Bild konnte nicht verarbeitet werden.');
  return blob;
}
async function handleItemPhotoFile(file) {
  try {
    const blob = await processItemImage(file); state.itemImageChange = { action: 'set', blob }; showItemPhotoBlob(blob); $('item-photo-remove').classList.remove('hidden');
  } catch (error) { toast(error.message); }
}

function projectThumbHtml(project) {
  const hasImage = Boolean(project?.image_updated_at);
  const attrs = hasImage ? ` data-project-image="${esc(project.id)}" data-image-version="${esc(project.image_updated_at)}"` : '';
  return `<div class="project-card-thumb" aria-hidden="true"${attrs}><img alt=""${hasImage ? '' : ' class="hidden"'}><span class="thumb-fallback">${icon('image', 'thumb-icon')}</span></div>`;
}
function invalidateProjectImage(projectId) {
  const entry = state.projectImageUrls.get(projectId); if (entry) URL.revokeObjectURL(entry.url); state.projectImageUrls.delete(projectId);
}
async function projectImageUrl(project) {
  if (!project?.image_updated_at) return '';
  const key = `${state.mode}:${project.image_updated_at}`; const cached = state.projectImageUrls.get(project.id);
  if (cached?.key === key) return cached.url;
  if (cached) { URL.revokeObjectURL(cached.url); state.projectImageUrls.delete(project.id); }
  const blob = await state.provider.getProjectImage(project.id); if (!blob) return ''; const url = URL.createObjectURL(blob); state.projectImageUrls.set(project.id, { key, url }); return url;
}
async function hydrateProjectImages(root = document) {
  const nodes = [...root.querySelectorAll('[data-project-image]')];
  await Promise.all(nodes.map(async node => { const project = byId('projects', node.dataset.projectImage); if (!project) return; try { const url = await projectImageUrl(project); if (!url) return; const img = node.querySelector('img'); if (img) { img.classList.remove('hidden'); img.src = url; node.classList.add('has-image'); } } catch {} }));
}
function revokeProjectPreview() { if (state.projectPreviewUrl) URL.revokeObjectURL(state.projectPreviewUrl); state.projectPreviewUrl = ''; }
function showProjectPhotoBlob(blob) { revokeProjectPreview(); const img=$('project-photo-img'); if(!blob){img.removeAttribute('src');img.classList.add('hidden');$('project-photo-placeholder').classList.remove('hidden');return;} state.projectPreviewUrl=URL.createObjectURL(blob);img.src=state.projectPreviewUrl;img.classList.remove('hidden');$('project-photo-placeholder').classList.add('hidden'); }
async function handleProjectPhotoFile(file) { try { const blob=await processItemImage(file); state.projectImageChange={action:'set',blob}; showProjectPhotoBlob(blob); $('project-photo-remove').classList.remove('hidden'); } catch(error){ toast(error.message); } }
async function showProjectCover(project) { const img=$('project-cover-img'); const placeholder=$('project-cover-placeholder'); img.removeAttribute('src'); img.classList.add('hidden'); placeholder.classList.remove('hidden'); if(!project?.image_updated_at)return; try{const url=await projectImageUrl(project);if(url){img.src=url;img.classList.remove('hidden');placeholder.classList.add('hidden');}}catch{} }
async function loadProjectPhotoEditor(project) { state.projectImageChange=null; state.editingProjectHadImage=Boolean(project?.image_updated_at); $('project-photo-remove').classList.toggle('hidden',!state.editingProjectHadImage); if(!state.editingProjectHadImage){showProjectPhotoBlob(null);return;} try{const blob=await state.provider.getProjectImage(project.id);showProjectPhotoBlob(blob);}catch{showProjectPhotoBlob(null);} }

function itemSubtitle(item) {
  const parts = [];
  if (item.value_text) parts.push(item.value_text);
  const category = catName(item.category_id);
  if (category && category !== 'Ohne Kategorie') parts.push(category);
  if (!parts.length && item.part_number) parts.push(item.part_number);
  return parts.join(' · ') || 'Bauteil';
}

function renderAll() {
  renderInventory();
  renderProjects();
  renderShortage();
  renderSetupLists();
  fillSelects();
  showView(state.view);
  hydrateItemImages();
  hydrateProjectImages();
}

function renderInventory() {
  const query = $('search').value.trim().toLowerCase();
  let items = [...state.data.items];
  if (query) items = items.filter(item => [item.name, item.value_text, item.part_number, item.manufacturer, catName(item.category_id), locName(item.location_id)].join(' ').toLowerCase().includes(query));
  if (state.lowOnly) items = items.filter(isLow);
  items.sort((a,b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }));
  const low = state.data.items.filter(isLow).length;
  $('inventory-summary').innerHTML = `
    <div class="summary-card"><span class="summary-icon">${icon('cube')}</span><strong>${state.data.items.length}</strong><span>Teile</span></div>
    <div class="summary-card"><span class="summary-icon">${icon('folder')}</span><strong>${state.data.categories.length}</strong><span>Kategorien</span></div>
    <div class="summary-card"><span class="summary-icon">${icon('warning')}</span><strong class="${low ? 'low' : ''}">${low}</strong><span>Knapp</span></div>`;
  $('item-list').innerHTML = items.map(item => `
    <article class="item-card">
      ${itemThumbHtml(item)}
      <button class="item-open" data-id="${esc(item.id)}" type="button">
        <div class="item-copy">
          <h3>${esc(item.name)}</h3>
          <p class="item-subtitle">${esc(itemSubtitle(item))}</p>
          <div class="meta"><span class="meta-plain">${icon('storage', 'meta-icon')}${esc(locName(item.location_id))}</span>${item.part_number ? `<span class="meta-plain">${esc(item.part_number)}</span>` : ''}</div>
        </div>
      </button>
      <div class="qty ${isLow(item) ? 'low' : ''}"><strong>${nfmt(item.quantity)} ${esc(shortUnit(item.unit))}</strong>${isLow(item) ? `<span class="low-indicator" title="Unter Mindestbestand">${icon('warning-fill')}</span>` : ''}</div>
    </article>`).join('');
  $('inventory-empty').classList.toggle('hidden', items.length > 0 || Boolean(query) || state.lowOnly);
  hydrateItemImages($('item-list'));
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
    return `<article class="project-card"><button class="project-open" data-id="${esc(project.id)}" type="button"><div class="project-card-layout">
      ${projectThumbHtml(project)}<div><div class="project-top"><div><h3>${esc(project.name)}</h3><div class="meta"><span class="pill">${esc(labelStatus[project.status] || project.status)}</span>${ready ? '<span class="pill">Baubar</span>' : ''}</div></div><span class="project-count">${stats.enough} / ${stats.total} vorhanden</span></div>
      <progress class="project-progress" max="100" value="${stats.percent}">${stats.percent}%</progress>
      <div class="project-stats"><span>Benötigte Positionen vorhanden</span><span>${stats.percent} %</span></div>
      ${state.data.project_files.filter(file => file.project_id === project.id).length ? `<div class="meta"><span class="meta-plain">${icon('file-3d','meta-icon')}${state.data.project_files.filter(file => file.project_id === project.id).length} Druckdatei(en)</span></div>` : ''}</div>
    </div></button></article>`;
  }).join('');
  $('projects-empty').classList.toggle('hidden', projects.length > 0);
  hydrateProjectImages($('project-list'));
}
function renderShortage() {
  const items = state.data.items.filter(isLow).sort((a,b) => (Number(a.quantity)-Number(a.min_quantity)) - (Number(b.quantity)-Number(b.min_quantity)));
  $('shortage-list').innerHTML = items.map(item => `<article class="item-card">${itemThumbHtml(item)}<button class="item-open" data-id="${esc(item.id)}" type="button"><div class="item-copy"><h3>${esc(item.name)}</h3><p class="item-subtitle">${esc(itemSubtitle(item))}</p><div class="meta"><span class="meta-plain">${icon('storage', 'meta-icon')}${esc(locName(item.location_id))}</span><span class="meta-plain">Minimum ${nfmt(item.min_quantity)} ${esc(shortUnit(item.unit))}</span></div></div></button><div class="qty low"><strong>${nfmt(item.quantity)} ${esc(shortUnit(item.unit))}</strong><span class="low-indicator">${icon('warning-fill')}</span></div></article>`).join('');
  $('shortage-empty').classList.toggle('hidden', items.length > 0);
  hydrateItemImages($('shortage-list'));
}
function renderSetupLists() {
  $('category-list').innerHTML = [...state.data.categories].sort((a,b)=>a.name.localeCompare(b.name,'de')).map(row => `<div class="manage-row"><span>${esc(row.name)}</span><button type="button" class="delete-category" data-id="${esc(row.id)}" aria-label="Kategorie löschen">${icon('close')}</button></div>`).join('');
  $('location-list').innerHTML = [...state.data.locations].sort((a,b)=>a.name.localeCompare(b.name,'de')).map(row => `<div class="manage-row"><span>${esc(row.name)}</span><button type="button" class="delete-location" data-id="${esc(row.id)}" aria-label="Lagerort löschen">${icon('close')}</button></div>`).join('');
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

async function openItem(id = '') {
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
  $('item-source-url').value = item?.source_url || '';
  $('item-notes').value = item?.notes || '';
  $('item-dialog-title').textContent = item ? 'Bauteil bearbeiten' : 'Bauteil anlegen';
  $('delete-item').classList.toggle('hidden', !item);
  state.itemImageChange = null; state.editingItemHadImage = Boolean(item?.image_updated_at); revokeEditorPreview(); showItemPhotoBlob(null);
  $('item-photo-remove').classList.toggle('hidden', !state.editingItemHadImage);
  $('item-dialog').showModal();
  if (state.editingItemHadImage && item) { try { const blob = await state.provider.getItemImage(item.id); if ($('item-id').value === item.id && !state.itemImageChange) showItemPhotoBlob(blob); } catch { /* missing image falls back */ } }
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
    source_url: $('item-source-url').value,
    notes: $('item-notes').value,
  };
}

async function saveItem(event) {
  event.preventDefault();
  const id = $('item-id').value;
  try {
    const saved = id ? await state.provider.update('items', id, itemFormData()) : await state.provider.create('items', itemFormData());
    if (state.itemImageChange?.action === 'set') await state.provider.setItemImage(saved.id, state.itemImageChange.blob);
    else if (state.itemImageChange?.action === 'delete') await state.provider.deleteItemImage(saved.id);
    invalidateItemImage(saved.id); state.itemImageChange = null; revokeEditorPreview();
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
  const projectMode = $('project-mode-badge');
  const projectModeLabel = projectMode.querySelector('.badge-label');
  const projectModeUse = projectMode.querySelector('use');
  if (projectModeLabel) projectModeLabel.textContent = state.mode === 'local' ? 'Lokal' : 'Server';
  if (projectModeUse) projectModeUse.setAttribute('href', state.mode === 'local' ? '#i-device' : '#i-server');
  state.projectImageChange = null; revokeProjectPreview(); state.editingProjectHadImage = Boolean(project?.image_updated_at);
  if (project) {
    $('project-display-name').textContent = project.name;
    setProjectEditMode(false, false);
    renderBom(project.id);
    renderProjectFiles(project.id);
    showProjectCover(project);
    loadProjectPhotoEditor(project);
  } else {
    $('project-display-name').textContent = '';
    $('project-bom-list').replaceChildren();
    $('project-detail-progress').replaceChildren();
    $('project-files-list').replaceChildren();
    showProjectCover(null);
    showProjectPhotoBlob(null); $('project-photo-remove').classList.add('hidden');
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
      ${itemThumbHtml(item, 'project-part-thumb')}
      <div class="project-part-copy"><strong>${esc(itemName(row.item_id))}</strong><small class="project-part-meta">${icon('storage', 'meta-icon')}${esc(item ? itemSubtitle(item) : 'Bauteil')}</small><div class="bom-actions"><button class="edit-bom" data-id="${esc(row.id)}" type="button" aria-label="Projektposition bearbeiten">${icon('edit')}</button><button class="delete-bom" data-id="${esc(row.id)}" type="button" aria-label="Projektposition entfernen">${icon('close')}</button></div></div>
      <div class="project-part-status ${enough ? '' : 'low'}"><span>${nfmt(item?.quantity || 0)} / ${nfmt(row.required_quantity)}</span><span class="${enough ? 'status-check' : 'status-warn'}">${enough ? icon('check') : icon('warning-fill')}</span></div>
    </article>`;
  }).join('') : '<div class="empty compact-empty"><p>Noch keine benötigten Bauteile hinterlegt.</p></div>';
  hydrateItemImages($('project-bom-list'));
}

function formatBytes(bytes) { const n=Number(bytes||0); if(n<1024)return `${n} B`; if(n<1048576)return `${(n/1024).toFixed(n<10240?1:0)} KB`; return `${(n/1048576).toFixed(n<10485760?1:0)} MB`; }
function projectFileType(file){return String(file.file_type||(file.name?.split('.').pop()||'')).toUpperCase();}
function renderProjectFiles(projectId){const rows=state.data.project_files.filter(r=>r.project_id===projectId).sort((x,y)=>String(y.updated_at||'').localeCompare(String(x.updated_at||''))); $('project-files-list').innerHTML=rows.length?rows.map(file=>`<article class="project-file-row"><span class="project-file-icon">${icon('file-3d')}</span><div class="project-file-copy"><strong>${esc(file.name)}</strong><small>${esc(projectFileType(file))} · ${formatBytes(file.size_bytes)}</small></div><div class="project-file-actions"><button class="download-project-file" data-id="${esc(file.id)}" type="button" aria-label="Datei herunterladen">${icon('download')}</button><button class="delete-project-file danger-file" data-id="${esc(file.id)}" type="button" aria-label="Datei löschen">${icon('trash')}</button></div></article>`).join(''):'<div class="project-file-empty">Noch keine 3D-Druckdatei hinterlegt.</div>';}
const PROJECT_FILE_EXTENSIONS=new Set(['stl','3mf','step','stp','obj','gcode','scad']); const PROJECT_FILE_MAX_LOCAL_BYTES=100*1024*1024;
async function uploadProjectFiles(files){const projectId=$('project-id').value;if(!projectId)return;for(const file of [...files]){const ext=(file.name.split('.').pop()||'').toLowerCase();if(!PROJECT_FILE_EXTENSIONS.has(ext)){toast(`${file.name}: Dateityp nicht unterstützt.`);continue;}if(file.size>PROJECT_FILE_MAX_LOCAL_BYTES){toast(`${file.name}: Datei ist größer als 100 MB.`);continue;}try{await state.provider.addProjectFile(projectId,file);}catch(error){toast(`${file.name}: ${error.message}`);}}await loadData();renderProjectFiles(projectId);toast('3D-Druckdateien aktualisiert.');}
async function downloadProjectFile(fileId){const meta=byId('project_files',fileId);if(!meta)return;try{const blob=await state.provider.getProjectFile(fileId);if(!blob)throw new Error('Dateiinhalt fehlt.');await shareOrDownloadFile(new File([blob],meta.name,{type:meta.mime_type||blob.type||'application/octet-stream'}),meta.name);}catch(error){toast(error.message);}}
async function deleteProjectFile(fileId){const meta=byId('project_files',fileId);if(!meta)return;if(!await confirmAction('3D-Druckdatei löschen?',`${meta.name} wird aus diesem Projekt entfernt.`,{dangerLabel:'Datei löschen'}))return;try{await state.provider.deleteProjectFile(fileId);await loadData();renderProjectFiles(meta.project_id);toast('3D-Druckdatei gelöscht.');}catch(error){toast(error.message);}}

async function saveProject(event) {
  event.preventDefault();
  const id = $('project-id').value;
  const data = { name: $('project-name').value, status: $('project-status').value, notes: $('project-notes').value };
  try {
    const saved = id ? await state.provider.update('projects', id, data) : await state.provider.create('projects', data);
    if (state.projectImageChange?.action === 'set') { await state.provider.setProjectImage(saved.id, state.projectImageChange.blob); invalidateProjectImage(saved.id); }
    else if (state.projectImageChange?.action === 'delete') { await state.provider.deleteProjectImage(saved.id); invalidateProjectImage(saved.id); }
    state.projectImageChange = null; revokeProjectPreview();
    await loadData();
    $('project-id').value = saved.id;
    $('delete-project').classList.remove('hidden');
    $('project-dialog-title').textContent = 'Projekt';
    setProjectEditMode(false, false);
    renderBom(saved.id);
    renderProjectFiles(saved.id);
    const freshProject = byId('projects', saved.id); showProjectCover(freshProject); loadProjectPhotoEditor(freshProject);
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
  try { await state.provider.delete('items', id); invalidateItemImage(id); revokeEditorPreview(); $('item-dialog').close(); await loadData(); toast('Bauteil gelöscht.'); } catch (error) { toast(error.message); }
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
  if (state.config.buildTarget === 'docker') {
    $('backend-url').value = window.location.origin;
    $('docker-web-url').value = state.config.dockerWebUrl || window.location.origin;
    $('cf-client-id').value = ''; $('cf-client-secret').value = '';
    const hasToken = Boolean(await getSecureSetting('appApiToken'));
    $('app-api-token').value = ''; $('app-api-token').placeholder = hasToken ? 'App API Token ist gespeichert' : 'nur falls AUTH_ENABLED=true';
    const fallbackUrl = state.config.dockerWebUrl || window.location.origin;
    $('docker-fallback').href = fallbackUrl; $('docker-fallback').classList.remove('hidden');
    renderBuildTargetUi();
    return;
  }
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
    await saveServerSettings({ backendUrl: state.config.buildTarget === 'docker' ? '' : $('backend-url').value, dockerWebUrl: state.config.buildTarget === 'docker' ? '' : $('docker-web-url').value, cfClientId: state.config.buildTarget === 'docker' ? '' : $('cf-client-id').value, cfClientSecret: state.config.buildTarget === 'docker' ? '' : $('cf-client-secret').value, appApiToken: $('app-api-token').value });
    $('cf-client-secret').value = '';
    $('app-api-token').value = '';
    await loadServerSettingsIntoForm();
    state.setupDirty = false;
    toast('Verbindung lokal auf diesem Gerät gespeichert.');
    if (state.mode === 'server') await loadData();
  } catch (error) { toast(error.message); }
}

async function testServer() {
  try {
    await saveServerSettings({ backendUrl: state.config.buildTarget === 'docker' ? '' : $('backend-url').value, dockerWebUrl: state.config.buildTarget === 'docker' ? '' : $('docker-web-url').value, cfClientId: state.config.buildTarget === 'docker' ? '' : $('cf-client-id').value, cfClientSecret: state.config.buildTarget === 'docker' ? '' : $('cf-client-secret').value, appApiToken: $('app-api-token').value });
    const result = await new ServerProvider(state.config).testConnection();
    state.setupDirty = false;
    toast(result?.status === 'ok' ? 'Server erreichbar.' : 'Server antwortet.');
  } catch (error) { toast(error.message); }
}

async function clearConnection() {
  if (!await confirmAction('Zugangsdaten löschen?', 'Backend URL, Cloudflare Service Token und optionaler App-Token werden nur auf diesem Gerät entfernt.', { dangerLabel: 'Zugangsdaten löschen' })) return;
  await clearServerCredentials();
  await loadServerSettingsIntoForm();
  state.setupDirty = false;
  toast('Zugangsdaten gelöscht.');
}

function backupCountsText(counts) {
  return `${counts.items} Bauteile, ${counts.projects} Projekte, ${counts.project_items} Projektpositionen, ${counts.project_files || 0} 3D-Dateien, ${counts.categories} Kategorien und ${counts.locations} Lagerorte`;
}

function conflictText(preview) {
  const conflicts = preview?.conflicts;
  if (!conflicts) return 'Keine Konfliktprüfung verfügbar.';
  if (conflicts.hard_count) return `${conflicts.hard_count} Eindeutigkeitskonflikt(e) erkannt; Zusammenführen ist blockiert, bis sie gelöst sind. ${conflicts.overwrite_count || 0} Datensatz-ID(s) würden aktualisiert.`;
  if (conflicts.overwrite_count) return `Keine harten Konflikte. ${conflicts.overwrite_count} Datensatz-ID(s) würden beim Zusammenführen aktualisiert.`;
  return 'Keine Konflikte mit bestehenden IDs oder eindeutigen Zuordnungen erkannt.';
}

async function shareOrDownloadFile(file, title = 'Maker Inventar Backup') {
  if (navigator.share && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title }); return; } catch (error) { if (error.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(file); const a = document.createElement('a'); a.href = url; a.download = file.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500);
}
function imageExtension(mime) { return mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg'; }
async function makeFullBackup(provider, items, prefix = 'maker-inventar-backup') {
  const backup = await provider.exportData(); backup.version = 4; backup.includes_images = true; backup.includes_project_images = true; backup.includes_project_files = true; backup.images = []; backup.project_images = []; backup.file_entries = [];
  const entries = [];
  for (const item of items.filter(row => row.image_updated_at)) {
    try {
      const blob = await provider.getItemImage(item.id); if (!blob) continue;
      const mime = blob.type || item.image_mime_type || 'image/jpeg'; const path = `images/${item.id}.${imageExtension(mime)}`;
      backup.images.push({ item_id: item.id, path, mime_type: mime, updated_at: item.image_updated_at || new Date().toISOString() }); entries.push({ name: path, data: blob });
    } catch { /* a missing image must not block the data backup */ }
  }
  for (const project of (await provider.bootstrap()).projects.filter(row => row.image_updated_at)) {
    try { const blob=await provider.getProjectImage(project.id); if(!blob)continue; const mime=blob.type||project.image_mime_type||'image/jpeg'; const path=`project-images/${project.id}.${imageExtension(mime)}`; backup.project_images.push({project_id:project.id,path,mime_type:mime,updated_at:project.image_updated_at||new Date().toISOString()}); entries.push({name:path,data:blob}); } catch {}
  }
  for (const meta of (backup.data.project_files || [])) { try { const blob=await provider.getProjectFile(meta.id); if(!blob)continue; const ext=(meta.name.split('.').pop()||'bin').toLowerCase(); const path=`project-files/${meta.id}.${ext}`; backup.file_entries.push({file_id:meta.id,path,name:meta.name,mime_type:meta.mime_type||blob.type||'application/octet-stream'}); entries.push({name:path,data:blob}); } catch {} }
  entries.unshift({ name: 'backup.json', data: JSON.stringify(backup, null, 2) });
  const zip = await createZip(entries); const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return new File([zip], `${prefix}-${stamp}.zip`, { type: 'application/zip' });
}
async function exportProviderBackup(provider, items, prefix = 'maker-inventar-backup') { const file = await makeFullBackup(provider, items, prefix); await shareOrDownloadFile(file); return file; }
async function exportBackup() {
  try { await exportProviderBackup(state.provider, state.data.items); toast('Vollbackup mit Bildern erstellt.'); } catch (error) { toast(error.message); }
}
async function parseBackupFile(file) {
  if (file.name.toLowerCase().endsWith('.zip') || file.type === 'application/zip') {
    if (file.size > 250 * 1024 * 1024) throw new Error('Backup-ZIP ist zu groß.');
    const entries = await readZip(file); const manifest = entries.get('backup.json'); if (!manifest) throw new Error('backup.json fehlt im ZIP.');
    const backup = JSON.parse(new TextDecoder().decode(manifest)); validateBackup(backup); return { backup, entries };
  }
  const backup = JSON.parse(await file.text()); validateBackup(backup); return { backup, entries: null };
}
async function restoreBackupImages(provider, backup, entries) {
  if (!entries || !Array.isArray(backup.images)) return 0;
  let count = 0;
  for (const info of backup.images) {
    const data = entries.get(info.path); if (!data || !info.item_id) continue;
    await provider.setItemImage(info.item_id, new Blob([data], { type: info.mime_type || 'image/jpeg' })); count++;
  }
  return count;
}
async function restoreBackupProjectImages(provider, backup, entries){if(!entries||!Array.isArray(backup.project_images))return 0;let count=0;for(const info of backup.project_images){const data=entries.get(info.path);if(!data||!info.project_id)continue;await provider.setProjectImage(info.project_id,new Blob([data],{type:info.mime_type||'image/jpeg'}));count++;}return count;}
async function restoreBackupProjectFiles(provider, backup, entries){if(!entries||!Array.isArray(backup.file_entries))return 0;let count=0;for(const info of backup.file_entries){const data=entries.get(info.path);if(!data||!info.file_id)continue;await provider.setProjectFile(info.file_id,new Blob([data],{type:info.mime_type||'application/octet-stream'}));count++;}return count;}
async function transferProjectFiles(source,target,sourceFiles){let count=0;for(const meta of sourceFiles||[]){try{const blob=await source.getProjectFile(meta.id);if(blob){await target.setProjectFile(meta.id,blob);count++;}}catch{}}return count;}
async function transferImages(source, target, sourceItems) {
  let count = 0;
  for (const item of sourceItems.filter(row => row.image_updated_at)) {
    try { const blob = await source.getItemImage(item.id); if (blob) { await target.setItemImage(item.id, blob); count++; } } catch { /* individual missing images do not block transfer */ }
  }
  return count;
}
async function transferProjectImages(source, target, sourceProjects) { let count=0; for(const project of sourceProjects.filter(row=>row.image_updated_at)){ try{const blob=await source.getProjectImage(project.id);if(blob){await target.setProjectImage(project.id,blob);count++;}}catch{}} return count; }

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
    const { backup, entries } = await parseBackupFile(file); const counts = validateBackup(backup); const preview = state.provider.previewImport ? await state.provider.previewImport(backup) : null;
    const imageCount = Array.isArray(backup.images) ? backup.images.length : 0; const projectImageCount = Array.isArray(backup.project_images) ? backup.project_images.length : 0; const projectFileCount = Array.isArray(backup.file_entries) ? backup.file_entries.length : 0;
    const strategy = await chooseStrategy('Backup importieren?', `Validiertes Backup: ${backupCountsText(counts)}${imageCount ? `, ${imageCount} Bauteilbild(er)` : ''}${projectImageCount ? `, ${projectImageCount} Projektbild(er)` : ''}. ${conflictText(preview)} Vor einem Ersetzen wird eine Sicherheitskopie angeboten.`);
    if (!strategy) return;
    if (state.mode === 'local' && strategy === 'replace') { const local = new LocalProvider(); const current = await local.bootstrap(); await exportProviderBackup(local, current.items, 'maker-inventar-vor-restore'); }
    await state.provider.importData(backup, strategy); const restored = await restoreBackupImages(state.provider, backup, entries); const restoredProjectImages=await restoreBackupProjectImages(state.provider,backup,entries); const restoredFiles=await restoreBackupProjectFiles(state.provider,backup,entries);
    clearImageCache(); await loadData(); toast(`Import abgeschlossen${restored ? ` · ${restored} Bauteilbild(er)` : ''}${restoredProjectImages ? ` · ${restoredProjectImages} Projektbild(er)` : ''}${restoredFiles ? ` · ${restoredFiles} 3D-Datei(en)` : ''}.`);
  } catch (error) { toast(error.message); }
}

async function transferLocalToServer() {
  try {
    const local = new LocalProvider(); const server = new ServerProvider(state.config); const localData = await local.bootstrap(); const backup = await local.exportData(); const counts = validateBackup(backup); const imageCount = localData.items.filter(row => row.image_updated_at).length; const projectImageCount=localData.projects.filter(row => row.image_updated_at).length; const projectFileCount=localData.project_files.length;
    await server.testConnection(); const preview = await server.previewImport(backup);
    const strategy = await chooseStrategy('Lokale Daten auf Server übertragen?', `${backupCountsText(counts)}${imageCount ? `, ${imageCount} Bauteilbild(er)` : ''}${projectImageCount ? `, ${projectImageCount} Projektbild(er)` : ''} werden bewusst zum Server übertragen. ${conflictText(preview)} Keine automatische Synchronisation.`);
    if (!strategy) return; await server.importData(backup, strategy); const moved = await transferImages(local, server, localData.items); const movedProjectImages=await transferProjectImages(local,server,localData.projects); const movedFiles=await transferProjectFiles(local,server,localData.project_files); if (state.mode === 'server') { clearImageCache(); await loadData(); } toast(`Lokale Daten wurden übertragen${moved ? ` · ${moved} Bauteilbild(er)` : ''}${movedProjectImages ? ` · ${movedProjectImages} Projektbild(er)` : ''}${movedFiles ? ` · ${movedFiles} 3D-Datei(en)` : ''}.`);
  } catch (error) { toast(error.message); }
}
async function transferServerToLocal() {
  try {
    const server = new ServerProvider(state.config); const local = new LocalProvider(); const serverData = await server.bootstrap(); const backup = await server.exportData(); const counts = validateBackup(backup); const imageCount = serverData.items.filter(row => row.image_updated_at).length; const projectImageCount=serverData.projects.filter(row => row.image_updated_at).length; const projectFileCount=serverData.project_files.length; const preview = await local.previewImport(backup);
    const strategy = await chooseStrategy('Serverdaten lokal übernehmen?', `${backupCountsText(counts)}${imageCount ? `, ${imageCount} Bauteilbild(er)` : ''}${projectImageCount ? `, ${projectImageCount} Projektbild(er)` : ''} werden in den lokalen Datenspeicher übernommen. ${conflictText(preview)}`);
    if (!strategy) return; if (strategy === 'replace') { const current = await local.bootstrap(); await exportProviderBackup(local, current.items, 'maker-inventar-lokal-vor-uebernahme'); }
    await local.importData(backup, strategy); const moved = await transferImages(server, local, serverData.items); const movedProjectImages=await transferProjectImages(server,local,serverData.projects); const movedFiles=await transferProjectFiles(server,local,serverData.project_files); if (state.mode === 'local') { clearImageCache(); await loadData(); } toast(`Serverdaten wurden lokal übernommen${moved ? ` · ${moved} Bauteilbild(er)` : ''}${movedProjectImages ? ` · ${movedProjectImages} Projektbild(er)` : ''}${movedFiles ? ` · ${movedFiles} 3D-Datei(en)` : ''}.`);
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

const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const UPDATE_RECHECK_AFTER_FOCUS_MS = 5 * 60 * 1000;
const UPDATE_RELOAD_KEY = 'maker-inventar-update-reload';

function beginCriticalOperation() { state.criticalOperations += 1; }
function endCriticalOperation() { state.criticalOperations = Math.max(0, state.criticalOperations - 1); }
async function withCriticalOperation(fn) {
  beginCriticalOperation();
  try { return await fn(); }
  finally { endCriticalOperation(); }
}

function criticalUpdateReason() {
  if (state.criticalOperations > 0) return 'Es läuft gerade ein Speichern, Upload, Import, Restore oder Datentransfer.';
  if (document.querySelector('dialog[open]')) return 'Bitte zuerst den geöffneten Dialog schließen oder speichern.';
  const selectedFile = [...document.querySelectorAll('input[type="file"]')].some(input => input.files?.length);
  if (selectedFile) return 'Bitte zuerst die ausgewählte Datei verarbeiten oder entfernen.';
  if (state.itemImageChange || state.projectImageChange) return 'Bitte zuerst die Bildänderung speichern oder verwerfen.';
  if (state.setupDirty) return 'In den Server-Einstellungen gibt es noch nicht gespeicherte Änderungen.';
  return '';
}

function markSetupDirty(event) {
  const id = event.target?.id || '';
  if (['backend-url','docker-web-url','cf-client-id','cf-client-secret','app-api-token'].includes(id)) state.setupDirty = true;
}

function updateUiReady(version = '') {
  state.updateReady = true;
  state.updateWaitingWorker = state.swRegistration?.waiting || state.updateWaitingWorker;
  $('update-banner').classList.remove('hidden');
  const label = version || state.publishedVersion;
  const remote = label && label !== CLIENT_VERSION ? ` ${label}` : '';
  $('update-status').textContent = `Neue Version${remote} verfügbar`;
}

function clearUpdateReady() {
  state.updateReady = false;
  state.updateWaitingWorker = null;
  $('update-banner').classList.add('hidden');
}

async function probePublishedVersion() {
  try {
    const response = await fetch(`VERSION?update-check=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) return '';
    const version = (await response.text()).trim();
    if (/^v\d+(?:[.-][A-Za-z0-9]+)*$/.test(version)) state.publishedVersion = version;
    return version;
  } catch { return ''; }
}

function queryWorkerVersion(worker) {
  return new Promise(resolve => {
    if (!worker) return resolve('');
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(''), 1400);
    channel.port1.onmessage = event => {
      clearTimeout(timer);
      resolve(String(event.data?.version || ''));
    };
    try { worker.postMessage({ type: 'GET_VERSION' }, [channel.port2]); }
    catch { clearTimeout(timer); resolve(''); }
  });
}

async function announceWaitingWorker(worker) {
  if (!worker) return;
  state.updateWaitingWorker = worker;
  const version = await queryWorkerVersion(worker);
  updateUiReady(version);
}

function waitForWorkerInstall(worker, timeoutMs = 12000) {
  return new Promise(resolve => {
    if (!worker) return resolve(null);
    if (['installed','activated','redundant'].includes(worker.state)) return resolve(worker);
    let done = false;
    let timer = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try { worker.removeEventListener('statechange', onState); } catch {}
      resolve(worker);
    };
    const onState = () => { if (['installed','activated','redundant'].includes(worker.state)) finish(); };
    worker.addEventListener('statechange', onState);
    timer = setTimeout(finish, timeoutMs);
  });
}

async function inspectServiceWorkerRegistration(registration, { waitForInstall = false } = {}) {
  if (!registration) return '';

  // Inspect a newer installing worker before an older waiting worker. This avoids
  // stepping through intermediate releases when a newer version is already online.
  if (registration.installing) {
    $('update-status').textContent = 'Neueste Version wird im Hintergrund geladen …';
    const worker = registration.installing;
    if (waitForInstall) await waitForWorkerInstall(worker);
    if (worker.state === 'redundant') {
      $('update-status').textContent = 'Update konnte nicht vollständig installiert werden';
      return 'failed';
    }
    if (registration.installing && !['installed','activated','redundant'].includes(worker.state)) return 'installing';
  }

  if (registration.waiting) {
    await announceWaitingWorker(registration.waiting);
    return 'waiting';
  }
  return '';
}

async function checkServiceWorkerUpdate({ silent = false, force = false, waitForInstall = false } = {}) {
  const registration = state.swRegistration;
  if (!registration) throw new Error('Service Worker nicht verfügbar.');
  if (!navigator.onLine) return '';
  const now = Date.now();
  if (!force && now - state.lastUpdateCheck < UPDATE_RECHECK_AFTER_FOCUS_MS) return '';
  state.lastUpdateCheck = now;

  if (!silent) $('update-status').textContent = 'Prüfung läuft …';
  // Check hosting first, then ask the browser to update the worker. Do not activate
  // a previously waiting release until this pass has had a chance to find a newer one.
  const publishedVersion = await probePublishedVersion();
  try { await registration.update(); }
  catch { if (!silent) $('update-status').textContent = 'Update-Prüfung nicht verfügbar'; return 'error'; }

  const result = await inspectServiceWorkerRegistration(registration, { waitForInstall });
  if (result) return result;

  if (publishedVersion && publishedVersion !== CLIENT_VERSION) {
    $('update-status').textContent = `Neue Version ${publishedVersion} wird vorbereitet …`;
    // VERSION can propagate a little earlier than service-worker.js on static hosting.
    setTimeout(() => registration.update().catch(() => {}), 2500);
    setTimeout(() => registration.update().catch(() => {}), 7500);
    return 'pending';
  }

  if (!state.updateReady) $('update-status').textContent = 'Aktuell';
  return '';
}

function reloadOnceForUpdate() {
  if (state.updateReloadIssued) return;
  let requested = false;
  try { requested = sessionStorage.getItem(UPDATE_RELOAD_KEY) === '1'; } catch {}
  if (!requested) return;
  state.updateReloadIssued = true;
  try { sessionStorage.removeItem(UPDATE_RELOAD_KEY); } catch {}
  if (state.updateReloadTimer) clearTimeout(state.updateReloadTimer);
  window.location.reload();
}

function activateWaitingWorker(worker, { startup = false } = {}) {
  if (!worker) return false;
  const blocked = criticalUpdateReason();
  if (blocked) {
    updateUiReady();
    if (!startup) toast(blocked);
    return false;
  }
  state.updateWaitingWorker = worker;
  localStorage.setItem('maker-inventar-view', state.view);
  try { sessionStorage.setItem(UPDATE_RELOAD_KEY, '1'); } catch {}
  $('update-status').textContent = startup ? 'Geladene neue Version wird sicher aktiviert …' : 'Update wird sicher aktiviert …';

  const onState = () => { if (worker.state === 'activated') reloadOnceForUpdate(); };
  worker.addEventListener('statechange', onState);
  try { worker.postMessage({ type: 'ACTIVATE_UPDATE', safeActivation: true }); }
  catch { return false; }
  if (worker.state === 'activated') reloadOnceForUpdate();

  if (state.updateReloadTimer) clearTimeout(state.updateReloadTimer);
  state.updateReloadTimer = setTimeout(() => {
    try { sessionStorage.removeItem(UPDATE_RELOAD_KEY); } catch {}
    $('update-status').textContent = 'Update ist geladen und wird beim nächsten sicheren Start übernommen.';
  }, 10000);
  return true;
}

function watchInstallingWorker(registration, worker) {
  if (!worker) return;
  $('update-status').textContent = 'Neueste Version wird im Hintergrund geladen …';
  worker.addEventListener('statechange', async () => {
    if (worker.state === 'installed' && navigator.serviceWorker.controller) await inspectServiceWorkerRegistration(registration);
    if (worker.state === 'installed' && !navigator.serviceWorker.controller) $('update-status').textContent = 'Offline-Basis installiert';
    if (worker.state === 'redundant') $('update-status').textContent = 'Update konnte nicht vollständig installiert werden';
  });
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) { $('update-status').textContent = 'Service Worker nicht unterstützt'; return; }
  try {
    navigator.serviceWorker.addEventListener('controllerchange', reloadOnceForUpdate);

    const registration = await navigator.serviceWorker.register('service-worker.js', {
      scope: './', updateViaCache: 'none'
    });
    state.swRegistration = registration;
    registration.addEventListener('updatefound', () => watchInstallingWorker(registration, registration.installing));

    // Important: query hosting and finish any newer installation before deciding
    // whether an already-waiting worker should be activated at startup.
    const result = await checkServiceWorkerUpdate({ silent: true, force: true, waitForInstall: true });
    if (result === 'waiting' && registration.waiting && navigator.serviceWorker.controller) {
      activateWaitingWorker(registration.waiting, { startup: true });
    } else {
      await inspectServiceWorkerRegistration(registration);
    }

    window.addEventListener('online', () => checkServiceWorkerUpdate({ silent: true, force: true }).catch(() => {}));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      checkServiceWorkerUpdate({ silent: true }).catch(() => {});
    });
    setInterval(() => checkServiceWorkerUpdate({ silent: true, force: true }).catch(() => {}), UPDATE_CHECK_INTERVAL_MS);
  } catch {
    $('update-status').textContent = 'Update-Prüfung nicht verfügbar';
  }
}

function applyUpdate() {
  const worker = state.swRegistration?.waiting || state.updateWaitingWorker;
  if (!worker) {
    if (state.swRegistration?.installing) toast('Das Update wird noch vorbereitet.');
    else toast('Kein wartendes Update gefunden.');
    return;
  }
  activateWaitingWorker(worker, { startup: false });
}

async function checkUpdate() {
  try {
    if (!state.swRegistration) throw new Error('Service Worker nicht verfügbar.');
    const result = await checkServiceWorkerUpdate({ silent: false, force: true, waitForInstall: true });
    if (result === 'waiting') toast('Neue Version ist vollständig geladen und bereit.');
  } catch (error) {
    $('update-status').textContent = 'Prüfung fehlgeschlagen';
    toast(error.message);
  }
}

function bindEvents() {
  document.querySelectorAll('.nav-button').forEach(btn => btn.addEventListener('click', () => showView(btn.dataset.target)));
  $('quick-add').addEventListener('click', () => state.view === 'projects' ? openProject() : openItem());
  $('empty-add-item').addEventListener('click', () => openItem());
  $('add-project').addEventListener('click', () => openProject());
  $('search').addEventListener('input', renderInventory);
  $('filter-low').addEventListener('click', () => { state.lowOnly = !state.lowOnly; $('filter-low').setAttribute('aria-pressed', String(state.lowOnly)); renderInventory(); });
  $('item-form').addEventListener('submit', event => withCriticalOperation(() => saveItem(event)));
  $('item-dialog').addEventListener('close', () => { state.itemImageChange = null; revokeEditorPreview(); });
  $('item-photo-camera').addEventListener('click', () => $('item-photo-camera-input').click());
  $('item-photo-library').addEventListener('click', () => $('item-photo-library-input').click());
  $('item-photo-camera-input').addEventListener('change', async () => { const file = $('item-photo-camera-input').files?.[0]; if (file) await handleItemPhotoFile(file); $('item-photo-camera-input').value = ''; });
  $('item-photo-library-input').addEventListener('change', async () => { const file = $('item-photo-library-input').files?.[0]; if (file) await handleItemPhotoFile(file); $('item-photo-library-input').value = ''; });
  $('item-photo-remove').addEventListener('click', () => { state.itemImageChange = state.editingItemHadImage ? { action: 'delete' } : null; showItemPhotoBlob(null); $('item-photo-remove').classList.add('hidden'); });
  $('project-form').addEventListener('submit', event => withCriticalOperation(() => saveProject(event)));
  $('project-dialog').addEventListener('close', () => { state.projectImageChange=null; revokeProjectPreview(); });
  $('project-photo-camera').addEventListener('click', () => $('project-photo-camera-input').click());
  $('project-photo-library').addEventListener('click', () => $('project-photo-library-input').click());
  $('project-photo-camera-input').addEventListener('change', async () => { const file=$('project-photo-camera-input').files?.[0]; if(file) await handleProjectPhotoFile(file); $('project-photo-camera-input').value=''; });
  $('project-photo-library-input').addEventListener('change', async () => { const file=$('project-photo-library-input').files?.[0]; if(file) await handleProjectPhotoFile(file); $('project-photo-library-input').value=''; });
  $('project-photo-remove').addEventListener('click', () => { state.projectImageChange=state.editingProjectHadImage?{action:'delete'}:null; showProjectPhotoBlob(null); $('project-photo-remove').classList.add('hidden'); });
  $('bom-form').addEventListener('submit', event => withCriticalOperation(() => saveBom(event)));
  $('delete-item').addEventListener('click', deleteCurrentItem);
  $('delete-project').addEventListener('click', deleteCurrentProject);
  $('add-project-item').addEventListener('click', () => openBom());
  $('add-project-file').addEventListener('click', () => $('project-file-input').click());
  $('project-file-input').addEventListener('change', async () => { const files=$('project-file-input').files; if(files?.length) await withCriticalOperation(() => uploadProjectFiles(files)); $('project-file-input').value=''; });
  $('toggle-project-edit').addEventListener('click', () => setProjectEditMode(true, false));
  $('cancel-project-edit').addEventListener('click', () => { const project = byId('projects', $('project-id').value); if (project) { $('project-name').value = project.name; $('project-status').value = project.status; $('project-notes').value = project.notes || ''; state.projectImageChange=null; revokeProjectPreview(); loadProjectPhotoEditor(project); setProjectEditMode(false, false); } });
  document.addEventListener('click', async event => {
    const item = event.target.closest('.item-open'); if (item) openItem(item.dataset.id);
    const project = event.target.closest('.project-open'); if (project) openProject(project.dataset.id);
    const editBom = event.target.closest('.edit-bom'); if (editBom) openBom(editBom.dataset.id);
    const downloadFile=event.target.closest('.download-project-file'); if(downloadFile) await downloadProjectFile(downloadFile.dataset.id);
    const deleteFile=event.target.closest('.delete-project-file'); if(deleteFile) await deleteProjectFile(deleteFile.dataset.id);
    const deleteBom = event.target.closest('.delete-bom'); if (deleteBom) {
      const row = byId('project_items', deleteBom.dataset.id); if (row && await confirmAction('Projektposition entfernen?', 'Nur diese Bedarfsliste-Zeile wird entfernt.', { dangerLabel: 'Entfernen' })) { await state.provider.delete('project_items', row.id); await loadData(); renderBom(row.project_id); }
    }
    const dc = event.target.closest('.delete-category'); if (dc) manageDelete('categories', dc.dataset.id, 'Kategorie');
    const dl = event.target.closest('.delete-location'); if (dl) manageDelete('locations', dl.dataset.id, 'Lagerort');
    const closer = event.target.closest('[data-close]'); if (closer) { if (closer.dataset.close === 'item-dialog') { state.itemImageChange = null; revokeEditorPreview(); } if (closer.dataset.close === 'project-dialog') { state.projectImageChange=null; revokeProjectPreview(); } $(closer.dataset.close).close(); }
  });
  $('category-form').addEventListener('submit', async event => { event.preventDefault(); try { await state.provider.create('categories', { name: $('new-category').value }); $('new-category').value=''; await loadData(); } catch(e){toast(e.message);} });
  $('location-form').addEventListener('submit', async event => { event.preventDefault(); try { await state.provider.create('locations', { name: $('new-location').value }); $('new-location').value=''; await loadData(); } catch(e){toast(e.message);} });
  $('choose-local').addEventListener('click', () => switchMode('local'));
  $('choose-server').addEventListener('click', () => switchMode('server'));
  $('first-local').addEventListener('click', () => switchMode('local', { firstRun: true }));
  $('first-server').addEventListener('click', async () => { await switchMode('server', { firstRun: true }); showView('setup'); });
  $('save-server-settings').addEventListener('click', () => withCriticalOperation(saveConnection));
  $('test-server').addEventListener('click', () => withCriticalOperation(testServer));
  $('clear-server-settings').addEventListener('click', clearConnection);
  $('export-backup').addEventListener('click', () => withCriticalOperation(exportBackup));
  $('import-backup').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', async () => { const file = $('import-file').files?.[0]; if (file) await withCriticalOperation(() => importSelectedFile(file)); $('import-file').value=''; });
  $('transfer-local-server').addEventListener('click', () => withCriticalOperation(transferLocalToServer));
  $('transfer-server-local').addEventListener('click', () => withCriticalOperation(transferServerToLocal));
  $('apply-update').addEventListener('click', applyUpdate);
  $('check-update').addEventListener('click', checkUpdate);
  document.addEventListener('input', markSetupDirty, true);
  document.addEventListener('change', markSetupDirty, true);
}

async function init() {
  bindEvents();
  await loadConfig();
  renderBuildTargetUi();
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
