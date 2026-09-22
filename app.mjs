import { DiscoverySession } from './recommend.mjs';
import { getCatalog, getNode, refresh, getStatus, consumeAccessLink, getRouteHash, routeWithAccess } from './share-data.mjs';

const main = document.querySelector('#main');
const announcement = document.querySelector('#announcement');
const toast = document.querySelector('#toast');
let catalog = null;
let session = null;
let requestNumber = 0;
let toastTimer;
let browseScroll = 0;
let lastRoute = '#/';
let catalogRequest = null;
let catalogRefreshQueued = false;
let connectionLost = false;
let returnFocus = null;
let pathViewId = null;
let stopPathMotion = () => {};
let matchLabelsRevealed = false;
const inspectorState = { open: false, recipeId: null, likeId: null, details: new Map() };
let navigationDepth = history.state?.tonight ? history.state.depth || 0 : 0;
history.replaceState({ tonight: true, depth: navigationDepth }, '');

function protectPrivateLinks() {
  document.querySelectorAll('a[href^="#/"], a[href^="#key="]').forEach(link => {
    const next = routeWithAccess(getRouteHash(link.getAttribute('href')));
    if (next !== link.getAttribute('href')) link.setAttribute('href', next);
  });
}
// Rewrite rendered recipe links, including links inside source notes, so opening
// in a new tab and copying a recipe link preserve access without browser storage.
new MutationObserver(protectPrivateLinks).observe(document.body, { childList: true, subtree: true });
protectPrivateLinks();

const icons = {
  more: '<path d="M7 10v10H3V10h4Zm0 0 5-7c1-1 3 0 2.5 2L14 9h5a2 2 0 0 1 2 2l-1 7a2 2 0 0 1-2 2H7"/>',
  less: '<path d="M7 14V4H3v10h4Zm0 0 5 7c1 1 3 0 2.5-2L14 15h5a2 2 0 0 0 2-2l-1-7a2 2 0 0 0-2-2H7"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  back: '<path d="M20 12H4m6-6-6 6 6 6"/>',
  missing: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m3 16 5-5 4 4 3-3 6 6M8 7h.01"/>',
};
const svg = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const nameOf = recipe => recipe.title.replace(/\s+\|\s+[^|]+$/, '');
const finite = value => typeof value === 'number' && Number.isFinite(value);
const number = value => finite(value) ? value.toFixed(5) : 'Not available';
const signed = value => finite(value) ? `${value > 0 ? '+' : ''}${value.toFixed(5)}` : 'Not available';
const familyLabel = family => ({ ingredients: 'Ingredients', techniques: 'Techniques', traditions: 'Traditions', text: 'Lexical words' }[family] || family);
const openDetails = (key, defaultOpen = false) => (inspectorState.details.get(key) ?? defaultOpen) ? ' open' : '';

function inspectorShell() {
  return `<section id="picks-inspector" class="picks-inspector" aria-labelledby="inspector-heading"${inspectorState.open ? '' : ' hidden'}></section>`;
}

function feedbackMarkup(items, direction) {
  const label = direction === 'more' ? 'More choices' : 'Less choices';
  return `<details class="inspector-signals" data-inspect-details="signals-${direction}"${openDetails(`signals-${direction}`, items.length <= 3)}><summary>${label} (${items.length})</summary>${items.length ? `<ol aria-label="${label}">${items.map(item => `<li>${esc(item.title)}</li>`).join('')}</ol>` : '<p>No selections yet.</p>'}</details>`;
}

function evidenceMarkup(evidence, key) {
  if (!evidence) return '<p class="inspector-muted">No comparison evidence was recorded.</p>';
  if (evidence.sameRecipe) return '<p class="inspector-muted">Identity shortcut: this is the same recipe. Similarity is 1 by identity; shared feature contributions were not used.</p>';
  const contributions = Array.isArray(evidence.familyContributions)
    ? Object.fromEntries(evidence.familyContributions.map(item => [item.family || item.key, item.contribution ?? item.value]))
    : evidence.familyContributions || {};
  const features = [...(evidence.features || [])].sort((a, b) => (b.similarityContribution || 0) - (a.similarityContribution || 0));
  return `<dl class="evidence-families">${['ingredients', 'techniques', 'traditions', 'text'].map(family => `<div><dt>${familyLabel(family)}</dt><dd>${number(contributions[family] ?? 0)}</dd></div>`).join('')}</dl>
    ${features.length ? `<p class="inspector-label">Largest shared contributions</p><ul class="shared-features">${features.slice(0, 6).map(feature => `<li><span>${esc(feature.term)} <small>${esc(familyLabel(feature.family))}${feature.pantry ? ', pantry downweight' : ''}</small></span><span class="inspector-number">${number(feature.similarityContribution)}</span></li>`).join('')}</ul>` : '<p class="inspector-muted">No shared features in this comparison.</p>'}
    <details class="inspector-raw" data-inspect-details="raw-${esc(key)}"${openDetails(`raw-${key}`)}><summary>Feature weights and frequency</summary><p class="inspector-muted">Denominator: ${number(evidence.denominator)}. Frequency counts recipes containing each feature at selection time. Contributions use the weighted overlap divided by this denominator.</p>${features.length ? `<div class="inspector-table-scroll" tabindex="0" role="region" aria-label="Shared feature weights"><table><thead><tr><th>Feature</th><th>Family</th><th>Weight</th><th>Frequency</th><th>Contribution</th></tr></thead><tbody>${features.map(feature => `<tr><td>${esc(feature.term)}${feature.pantry ? ' (pantry)' : ''}</td><td>${esc(familyLabel(feature.family))}</td><td>${number(feature.weight)}</td><td>${finite(feature.frequency) ? feature.frequency : 'Not available'}</td><td>${number(feature.similarityContribution)}</td></tr>`).join('')}</tbody></table></div>` : ''}</details>`;
}

function pairMarkup(pair, label, key) {
  if (!pair) return `<div class="inspector-pair"><h4>${label}</h4><p class="inspector-muted">No comparison applied.</p></div>`;
  return `<details class="inspector-pair" data-inspect-details="pair-${key}"${openDetails(`pair-${key}`)}><summary>${label}</summary><p>${esc(pair.title)} <span class="inspector-muted">· similarity ${number(pair.similarity)}</span></p>${evidenceMarkup(pair.evidence, key)}</details>`;
}

function renderInspector() {
  const panel = document.querySelector('#picks-inspector');
  if (!panel || !inspectorState.open) return;
  const snapshot = session?.inspect?.();
  if (!snapshot) {
    panel.innerHTML = '<h2 id="inspector-heading" tabindex="-1">Why these picks?</h2><p>The inspector is not available in this loaded version of Tonight.</p>';
    return;
  }
  const decisions = snapshot.decisions || [];
  let trace = decisions.find(item => item.id === inspectorState.recipeId) || decisions[0];
  inspectorState.recipeId = trace?.id || null;
  const likes = trace?.likes || [];
  const comparison = likes.find(item => item.id === inspectorState.likeId) || likes[0];
  inspectorState.likeId = comparison?.id || null;
  const feedback = snapshot.feedback || { more: [], less: [] };
  const maximumTies = likes.some(item => item.maximumTieCount > 1);
  const currentMatch = trace ? session?.matchFor?.(trace.id) : null;
  const mode = { relevance: 'Relevant pick', exploration: 'Exploration pick', random: 'Random pick' }[trace?.mode] || 'Selection';
  const source = { unseen: 'Not shown earlier in this session.', recycled: 'Previously shown, brought back into the available pool.', resurfaced: 'A previously shown recipe returned as a strong match.', 'immediate-repeat': 'Repeated from the immediately previous set.' }[trace?.source] || '';
  const resurfacing = trace?.source === 'resurfaced' ? trace.resurfacing : null;
  panel.innerHTML = `<div class="inspector-heading-row"><div><h2 id="inspector-heading" tabindex="-1">Why these picks?</h2><p class="inspector-muted">The actual choices and comparisons behind this set. Scores are relative ranking values, not probabilities.</p></div><button type="button" class="button quiet" id="inspector-close">Close inspector</button></div>
    ${snapshot.stale ? `<p class="notice inspector-stale" role="status">Selection-time snapshot: the collection changed after these picks were made. These reasons preserve the original comparison; they have not been recomputed from the refreshed collection.</p>` : ''}
    <div class="inspector-signals-grid">${feedbackMarkup(feedback.more || [], 'more')}${feedbackMarkup(feedback.less || [], 'less')}</div>
    ${trace ? `<div class="inspector-selection"><label for="inspect-recipe">Recipe to inspect</label><select id="inspect-recipe">${decisions.map(item => `<option value="${esc(item.id)}"${item.id === trace.id ? ' selected' : ''}>${esc(item.displayOrder)}. ${esc(nameOf(session.byId?.get(item.id) || item))}</option>`).join('')}</select></div>
    <div class="inspector-current-match"><h3>Current session match</h3>${currentMatch ? `<p><strong data-current-match data-match-percent="${esc(currentMatch.percent)}" data-value="${esc(currentMatch.value)}">${esc(currentMatch.percent)}% match</strong> <span class="inspector-muted">Based on your picks so far.</span></p><p class="inspector-muted">Uses your current feedback and collection. It measures shared features, not a probability. The selection-time scores below explain how this set was picked.</p>` : '<p class="inspector-muted">A match appears after reactions to three different recipes, including at least one More choice. It is based on your picks so far.</p>'}</div>
    <div class="inspector-trace"><div class="inspector-score-section"><h3>${mode}</h3><p class="inspector-muted">${source}${trace.mode === 'exploration' ? ' Exploration favors different options, so its affinity effect can be negative.' : ''}</p>${resurfacing ? `<p class="inspector-muted" data-resurfacing-summary>Returned after ${esc(resurfacing.batchesSinceShown)} sets, meeting the ${esc(resurfacing.cooldownBatches)}-set cooldown. Its selection-time match quality of ${number(resurfacing.quality)} met the required ${number(resurfacing.threshold)}.</p><details class="inspector-raw" data-inspect-details="resurfacing"${openDetails('resurfacing')}><summary>Why this recipe returned</summary><dl class="selection-facts">${[['lastShownBatch', 'Last shown in set'], ['batchesSinceShown', 'Sets since last shown'], ['cooldownBatches', 'Required cooldown'], ['quality', 'Match quality at selection'], ['threshold', 'Required quality'], ['bestUnseenQuality', 'Best unseen match quality'], ['absoluteThreshold', 'Absolute minimum quality'], ['relativeFactor', 'Relative quality factor'], ['maxSlots', 'Maximum returning recipes']].map(([key, label]) => `<dt>${label}</dt><dd data-resurfacing="${key}" data-value="${esc(resurfacing[key])}">${['lastShownBatch', 'batchesSinceShown', 'cooldownBatches', 'maxSlots'].includes(key) ? esc(resurfacing[key]) : number(resurfacing[key])}</dd>`).join('')}</dl><p class="inspector-muted">The required quality is the larger of the absolute minimum and the relative factor times the best unseen match quality. These are measurements from the original selection.</p></details>` : ''}${snapshot.stale && session.byId?.get(trace.id)?.title !== trace.title ? `<p class="inspector-muted">Name at selection: ${esc(trace.title)}</p>` : ''}<dl class="score-breakdown">${[['affinity', 'Like influence'], ['negative', 'Less-choice penalty'], ['diversity', 'Similarity to this set'], ['random', 'Random contribution']].map(([key, label]) => `<div><dt>${label}</dt><dd data-score="${key}" data-value="${esc(trace.components?.[key])}">${signed(trace.components?.[key])}</dd></div>`).join('')}<div class="score-total"><dt>Total selection score</dt><dd data-score="total" data-value="${esc(trace.score)}">${signed(trace.score)}</dd></div></dl><p class="inspector-muted">Numbers are rounded for display; totals use unrounded values.</p>
    <details class="inspector-raw" data-inspect-details="selection"${openDetails('selection')}><summary>Selection order and candidate pool</summary><dl class="selection-facts"><dt>Picked within this set</dt><dd>${esc(trace.selectionOrder)}</dd><dt>Displayed position</dt><dd>${esc(trace.displayOrder)}</dd><dt>Candidates scored</dt><dd>${esc(trace.pool?.count)}</dd><dt>Pool before exploration filter</dt><dd>${esc(trace.pool?.remaining)}</dd><dt>Exploration filter used</dt><dd>${trace.pool?.explorationFiltered ? 'Yes' : 'No'}</dd><dt>Runner-up score</dt><dd>${number(trace.pool?.runnerUpScore)}</dd><dt>Lead over runner-up</dt><dd>${number(trace.pool?.margin)}</dd><dt>Raw affinity</dt><dd>${number(trace.inputs?.affinity)}</dd><dt>Strongest negative similarity</dt><dd>${number(trace.inputs?.negativeSimilarity)}</dd><dt>Redundancy within set</dt><dd>${number(trace.inputs?.redundancy)}</dd><dt>Random draw</dt><dd>${number(trace.inputs?.randomDraw)}</dd></dl><p class="inspector-muted">Selection order can differ from the shuffled display order. Each score describes the pool at that selection step.</p></details></div>
    <div class="inspector-evidence-section"><h3>Shared evidence</h3>${likes.length ? `<label for="inspect-like">Compare with a More choice</label><select id="inspect-like">${likes.map(item => `<option value="${esc(item.id)}"${item.id === comparison.id ? ' selected' : ''}>${esc(item.title)}</option>`).join('')}</select><p class="inspector-muted">Similarity ${number(comparison.similarity)}. This comparison contributes ${number(comparison.affinityContribution)} to raw affinity before the selection-mode multiplier. The signed score effect appears under Like influence.</p>${maximumTies ? '<p class="inspector-muted">Several likes tie for the strongest match. The maximum counts once; its share is shown with the first tied recipe.</p>' : ''}${evidenceMarkup(comparison.evidence, 'like')}` : '<p class="inspector-muted">No More choices were part of this selection. There is no liked-recipe comparison to show.</p>'}
    <div class="inspector-pairs">${pairMarkup(trace.negative, 'Strongest Less-choice comparison', 'negative')}${pairMarkup(trace.diversity, 'Closest earlier pick in this set', 'diversity')}</div></div></div>` : '<p class="inspector-muted">No current picks to inspect. Your session choices are still shown above.</p>'}
    <details class="inspector-method" data-inspect-details="method"${openDetails('method')}><summary>How to read this</summary><p>Ingredient, technique, tradition, and lexical-word features can overlap. They do not assign a recipe to a single category. Lexical words are matched text tokens, not embeddings. Common pantry ingredients receive little weight; distinctive shared features can contribute more.</p><p>Card matches use current positive affinity minus the bounded negative penalty, limited to 0 through 1 and rounded to a percentage. Randomness, exploration, and the order of picks do not affect that match.</p><p>Like influence, the Less-choice penalty, variety within the set, and randomness are the actual signed additions to the total score. Exploration can reverse the affinity effect to probe a different direction. A single Less choice applies a bounded recipe comparison rather than a ban on an ingredient or cuisine.</p><dl class="selection-facts">${(snapshot.families || []).map(family => `<dt>${esc(family.label || familyLabel(family.key))} base weight</dt><dd>${number(family.weight)}</dd>`).join('')}<dt>Set number</dt><dd>${esc(snapshot.batchNumber)}</dd><dt>Selection model revision</dt><dd>${esc(snapshot.selectionRevision)}</dd><dt>Current model revision</dt><dd>${esc(snapshot.modelRevision)}</dd></dl></details>`;
  panel.querySelector('#inspector-close').addEventListener('click', () => setInspectorOpen(false));
  panel.querySelector('#inspect-recipe')?.addEventListener('change', event => {
    inspectorState.recipeId = event.target.value;
    renderInspector();
    document.querySelector('#inspect-recipe').focus({ preventScroll: true });
  });
  panel.querySelector('#inspect-like')?.addEventListener('change', event => {
    inspectorState.likeId = event.target.value;
    renderInspector();
    document.querySelector('#inspect-like').focus({ preventScroll: true });
  });
  panel.querySelectorAll('[data-inspect-details]').forEach(details => {
    // Remember deliberate disclosure choices, not the browser's initial toggle
    // event, so a growing signal list can still collapse at its default limit.
    details.querySelector(':scope > summary')?.addEventListener('click', () => {
      inspectorState.details.set(details.dataset.inspectDetails, !details.open);
    });
  });
}

function setInspectorOpen(open) {
  inspectorState.open = open;
  const panel = document.querySelector('#picks-inspector');
  const toggle = document.querySelector('#inspector-toggle');
  if (!panel || !toggle) return;
  panel.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
  if (open) {
    renderInspector();
    document.querySelector('#inspector-heading')?.focus({ preventScroll: true });
  } else toggle.focus({ preventScroll: true });
}

function wireInspector() {
  document.querySelector('#inspector-toggle')?.addEventListener('click', () => setInspectorOpen(!inspectorState.open));
  renderInspector();
}

function reactionPathMarkup(node, animate) {
  if (node.kind !== 'recipe') return '';
  const events = session?.inspect?.().history || [];
  if (!events.length) return '<section class="reaction-path reaction-path-empty" aria-labelledby="path-heading"><h2 id="path-heading">Your path</h2><p>No reactions yet. <span>Viewing now: ' + esc(node.title) + '</span></p></section>';
  const current = { id: node.id, title: node.title, image: node.image };
  const replayCount = Math.min(6, events.length);
  const replayStart = events.length - replayCount;
  const delayStep = 420;
  const items = events.map((event, index) => {
    const direction = event.direction === 'more' ? 'more' : 'less';
    const contents = `<span class="path-visual">${imageMarkup(event)}<span class="path-reaction-burst path-burst-${direction}" data-path-overlay="${direction}" aria-hidden="true">${svg(direction)}</span></span><span class="path-recipe-name">${esc(event.title)}</span>`;
    const available = session?.byId?.has(event.id);
    return `<li data-path-sequence="${esc(event.sequence)}"${animate && index >= replayStart ? ` data-path-animate="reaction" data-path-delay="${(index - replayStart) * delayStep}"` : ''}>${available ? `<a href="#/node/${esc(event.id)}" class="path-recipe-link">${contents}</a>` : `<div class="path-recipe-link">${contents}</div>`}<span class="path-direction">${svg(direction)}${direction === 'more' ? 'More like this' : 'Less like this'}</span></li>`;
  });
  items.push(`<li data-path-current${animate ? ` data-path-animate="current" data-path-delay="${replayCount * delayStep}"` : ''}><span class="path-current-glow" data-path-gold aria-hidden="true"></span><span class="path-visual">${imageMarkup(current)}</span><span class="path-recipe-name">${esc(current.title)}</span><span class="path-current-label">Viewing now</span></li>`);
  return `<section class="reaction-path${animate ? ' path-enter' : ''}" aria-labelledby="path-heading"><h2 id="path-heading">Your path</h2><p class="path-description">Reactions in order, ending at the recipe you are viewing.${events.length > replayCount ? ' The latest six reactions replay; your full history remains scrollable.' : ''}</p><div class="reaction-path-scroll" tabindex="0" role="region" aria-label="Your path, scroll horizontally"><ol class="reaction-path-items" aria-label="Your reaction path">${items.join('')}</ol></div></section>`;
}

function wirePathMotion(animate, priorScroll) {
  const scroller = main.querySelector('.reaction-path-scroll');
  if (!scroller) return;
  const animated = [...scroller.querySelectorAll('[data-path-animate]')];
  animated.forEach(item => item.style.setProperty('--path-delay', `${item.dataset.pathDelay}ms`));
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (!animate || reducedMotion.matches || !animated.length) {
    scroller.closest('.reaction-path')?.classList.remove('path-enter');
    scroller.scrollLeft = priorScroll ?? scroller.scrollWidth;
    return;
  }
  const timers = [];
  let follow = true;
  const scrollStyle = getComputedStyle(scroller);
  const insetLeft = parseFloat(scrollStyle.paddingLeft) || 0;
  const insetRight = parseFloat(scrollStyle.paddingRight) || 0;
  const stopFollowing = () => {
    follow = false;
    timers.forEach(clearTimeout);
    timers.length = 0;
    scroller.closest('.reaction-path')?.classList.remove('path-enter');
  };
  const reveal = (item, first = false) => {
    if (!follow || !scroller.isConnected) return;
    const left = item.getBoundingClientRect().left - scroller.getBoundingClientRect().left + scroller.scrollLeft;
    const right = left + item.offsetWidth;
    const target = first || left < scroller.scrollLeft + insetLeft ? left - insetLeft : right > scroller.scrollLeft + scroller.clientWidth - insetRight ? right + insetRight - scroller.clientWidth : scroller.scrollLeft;
    scroller.scrollTo({ left: Math.max(0, target), behavior: first ? 'instant' : 'smooth' });
  };
  for (const type of ['pointerdown', 'wheel', 'keydown']) scroller.addEventListener(type, stopFollowing, { passive: true });
  reducedMotion.addEventListener('change', stopFollowing);
  stopPathMotion = () => {
    stopFollowing();
    for (const type of ['pointerdown', 'wheel', 'keydown']) scroller.removeEventListener(type, stopFollowing);
    reducedMotion.removeEventListener('change', stopFollowing);
  };
  reveal(animated[0], true);
  animated.slice(1).forEach(item => timers.push(setTimeout(() => reveal(item), Number(item.dataset.pathDelay))));
}

function say(message, visible = false) {
  announcement.textContent = message;
  if (visible) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.hidden = false;
    toastTimer = setTimeout(() => { toast.hidden = true; }, 2800);
  }
}

function imageMarkup(recipe) {
  const fallback = `<svg class="missing-image" viewBox="0 0 24 24" role="img" aria-label="No image available">${icons.missing}</svg>`;
  return `<span class="image-wrap">${recipe.image ? `<img src="${esc(recipe.image)}" alt="" referrerpolicy="no-referrer" loading="lazy" decoding="async">` : fallback}</span>`;
}

function wireImages(container) {
  container.querySelectorAll('.image-wrap img').forEach(img => {
    const fail = () => {
      img.parentElement.innerHTML = `<svg class="missing-image" viewBox="0 0 24 24" role="img" aria-label="Image unavailable">${icons.missing}</svg>`;
    };
    img.addEventListener('error', fail, { once: true });
    if (img.complete && img.naturalWidth === 0) fail();
  });
}

function renderLoading() {
  main.innerHTML = `<div class="intro"><div><h1>What sounds good tonight?</h1><p>Opening your recipe collection…</p></div></div><div class="recipe-grid" aria-hidden="true">${Array.from({ length: 8 }, () => '<div class="skeleton"><div class="image-wrap"></div><div class="skeleton-line"></div></div>').join('')}</div>`;
}

function renderBrowse({ focus = false } = {}) {
  if (!catalog && getStatus().locked) { renderAccess(); return; }
  stopPathMotion();
  stopPathMotion = () => {};
  document.title = 'Tonight · Your recipe collection';
  pathViewId = null;
  const recipes = session?.current || [];
  const warning = connectionLost ? 'Updates are temporarily unavailable. You can keep exploring the last shared collection.' : catalog?.warning;
  const intro = `<div class="intro"><div><h1 id="browse-heading">What sounds good tonight?</h1><p>A few ideas from your collection. More or less, follow your appetite.</p></div><div class="browse-tools"><span class="session-note">Just for this session</span><button type="button" class="inspect-toggle" id="inspector-toggle" aria-controls="picks-inspector" aria-expanded="${inspectorState.open}">Inspect picks</button></div></div>`;
  if (!catalog?.available) {
    main.innerHTML = `<section class="empty"><h1>Your collection is taking a moment.</h1><p>${esc(catalog?.warning || 'The Recipes Vault is unavailable. Make sure it is connected, then try again.')}</p><button class="button primary" id="retry">Try again</button></section>`;
    document.querySelector('#retry').onclick = () => loadCatalog(true);
    return;
  }
  if (!recipes.length) {
    const noRecipes = !catalog.recipes.length;
    main.innerHTML = `${intro}${inspectorShell()}<section class="empty"><h2>${noRecipes ? 'No recipes to browse yet.' : 'A fresh start?'}</h2><p>${noRecipes ? 'Cookable recipes will appear here as they are added to your Recipes Vault.' : 'You’ve set these choices aside. Start a new session to bring everything back.'}</p>${noRecipes ? '' : '<button class="button primary" id="empty-reset">Start a new session</button>'}</section>`;
    document.querySelector('#empty-reset')?.addEventListener('click', reset);
    wireInspector();
    if (focus) main.focus({ preventScroll: true });
    return;
  }
  const matches = new Map(recipes.map(recipe => [recipe.id, session?.matchFor?.(recipe.id)]));
  const hasMatches = [...matches.values()].some(Boolean);
  const revealMatches = hasMatches && !matchLabelsRevealed && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (hasMatches) matchLabelsRevealed = true;
  main.innerHTML = `${intro}${warning ? `<div class="notice" role="status">${esc(warning)}</div>` : ''}${inspectorShell()}<section class="recipe-grid" aria-label="Recipe ideas">${recipes.map(recipe => {
    const name = nameOf(recipe);
    const match = matches.get(recipe.id);
    const matchLabel = match ? `<span class="recipe-match${revealMatches ? ' match-reveal' : ''}" data-match-percent="${esc(match.percent)}" title="Based on your picks so far">${esc(match.percent)}% match</span>` : '';
    return `<article class="recipe-card" data-id="${esc(recipe.id)}"><a class="recipe-link" href="#/node/${esc(recipe.id)}">${imageMarkup(recipe)}<div class="recipe-caption"><h2>${esc(name)}</h2>${matchLabel}</div></a><div class="feedback"><button type="button" data-reaction="more" aria-label="More like ${esc(name)}" title="More like this">${svg('more')}<span>More like this</span></button><button type="button" data-reaction="less" aria-label="Less like ${esc(name)}" title="Less like this">${svg('less')}<span>Less like this</span></button></div></article>`;
  }).join('')}</section><div class="browse-footer"><button class="button primary" id="next">Show me more ${svg('arrow')}</button><p>${session.exhausted ? 'You’ve explored these recipes. A few familiar ideas may return.' : 'Your reactions stay in this session. Start fresh whenever you like.'}</p></div>`;
  main.querySelectorAll('[data-reaction]').forEach(button => button.addEventListener('click', () => {
    const id = button.closest('.recipe-card').dataset.id;
    const reaction = button.dataset.reaction;
    session.react(id, reaction);
    renderBrowse({ focus: true });
    window.scrollTo({ top: 0, behavior: 'instant' });
    say(reaction === 'more' ? 'More in that direction. Here are your next ideas.' : 'A little less of that. Here are your next ideas.', true);
  }));
  main.querySelectorAll('.recipe-link').forEach(link => link.addEventListener('click', () => {
    browseScroll = window.scrollY;
    returnFocus = link.closest('.recipe-card').dataset.id;
  }));
  document.querySelector('#next').onclick = () => {
    session.next();
    renderBrowse({ focus: true });
    window.scrollTo({ top: 0, behavior: 'instant' });
    say('Your next recipe ideas are ready.');
  };
  wireImages(main);
  main.querySelectorAll('.match-reveal').forEach(label => {
    const finish = () => label.classList.remove('match-reveal');
    label.addEventListener('animationend', finish, { once: true });
    label.addEventListener('animationcancel', finish, { once: true });
  });
  wireInspector();
  if (focus) main.focus({ preventScroll: true });
}

async function renderNode(id, anchor = '', { keepPosition = false } = {}) {
  stopPathMotion();
  stopPathMotion = () => {};
  const currentRequest = ++requestNumber;
  const priorScroll = window.scrollY;
  const priorPathScroll = main.querySelector('.reaction-path-scroll')?.scrollLeft;
  if (!keepPosition) main.innerHTML = '<div class="detail"><a class="button quiet" href="#/">Back to ideas</a><p>Opening recipe…</p></div>';
  try {
    const node = await getNode(id);
    if (currentRequest !== requestNumber) return;
    document.title = `${node.title} · Tonight`;
    const metadata = Object.entries(node.metadata || {}).filter(([, value]) => value != null && value !== '');
    const animatePath = !keepPosition && pathViewId !== id;
    pathViewId = node.kind === 'recipe' ? id : null;
    main.innerHTML = `<section class="detail"><nav class="detail-nav" aria-label="Recipe navigation"><button class="button quiet" id="back">${svg('back')}Back</button><a class="button quiet" href="#/">All ideas</a></nav>${reactionPathMarkup(node, animatePath)}<article class="recipe-body"></article><details class="metadata"><summary>Recipe details &amp; provenance</summary><dl>${metadata.map(([key, value]) => `<dt>${esc(key.replaceAll('_', ' '))}</dt><dd>${esc(typeof value === 'object' ? Array.isArray(value) ? value.join(', ') : JSON.stringify(value) : value)}</dd>`).join('')}</dl></details><p class="provenance">Read from your Recipes Vault. Original notes and source uncertainty are preserved.</p></section>`;
    wirePathMotion(animatePath, animatePath ? undefined : priorPathScroll);
    wireImages(main);
    // The server renders and sanitizes vault Markdown. No unsanitized Markdown reaches innerHTML.
    const body = main.querySelector('.recipe-body');
    body.innerHTML = node.html;
    if (!body.querySelector('h1')) {
      const h1 = document.createElement('h1'); h1.textContent = node.title; body.prepend(h1);
    }
    for (const table of body.querySelectorAll('table')) {
      const wrapper = document.createElement('div'); wrapper.className = 'table-scroll';
      wrapper.tabIndex = 0; wrapper.setAttribute('role', 'region'); wrapper.setAttribute('aria-label', 'Recipe table');
      table.replaceWith(wrapper); wrapper.append(table);
    }
    body.querySelectorAll('a[href^="http"]').forEach(a => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
    body.querySelectorAll('img').forEach(img => {
      img.referrerPolicy = 'no-referrer';
      const fail = () => { const text = document.createElement('p'); text.className = 'notice'; text.textContent = 'This source image is unavailable.'; img.replaceWith(text); };
      img.addEventListener('error', fail, { once: true });
      if (img.complete && !img.naturalWidth) fail();
    });
    document.querySelector('#back').onclick = () => {
      if (navigationDepth > 0) history.back();
      else location.hash = routeWithAccess('#/');
    };
    if (keepPosition) window.scrollTo(0, priorScroll);
    else if (anchor) document.getElementById(anchor)?.scrollIntoView();
    else { window.scrollTo(0, 0); main.focus({ preventScroll: true }); }
  } catch (error) {
    if (currentRequest !== requestNumber) return;
    main.innerHTML = `<section class="empty"><h1>Couldn’t open that page.</h1><p>${esc(error.message)}</p><a class="button primary" href="#/">Back to ideas</a></section>`;
  }
}

function route({ keepPosition = false } = {}) {
  if (!catalog) { renderAccess(); return; }
  const hash = getRouteHash();
  const match = hash.match(/^#\/node\/([\w-]+)(?:\?(.*))?$/);
  if (match) {
    renderNode(match[1], new URLSearchParams(match[2] || '').get('section') || '', { keepPosition });
  } else {
    ++requestNumber;
    renderBrowse();
    if (lastRoute !== '#/') {
      window.scrollTo(0, browseScroll);
      const link = returnFocus && main.querySelector(`[data-id="${CSS.escape(returnFocus)}"] .recipe-link`);
      (link || main).focus({ preventScroll: true });
    }
  }
  lastRoute = hash;
}

function reset() {
  if (!session) { renderAccess(); return; }
  session?.reset();
  matchLabelsRevealed = false;
  browseScroll = 0;
  returnFocus = null;
  if (getRouteHash() !== '#/') location.hash = routeWithAccess('#/');
  else renderBrowse({ focus: true });
  window.scrollTo(0, 0);
  say('A fresh session. All your recipes are back in the mix.', true);
}

async function loadCatalog(force = false) {
  if (catalogRequest) { catalogRefreshQueued = true; return catalogRequest; }
  catalogRequest = (async () => {
    try {
      const next = await (catalog ? refresh() : getCatalog());
      const changed = catalog?.version !== next.version;
      const initialRender = !session;
      catalog = next;
      connectionLost = getStatus().offline;
      document.querySelector('#reset').hidden = false;
      if (!session) { session = new DiscoverySession(catalog.recipes); session.next(); }
      else if (changed) session.updateRecipes(catalog.recipes);
      if (changed || force) {
        if (session.current.length === 0 && catalog.recipes.some(recipe => !session.negatives.has(recipe.id))) session.next();
        route({ keepPosition: !initialRender });
      }
    } catch (error) {
      connectionLost = getStatus().offline;
      if (error.code === 'LOCKED') {
        ++requestNumber;
        catalog = null;
        session = null;
        inspectorState.details.clear();
        inspectorState.recipeId = null;
        inspectorState.likeId = null;
        matchLabelsRevealed = false;
        renderAccess();
      } else if (!catalog) renderAccess();
      else if (!getRouteHash().startsWith('#/node/')) renderBrowse();
    } finally {
      renderFreshness();
      catalogRequest = null;
      if (catalogRefreshQueued) { catalogRefreshQueued = false; queueMicrotask(() => loadCatalog(true)); }
    }
  })();
  return catalogRequest;
}

document.querySelector('#reset').addEventListener('click', reset);
document.querySelector('.skip-link').addEventListener('click', event => {
  event.preventDefault();
  main.focus();
  main.scrollIntoView();
});
window.addEventListener('hashchange', () => {
  if (consumeAccessLink()) {
    ++requestNumber;
    catalog = null;
    session = null;
    renderLoading();
    loadCatalog(true);
    protectPrivateLinks();
    return;
  }
  if (location.hash.startsWith('#/')) history.replaceState(history.state, '', routeWithAccess(location.hash));
  navigationDepth = history.state?.tonight ? history.state.depth || 0 : navigationDepth + 1;
  history.replaceState({ tonight: true, depth: navigationDepth }, '');
  route();
});
renderLoading();
await loadCatalog(true);
setInterval(() => { if (!document.hidden) loadCatalog(connectionLost); }, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadCatalog(connectionLost); });
window.addEventListener('online', () => loadCatalog(true));
window.addEventListener('pagehide', () => stopPathMotion());
window.addEventListener('pageshow', event => { if (event.persisted) loadCatalog(true); });

function renderAccess() {
  stopPathMotion();
  document.title = 'Tonight · A shared recipe collection';
  document.querySelector('#reset').hidden = true;
  const status = getStatus();
  const heading = status.offline ? 'The collection is taking a moment.' : 'You’re invited to Tonight.';
  const message = status.offline ? 'We couldn’t reach the shared recipes. Check your connection and try again.' : status.reason === 'invalid' ? 'This private link could not open the collection. Ask the person who shared Tonight for their latest link.' : 'Open the complete private link you received to explore the recipes. No account needed.';
  main.innerHTML = `<section class="empty private-access"><h1>${heading}</h1><p>${message}</p>${status.offline || status.reason === 'invalid' ? '<button class="button primary" id="access-retry">Try again</button>' : ''}</section>`;
  document.querySelector('#access-retry')?.addEventListener('click', () => loadCatalog(true));
  renderFreshness();
}

function renderFreshness() {
  const footer = document.querySelector('#freshness');
  const status = getStatus();
  footer.hidden = !status.publishedAt;
  if (!status.publishedAt) { footer.textContent = ''; return; }
  const date = new Date(status.publishedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  footer.textContent = `Collection updated ${date}. ${status.offline ? 'Updates unavailable; showing the last shared collection.' : 'New recipes appear automatically when the collection is shared.'}`;
}
