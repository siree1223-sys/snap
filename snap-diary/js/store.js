// IndexedDB: the on-device copy of the diary. Everything works offline from
// here; Google Drive is the durable copy that sync keeps up to date.
//   entries: diary entries (+ local sync bookkeeping)
//   blobs:   "photo:<id>", "thumb:<id>", "depth:<id>" image blobs
//   meta:    Drive folder ids, last sync time, ...

const DB_NAME = "snap-diary";
const DB_VERSION = 1;
let dbPromise = null;

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("entries")) {
          db.createObjectStore("entries", { keyPath: "id" }).createIndex("date", "date");
        }
        if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs");
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("다른 탭에서 앱을 닫아 주세요."));
    }).catch((error) => {
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
}

async function run(storeName, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;
    Promise.resolve(fn(store)).then((value) => { result = value; }, reject);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("저장소 작업이 취소되었습니다."));
  });
}

export const entries = {
  all: () => run("entries", "readonly", (s) => promisify(s.getAll())),
  get: (id) => run("entries", "readonly", (s) => promisify(s.get(id))),
  put: (entry) => run("entries", "readwrite", (s) => promisify(s.put(entry))),
  remove: (id) => run("entries", "readwrite", (s) => promisify(s.delete(id))),
  /**
   * Atomic read-modify-write. `mutate(current)` runs synchronously inside one
   * transaction and returns the new value, null to delete, or undefined to
   * leave the record unchanged. Resolves to the stored value.
   */
  update: (id, mutate) => run("entries", "readwrite", (s) => new Promise((resolve, reject) => {
    const read = s.get(id);
    read.onerror = () => reject(read.error);
    read.onsuccess = () => {
      let next;
      try {
        next = mutate(read.result ? structuredClone(read.result) : undefined);
      } catch (error) {
        reject(error);
        return;
      }
      if (next === undefined) resolve(read.result);
      else if (next === null) s.delete(id).onsuccess = () => resolve(null);
      else s.put(next).onsuccess = () => resolve(next);
    };
  }))
};

export const blobs = {
  get: (key) => run("blobs", "readonly", (s) => promisify(s.get(key))),
  put: (key, blob) => run("blobs", "readwrite", (s) => promisify(s.put(blob, key))),
  remove: (key) => run("blobs", "readwrite", (s) => promisify(s.delete(key))),
  keys: () => run("blobs", "readonly", (s) => promisify(s.getAllKeys()))
};

export const meta = {
  get: (key) => run("meta", "readonly", (s) => promisify(s.get(key))),
  set: (key, value) => run("meta", "readwrite", (s) => promisify(s.put(value, key))),
  remove: (key) => run("meta", "readwrite", (s) => promisify(s.delete(key)))
};

export function photoKeys(photoId) {
  return [`photo:${photoId}`, `thumb:${photoId}`, `depth:${photoId}`];
}

export async function removePhotoBlobs(photoId) {
  for (const key of photoKeys(photoId)) await blobs.remove(key);
}

/** Deletes every local diary record (used by "이 기기에서 데이터 지우기"). */
export async function clearAll() {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(["entries", "blobs", "meta"], "readwrite");
    tx.objectStore("entries").clear();
    tx.objectStore("blobs").clear();
    tx.objectStore("meta").clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      return await navigator.storage.persist();
    }
    return true;
  } catch {
    return false;
  }
}
