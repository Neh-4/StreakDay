/* ============================================================
   DayForge — storage.js
   
   Drop-in replacement for window.storage (the Claude artifact API).
   
   Architecture:
     WRITE  → IndexedDB first (instant, offline-safe)
              → Firestore second (cloud sync)
     READ   → Firestore first (freshest data)
              → IndexedDB fallback (when offline)
   
   This means:
     • The app always responds instantly (no waiting for network)
     • Data survives crashes (IndexedDB write completes before Firestore)
     • Data survives lost devices (Firestore is the source of truth)
     • Works fully offline (Firestore SDK queues writes internally)
   
   HOW TO USE:
     1. Add Firebase SDK to index.html (see snippet at bottom of this file)
     2. Replace window.storage.get/set/delete/list calls with:
          DFStorage.get(key, shared?)
          DFStorage.set(key, value, shared?)
          DFStorage.delete(key, shared?)
          DFStorage.list(prefix?, shared?)
     3. Call DFStorage.init(firebaseConfig, userId) after sign-in
   ============================================================ */

const DFStorage = (() => {

  /* ── Internal state ── */
  let _db       = null;   // IndexedDB instance
  let _firestore = null;  // Firestore instance
  let _userId   = null;   // Firebase UID of signed-in user
  let _ready    = false;

  const IDB_NAME    = 'dayforge-local';
  const IDB_VERSION = 1;
  const IDB_STORE   = 'keyval';

  /* ── Initialise (call once after Firebase Auth signs in) ── */
  async function init(firebaseApp, userId) {
    _userId   = userId;
    _firestore = firebase.firestore(firebaseApp);
    _db       = await openIDB();
    _ready    = true;

    /* Register a background sync tag so pending writes flush when back online */
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
      const reg = await navigator.serviceWorker.ready;
      try { await reg.sync.register('dayforge-sync'); } catch (_) {}
    }

    /* Listen for sync-complete messages from the Service Worker */
    navigator.serviceWorker?.addEventListener('message', e => {
      if (e.data?.type === 'SYNC_COMPLETE') {
        console.log('[DFStorage] Background sync completed at', new Date(e.data.timestamp));
      }
    });
  }

  /* ── IndexedDB helpers ── */
  function openIDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = e => {
        e.target.result.createObjectStore(IDB_STORE);
      };
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    });
  }

  function idbGet(key) {
    return new Promise((resolve, reject) => {
      const tx = _db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror   = e => reject(e.target.error);
    });
  }

  function idbSet(key, value) {
    return new Promise((resolve, reject) => {
      const tx = _db.transaction(IDB_STORE, 'readwrite');
      const req = tx.objectStore(IDB_STORE).put(value, key);
      req.onsuccess = () => resolve();
      req.onerror   = e => reject(e.target.error);
    });
  }

  function idbDelete(key) {
    return new Promise((resolve, reject) => {
      const tx = _db.transaction(IDB_STORE, 'readwrite');
      const req = tx.objectStore(IDB_STORE).delete(key);
      req.onsuccess = () => resolve();
      req.onerror   = e => reject(e.target.error);
    });
  }

  function idbList(prefix) {
    return new Promise((resolve, reject) => {
      const tx = _db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).getAllKeys();
      req.onsuccess = () => {
        const keys = req.result.filter(k => !prefix || k.startsWith(prefix));
        resolve(keys);
      };
      req.onerror = e => reject(e.target.error);
    });
  }

  /* ── Firestore path helpers ── */
  /*
     Data is stored under:
       users/{uid}/data/{encoded-key}
     
     The key is base64-encoded so slashes and special chars are safe as Firestore doc IDs.
     Shared keys (legacy Claude artifact compatibility) are stored under:
       shared/{encoded-key}
  */
  function fsPath(key, shared) {
    const encoded = btoa(unescape(encodeURIComponent(key)));
    return shared
      ? _firestore.collection('shared').doc(encoded)
      : _firestore.collection('users').doc(_userId).collection('data').doc(encoded);
  }

  /* ── Public API ── */

  async function get(key, shared = false) {
    if (!_ready) throw new Error('[DFStorage] Not initialised. Call DFStorage.init() first.');

    /* Try Firestore first (source of truth) */
    try {
      const snap = await fsPath(key, shared).get();
      if (snap.exists) {
        const val = snap.data().value;
        /* Keep IndexedDB in sync */
        await idbSet(`${shared?'s':'u'}:${key}`, val);
        return { key, value: val, shared };
      }
    } catch (e) {
      console.warn('[DFStorage] Firestore read failed, falling back to IndexedDB', e);
    }

    /* Fallback: IndexedDB (works offline) */
    const local = await idbGet(`${shared?'s':'u'}:${key}`);
    if (local !== null) return { key, value: local, shared };

    throw new Error(`[DFStorage] Key not found: ${key}`);
  }

  async function set(key, value, shared = false) {
    if (!_ready) throw new Error('[DFStorage] Not initialised. Call DFStorage.init() first.');

    /* 1. Write to IndexedDB immediately (crash-safe) */
    await idbSet(`${shared?'s':'u'}:${key}`, value);

    /* 2. Write to Firestore (may queue offline — SDK handles retry) */
    try {
      await fsPath(key, shared).set({
        value,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        userId: shared ? null : _userId
      });
    } catch (e) {
      console.warn('[DFStorage] Firestore write queued (offline)', e.code);
      /* The Firestore SDK has already queued this locally — it will sync when online */
    }

    return { key, value, shared };
  }

  async function del(key, shared = false) {
    if (!_ready) throw new Error('[DFStorage] Not initialised. Call DFStorage.init() first.');

    await idbDelete(`${shared?'s':'u'}:${key}`);

    try {
      await fsPath(key, shared).delete();
    } catch (e) {
      console.warn('[DFStorage] Firestore delete queued (offline)', e.code);
    }

    return { key, deleted: true, shared };
  }

  async function list(prefix, shared = false) {
    if (!_ready) throw new Error('[DFStorage] Not initialised. Call DFStorage.init() first.');

    /* List from IndexedDB (fast, works offline) */
    const idbPrefix = `${shared?'s':'u'}:${prefix || ''}`;
    const localKeys = await idbList(idbPrefix);
    const keys = localKeys.map(k => k.replace(/^[su]:/, ''));
    return { keys, prefix, shared };
  }

  /* ── Export data as JSON (for user-triggered backup) ── */
  async function exportUserData() {
    if (!_userId) throw new Error('[DFStorage] Not signed in');
    const snap = await _firestore
      .collection('users').doc(_userId).collection('data')
      .get();
    const data = {};
    snap.forEach(doc => {
      try {
        const key = decodeURIComponent(escape(atob(doc.id)));
        data[key] = doc.data().value;
      } catch (_) {}
    });
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `dayforge-backup-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /* ── Import from backup JSON ── */
  async function importUserData(jsonString) {
    const data = JSON.parse(jsonString);
    const entries = Object.entries(data);
    for (const [key, value] of entries) {
      await set(key, value, false);
    }
    return entries.length;
  }

  return { init, get, set, delete: del, list, exportUserData, importUserData };
})();

/* ============================================================
   HOW TO WIRE THIS INTO index.html
   
   Step 1 — Add Firebase SDK in <head> (use the compat version for simplest setup):
   
   <script src="https://www.gstatic.com/firebasejs/9.22.0/firebase-app-compat.js"></script>
   <script src="https://www.gstatic.com/firebasejs/9.22.0/firebase-auth-compat.js"></script>
   <script src="https://www.gstatic.com/firebasejs/9.22.0/firebase-firestore-compat.js"></script>
   <script src="/storage.js"></script>
   
   Step 2 — Initialise Firebase and DFStorage after sign-in:
   
   const firebaseConfig = {
     apiKey:            "YOUR_API_KEY",
     authDomain:        "YOUR_PROJECT.firebaseapp.com",
     projectId:         "YOUR_PROJECT_ID",
     storageBucket:     "YOUR_PROJECT.appspot.com",
     messagingSenderId: "YOUR_SENDER_ID",
     appId:             "YOUR_APP_ID"
   };
   const app = firebase.initializeApp(firebaseConfig);
   
   firebase.auth().onAuthStateChanged(async user => {
     if (user) {
       await DFStorage.init(app, user.uid);
       // Now replace window.storage calls:
       // window.storage.get(key, shared)    → DFStorage.get(key, shared)
       // window.storage.set(key, val, shared) → DFStorage.set(key, val, shared)
       enterApp(); // your existing function
     } else {
       showScreen('auth');
     }
   });
   
   Step 3 — Replace all window.storage calls in the app:
   
   const get = async (key) => {
     try {
       const r = await DFStorage.get(`dayforge:${key}`);
       return r ? JSON.parse(r.value) : null;
     } catch { return null; }
   };
   
   const set = async (key, val) => {
     try {
       await DFStorage.set(`dayforge:${key}`, JSON.stringify(val));
     } catch (e) { console.error(e); }
   };
   
   Step 4 — Register the Service Worker in your app's init:
   
   if ('serviceWorker' in navigator) {
     window.addEventListener('load', () => {
       navigator.serviceWorker.register('/service-worker.js')
         .then(reg => console.log('SW registered', reg.scope))
         .catch(err => console.warn('SW failed', err));
     });
   }
   
   Step 5 — Add export/import buttons in the Profile section:
   
   // Export
   document.getElementById('btn-export').onclick = () => DFStorage.exportUserData();
   
   // Import
   document.getElementById('btn-import').onchange = async (e) => {
     const text = await e.target.files[0].text();
     const count = await DFStorage.importUserData(text);
     showToast(`Imported ${count} records`);
   };
   
   ============================================================ */
