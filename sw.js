// Nalhuitad · Service Worker v1.0
// Polling de notificaciones desde Firestore cada 2 minutos

const FS_PROJECT = 'nalhuitad-d6758';
const FS_KEY     = 'AIzaSyCHlsJDU0o7JsOvY4mgr5lVhiDOEok3C5w';
const FS_BASE    = `https://firestore.googleapis.com/v1/projects/${FS_PROJECT}/databases/(default)/documents`;
const NOTIF_SEEN_KEY = 'nalhuitad_notif_seen';

self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(clients.claim()); });

// ── Helpers Firestore ────────────────────────────────
function fromFSValue(v) {
  if (!v) return null;
  if ('stringValue'  in v) return v.stringValue;
  if ('integerValue' in v) return parseInt(v.integerValue);
  if ('doubleValue'  in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue'    in v) return null;
  if ('arrayValue'   in v) return (v.arrayValue.values || []).map(fromFSValue);
  if ('mapValue'     in v) {
    const obj = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) obj[k] = fromFSValue(val);
    return obj;
  }
  return null;
}
function fromFSDoc(doc) {
  const obj = {};
  for (const [k, v] of Object.entries(doc.fields || {})) obj[k] = fromFSValue(v);
  if (doc.name) obj.id = doc.name.split('/').pop();
  return obj;
}

async function getToken() {
  const clients_list = await clients.matchAll();
  // Intentar leer auth desde IndexedDB (compartida con la página)
  return new Promise(resolve => {
    const req = indexedDB.open('nalhuitad_idb', 1);
    req.onsuccess = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('kv')) { resolve(null); return; }
      const tx = db.transaction('kv', 'readonly');
      const store = tx.objectStore('kv');
      const get = store.get('auth_token');
      get.onsuccess = () => resolve(get.result || null);
      get.onerror = () => resolve(null);
    };
    req.onerror = () => resolve(null);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
  });
}

async function fetchNotifications() {
  try {
    const token = await getToken();
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;

    const url = FS_BASE + '/notifications?key=' + FS_KEY +
      '&orderBy=createdAt%20desc&pageSize=20';
    const r = await fetch(url, { headers });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.documents || []).map(fromFSDoc);
  } catch {
    return [];
  }
}

async function getSeen() {
  return new Promise(resolve => {
    const req = indexedDB.open('nalhuitad_idb', 1);
    req.onsuccess = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('kv')) { resolve(new Set()); return; }
      const tx = db.transaction('kv', 'readonly');
      const store = tx.objectStore('kv');
      const get = store.get(NOTIF_SEEN_KEY);
      get.onsuccess = () => resolve(new Set(get.result || []));
      get.onerror = () => resolve(new Set());
    };
    req.onerror = () => resolve(new Set());
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
  });
}

async function markSeen(ids) {
  return new Promise(resolve => {
    const req = indexedDB.open('nalhuitad_idb', 1);
    req.onsuccess = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('kv')) { resolve(); return; }
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(ids, NOTIF_SEEN_KEY);
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    };
    req.onerror = resolve;
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
  });
}

async function checkAndNotify() {
  const notifs = await fetchNotifications();
  if (notifs.length === 0) return;

  const seen = await getSeen();
  const newOnes = notifs.filter(n => !seen.has(n.id) && n.unread !== false);

  for (const n of newOnes) {
    const icon = n.nivel === 'rojo' ? '🔴' : n.nivel === 'ambar' ? '🟡' : '🟢';
    await self.registration.showNotification('Nalhuitad · ' + (n.title || 'Alerta'), {
      body: n.body || '',
      icon: '/nalhuitad.github.io/icon-192.png',
      badge: '/nalhuitad.github.io/icon-192.png',
      tag: n.id,
      data: { url: 'https://agricolanalhuitad.github.io/nalhuitad.github.io/', lotId: n.lotId || null },
      requireInteraction: n.nivel === 'rojo',
    });
  }

  // Marcar como vistos
  const newSeenIds = [...seen, ...newOnes.map(n => n.id)].slice(-100);
  await markSeen(newSeenIds);
}

// ── Polling cada 2 minutos ───────────────────────────
self.addEventListener('periodicsync', e => {
  if (e.tag === 'nalhuitad-notif') {
    e.waitUntil(checkAndNotify());
  }
});

// Fallback: message desde la página para forzar check
self.addEventListener('message', e => {
  if (e.data?.type === 'CHECK_NOTIFICATIONS') {
    checkAndNotify();
  }
});

// Click en notificación → abre la app
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || 'https://agricolanalhuitad.github.io/nalhuitad.github.io/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
      const existing = cs.find(c => c.url.includes('nalhuitad'));
      if (existing) { existing.focus(); return; }
      return clients.openWindow(url);
    })
  );
});
