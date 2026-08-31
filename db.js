const LOCAL_DB = 'maker-inventar-local';
const LOCAL_DB_VERSION = 2;
const CONFIG_DB = 'maker-inventar-config';
const CONFIG_DB_VERSION = 1;
const STORES = ['categories', 'locations', 'items', 'projects', 'project_items'];
const IMAGE_STORE = 'item_images';

function requestAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB-Fehler'));
  });
}
function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('IndexedDB-Transaktion abgebrochen'));
    tx.onerror = () => reject(tx.error || new Error('IndexedDB-Transaktionsfehler'));
  });
}
export async function openLocalDb() {
  const req = indexedDB.open(LOCAL_DB, LOCAL_DB_VERSION);
  req.onupgradeneeded = () => {
    const db = req.result;
    for (const store of STORES) {
      if (!db.objectStoreNames.contains(store)) {
        const objectStore = db.createObjectStore(store, { keyPath: 'id' });
        objectStore.createIndex('updated_at', 'updated_at');
      }
    }
    if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    if (!db.objectStoreNames.contains(IMAGE_STORE)) db.createObjectStore(IMAGE_STORE, { keyPath: 'item_id' });
    if (req.oldVersion < 2 && db.objectStoreNames.contains('items')) {
      const store = req.transaction.objectStore('items');
      store.openCursor().onsuccess = event => {
        const cursor = event.target.result;
        if (!cursor) return;
        const row = cursor.value;
        cursor.update({ ...row, image_mime_type: row.image_mime_type || '', image_updated_at: row.image_updated_at || '' });
        cursor.continue();
      };
    }
  };
  const db = await requestAsPromise(req);
  await seedLocalDb(db);
  return db;
}
async function seedLocalDb(db) {
  const tx = db.transaction(['meta', 'categories', 'locations'], 'readwrite');
  const meta = tx.objectStore('meta');
  const seeded = await requestAsPromise(meta.get('seeded'));
  if (!seeded) {
    const now = new Date().toISOString();
    for (const name of ['Mikrocontroller', 'Sensoren', 'Module', 'Widerstände', 'Kondensatoren', 'Mechanik', 'Sonstiges']) tx.objectStore('categories').put({ id: crypto.randomUUID(), name, created_at: now, updated_at: now });
    for (const name of ['Werkbank', 'Schublade 1', 'Schublade 2']) tx.objectStore('locations').put({ id: crypto.randomUUID(), name, created_at: now, updated_at: now });
    meta.put({ key: 'seeded', value: true, updated_at: now });
  }
  await transactionDone(tx);
}
export async function localGetAll(store) {
  const db = await openLocalDb(); const tx = db.transaction(store, 'readonly');
  const result = await requestAsPromise(tx.objectStore(store).getAll()); await transactionDone(tx); db.close();
  return result.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
}
export async function localPut(store, record) {
  const db = await openLocalDb(); const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(record); await transactionDone(tx); db.close(); return record;
}
export async function localGetItemImage(itemId) {
  const db = await openLocalDb(); const tx = db.transaction(IMAGE_STORE, 'readonly');
  const row = await requestAsPromise(tx.objectStore(IMAGE_STORE).get(itemId)); await transactionDone(tx); db.close(); return row || null;
}
export async function localPutItemImage(itemId, blob, mimeType, updatedAt) {
  const db = await openLocalDb(); const tx = db.transaction(IMAGE_STORE, 'readwrite');
  tx.objectStore(IMAGE_STORE).put({ item_id: itemId, blob, mime_type: mimeType || blob.type || 'image/jpeg', updated_at: updatedAt || new Date().toISOString() });
  await transactionDone(tx); db.close();
}
export async function localDeleteItemImage(itemId) {
  const db = await openLocalDb(); const tx = db.transaction(IMAGE_STORE, 'readwrite'); tx.objectStore(IMAGE_STORE).delete(itemId); await transactionDone(tx); db.close();
}
export async function localDelete(store, id) {
  const db = await openLocalDb(); let stores = [store];
  if (store === 'items') stores = [store, 'project_items', IMAGE_STORE];
  else if (store === 'projects') stores = [store, 'project_items'];
  else if (store === 'categories' || store === 'locations') stores = [store, 'items'];
  const tx = db.transaction(stores, 'readwrite'); tx.objectStore(store).delete(id);
  if (store === 'items') tx.objectStore(IMAGE_STORE).delete(id);
  if (store === 'items' || store === 'projects') {
    const piStore = tx.objectStore('project_items'); const all = await requestAsPromise(piStore.getAll());
    for (const row of all) if ((store === 'items' && row.item_id === id) || (store === 'projects' && row.project_id === id)) piStore.delete(row.id);
  }
  if (store === 'categories' || store === 'locations') {
    const itemStore = tx.objectStore('items'); const allItems = await requestAsPromise(itemStore.getAll());
    for (const row of allItems) {
      if (store === 'categories' && row.category_id === id) itemStore.put({ ...row, category_id: null, updated_at: new Date().toISOString() });
      if (store === 'locations' && row.location_id === id) itemStore.put({ ...row, location_id: null, updated_at: new Date().toISOString() });
    }
  }
  await transactionDone(tx); db.close();
}
export async function localReplaceAll(data) {
  const db = await openLocalDb(); const tx = db.transaction([...STORES, IMAGE_STORE], 'readwrite');
  for (const store of STORES) tx.objectStore(store).clear(); tx.objectStore(IMAGE_STORE).clear();
  for (const store of STORES) for (const record of data[store] || []) tx.objectStore(store).put(record);
  await transactionDone(tx); db.close();
}
export async function localMergeAll(data) {
  const db = await openLocalDb(); const tx = db.transaction(STORES, 'readwrite');
  for (const store of STORES) for (const record of data[store] || []) tx.objectStore(store).put(record);
  await transactionDone(tx); db.close();
}
export async function openConfigDb() {
  const req = indexedDB.open(CONFIG_DB, CONFIG_DB_VERSION);
  req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' }); };
  return requestAsPromise(req);
}
export async function getSecureSetting(key) {
  const db = await openConfigDb(); const tx = db.transaction('settings', 'readonly'); const row = await requestAsPromise(tx.objectStore('settings').get(key)); await transactionDone(tx); db.close(); return row ? row.value : null;
}
export async function setSecureSetting(key, value) {
  const db = await openConfigDb(); const tx = db.transaction('settings', 'readwrite'); tx.objectStore('settings').put({ key, value, updated_at: new Date().toISOString() }); await transactionDone(tx); db.close();
}
export async function deleteSecureSetting(key) {
  const db = await openConfigDb(); const tx = db.transaction('settings', 'readwrite'); tx.objectStore('settings').delete(key); await transactionDone(tx); db.close();
}
export async function clearServerCredentials() { for (const key of ['backendUrl', 'dockerWebUrl', 'cfClientId', 'cfClientSecret', 'appApiToken']) await deleteSecureSetting(key); }
export { STORES, IMAGE_STORE };
