// Session-only discovery. This module neither writes to storage nor changes recipes.
const CHANNEL_WEIGHTS = { ingredients: 1.5, techniques: 1, traditions: 0.85, text: 0.12 };
const FAMILY_LABELS = { ingredients: 'Ingredients', techniques: 'Techniques', traditions: 'Traditions', text: 'Words' };
const RESURFACING = { cooldownBatches: 3, absoluteThreshold: 0.15, relativeFactor: 0.8 };
const STOP_WORDS = new Set(('a an and are as at be been by can dish for from has have in into is it its of on or recipe recipes that the their then these this to use used using was were will with you your').split(' '));
const PANTRY = /^(?:water|(?:sea |kosher |table |fine |coarse )?salt|(?:ground )?(?:black |white )?pepper|(?:extra virgin |virgin )?olive oil|(?:vegetable |canola |neutral |cooking |sunflower |corn )?oil)$/u;

function normalize(value) {
  return String(value ?? '').normalize('NFKC').replace(/^\[\[|\]\]$/gu, '')
    .split('|')[0].split('#')[0].replace(/\\/gu, '/').split('/').pop()
    .replace(/\.md$/iu, '').toLowerCase().replace(/[-_]/gu, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/gu, ' ').trim();
}

function termsFor(recipe) {
  const result = new Set();
  for (const channel of Object.keys(CHANNEL_WEIGHTS)) {
    const values = recipe.features?.[channel];
    for (const value of Array.isArray(values) ? values : []) {
      const normalized = normalize(value);
      const terms = channel === 'text' ? normalized.split(' ') : [normalized];
      for (const term of terms) {
        if (!term || (channel === 'text' && (term.length < 3 || STOP_WORDS.has(term)))) continue;
        result.add(`${channel}:${term}`);
      }
    }
  }
  return result;
}

function buildModel(recipes) {
  const terms = new Map(recipes.map(recipe => [recipe.id, termsFor(recipe)]));
  const frequencies = new Map();
  for (const recipeTerms of terms.values()) {
    for (const term of recipeTerms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  }
  const weights = new Map();
  for (const [term, frequency] of frequencies) {
    const separator = term.indexOf(':');
    const channel = term.slice(0, separator);
    const value = term.slice(separator + 1);
    const rarity = 0.5 + Math.log(1 + recipes.length / (1 + frequency));
    const evidence = channel === 'ingredients' && PANTRY.test(value) ? 0.025 : rarity ** 2;
    weights.set(term, CHANNEL_WEIGHTS[channel] * evidence);
  }
  const totals = new Map([...terms].map(([id, values]) => [id, [...values].reduce((sum, term) => sum + weights.get(term), 0)]));
  const cache = new Map();
  return {
    evidence(a, b) {
      // Identity is a separate compare() branch. Do not invent a feature-based
      // explanation for its exact score of one.
      if (a === b) return { sameRecipe: true, denominator: null, features: [], familyContributions: {}, identityContribution: 1 };
      const denominator = Math.sqrt(((totals.get(a) ?? 0) + 0.5) * ((totals.get(b) ?? 0) + 0.5));
      const right = terms.get(b);
      const features = [];
      const familyContributions = Object.fromEntries(Object.keys(CHANNEL_WEIGHTS).map(key => [key, 0]));
      for (const key of terms.get(a) ?? []) {
        if (!right?.has(key)) continue;
        const separator = key.indexOf(':');
        const family = key.slice(0, separator);
        const term = key.slice(separator + 1);
        const weight = weights.get(key);
        const similarityContribution = weight / denominator;
        features.push({ family, term, weight, frequency: frequencies.get(key), similarityContribution, pantry: family === 'ingredients' && PANTRY.test(term) });
        familyContributions[family] += similarityContribution;
      }
      return { sameRecipe: false, denominator, features, familyContributions, identityContribution: 0 };
    },
    compare(a, b) {
      if (a === b) return 1;
      const key = JSON.stringify(a < b ? [a, b] : [b, a]);
      if (cache.has(key)) return cache.get(key);
      const left = terms.get(a);
      const right = terms.get(b);
      if (!left?.size || !right?.size) return 0;
      let shared = 0;
      for (const term of left) if (right.has(term)) shared += weights.get(term);
      // The small evidence floor keeps pantry-only or one-word pages from
      // appearing strongly related merely because their feature sets are tiny.
      const result = shared / Math.sqrt((totals.get(a) + 0.5) * (totals.get(b) + 0.5));
      cache.set(key, result);
      return result;
    },
  };
}

/** Weighted feature similarity in [0, 1]; pass the catalog for corpus rarity. */
export function similarity(a, b, recipes = [a, b]) {
  return buildModel(recipes).compare(a.id, b.id);
}

function cleanCatalog(recipes) {
  const byId = new Map();
  for (const recipe of Array.isArray(recipes) ? recipes : []) {
    if (recipe && typeof recipe.id === 'string' && recipe.id && !byId.has(recipe.id)) byId.set(recipe.id, recipe);
  }
  return [...byId.values()];
}

export class DiscoverySession {
  constructor(recipes, { rng = Math.random, size = 8 } = {}) {
    this.rng = typeof rng === 'function' ? rng : Math.random;
    this.size = Number.isFinite(size) ? Math.max(1, Math.floor(size)) : 8;
    this.current = [];
    this.positives = new Set();
    this.negatives = new Set();
    this.seen = new Set();
    this.exhausted = false;
    this.explorationIds = new Set();
    this._batchNumber = 0;
    this._modelRevision = 0;
    this._selectionRevision = 0;
    this._decisions = [];
    this._history = [];
    this._lastShown = new Map();
    this.updateRecipes(recipes);
  }

  random() {
    const value = Number(this.rng());
    return Number.isFinite(value) ? Math.min(1 - Number.EPSILON, Math.max(0, value)) : 0.5;
  }

  affinity(id) {
    const values = [...this.positives].map(positive => this.model.compare(id, positive));
    return values.length ? Math.max(...values) * 0.85 + values.reduce((a, b) => a + b, 0) / values.length * 0.15 : 0;
  }

  aversion(id) {
    const values = [...this.negatives].map(negative => this.model.compare(id, negative));
    // A local, bounded penalty, never a feature ban. Broad cuisine or common
    // ingredient overlap receives much less penalty than a near duplicate.
    return values.length ? Math.max(...values) ** 3 * 0.28 : 0;
  }

  recordDecision(recipe, details, otherPicks) {
    const likes = [...this.positives].map(id => ({
      id, title: this.byId.get(id).title, similarity: this.model.compare(recipe.id, id), evidence: this.model.evidence(recipe.id, id),
    }));
    const maxLike = likes.length ? Math.max(...likes.map(like => like.similarity)) : 0;
    const dominantLike = likes.findIndex(like => like.similarity === maxLike);
    const maximumTieCount = likes.filter(like => like.similarity === maxLike).length;
    for (let index = 0; index < likes.length; index++) {
      // Math.max has no unique cause when several comparisons tie. Attribute
      // its existing scalar to the first tied reference, without changing it.
      const like = likes[index];
      like.meanShare = like.similarity / likes.length * 0.15;
      like.maxShare = index === dominantLike ? maxLike * 0.85 : 0;
      like.affinityContribution = like.meanShare + like.maxShare;
      like.tiedForMaximum = like.similarity === maxLike;
      like.maximumTieCount = maximumTieCount;
    }
    const strongest = references => {
      let match = null;
      for (const other of references) {
        const similarity = this.model.compare(recipe.id, other.id);
        if (match === null || similarity > match.similarity) match = { id: other.id, title: other.title, similarity };
      }
      return match ? { ...match, evidence: this.model.evidence(recipe.id, match.id) } : null;
    };
    const negative = strongest([...this.negatives].map(id => this.byId.get(id)));
    const diversity = strongest(otherPicks);
    this._decisions.push({
      id: recipe.id, title: recipe.title,
      ...details,
      selectionOrder: this._decisions.length + 1,
      displayOrder: null,
      inputs: { ...details.inputs, negativeSimilarity: negative?.similarity ?? 0 },
      likes, negative, diversity,
    });
  }

  select(candidates, count, selected, source = 'unseen', policy = {}) {
    const remaining = [...candidates];
    const hasLikes = this.positives.size > 0;
    const explorationCount = policy.explorationCount ?? (!hasLikes ? 0 : count === 1 ? Number(this.random() < 0.2) : Math.max(1, Math.round(count * 0.2)));
    const picked = [];
    for (let slot = 0; slot < count && remaining.length; slot++) {
      const exploring = slot >= count - explorationCount;
      let pool = remaining;
      if (exploring && remaining.length > 2) {
        // Probe among the less related options. Randomness still varies those
        // probes, and a homogeneous/small catalog remains fully usable.
        pool = [...remaining].sort((a, b) => this.affinity(a.id) - this.affinity(b.id))
          .slice(0, Math.max(2, Math.ceil(remaining.length * 0.6)));
      }
      let best;
      let bestScore = -Infinity;
      let bestDetails;
      const considered = [];
      for (const recipe of pool) {
        const affinity = this.affinity(recipe.id);
        const otherPicks = [...selected, ...picked];
        const redundancy = otherPicks.length ? Math.max(...otherPicks.map(other => this.model.compare(recipe.id, other.id))) : 0;
        const relevant = hasLikes && !exploring;
        let negative;
        let randomDraw;
        let score;
        // Keep the original evaluation order and one RNG draw per candidate.
        // These recorded inputs are the operands of the actual winning score.
        if (relevant) {
          negative = this.aversion(recipe.id);
          randomDraw = this.random();
          score = affinity * 1.2 - negative - redundancy * 0.13 + randomDraw * 0.08;
        } else {
          randomDraw = this.random();
          negative = this.aversion(recipe.id);
          score = randomDraw * 0.7 - redundancy * 0.28 - negative - (exploring ? affinity * 0.15 : 0);
        }
        considered.push({ id: recipe.id, score });
        if (score > bestScore) {
          best = recipe;
          bestScore = score;
          bestDetails = {
            mode: relevant ? 'relevance' : exploring ? 'exploration' : 'random', source, score,
            components: { affinity: relevant ? affinity * 1.2 : exploring ? -affinity * 0.15 : 0, negative: -negative, diversity: -redundancy * (relevant ? 0.13 : 0.28), random: randomDraw * (relevant ? 0.08 : 0.7) },
            inputs: { affinity, redundancy, randomDraw },
          };
        }
      }
      const runnerUpScore = considered.length > 1 ? Math.max(...considered.filter(item => item.id !== best.id).map(item => item.score)) : null;
      this.recordDecision(best, {
        ...bestDetails,
        pool: { count: pool.length, remaining: remaining.length, explorationFiltered: pool !== remaining, runnerUpScore, margin: runnerUpScore === null ? null : bestScore - runnerUpScore },
        candidates: considered,
        ...(policy.resurfacing ? { resurfacing: policy.resurfacing.get(best.id) } : {}),
      }, [...selected, ...picked]);
      picked.push(best);
      if (exploring) this.explorationIds.add(best.id);
      remaining.splice(remaining.findIndex(recipe => recipe.id === best.id), 1);
    }
    return picked;
  }

  next() {
    this.explorationIds.clear();
    this._batchNumber++;
    this._selectionRevision = this._modelRevision;
    this._decisions = [];
    const eligible = this.recipes.filter(recipe => !this.negatives.has(recipe.id));
    const unseen = eligible.filter(recipe => !this.seen.has(recipe.id));
    const target = Math.min(this.size, eligible.length);
    const selected = [];
    const maxSlots = Math.min(2, Math.floor(target / 4));
    if (this.positives.size && unseen.length >= target && maxSlots > 0) {
      const bestUnseenQuality = Math.max(...unseen.map(recipe => this.matchQuality(recipe.id).value));
      const threshold = Math.max(RESURFACING.absoluteThreshold, RESURFACING.relativeFactor * bestUnseenQuality);
      const resurfacing = new Map();
      const familiar = eligible.filter(recipe => {
        const lastShownBatch = this._lastShown.get(recipe.id);
        if (lastShownBatch === undefined) return false;
        const batchesSinceShown = this._batchNumber - lastShownBatch;
        if (batchesSinceShown < RESURFACING.cooldownBatches) return false;
        const quality = this.matchQuality(recipe.id).value;
        if (quality < threshold) return false;
        resurfacing.set(recipe.id, { lastShownBatch, batchesSinceShown, ...RESURFACING, quality, bestUnseenQuality, threshold, maxSlots });
        return true;
      });
      selected.push(...this.select(familiar, Math.min(maxSlots, familiar.length), [], 'resurfaced', { explorationCount: 0, resurfacing }));
    }
    const freshCount = Math.min(target - selected.length, unseen.length);
    // Familiar picks occupy relevance slots, preserving the usual two fresh
    // exploration probes in an eight-card batch. Sparse-catalog recycling below
    // remains a separate fallback when there are not enough unseen choices.
    const freshPolicy = selected.length ? { explorationCount: Math.min(freshCount, Math.max(1, Math.round(target * 0.2))) } : {};
    selected.push(...this.select(unseen, freshCount, selected, 'unseen', freshPolicy));
    if (selected.length < target) {
      const selectedIds = new Set(selected.map(recipe => recipe.id));
      const previousIds = new Set(this.current.map(recipe => recipe.id));
      const recycled = eligible.filter(recipe => !selectedIds.has(recipe.id) && this.seen.has(recipe.id));
      // Prefer another previously seen dish over immediately repeating a card.
      const away = recycled.filter(recipe => !previousIds.has(recipe.id));
      selected.push(...this.select(away, Math.min(target - selected.length, away.length), selected, 'recycled'));
      if (selected.length < target) {
        selected.push(...this.select(recycled.filter(recipe => previousIds.has(recipe.id)), target - selected.length, selected, 'immediate-repeat'));
      }
    }
    // Mix the probe positions into the grid, avoiding a fixed exploration row.
    for (let index = selected.length - 1; index > 0; index--) {
      const other = Math.floor(this.random() * (index + 1));
      [selected[index], selected[other]] = [selected[other], selected[index]];
    }
    this.current = selected;
    const byId = new Map(this._decisions.map(decision => [decision.id, decision]));
    this._decisions = selected.map((recipe, index) => ({ ...byId.get(recipe.id), displayOrder: index + 1 }));
    for (const recipe of selected) {
      this.seen.add(recipe.id);
      this._lastShown.set(recipe.id, this._batchNumber);
    }
    this.exhausted = eligible.every(recipe => this.seen.has(recipe.id));
    return this.current;
  }

  react(id, direction) {
    if (direction !== 'more' && direction !== 'less') throw new TypeError('Reaction must be more or less.');
    // A refresh may remove the recipe while its card is still being clicked.
    if (!this.byId.has(id)) return this.current;
    const recipe = this.byId.get(id);
    this._history.push(Object.freeze({ sequence: this._history.length + 1, id, title: recipe.title, image: recipe.image ?? null, direction }));
    (direction === 'more' ? this.positives : this.negatives).add(id);
    (direction === 'more' ? this.negatives : this.positives).delete(id);
    return this.next();
  }

  reset() {
    this.positives.clear();
    this.negatives.clear();
    this.seen.clear();
    this.current = [];
    this._history = [];
    this._batchNumber = 0;
    this._lastShown.clear();
    return this.next();
  }

  updateRecipes(recipes) {
    this.recipes = cleanCatalog(recipes);
    this.byId = new Map(this.recipes.map(recipe => [recipe.id, recipe]));
    this.model = buildModel(this.recipes);
    this._modelRevision++;
    for (const set of [this.positives, this.negatives, this.seen, this.explorationIds]) {
      for (const id of set) if (!this.byId.has(id)) set.delete(id);
    }
    this.current = this.current.filter(recipe => this.byId.has(recipe.id)).map(recipe => this.byId.get(recipe.id));
    // Retain selection-time evidence after an edit. It describes the old model,
    // never a recomputed explanation of why these existing cards were chosen.
    this._decisions = this._decisions.filter(decision => this.byId.has(decision.id));
    for (const id of this._lastShown.keys()) if (!this.byId.has(id)) this._lastShown.delete(id);
    this.exhausted = this.recipes.filter(recipe => !this.negatives.has(recipe.id)).every(recipe => this.seen.has(recipe.id));
    return this.current;
  }

  inspect() {
    const feedback = set => [...set].map(id => ({ id, title: this.byId.get(id).title }));
    return structuredClone({
      batchNumber: this._batchNumber,
      modelRevision: this._modelRevision,
      selectionRevision: this._selectionRevision,
      stale: this._batchNumber > 0 && this._modelRevision !== this._selectionRevision,
      feedback: { more: feedback(this.positives), less: feedback(this.negatives) },
      history: this._history,
      decisions: this._decisions,
      families: Object.entries(CHANNEL_WEIGHTS).map(([key, weight]) => ({ key, label: FAMILY_LABELS[key], weight })),
    });
  }

  matchQuality(id) {
    const affinity = this.affinity(id);
    const negative = this.aversion(id);
    const value = Math.min(1, Math.max(0, affinity - negative));
    return { affinity, negative, value };
  }

  matchFor(id) {
    const distinctCount = new Set([...this.positives, ...this.negatives]).size;
    if (!this.byId.has(id) || distinctCount < 3 || this.positives.size === 0) return null;
    // A current-model match, separate from selection-time scores. Exploration,
    // previous display order, novelty and random draws have no role here.
    const quality = this.matchQuality(id);
    return { percent: Math.round(quality.value * 100), ...quality, modelRevision: this._modelRevision, distinctCount };
  }

  describe() {
    return {
      total: this.recipes.length,
      seen: this.seen.size,
      unseen: this.recipes.filter(recipe => !this.seen.has(recipe.id) && !this.negatives.has(recipe.id)).length,
      positives: [...this.positives],
      negatives: [...this.negatives],
      explorationIds: [...this.explorationIds],
      exhausted: this.exhausted,
    };
  }
}
