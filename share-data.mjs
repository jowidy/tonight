const DATA_URL = 'https://raw.githubusercontent.com/jowidy/tonight/data/catalog.enc.json';
let accessKey = null;
let snapshot = null;
let pending = null;
let state = { locked: true, reason: 'missing', offline: false, publishedAt: null };

// Remove the previous release's origin-wide stored key during migration.
try { sessionStorage.removeItem('tonight-access-key'); } catch { /* Storage can be disabled. */ }

export function consumeAccessLink() {
  if (!location.hash.startsWith('#key=')) return false;
  const params = new URLSearchParams(location.hash.slice(1));
  const supplied = params.get('key');
  const nextKey = /^[A-Za-z0-9_-]{43}$/.test(supplied || '') ? supplied : null;
  if (nextKey && nextKey === accessKey) return false;
  accessKey = nextKey;
  snapshot = null;
  state = { locked: true, reason: accessKey ? 'opening' : 'invalid', offline: false, publishedAt: null };
  return true;
}

consumeAccessLink();

export function getRouteHash(hash = location.hash) {
  if (!hash.startsWith('#key=')) return hash || '#/';
  const params = new URLSearchParams(hash.slice(1));
  const recipe = params.get('recipe');
  if (!recipe || !/^[\w-]+$/.test(recipe)) return '#/';
  const section = params.get('section');
  return `#/node/${recipe}${section ? `?section=${encodeURIComponent(section)}` : ''}`;
}

export function routeWithAccess(route = '#/') {
  if (!accessKey) return route;
  const params = new URLSearchParams({ key: accessKey });
  const match = route.match(/^#\/node\/([\w-]+)(?:\?(.*))?$/);
  if (match) {
    params.set('recipe', match[1]);
    const section = new URLSearchParams(match[2] || '').get('section');
    if (section) params.set('section', section);
  }
  return `#${params}`;
}

function bytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encoding');
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function locked(reason) {
  snapshot = null;
  state = { locked: true, reason, offline: false, publishedAt: null };
  const error = new Error('This collection needs a current private link.');
  error.code = 'LOCKED';
  return error;
}

export function getStatus() { return { ...state }; }

export function getShareUrl() {
  return accessKey && !state.locked ? `${location.origin}${location.pathname}#key=${accessKey}` : null;
}

export async function refresh() {
  if (pending) return pending;
  if (!accessKey) throw locked(state.reason === 'invalid' ? 'invalid' : 'missing');
  const currentKey = accessKey;
  pending = (async () => {
    let response;
    try {
      response = await fetch(`${DATA_URL}?v=${Math.floor(Date.now() / 60000)}`, {
        cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error('Collection unavailable');
    } catch {
      if (currentKey !== accessKey) throw locked('opening');
      state = { ...state, offline: true };
      if (snapshot) return snapshot.catalog;
      const error = new Error('The collection could not be reached. Check your connection and try again.');
      error.code = 'OFFLINE';
      throw error;
    }
    try {
      const envelope = await response.json();
      if (envelope.format !== 'tonight-aesgcm-v1') throw new Error('Unsupported collection');
      const iv = bytes(envelope.iv);
      if (iv.length !== 12) throw new Error('Invalid collection');
      const key = await crypto.subtle.importKey('raw', bytes(currentKey), 'AES-GCM', false, ['decrypt']);
      const compressed = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, bytes(envelope.ciphertext));
      const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
      const next = JSON.parse(await new Response(stream).text());
      if (next.schema !== 1 || !Array.isArray(next.catalog?.recipes) || !next.nodes || !Number.isFinite(Date.parse(next.publishedAt))) throw new Error('Invalid collection');
      if (currentKey !== accessKey) throw new Error('Access changed');
      snapshot = next;
      state = { locked: false, reason: null, offline: false, publishedAt: next.publishedAt };
      return snapshot.catalog;
    } catch {
      // Authentication failure also removes previously displayed data. Never fall
      // back to an old snapshot after a changed key or altered publication.
      throw locked('invalid');
    }
  })();
  try { return await pending; } finally { pending = null; }
}

export async function getCatalog() { return snapshot?.catalog || refresh(); }

export async function getNode(id) {
  if (!snapshot) await getCatalog();
  if (!Object.hasOwn(snapshot.nodes, id)) throw new Error('This page is no longer in the shared collection.');
  return snapshot.nodes[id];
}
