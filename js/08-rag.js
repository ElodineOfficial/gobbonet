/* @gobbonet-split js/08-rag.js
   Moved verbatim from chat.html lines 5500-6419.
   retrieval engine and telemetry
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   RAG ENGINE  (Stage 1 — dual retriever + telemetry)

   Two retrievers feed context on demand, integrated at the single
   injection seam (buildContextMessages). Everything below is
   degrade-safe: if the embed server is down Retriever A and the
   semantic backstop silently switch off and weighted-tag Retriever
   B carries on; if a card has no storybook the whole thing no-ops.

     Retriever A — general / semantic. Entity descriptions + freeform
       prose chunks are embedded once (cached by content hash) and
       cosine-scored against the recent window each turn.
     Retriever B — structured / weighted-tag. A thematic pull fires
       when the SUMMED weight of matched tags >= fire_threshold;
       entity + subtree granularity; one-hop relational expansion
       gated by offscreen_default; warmth/decay kills flicker.

   The unified ranker merges A+B, dedupes (an entity from both
   sources costs budget once), ranks by score x arc-role, fills a
   retrieval budget carved from the existing context budget, and
   pushes survivors as system messages. Every decision is logged
   into the per-turn telemetry record (Part 1 of the design) and
   emitted on the 'gobbonet:retrieval' event for Stage 2 to consume.
================================================================ */

/* Fast, dependency-free string hash (FNV-1a, 32-bit, hex). Used as a
   cache key for embedding vectors and as window.hash for telemetry. We
   deliberately avoid SubtleCrypto here: it needs a secure context, and
   the LAN deployment serves plain http, where crypto.subtle is absent. */
function ragHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}

/* Parse one *_tags value into [{term, weight}]. Bare terms default to
   weight 1.0; "divine [0.8]" tunes a noisy term down. This grammar lives
   ONLY in tag fields — it is retrieval control data, parsed at load and
   never sent to the model as prose. */
function parseWeightedTags(value) {
  if (!value) return [];
  return value.split(',').map(raw => {
    const s = raw.trim();
    if (!s) return null;
    const m = s.match(/^(.*?)\s*\[\s*([\d.]+)\s*\]\s*$/);
    if (m) {
      const term = m[1].trim();
      const w = parseFloat(m[2]);
      if (!term) return null;
      return { term, weight: (isFinite(w) ? w : 1.0) };
    }
    return { term: s, weight: 1.0 };
  }).filter(Boolean);
}

/* The reserved directive suffixes, locked by the schema commitment. A line
   "<id>_<suffix>: value" routes to structured control data; "<id>." prefixes
   address subtrees (entity.subtree). Anything that is not a recognized
   directive (and not a section header) is prose for Retriever A. */
const RAG_DIRECTIVE_RE = /^([A-Za-z0-9][A-Za-z0-9_.\- ]*?)_(tags|relation(?:_[A-Za-z0-9]+)?|role_in_arcs|use(?:_[A-Za-z0-9]+)?|offscreen_default)\s*:\s*(.*)$/i;
// Bare directive (inside a "# entity" section): "tags: ...", "relation: ...".
const RAG_BARE_DIRECTIVE_RE = /^(tags|relation(?:_[A-Za-z0-9]+)?|role_in_arcs|use(?:_[A-Za-z0-9]+)?|offscreen_default)\s*:\s*(.*)$/i;
// Section header forms: "# selah", "== selah ==", "[selah]". "##"/"." = subtree.
const RAG_HEADER_RE = /^(?:#{1,3}\s*|\=\=\s*|\[)\s*([A-Za-z0-9][A-Za-z0-9_.\- ]*?)\s*(?:\=\=|\])?\s*$/;

function ragNewEntity(id) {
  return {
    id, kind: id.includes('.') ? 'subtree' : 'entity',
    parent: id.includes('.') ? id.split('.')[0] : null,
    tags: [], relations: [], roleInArcs: '', usePrinciples: '',
    offscreenDefault: false, prose: ''
  };
}

/* Parse the whole storybook field. Routes structured lines to entities/
   subtrees (Retriever B) and plain prose to chunks (Retriever A). Supports
   BOTH the flat form ("selah_tags: angel [1.0]") and the sectioned form
   ("# selah" header, then bare "tags: ..." + prose lines). */
function parseStorybook(raw) {
  const result = { entities: {}, order: [], proseChunks: [],
                   counts: { entities: 0, subtrees: 0, tags: 0, proseChunks: 0 } };
  if (!raw || !raw.trim()) return result;

  const ensure = (id) => {
    if (!result.entities[id]) { result.entities[id] = ragNewEntity(id); result.order.push(id); }
    return result.entities[id];
  };
  const applyDirective = (ent, suffix, value) => {
    const s = suffix.toLowerCase();
    if (s === 'tags') ent.tags = ent.tags.concat(parseWeightedTags(value));
    else if (s === 'role_in_arcs') ent.roleInArcs = value.trim();
    else if (s === 'offscreen_default') ent.offscreenDefault = /^(1|true|yes|on)$/i.test(value.trim());
    else if (s.startsWith('relation')) ent.relations = ent.relations.concat(
      value.split(',').map(v => v.trim()).filter(Boolean));
    else if (s.startsWith('use')) ent.usePrinciples = (ent.usePrinciples ? ent.usePrinciples + ' ' : '') + value.trim();
  };

  let current = null;          // active section entity id
  let proseBuf = [];           // un-attributed prose accumulating into a chunk
  const flushProse = () => {
    const text = proseBuf.join('\n').trim();
    if (text) result.proseChunks.push({ id: 'doc:' + result.proseChunks.length, text });
    proseBuf = [];
  };

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) { // blank line ends an un-attributed prose chunk
      if (!current) flushProse();
      continue;
    }
    // A horizontal rule (---, ===, ___, ***) closes the current section so
    // following prose becomes standalone docs again. The escape hatch for
    // "structured entities, THEN general world prose for the semantic side."
    if (/^\s*([-=_*])\1{2,}\s*$/.test(line)) {
      if (!current) flushProse();
      current = null;
      continue;
    }
    let m;
    if ((m = line.match(RAG_DIRECTIVE_RE))) {
      const ent = ensure(m[1].trim());
      applyDirective(ent, m[2], m[3]);
      current = ent.id;
      continue;
    }
    if (current && (m = line.match(RAG_BARE_DIRECTIVE_RE))) {
      applyDirective(result.entities[current], m[1], m[2]);
      continue;
    }
    if ((m = line.match(RAG_HEADER_RE)) && !line.includes(':')) {
      if (!current) flushProse();
      current = ensure(m[1].trim()).id;
      continue;
    }
    // Plain prose. Attributed to the current section entity, else a doc chunk.
    if (current) {
      const ent = result.entities[current];
      ent.prose = ent.prose ? ent.prose + '\n' + line : line;
    } else {
      proseBuf.push(line);
    }
  }
  flushProse();

  for (const id of result.order) {
    const e = result.entities[id];
    if (e.kind === 'subtree') result.counts.subtrees++; else result.counts.entities++;
    result.counts.tags += e.tags.length;
  }
  result.counts.proseChunks = result.proseChunks.length
    + result.order.filter(id => result.entities[id].prose).length;
  return result;
}

/* Parse-and-cache on the card. Re-parses only when the raw text changes
   (keyed by hash) so the hot path doesn't re-parse a 40KB bible per turn. */
function getCardStorybook(card) {
  const raw = (card && card.ragStorybook) || '';
  const h = ragHash(raw);
  if (!card._storybook || card._storybook._hash !== h) {
    const parsed = parseStorybook(raw);
    parsed._hash = h;
    try { Object.defineProperty(card, '_storybook', { value: parsed, writable: true, enumerable: false, configurable: true }); }
    catch (e) { card._storybook = parsed; }
  }
  return card._storybook;
}

/* ---- Embedding client (Retriever A). Degrade-safe: any failure returns
   null and the caller proceeds tag-only. ---- */
const RAG_EMBED_PREFIX = { document: 'search_document: ', query: 'search_query: ' };
const _ragVecMem = new Map();      // hash -> Float32-ish array (in-memory mirror)
let _ragEmbedDimWarned = false;

async function ragEmbedRaw(text, mode) {
  // Returns a vector array, or null on any failure (server down, 401, etc.).
  if (!text || !text.trim()) return null;
  const prefix = RAG_EMBED_PREFIX[mode] || '';
  try {
    const resp = await fetch(EMBED_URL + '/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: prefix + text, model: 'embed' })
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const vec = data && data.data && data.data[0] && data.data[0].embedding;
    return Array.isArray(vec) && vec.length ? vec : null;
  } catch (e) {
    return null;
  }
}

async function ragEmbedCached(text, mode) {
  // Document embeddings are cached by content hash (in-mem + IndexedDB).
  // Query embeddings are per-turn and not cached.
  if (mode === 'query') return await ragEmbedRaw(text, 'query');
  const h = ragHash('d:' + text);
  if (_ragVecMem.has(h)) return _ragVecMem.get(h);
  try {
    if (STORAGE_BACKEND === 'idb' && _idb) {
      const rec = await idbGet('vectors', h);
      if (rec && rec.vec) { _ragVecMem.set(h, rec.vec); return rec.vec; }
    }
  } catch (e) { /* cache miss */ }
  const vec = await ragEmbedRaw(text, 'document');
  if (vec) {
    _ragVecMem.set(h, vec);
    try { if (STORAGE_BACKEND === 'idb' && _idb) await idbPut('vectors', { hash: h, vec, ts: Date.now() }); } catch (e) {}
  }
  return vec;
}

function ragCosine(a, b) {
  if (!a || !b || a.length !== b.length) {
    if (a && b && a.length !== b.length && !_ragEmbedDimWarned) {
      console.warn('[rag] embedding dimension mismatch — stale cache from a different embed model? Clearing.');
      _ragEmbedDimWarned = true;
      _ragVecMem.clear();
      try { if (STORAGE_BACKEND === 'idb' && _idb) idbTx('vectors','readwrite').clear(); } catch (e) {}
    }
    return 0;
  }
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/* Build the embeddable "doc" pool for a card: every entity/subtree that has
   description prose, plus every standalone prose chunk. Returns [{id, kind,
   parent, text, entityId}]. Embedding itself is lazy + cached per item. */
function ragBuildDocPool(book) {
  const docs = [];
  for (const id of book.order) {
    const e = book.entities[id];
    if (e.prose && e.prose.trim()) {
      docs.push({ id, kind: e.kind, parent: e.parent, text: e.prose, entityId: id });
    }
  }
  for (const c of book.proseChunks) {
    docs.push({ id: c.id, kind: 'doc', parent: null, text: c.text, entityId: null });
  }
  return docs;
}

/* Opportunistic ingest: embed-and-cache all of a card's docs ahead of time
   (fire-and-forget). Called on card save so the first chat turn isn't the one
   paying the indexing cost. Silently no-ops if the embed server is down. */
async function ragIngestCard(card) {
  try {
    if (!state.settings.retrievalEnabled || !state.settings.retrieverA) return;
    const book = getCardStorybook(card);
    const docs = ragBuildDocPool(book);
    for (const d of docs) { await ragEmbedCached(d.text, 'document'); }
  } catch (e) { /* degrade silently */ }
}

/* Per-thread warmth state (anti-flicker). Kept in-memory only — it is
   session-scoped flicker control, not worth syncing into /state. */
const _ragWarmth = new Map(); // threadId -> { entityId: remainingTurns }
function ragWarmthFor(threadId) {
  if (!_ragWarmth.has(threadId)) _ragWarmth.set(threadId, {});
  return _ragWarmth.get(threadId);
}

/* Emit a telemetry record: dispatch the event Stage 2 subscribes to, push
   onto the in-memory ring buffer, and best-effort persist to IndexedDB. This
   is the non-negotiable contract built on day one. */
const RAG_TELEMETRY_RING = 200;
function ragEmitRecord(record) {
  try {
    if (!window.__gobboTelemetry) window.__gobboTelemetry = [];
    window.__gobboTelemetry.push(record);
    if (window.__gobboTelemetry.length > RAG_TELEMETRY_RING) {
      window.__gobboTelemetry.splice(0, window.__gobboTelemetry.length - RAG_TELEMETRY_RING);
    }
  } catch (e) {}
  try { window.dispatchEvent(new CustomEvent('gobbonet:retrieval', { detail: record })); } catch (e) {}
  // Best-effort durable append (ring-buffered). Stage 2's tracker reads these.
  (async () => {
    try {
      if (STORAGE_BACKEND !== 'idb' || !_idb) return;
      await idbPut('telemetry', record);
      const keys = await idbGetAllKeys('telemetry');
      if (keys.length > RAG_TELEMETRY_RING) {
        const excess = keys.slice(0, keys.length - RAG_TELEMETRY_RING);
        for (const k of excess) { try { await idbDelete('telemetry', k); } catch (e) {} }
      }
    } catch (e) {}
  })();
}

let _ragTurnSeq = 0;

/* The unified retrieval pipeline. Returns:
     { injections: [{ entityId, text, tokenCost }], record, retrievalTokens }
   `freeForRetrieval` is the token headroom the budgeter has left after
   system + lore + live + reserves; we never spend more than that, regardless
   of the configured retrievalBudgetTokens ceiling. Never throws. */
async function runRetrieval(thread, card, freeForRetrieval, budgetSnapshot) {
  const cfg = state.settings;
  const record = {
    turn_id: 't_' + Date.now().toString(36) + '_' + (_ragTurnSeq++),
    thread_id: thread.id,
    ts: Date.now(),
    model_id: (activeModel && (activeModel.id || activeModel.name)) || 'unknown',
    config: {
      retriever_a: !!cfg.retrieverA,
      retriever_b: !!cfg.retrieverB,
      fire_threshold: cfg.fireThreshold,
      warmth_turns: cfg.warmthTurns,
      expansion_depth: cfg.expansionDepth,
      semantic_backstop: !!cfg.semanticBackstop,
      embed_available: false,          // set true below if a query embed succeeds
      top_k_a: cfg.topKA,
      retrieval_budget_tokens: cfg.retrievalBudgetTokens
    },
    window: { messages_scanned: 0, tokens_scanned: 0, hash: '' },
    budget: budgetSnapshot,
    candidates: [],
    shadow: [],
    post: { ttft_ms: null, retrieval_latency_ms: 0, per_candidate_usage: [] },
    flags: { turn_rating: null, barged_in: [], missing: [] },
    cards_in_play: []
  };

  const injections = [];
  const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

  // Single exit point: every path (early no-op, normal, or error) routes
  // through here so the per-turn record is emitted exactly once with latency
  // filled in. Honors the "one record per generation turn" contract.
  const finish = () => {
    const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    record.post.retrieval_latency_ms = Math.round(t1 - t0);
    if (typeof record.budget.retrieval_tokens !== 'number') record.budget.retrieval_tokens = 0;
    ragEmitRecord(record);
    return { injections, record, retrievalTokens: record.budget.retrieval_tokens || 0 };
  };

  try {
    if (!cfg.retrievalEnabled) { record.budget.retrieval_tokens = 0; return finish(); }

    const book = getCardStorybook(card);
    record.cards_in_play.push({
      card_id: card.id,
      tag_count: book.order.reduce((n, id) => n + book.entities[id].tags.length, 0),
      weight_total: book.order.reduce((n, id) => n + book.entities[id].tags.reduce((s, t) => s + t.weight, 0), 0),
      subtree_count: book.counts.subtrees
    });

    // Nothing authored → still emit a (cheap) record so the per-turn contract
    // holds, but skip all the work.
    const hasContent = book.order.length > 0 || book.proseChunks.length > 0;
    if (!hasContent) { record.budget.retrieval_tokens = 0; return finish(); }

    // ---- recent window (trigger surface) ----
    const live = thread.messages.filter(m => !m.archived);
    const win = live.slice(-Math.max(1, cfg.retrievalWindowMsgs || 4));
    const windowText = win.map(m => m.content || m.reasoning || '').join('\n');
    const windowLower = windowText.toLowerCase();
    record.window.messages_scanned = win.length;
    record.window.tokens_scanned = estimateTokens(windowText);
    record.window.hash = 'fnv:' + ragHash(windowText);

    // candidate accumulator keyed by cand_id; each value collects how it was hit
    const cand = {}; // id -> { id, kind, parent, triggers:Set, matched_tags, weight_sum, semScore, offscreen, role, use, prose }
    const touch = (id) => {
      const e = book.entities[id];
      if (!cand[id]) cand[id] = {
        id, kind: e ? e.kind : 'doc', parent: e ? e.parent : null,
        triggers: new Set(), matched_tags: [], weight_sum: 0, semScore: 0,
        offscreen: e ? e.offscreenDefault : false,
        role: e ? e.roleInArcs : '', use: e ? e.usePrinciples : '',
        prose: e ? e.prose : ''
      };
      return cand[id];
    };

    // per-entity weight sums (also used for the shadow recompute)
    const weightSums = {}; // id -> { sum, matched:[{term,weight}], identityHit:bool, nameHit:bool }

    // ---- Retriever B: weighted-tag firing ----
    if (cfg.retrieverB) {
      for (const id of book.order) {
        const e = book.entities[id];
        if (!e.tags.length) continue;
        let sum = 0; const matched = []; let identityHit = false;
        for (const t of e.tags) {
          const re = new RegExp('\\b' + t.term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
          if (re.test(windowLower)) {
            matched.push({ term: t.term, weight: t.weight });
            sum += t.weight;
            if (t.weight >= cfg.fireThreshold) identityHit = true;
          }
        }
        // explicit name mention (entity id or its leaf name) bypasses suppression
        const leaf = id.split('.').pop();
        const nameHit = new RegExp('\\b' + leaf.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(windowLower);
        weightSums[id] = { sum, matched, identityHit, nameHit };

        if (sum >= cfg.fireThreshold) {
          const c = touch(id);
          c.matched_tags = matched;
          c.weight_sum = sum;
          c.triggers.add(identityHit ? 'identity' : 'thematic_cluster');
          c._nameHit = nameHit;
        }
      }
    }

    // ---- Retriever A: semantic (+ backstop). Query embed is the only
    //      per-turn embed call; doc vectors are cached from ingest. ----
    const docs = ragBuildDocPool(book);
    if (cfg.retrieverA && docs.length) {
      const qvec = await ragEmbedRaw(windowText, 'query');
      if (qvec) {
        record.config.embed_available = true;
        const scored = [];
        for (const d of docs) {
          const dv = await ragEmbedCached(d.text, 'document');
          if (!dv) continue;
          const sim = ragCosine(qvec, dv);
          scored.push({ d, sim });
        }
        scored.sort((a, b) => b.sim - a.sim);
        const SEM_FLOOR = 0.25;
        let taken = 0;
        for (const s of scored) {
          if (s.sim < SEM_FLOOR) break;
          if (taken >= (cfg.topKA || 5)) break;
          taken++;
          const targetId = s.d.entityId || s.d.id;
          const c = touch(targetId);
          c.semScore = Math.max(c.semScore, s.sim);
          c.triggers.add('semantic'); // also serves as the backstop for B entities
          if (s.d.entityId == null) c.prose = s.d.text; // standalone doc payload
        }
      }
    }

    // ---- relational one-hop expansion (gated by offscreen_default) ----
    if (cfg.expansionDepth >= 1 && cfg.retrieverB) {
      const fired = Object.keys(cand).filter(id => cand[id].triggers.has('identity')
        || cand[id].triggers.has('thematic_cluster'));
      for (const id of fired) {
        const e = book.entities[id];
        if (!e) continue;
        for (const rel of e.relations) {
          const nid = book.entities[rel] ? rel : (book.order.find(o => o.split('.').pop() === rel) || rel);
          const ne = book.entities[nid];
          if (!ne) continue;
          if (ne.offscreenDefault) continue;       // suppressor gates the pull
          if (cand[nid]) continue;                  // already a candidate
          const c = touch(nid);
          c.triggers.add('relational');
        }
      }
    }

    // ---- warmth/decay (anti-flicker): decrement, then re-light fired ----
    const warmth = ragWarmthFor(thread.id);
    for (const id of Object.keys(warmth)) { warmth[id] -= 1; if (warmth[id] <= 0) delete warmth[id]; }
    // entities that fired this turn (and survive suppression) get re-lit below;
    // warm-but-not-fired entities are surfaced as 'warmth' candidates here.
    for (const id of Object.keys(warmth)) {
      if (!cand[id] && book.entities[id]) {
        const c = touch(id);
        c.triggers.add('warmth');
      }
    }

    // ---- score, suppress, dedupe ----
    const roleBoost = (role) => role && role.trim() ? 1.15 : 1.0;
    const triggerType = (c) => {
      if (c.triggers.has('identity')) return 'identity';
      if (c.triggers.has('thematic_cluster')) return 'thematic_cluster';
      if (c.triggers.has('relational')) return 'relational';
      if (c.triggers.has('semantic')) return 'semantic';
      if (c.triggers.has('warmth')) return 'warmth';
      return 'manual';
    };

    const ranked = [];
    for (const id of Object.keys(cand)) {
      const c = cand[id];
      const tt = triggerType(c);
      // base score: blend normalized weight-sum and semantic similarity
      const wScore = c.weight_sum > 0 ? Math.min(1, c.weight_sum / (cfg.fireThreshold * 2)) : 0;
      let base = Math.max(wScore, c.semScore);
      if (tt === 'warmth' || tt === 'relational') base *= 0.6; // dampen sticky/expanded pulls
      const score = +(base * roleBoost(c.role)).toFixed(4);

      // offscreen suppression: a thematic-only hit on an offscreen entity is
      // vetoed unless an identity tag, an explicit name mention, or a fired
      // subtree justifies it. Subtrees themselves are never suppressed.
      let suppressed = false;
      if (c.offscreen && c.kind === 'entity') {
        const onlyThematic = c.triggers.has('thematic_cluster')
          && !c.triggers.has('identity') && !c._nameHit;
        const subtreeFired = Object.keys(cand).some(o => cand[o].parent === id
          && (cand[o].triggers.has('identity') || cand[o].triggers.has('thematic_cluster')));
        if (onlyThematic && !subtreeFired) suppressed = true;
      }

      ranked.push({ c, id, tt, score, suppressed });
    }

    // dedupe note: a single id already collapses A+B hits into one candidate,
    // so budget is spent once. If the same entity surfaced via both, its
    // record carries multiple trigger flags; the canonical trigger_type is the
    // strongest one. (No separate dup rows needed — one id, one budget charge.)
    ranked.sort((a, b) => b.score - a.score);

    // ---- budget fill ----
    const retrievalCeiling = Math.max(0, Math.min(cfg.retrievalBudgetTokens || 0, Math.floor(freeForRetrieval)));
    let spent = 0;
    for (const r of ranked) {
      const e = book.entities[r.id];
      let payload = (r.c.prose || (e && e.prose) || '').trim();
      const usePrinciples = e && e.usePrinciples ? e.usePrinciples.trim() : '';
      if (!payload && !usePrinciples) { // nothing to inject (tags-only entity, no desc)
        record.candidates.push(_ragCandRow(r, 0, false, 'no_payload'));
        continue;
      }
      let injectText = payload;
      if (usePrinciples) injectText += (injectText ? '\n' : '') + '[Render guidance] ' + usePrinciples;
      const tokenCost = estimateTokens(injectText) + 4;

      if (r.suppressed) {
        record.candidates.push(_ragCandRow(r, tokenCost, false, 'offscreen_suppressed', !!usePrinciples));
        continue;
      }
      if (spent + tokenCost > retrievalCeiling) {
        record.candidates.push(_ragCandRow(r, tokenCost, false, 'budget', !!usePrinciples));
        continue;
      }
      spent += tokenCost;
      injections.push({ entityId: r.id, text: injectText, tokenCost });
      record.candidates.push(_ragCandRow(r, tokenCost, true, null, !!usePrinciples));
      // re-light warmth for anything actually included via a real fire
      if (r.tt === 'identity' || r.tt === 'thematic_cluster' || r.tt === 'semantic') {
        warmth[r.id] = cfg.warmthTurns;
      }
    }
    record.budget.retrieval_tokens = spent;

    // ---- shadow: cheap counterfactuals from the SAME window ----
    const firedAt = (thr) => book.order.filter(id => weightSums[id] && weightSums[id].sum >= thr);
    const baseFired = firedAt(cfg.fireThreshold);
    const tokAt = (ids) => ids.reduce((n, id) => {
      const e = book.entities[id]; return n + (e && e.prose ? estimateTokens(e.prose) + 4 : 0);
    }, 0);
    record.shadow.push({ config_delta: { fire_threshold: +(cfg.fireThreshold * 0.5).toFixed(2) },
      would_fire: firedAt(cfg.fireThreshold * 0.5),
      extra_tokens: tokAt(firedAt(cfg.fireThreshold * 0.5)) - tokAt(baseFired) });
    record.shadow.push({ config_delta: { fire_threshold: +(cfg.fireThreshold * 1.5).toFixed(2) },
      would_fire: firedAt(cfg.fireThreshold * 1.5),
      extra_tokens: tokAt(firedAt(cfg.fireThreshold * 1.5)) - tokAt(baseFired) });

    return finish();
  } catch (err) {
    console.warn('[rag] retrieval failed (degrading to no injection):', err && err.message);
    record.error = String(err && err.message || err);
  }

  return finish();
}

/* Build one candidates[] row for the telemetry record. */
function _ragCandRow(r, tokenCost, included, evictionReason, useAttached) {
  return {
    cand_id: r.id,
    kind: r.c.kind,
    parent_entity: r.c.parent,
    trigger_type: r.tt,
    matched_tags: r.c.matched_tags,
    weight_sum: +(r.c.weight_sum || 0).toFixed(3),
    score: r.score,
    offscreen_default: !!r.c.offscreen,
    included: !!included,
    eviction_reason: evictionReason,
    use_principles_attached: !!useAttached,
    token_cost: tokenCost
  };
}

/* Confined weight-annotation scrub. ONLY strips a trailing " [n.n]" that
   directly follows one of the supplied tag terms — never a blanket bracket
   strip (that would eat legitimate [stage directions], [redacted], dice
   notation). Used by translateTemplates as a safety net for the rare case
   where a tag term with its weight leaks into injected prose. */
function ragScrubWeightAnnotations(text, terms) {
  if (!text || !terms || !terms.length) return text;
  let out = text;
  for (const term of terms) {
    if (!term) continue;
    const t = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp('(' + t + ')\\s*\\[\\s*[\\d.]+\\s*\\]', 'gi'), '$1');
  }
  return out;
}

async function buildContextMessages(thread, card, opts) {
  opts = opts || {};
  const tokenLimit = state.settings.tokenLimit;
  const budget = Math.floor(tokenLimit * 0.9);

  // Post-compression landing zone, as a fraction of budget. The gap
  // between this and 1.0 = headroom before the NEXT compression fires.
  //   0.65 → ~25% headroom
  //   higher → smaller savings per pass, more frequent compressions
  //   lower  → bigger savings per pass, longer between compressions
  const TARGET_FACTOR = 0.65;

  // Trailing token reserve: the most-recent slice of the conversation
  // we promise to keep verbatim no matter what. Expressed as a fraction
  // of the budget so it scales with the configured context size — at
  // 16k this is ~3.1k tokens of recent talk, at 100k it's ~19.5k. Both
  // are sensible "don't compress what the model needs to respond to
  // the next turn" floors.
  const RECENT_RESERVE_FACTOR = 0.22;
  const recentReserve = Math.floor(budget * RECENT_RESERVE_FACTOR);

  // Response reserve: how much of the budget we hold back as guaranteed
  // room for the model's REPLY. Without this, compression only fires
  // when the INPUT crosses 90% of CTX — leaving as little as one short
  // user message's worth of room for the response. On turns where the
  // user just said "ok" or "go on", the AI started generating with ~10%
  // of CTX (or less) for output and a long reply got truncated mid-token
  // because the tiny user message didn't push the input over the line.
  //
  // The fix is to make the compression trigger output-aware: fire when
  // there isn't enough room left for a meaningful reply, not just when
  // the input has overflowed. Expressed as a fraction of budget so it
  // scales with context size:
  //   at 16K CTX  → ~2.9K output tokens reserved at trigger
  //   at 32K CTX  → ~5.9K
  //   at 100K CTX → ~18K
  //
  // Combined with the existing 10%-of-CTX physical margin (budget vs
  // tokenLimit), the AI is guaranteed ~30% of CTX worth of output room
  // at the moment compression fires, and substantially more right after
  // compression lands at TARGET_FACTOR. NOTE: the hard trim safety net
  // further down still keys off `budget` (the real physical ceiling) —
  // this reserve is a softer trigger, not a new physical limit.
  const RESPONSE_RESERVE_FACTOR = 0.20;
  const responseReserve = Math.floor(budget * RESPONSE_RESERVE_FACTOR);
  const effectiveBudget = budget - responseReserve;

  // ---- Fixed (per-build) context overhead ----
  // Writing style is the primary behavioural directive. It is emitted as
  // the LAST system block (see assembly below) so it lands freshest under
  // recency-weighted templates, but its token cost is fixed regardless.
  const writingStyleTokens = estimateTokens(card.writingStyle) + 4;

  // Personality is now a PERSISTENT block (position 2), established on every
  // turn rather than re-injected on a cadence. Counted whenever present.
  const personalityText = (card.personality || '').trim();
  const personalityTokens = personalityText ? estimateTokens(personalityText) + 4 : 0;

  // Authored world/setting lore (card.startingLore): small, always-on,
  // pulled FRESH from the card each build and emitted as the position-1
  // block. Kept distinct from the running conversation summary below — the
  // two are no longer blended into a single field.
  const authoredLore = (card.loreEnabled && card.startingLore) ? card.startingLore.trim() : '';
  const authoredLoreTokens = authoredLore ? estimateTokens(authoredLore) + 4 : 0;

  // Persona injection (USER info). The cadence is unchanged; only its
  // POSITION moves — it now lands LAST, immediately before the final user
  // message, because the model weights the tail of the prompt most. Anchored
  // on user message 1 too so the model knows who it's talking to from turn 1.
  // injectionFrequency === 0 disables injection (name/colors still apply).
  const totalUserMsgs = thread.messages.filter(m => m.role === 'user').length;
  const personaForBuild = getActivePersona();
  const personaFreq = (typeof personaForBuild.injectionFrequency === 'number')
    ? personaForBuild.injectionFrequency
    : 5;
  const personaDesc = (personaForBuild.description || '').trim();
  const needsPersonaInject = personaFreq > 0
    && personaDesc
    && (totalUserMsgs === 1
        || (totalUserMsgs > 1 && totalUserMsgs % personaFreq === 0));
  const personaPromptText = needsPersonaInject
    ? `[Persona: ${personaForBuild.name || 'Anonymous'}]\n${personaDesc}`
    : '';
  const personaTokens = needsPersonaInject ? estimateTokens(personaPromptText) + 4 : 0;

  // Running conversation summary (thread.lore — now summary-ONLY; authored
  // lore is never folded in). Emitted as the position-3 block.
  let summary = getThreadLore(thread);
  const summaryTokens = (summary && card.loreEnabled) ? estimateTokens(summary) + 4 : 0;

  let usedTokens = writingStyleTokens + personalityTokens + authoredLoreTokens
                 + personaTokens + summaryTokens;

  // Live (non-archived) messages — what we'd send if no compression
  // happened this turn. Pre-compute per-message token costs so we can
  // walk back from the tail accumulating into the reserve.
  let liveMsgs = thread.messages.filter(m => !m.archived);
  const liveCosts = liveMsgs.map(m =>
    estimateTokens(m.content || '') + estimateTokens(m.reasoning || '') + 4
    + (m.attachmentText ? estimateTokens(m.attachmentText) : 0)
  );
  const liveTokens = liveCosts.reduce((a, b) => a + b, 0);
  const projected  = usedTokens + liveTokens;

  // Trigger: would sending right now leave too little room for the
  // model's reply? `effectiveBudget` = `budget` minus the response
  // reserve, so we fire earlier than the raw input ceiling and the AI
  // always has at least responseReserve worth of output headroom.
  const shouldSummarize = card.loreEnabled && projected > effectiveBudget && liveMsgs.length > 1;

  if (shouldSummarize) {
    // How many tokens do we want to free? Aim to land at TARGET_FACTOR
    // of budget. Reserve some headroom for the lore that's about to
    // grow, so we don't immediately bounce back over the line.
    const summaryReserve = Math.max(summaryTokens, 1024);
    const targetTotal    = Math.floor(budget * TARGET_FACTOR);
    const fixedOverhead  = writingStyleTokens + personalityTokens + authoredLoreTokens + personaTokens;
    const targetLive     = Math.max(0, targetTotal - fixedOverhead - summaryReserve);
    const tokensToFree   = Math.max(0, liveTokens - targetLive);

    // Walk back from the tail accumulating the trailing reserve. The
    // index `firstArchivable` is the boundary: everything BEFORE it is
    // a candidate to archive; everything from it onward stays verbatim.
    let tailTokens = 0;
    let firstArchivable = liveMsgs.length;
    for (let i = liveMsgs.length - 1; i >= 0; i--) {
      if (tailTokens + liveCosts[i] > recentReserve && i < liveMsgs.length - 1) {
        firstArchivable = i + 1;
        break;
      }
      tailTokens += liveCosts[i];
      firstArchivable = i;
    }

    // Walk oldest-first within the archivable range, marking messages
    // until we've freed enough — or run out of archivable candidates.
    const toArchive = [];
    let freed = 0;
    for (let i = 0; i < firstArchivable; i++) {
      const m = liveMsgs[i];
      m.archived = true;
      toArchive.push(m);
      freed += liveCosts[i];
      if (freed >= tokensToFree) break;
    }

    if (toArchive.length > 0) {
      // Fold the just-archived chunk into the running summary (with any prior).
      const _loreBefore = summary || '';
      summary = await summarizeForLore(summary, toArchive);
      setThreadLore(thread, summary);

      // Record what this pass actually did. Without a before/after size you
      // cannot tell a summary that is absorbing new events from one that is
      // simply accreting — which is exactly how the repeated-location bug
      // hid: every pass "worked", and only the growth curve showed it was
      // appending rather than rewriting.
      //
      // Snapshots are capped at the last 6 passes so a long thread does not
      // carry an unbounded audit trail around in state.
      try {
        if (!Array.isArray(thread.loreLog)) thread.loreLog = [];
        thread.loreLog.push({
          at: Date.now(),
          folded: toArchive.length,
          before: _loreBefore.length,
          after: (summary || '').length,
          summary: summary || ''
        });
        while (thread.loreLog.length > 6) thread.loreLog.shift();
      } catch (e) { /* telemetry must never break a turn */ }

      // Persistent marker so the user can see the compression event while
      // the post-compression COT streams in. summarizeForLore's transient
      // "compressing..." indicator goes away the moment it returns; without
      // this, the only surviving record is the small "📝 N folded into lore"
      // divider near the TOP of the chat, which is easy to miss when the
      // user's eye is on the streaming reply at the bottom. Read by
      // renderMessages; cleared at the start of the next user turn.
      pendingLoreCompressionNote = { count: toArchive.length, threadId: thread.id };

      // Recompute post-archive state. usedTokens now reflects the new
      // (typically smaller) lore — this is what gets returned to the
      // caller as tokensUsed so the status bar shows reality.
      liveMsgs = thread.messages.filter(m => !m.archived);
      usedTokens = writingStyleTokens + personalityTokens + authoredLoreTokens + personaTokens
                 + (summary ? estimateTokens(summary) + 4 : 0);
      saveState();
      renderMessages();   // surface the dimming + lore divider immediately
    }
  }

  // Trim safety net — pathological case where the LIVE window alone
  // still exceeds budget (one giant pasted message, lore disabled, or
  // the trailing reserve itself is over budget). We trim what we send
  // to the API but do NOT archive these — they remain visible and
  // unfaded in the scrollback.
  let finalRecent = [...liveMsgs];
  let recentTotal = estimateMessagesTokens(finalRecent);
  while (finalRecent.length > 2 && (usedTokens + recentTotal) > budget) {
    finalRecent.shift();
    recentTotal = estimateMessagesTokens(finalRecent);
  }

  // Assemble in ascending priority — the model weights what arrives LAST, so
  // the order is: lore -> personality -> summary -> RAG -> writing style, then
  // the conversation, then (just before the final user turn) the response
  // direction and the USER's persona. Lock in character/user names at call
  // time so translateTemplates can't race with a card switch mid-build.
  const charName = card.name || 'Assistant';
  const userName = personaForBuild.name || 'Anonymous';

  const apiMessages = [];

  // ---- 1. LORE (authored world/setting; fresh from the card) ----
  if (authoredLore) {
    apiMessages.push({ role: 'system',
      content: '[Lore]\n' + translateTemplates(authoredLore, charName, userName) });
  }

  // ---- 2. PERSONALITY (+ character identity) — persistent every turn ----
  {
    let personalityBlock = `[Character: ${charName}]`;
    if (personalityText) personalityBlock += '\n' + translateTemplates(personalityText, charName, userName);
    apiMessages.push({ role: 'system', content: personalityBlock });
  }

  // ---- 3. AUTO-SUMMARY (running summary of older, archived turns) ----
  if (summary && card.loreEnabled) {
    apiMessages.push({ role: 'system',
      content: '[Story so far \u2014 summary of earlier messages]\n' + translateTemplates(summary, charName, userName) });
  }

  // ---- RAG retrieval (Stage 1) ----
  // Carve the retrieval budget from the SAME accounting the budgeter already
  // uses: whatever room is left after system + lore + live convo, minus the
  // response reserve so retrieved lore never eats the model's reply headroom.
  // runRetrieval never throws; on any failure it returns no injections and
  // still emits a telemetry record. Diagnostic builds (gobboDiag) suppress
  // emission + warmth mutation via opts.diag.
  let retrievalTokens = 0;
  if (!opts.diag) {
    const summaryTokensNow = (summary && card.loreEnabled) ? estimateTokens(summary) + 4 : 0;
    const budgetSnapshot = {
      token_limit: tokenLimit,
      budget: budget,
      system_tokens: writingStyleTokens + personalityTokens,
      lore_summary_tokens: authoredLoreTokens + summaryTokensNow,
      live_convo_tokens: recentTotal,
      retrieval_tokens: 0,
      free_tokens: Math.max(0, budget - usedTokens - recentTotal)
    };
    const freeForRetrieval = Math.max(0, budget - usedTokens - recentTotal - responseReserve);
    try {
      const ret = await runRetrieval(thread, card, freeForRetrieval, budgetSnapshot);
      retrievalTokens = ret.retrievalTokens || 0;
      for (const inj of ret.injections) {
        // Tag terms (with their authored weights) are control data and must
        // never reach the model. The confined scrub strips a trailing
        // " [n.n]" only when it directly follows one of THIS card's tag
        // terms — legitimate [brackets] in story prose are left untouched.
        const allTerms = [];
        try {
          const bk = getCardStorybook(card);
          for (const id of bk.order) for (const t of bk.entities[id].tags) allTerms.push(t.term);
        } catch (e) {}
        const scrubbed = ragScrubWeightAnnotations(inj.text, allTerms);
        apiMessages.push({
          role: 'system',
          content: '[Storybook: ' + inj.entityId + ']\n' + translateTemplates(scrubbed, charName, userName)
        });
      }
    } catch (e) {
      console.warn('[rag] injection skipped:', e && e.message);
    }
  }

  // ---- 5. WRITING STYLE (primary directive) — emitted LAST among the
  // system blocks so it sits freshest right before the conversation. ----
  apiMessages.push({ role: 'system', content: translateTemplates(card.writingStyle, charName, userName) });

  // Pick a carousel line once per context build (mutates card index for sequential mode)
  const carouselLine = pickCarouselLine(card);
  if (carouselLine) {
    // Save the updated index (sequential mode incremented it)
    saveState();
  }

  for (let i = 0; i < finalRecent.length; i++) {
    const m = finalRecent[i];
    const isLastUserMsg = m.role === 'user' && i === finalRecent.length - 1;
    // Just before the final user turn, in ascending priority: the optional
    // per-response narrative nudge, then the USER's persona LAST so it sits
    // immediately against the user message (recency = highest weight). The
    // old periodic personality reminder is gone — personality is now a
    // persistent block up top (position 2).
    if (carouselLine && isLastUserMsg) {
      apiMessages.push({ role: 'system', content: '[Narrative direction for this response]\n' + translateTemplates(carouselLine, charName, userName) });
    }
    if (needsPersonaInject && isLastUserMsg) {
      apiMessages.push({ role: 'system', content: translateTemplates(personaPromptText, charName, userName) });
    }
    // Use content for the API. If content is empty but reasoning exists
    // (older messages from before the parser split was working), fall back
    // to reasoning. Standard practice for thinking-style models is to send
    // only the final response back in history, not the chain-of-thought.
    let msgContent = translateTemplates(m.content || (m.role === 'assistant' ? m.reasoning : '') || '', charName, userName);
    if (m.attachmentText) msgContent = m.attachmentText + msgContent;
    if (m.searchData) msgContent += '\n' + m.searchData;
    apiMessages.push({ role: m.role, content: msgContent });
  }

  const finalApiMessages = normalizeMessagesForStrictTemplates(apiMessages);

  // Diagnostic: log the shape and sizes we're about to send. If you ever
  // see consecutive same-role entries or a leading non-system non-user,
  // the normalization missed an edge case. roleSeq is the at-a-glance
  // version; the full object below has content lengths for sanity.
  if (typeof console !== 'undefined' && console.debug) {
    const roleSeq = finalApiMessages.map(m => m.role[0]).join('');  // e.g. "suaua"
    console.debug(
      `[chat] sending ${finalApiMessages.length} msgs to /llm (roles: ${roleSeq})`,
      finalApiMessages.map(m => ({ role: m.role, chars: (m.content || '').length }))
    );
  }

  return {
    apiMessages: finalApiMessages,
    tokensUsed: usedTokens + recentTotal + retrievalTokens,
    budget
  };
}

