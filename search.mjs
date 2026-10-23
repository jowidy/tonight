// Search uses the catalog directly, independently of recommendation feedback.
export function normalizeSearch(value) {
  return String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '')
    .toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

export function tagLabel(value) {
  return String(value).replace(/[-_]+/g, ' ');
}

const compact = value => value.replaceAll(' ', '');
const titleOf = recipe => String(recipe.title || '').replace(/\s+\|\s+[^|]+$/, '');
const sortedTags = values => [...values].sort((a, b) => tagLabel(a).localeCompare(tagLabel(b)));

export function createSearchIndex(recipes = []) {
  const ingredients = new Set();
  const traditions = new Set();
  const entries = recipes.map(recipe => {
    const features = recipe.features || {};
    const ingredientTags = new Set(features.ingredients || []);
    const traditionTags = new Set(features.traditions || []);
    ingredientTags.forEach(tag => ingredients.add(tag));
    traditionTags.forEach(tag => traditions.add(tag));
    const title = normalizeSearch(titleOf(recipe));
    const fields = [recipe.title, ...(features.ingredients || []), ...(features.traditions || []),
      ...(features.techniques || []), ...(features.text || [])].map(normalizeSearch).filter(Boolean);
    return { recipe, title, compactTitle: compact(title), text: fields.join(' '),
      // Keep compact matching inside individual fields so unrelated tags cannot
      // accidentally combine into a new search word.
      compactFields: fields.map(compact), ingredients: ingredientTags, traditions: traditionTags };
  });
  return { entries, facets: { ingredients: sortedTags(ingredients), traditions: sortedTags(traditions) } };
}

export function searchRecipes(index, { query = '', ingredients = [], traditions = [] } = {}) {
  const phrase = normalizeSearch(query);
  const words = [...new Set(phrase.split(' ').filter(Boolean))];
  const compactPhrase = compact(phrase);
  const results = [];
  for (const entry of index.entries) {
    // Every ingredient is required; any selected tradition is accepted.
    if (![...ingredients].every(tag => entry.ingredients.has(tag))) continue;
    if (traditions.size || traditions.length) {
      if (![...traditions].some(tag => entry.traditions.has(tag))) continue;
    }
    if (!words.every(word => entry.text.includes(word) || entry.compactFields.some(field => field.includes(word)))) continue;
    let rank = 0;
    if (phrase) {
      if (entry.title === phrase || entry.compactTitle === compactPhrase) rank = 4;
      else if (entry.title.startsWith(phrase) || entry.compactTitle.startsWith(compactPhrase)) rank = 3;
      else if (entry.title.includes(phrase) || entry.compactTitle.includes(compactPhrase)) rank = 2;
      else if (words.every(word => entry.title.includes(word) || entry.compactTitle.includes(word))) rank = 1;
    }
    results.push({ recipe: entry.recipe, rank });
  }
  return results.sort((a, b) => b.rank - a.rank || titleOf(a.recipe).localeCompare(titleOf(b.recipe))
    || String(a.recipe.id).localeCompare(String(b.recipe.id))).map(item => item.recipe);
}

export function parseSearchRoute(hash) {
  const params = new URLSearchParams(hash.split('?')[1] || '');
  const page = Number(params.get('page'));
  return { query: params.get('q') || '', ingredients: new Set(params.getAll('ingredient').filter(Boolean)),
    traditions: new Set(params.getAll('tradition').filter(Boolean)),
    page: Number.isSafeInteger(page) && page > 0 ? page : 1 };
}

export function searchRoute(state) {
  const params = new URLSearchParams();
  if (state.query) params.set('q', state.query);
  [...state.ingredients].sort().forEach(tag => params.append('ingredient', tag));
  [...state.traditions].sort().forEach(tag => params.append('tradition', tag));
  if (state.page > 1) params.set('page', String(state.page));
  return `#/search${params.size ? `?${params}` : ''}`;
}
