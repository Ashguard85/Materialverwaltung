import {
  STORES,
  localGetAll,
  localPut,
  localDelete,
  localReplaceAll,
  localMergeAll,
  localGetItemImage,
  localPutItemImage,
  localDeleteItemImage,
  getSecureSetting,
  setSecureSetting,
} from './db.js';

export const BACKUP_FORMAT = 'maker-inventar-backup';
export const BACKUP_VERSION = 2;

function now() { return new Date().toISOString(); }
function id() { return crypto.randomUUID(); }
function text(value, fallback = '') { return String(value ?? fallback).trim(); }
function nonnegative(value, fallback = 0) {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n) || n < 0) throw new Error('Menge muss eine nichtnegative Zahl sein.');
  return n;
}
function cloneData(data) {
  return Object.fromEntries(STORES.map(store => [store, (data[store] || []).map(row => ({ ...row }))]));
}
function stripImageMeta(data) {
  const clean = cloneData(data);
  clean.items = clean.items.map(row => ({ ...row, image_mime_type: '', image_updated_at: '' }));
  return clean;
}

export function validateBackup(backup) {
  if (!backup || typeof backup !== 'object') throw new Error('Ungültige Backup-Datei.');
  if (backup.format !== BACKUP_FORMAT) throw new Error('Unbekanntes Backup-Format.');
  if (![1, BACKUP_VERSION].includes(Number(backup.version))) throw new Error('Nicht unterstützte Backup-Version.');
  const data = backup.data;
  if (!data || typeof data !== 'object') throw new Error('Backup enthält keine Daten.');
  const counts = {};
  for (const store of STORES) {
    if (!Array.isArray(data[store])) throw new Error(`Backup-Bereich ${store} fehlt.`);
    counts[store] = data[store].length;
  }
  return counts;
}

export class LocalProvider {
  constructor() { this.kind = 'local'; }
  async bootstrap() { const result = {}; for (const store of STORES) result[store] = await localGetAll(store); return result; }
  async create(store, input) {
    const all = await localGetAll(store);
    if ((store === 'categories' || store === 'locations') && all.some(row => text(row.name).toLowerCase() === text(input.name).toLowerCase())) throw new Error('Name existiert bereits.');
    if (store === 'project_items' && all.some(row => row.project_id === input.project_id && row.item_id === input.item_id)) throw new Error('Dieses Bauteil ist im Projekt bereits enthalten.');
    const ts = now(); const record = this.normalize(store, { ...input, id: id(), created_at: ts, updated_at: ts }); await localPut(store, record); return record;
  }
  async update(store, recordId, input) {
    const all = await localGetAll(store); const current = all.find(row => row.id === recordId); if (!current) throw new Error('Datensatz nicht gefunden.');
    if ((store === 'categories' || store === 'locations') && all.some(row => row.id !== recordId && text(row.name).toLowerCase() === text(input.name ?? current.name).toLowerCase())) throw new Error('Name existiert bereits.');
    const record = this.normalize(store, { ...current, ...input, id: recordId, updated_at: now() }); await localPut(store, record); return record;
  }
  async delete(store, recordId) { await localDelete(store, recordId); }
  normalize(store, row) {
    const base = { ...row, id: text(row.id) || id(), created_at: text(row.created_at) || now(), updated_at: text(row.updated_at) || now() };
    if (store === 'categories' || store === 'locations') { base.name = text(row.name); if (!base.name) throw new Error('Name ist erforderlich.'); }
    if (store === 'items') {
      base.name = text(row.name); if (!base.name) throw new Error('Name ist erforderlich.');
      base.category_id = text(row.category_id) || null; base.location_id = text(row.location_id) || null;
      base.quantity = nonnegative(row.quantity); base.min_quantity = nonnegative(row.min_quantity); base.unit = text(row.unit, 'Stk') || 'Stk';
      base.value_text = text(row.value_text); base.manufacturer = text(row.manufacturer); base.part_number = text(row.part_number); base.package = text(row.package); base.tags = text(row.tags); base.source_url = text(row.source_url); base.notes = text(row.notes);
      base.image_mime_type = text(row.image_mime_type); base.image_updated_at = text(row.image_updated_at);
    }
    if (store === 'projects') { base.name = text(row.name); if (!base.name) throw new Error('Name ist erforderlich.'); base.status = text(row.status, 'planned') || 'planned'; base.notes = text(row.notes); }
    if (store === 'project_items') { base.project_id = text(row.project_id); base.item_id = text(row.item_id); if (!base.project_id || !base.item_id) throw new Error('Projekt und Bauteil sind erforderlich.'); base.required_quantity = nonnegative(row.required_quantity, 1); base.notes = text(row.notes); }
    return base;
  }
  async getItemImage(itemId) { const row = await localGetItemImage(itemId); return row?.blob || null; }
  async setItemImage(itemId, blob) {
    const items = await localGetAll('items'); const item = items.find(row => row.id === itemId); if (!item) throw new Error('Bauteil nicht gefunden.');
    const updatedAt = now(); const mime = blob.type || 'image/jpeg'; await localPutItemImage(itemId, blob, mime, updatedAt);
    const updated = this.normalize('items', { ...item, image_mime_type: mime, image_updated_at: updatedAt, updated_at: updatedAt }); await localPut('items', updated); return updated;
  }
  async deleteItemImage(itemId) {
    await localDeleteItemImage(itemId); const items = await localGetAll('items'); const item = items.find(row => row.id === itemId);
    if (item) { const updatedAt = now(); await localPut('items', this.normalize('items', { ...item, image_mime_type: '', image_updated_at: '', updated_at: updatedAt })); }
  }
  async previewImport(backup) {
    const counts = validateBackup(backup); const current = await this.bootstrap(); const overwrites = {}; let overwriteCount = 0;
    for (const store of STORES) { const ids = new Set(current[store].map(row => row.id)); overwrites[store] = backup.data[store].filter(row => ids.has(row.id)).length; overwriteCount += overwrites[store]; }
    const hard = [];
    for (const store of ['categories', 'locations']) for (const row of backup.data[store]) { const conflict = current[store].find(existing => text(existing.name).toLowerCase() === text(row.name).toLowerCase() && existing.id !== row.id); if (conflict) hard.push({ table: store, type: 'name', message: `${store}: Name '${row.name}' existiert mit anderer ID` }); }
    for (const row of backup.data.project_items) { const conflict = current.project_items.find(existing => existing.project_id === row.project_id && existing.item_id === row.item_id && existing.id !== row.id); if (conflict) hard.push({ table: 'project_items', type: 'pair', message: 'Projekt/Bauteil-Kombination existiert mit anderer ID' }); }
    return { valid: true, counts, conflicts: { overwrites, hard, hard_count: hard.length, overwrite_count: overwriteCount } };
  }
  async exportData() { const data = stripImageMeta(await this.bootstrap()); return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exported_at: now(), app_version: 'v6', includes_images: false, data }; }
  async importData(backup, strategy = 'replace') {
    const preview = await this.previewImport(backup); const counts = preview.counts; const data = cloneData(backup.data);
    data.items = data.items.map(row => ({ ...row, image_mime_type: text(row.image_mime_type), image_updated_at: text(row.image_updated_at) }));
    if (strategy === 'replace') await localReplaceAll(data);
    else if (strategy === 'merge') {
      if (preview.conflicts.hard_count) throw new Error(`Merge abgebrochen: ${preview.conflicts.hard_count} Eindeutigkeitskonflikt(e) müssen zuerst gelöst werden.`);
      const current = await this.bootstrap(); const existing = new Map(current.items.map(row => [row.id, row]));
      data.items = data.items.map(row => { const old = existing.get(row.id); return old?.image_updated_at && !row.image_updated_at ? { ...row, image_mime_type: old.image_mime_type, image_updated_at: old.image_updated_at } : row; });
      await localMergeAll(data);
    } else throw new Error('Unbekannte Importstrategie.');
    return { ok: true, strategy, counts };
  }
}

export class ServerProvider {
  constructor(config) { this.kind = 'server'; this.config = config; }
  async settings() { return { backendUrl: text(await getSecureSetting('backendUrl')) || text(this.config.defaultServerUrl), cfClientId: text(await getSecureSetting('cfClientId')), cfClientSecret: text(await getSecureSetting('cfClientSecret')), appApiToken: text(await getSecureSetting('appApiToken')) }; }
  async rawRequest(path, options = {}) {
    const settings = await this.settings(); if (!settings.backendUrl) throw new Error('Backend URL ist noch nicht eingerichtet.');
    let parsed; try { parsed = new URL(settings.backendUrl); } catch { throw new Error('Backend URL ist ungültig.'); }
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') throw new Error('Für externe Server ist HTTPS erforderlich.');
    const url = settings.backendUrl.replace(/\/$/, '') + path; const headers = new Headers(options.headers || {});
    if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    if (settings.cfClientId) headers.set('CF-Access-Client-Id', settings.cfClientId); if (settings.cfClientSecret) headers.set('CF-Access-Client-Secret', settings.cfClientSecret); if (settings.appApiToken) headers.set('Authorization', `Bearer ${settings.appApiToken}`);
    let response; try { response = await fetch(url, { ...options, headers, cache: 'no-store' }); } catch { throw new Error('Server nicht erreichbar.'); }
    if (!response.ok) { let message = ''; try { message = (await response.clone().json()).error || ''; } catch { /* ignore */ } if (response.status === 401 || response.status === 403) throw new Error(message || 'Authentifizierung oder Berechtigung fehlgeschlagen.'); if (response.status === 404) throw new Error(message || 'Nicht gefunden.'); if (response.status === 504 || response.status === 408) throw new Error('Server-Zeitüberschreitung.'); throw new Error(message || `Serverfehler (${response.status}).`); }
    return response;
  }
  async request(path, options = {}) { const response = await this.rawRequest(path, options); if (response.status === 204) return null; const type = response.headers.get('content-type') || ''; if (type.includes('application/json')) return response.json(); return response.text(); }
  async testConnection() { return this.request('/health'); }
  async bootstrap() { return this.request('/api/bootstrap'); }
  async create(store, input) { return this.request(`/api/${this.endpoint(store)}`, { method: 'POST', body: JSON.stringify(input) }); }
  async update(store, recordId, input) { return this.request(`/api/${this.endpoint(store)}/${encodeURIComponent(recordId)}`, { method: 'PATCH', body: JSON.stringify(input) }); }
  async delete(store, recordId) { return this.request(`/api/${this.endpoint(store)}/${encodeURIComponent(recordId)}`, { method: 'DELETE' }); }
  endpoint(store) { return store === 'project_items' ? 'project-items' : store; }
  async getItemImage(itemId) { return (await this.rawRequest(`/api/items/${encodeURIComponent(itemId)}/image`)).blob(); }
  async setItemImage(itemId, blob) { const form = new FormData(); form.append('image', blob, 'item.jpg'); return this.request(`/api/items/${encodeURIComponent(itemId)}/image`, { method: 'POST', body: form }); }
  async deleteItemImage(itemId) { return this.request(`/api/items/${encodeURIComponent(itemId)}/image`, { method: 'DELETE' }); }
  async exportData() { return this.request('/api/export/backup'); }
  async importData(backup, strategy = 'replace') { validateBackup(backup); return this.request('/api/import/restore', { method: 'POST', body: JSON.stringify({ backup, strategy }) }); }
  async previewImport(backup) { validateBackup(backup); return this.request('/api/import/preview', { method: 'POST', body: JSON.stringify(backup) }); }
}

export async function saveServerSettings({ backendUrl, dockerWebUrl, cfClientId, cfClientSecret, appApiToken }) {
  const normalizedUrl = text(backendUrl).replace(/\/$/, '');
  if (normalizedUrl) { let parsed; try { parsed = new URL(normalizedUrl); } catch { throw new Error('Backend URL ist ungültig.'); } if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') throw new Error('Backend URL muss HTTPS verwenden.'); }
  await setSecureSetting('backendUrl', normalizedUrl); await setSecureSetting('dockerWebUrl', text(dockerWebUrl).replace(/\/$/, '')); await setSecureSetting('cfClientId', text(cfClientId)); if (cfClientSecret !== undefined && cfClientSecret !== '') await setSecureSetting('cfClientSecret', text(cfClientSecret)); await setSecureSetting('appApiToken', text(appApiToken));
}
