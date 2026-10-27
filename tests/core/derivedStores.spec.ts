import { afterEach, describe, expect, it, vi } from 'vitest';

/** THE DERIVED CACHE'S KINDS IN STORES OF THEIR OWN (`derivedCache.ts` OWN_STORES): what one kind writes never holds up what another reads (IndexedDB schedules a transaction behind the read/write ones over the same store) */

interface Recorded { readonly stores: readonly string[]; readonly mode: string; readonly puts: [string, string][]; readonly deletes: [string, unknown][] }

/** An IndexedDB of version `was` that answers at once, keeping each transaction's stores and what it put where. */
function fakeIndexedDb(was: number): { readonly api: unknown; readonly transactions: Recorded[]; readonly created: string[]; readonly upgraded: [string, unknown][] } {
  const transactions: Recorded[] = [];
  const created: string[] = [];
  const upgraded: [string, unknown][] = [];
  const names = new Set(was > 0 ? ['entries'] : []);
  const request = (): { onerror: null; onsuccess: null } => ({ onerror: null, onsuccess: null });
  const storeOf = (name: string, puts: [string, string][], deletes: [string, unknown][]) => ({
    put: (_value: unknown, key: string) => { puts.push([name, key]); return request(); },
    delete: (key: unknown) => { deletes.push([name, key]); return request(); },
    get: () => request(),
    getAllKeys: () => request(),
  });
  const db = {
    objectStoreNames: { contains: (name: string) => names.has(name) },
    createObjectStore: (name: string) => { names.add(name); created.push(name); },
    onversionchange: null, onclose: null, close: () => {},
    transaction(stores: string | string[], mode: string) {
      const list = typeof stores === 'string' ? [stores] : stores;
      for (const name of list) if (!names.has(name)) throw new Error(`no store ${name}`);
      const puts: [string, string][] = [], deletes: [string, unknown][] = [];
      transactions.push({ stores: list, mode, puts, deletes });
      const tx = { oncomplete: null as (() => void) | null, onabort: null, onerror: null, objectStore: (name: string) => {
        if (!list.includes(name)) throw new Error(`${name} not in the transaction`);
        return storeOf(name, puts, deletes);
      } };
      setTimeout(() => tx.oncomplete?.(), 0);
      return tx;
    },
  };
  const api = {
    open: (_name: string, version: number) => {
      const upgrade = { objectStore: (name: string) => ({ delete: (range: unknown) => { upgraded.push([name, range]); return request(); } }) };
      const opening = { result: db, transaction: upgrade, onsuccess: null as (() => void) | null, onerror: null, onblocked: null, onupgradeneeded: null as ((e: { oldVersion: number }) => void) | null };
      setTimeout(() => {
        if (version > was) opening.onupgradeneeded?.({ oldVersion: was });
        opening.onsuccess?.();
      }, 0);
      return opening;
    },
  };
  return { api, transactions, created, upgraded };
}

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe("the derived cache's stores", () => {
  it('keeps the cells, the road tiles and the ecology each in their own, every other kind in the shared one', async () => {
    const fake = fakeIndexedDb(0);
    vi.stubGlobal('indexedDB', fake.api);
    vi.resetModules();
    const cache = await import('@core/derivedCache');
    // The cells' writer hands whole keys under an empty prefix (`cellPool.ts` keptStore), mixed kinds in one batch.
    await cache.keepDerivedManyCommitted('', new Map([['cellWork:h:a', 1], ['roadtiles:h:b', 2], ['city:h:c', 3]]));
    await cache.keepDerivedQueuedMany([['ecology:h:d', 4], ['farWoods:h:e', 5]], new cache.WriteBudget(1024));
    await cache.readDerivedSome('roadtiles:h:', ['b']);
    await cache.readDerivedKeys('cellWork:h:');
    const batch = fake.transactions[0]!;
    expect([...batch.stores].sort()).toEqual(['cellWork', 'entries', 'roadtiles']);
    expect(batch.puts).toEqual([['cellWork', 'cellWork:h:a'], ['roadtiles', 'roadtiles:h:b'], ['entries', 'city:h:c']]);
    expect(fake.transactions[1]!.puts).toEqual([['ecology', 'ecology:h:d'], ['farWoods', 'farWoods:h:e']]);
    // A read of the road tiles over their store alone: no write of the cells before it holds it up.
    expect(fake.transactions[2]).toMatchObject({ stores: ['roadtiles'], mode: 'readonly' });
    expect(fake.transactions[3]).toMatchObject({ stores: ['cellWork'], mode: 'readonly' });
    expect([...fake.created].sort()).toEqual(['cellWork', 'ecology', 'entries', 'farWoods', 'roadtiles']);
  });

  it('lets go of the moved kinds kept in the shared store by a version 1, nothing else', async () => {
    const fake = fakeIndexedDb(1);
    vi.stubGlobal('indexedDB', fake.api);
    // Node has no IndexedDB: a key range as its bounds.
    vi.stubGlobal('IDBKeyRange', { bound: (lower: string, upper: string) => ({ lower, upper }) });
    vi.resetModules();
    const cache = await import('@core/derivedCache');
    expect(await cache.derivedCacheOpen()).toBe(true);
    expect(fake.upgraded.map(([store]) => store)).toEqual(['entries', 'entries', 'entries', 'entries']);
    const ranges = fake.upgraded.map(([, range]) => (range as { lower: string }).lower).sort();
    expect(ranges).toEqual(['cellWork:', 'ecology:', 'farWoods:', 'roadtiles:']);
  });
});
