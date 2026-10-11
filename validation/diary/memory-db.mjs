// In-memory stand-in for js/store.js with the same interface and semantics
// (values are cloned on the way in and out, update() is atomic).
export function createMemoryDB() {
  const maps = { entries: new Map(), blobs: new Map(), meta: new Map() };
  const clone = (v) => (v instanceof Blob || v === undefined ? v : structuredClone(v));
  const kv = (map) => ({
    get: async (k) => clone(map.get(k)),
    set: async (k, v) => { map.set(k, clone(v)); },
    put: async (k, v) => { map.set(k, clone(v)); },
    remove: async (k) => { map.delete(k); },
    keys: async () => [...map.keys()]
  });
  return {
    maps,
    entries: {
      all: async () => [...maps.entries.values()].map(clone),
      get: async (id) => clone(maps.entries.get(id)),
      put: async (e) => { maps.entries.set(e.id, clone(e)); },
      remove: async (id) => { maps.entries.delete(id); },
      update: async (id, mutate) => {
        const next = mutate(clone(maps.entries.get(id)));
        if (next === undefined) return clone(maps.entries.get(id));
        if (next === null) { maps.entries.delete(id); return null; }
        maps.entries.set(id, clone(next));
        return clone(next);
      }
    },
    blobs: { get: kv(maps.blobs).get, put: kv(maps.blobs).put, remove: kv(maps.blobs).remove, keys: kv(maps.blobs).keys },
    meta: { get: kv(maps.meta).get, set: kv(maps.meta).set, remove: kv(maps.meta).remove }
  };
}
