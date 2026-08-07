/* @gobbonet-split js/05-persistence.js
   Moved verbatim from chat.html lines 3353-4014.
   localStorage / IndexedDB, saveState
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   PERSISTENCE
================================================================ */
/* ----------------------------------------------------------------
   IndexedDB persistence layer

   Why: the whole app state used to be one JSON blob in one localStorage
   key, rewritten on every save. localStorage caps at ~5 MB per origin, so
   long multi-day chats eventually hit QuotaExceededError and saves silently
   froze. IndexedDB is disk-backed (hundreds of MB to GB), async (off the
   synchronous hot path), and supports per-record writes — so a streaming
   tick can rewrite just the active thread instead of the entire history.

   Layout (db 'gobbonet-state', v1):
     - store 'meta'    (out-of-line keys): one record under key 'app' holding
       the non-threads part of the blob (settings, cards, personas, folders,
       macros, scalars). Small; rewritten wholesale on a full save.
     - store 'threads' (keyPath 'id'): one record per thread — where the
       volume lives and where per-record writes pay off.

   buildStateBlob() stays the single source of truth for the blob shape, so
   the /state server backup format is unchanged.

   Graceful fallback: if IndexedDB is unavailable (rare private-mode cases)
   STORAGE_BACKEND stays 'localstorage' and the original localStorage path
   runs unchanged, so the app still works.
---------------------------------------------------------------- */
const IDB_DB = 'gobbonet-state', IDB_VER = 2;
let _idb = null;
let STORAGE_BACKEND = 'localstorage'; // upgraded to 'idb' after a successful open

function idbOpen() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || !indexedDB) return reject(new Error('no-indexeddb'));
    const req = indexedDB.open(IDB_DB, IDB_VER);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('meta'))    db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('threads')) db.createObjectStore('threads', { keyPath: 'id' });
      // v2 (RAG Stage 1): two local-only stores that are NEVER part of the
      // /state sync blob (telemetry is bulky; vectors are derivable). Keeping
      // them in IndexedDB out of /state matches the design's storage rules.
      //  - 'vectors':   embedding cache keyed by content hash, so re-saving a
      //                 storybook only re-embeds the chunks whose text changed.
      //  - 'telemetry': per-turn retrieval records (ring-buffered). Stage 2's
      //                 tracker reads/exports these; Stage 1 just appends.
      if (!db.objectStoreNames.contains('vectors'))   db.createObjectStore('vectors',   { keyPath: 'hash' });
      if (!db.objectStoreNames.contains('telemetry')) db.createObjectStore('telemetry', { keyPath: 'turn_id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}
function idbTx(store, mode) { return _idb.transaction(store, mode).objectStore(store); }
function idbGet(store, key)  { return new Promise((res, rej) => { const r = idbTx(store,'readonly').get(key); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }
function idbGetAll(store)     { return new Promise((res, rej) => { const r = idbTx(store,'readonly').getAll(); r.onsuccess=()=>res(r.result||[]); r.onerror=()=>rej(r.error); }); }
// put(val,key): only pass `key` when defined. The 'threads' store has an
// in-line keyPath, so calling put(value, key) on it throws DataError — the
// streaming path calls idbPut('threads', thread) with no key, which must
// resolve to a bare put(value).
function idbPut(store, val, key) {
  return new Promise((res, rej) => {
    const os = idbTx(store, 'readwrite');
    const r = (key === undefined) ? os.put(val) : os.put(val, key);
    r.onsuccess = () => res();
    r.onerror   = () => rej(r.error);
  });
}
function idbBulkPutThreads(threads) {
  return new Promise((res, rej) => {
    const tx = _idb.transaction('threads','readwrite'); const os = tx.objectStore('threads');
    for (const t of (threads || [])) os.put(t);
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}
function idbClearThreads() { return new Promise((res, rej) => { const r = idbTx('threads','readwrite').clear(); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error); }); }
// Generic helpers used by the RAG stores ('vectors', 'telemetry'). Best-effort
// callers wrap these in try/catch, so a missing store or closed db just no-ops.
function idbDelete(store, key) { return new Promise((res, rej) => { const r = idbTx(store,'readwrite').delete(key); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error); }); }
function idbGetAllKeys(store)  { return new Promise((res, rej) => { const r = idbTx(store,'readonly').getAllKeys(); r.onsuccess=()=>res(r.result||[]); r.onerror=()=>rej(r.error); }); }

// Assign a parsed state blob into the live `state` object and run all the
// in-place migrations. Source-agnostic: the blob may come from IndexedDB,
// the localStorage cache, or a server-restore string — factored out of the
// old synchronous loadState so every load path shares one migration code path.
function applyLoadedState(saved) {
  try {
      state.threads = saved.threads || [];

      // Restore the user-arranged thread order. On the IndexedDB backend the
      // 'threads' store is keyed by id, so idbGetAll('threads') hands records
      // back in id order — not the array order the user arranged by dragging
      // (nor what bump-to-top / new-thread-unshift produced). buildStateBlob()
      // persists that order as `threadOrder`; re-apply it here so a reload
      // matches what was on screen. Idempotent for the localStorage/server
      // blobs (their `threads` already arrive in order) and skipped for older
      // saves that predate `threadOrder`. Any thread absent from the order list
      // (e.g. a record synced in separately) keeps its relative position after
      // the ranked ones, thanks to the stable sort.
      if (Array.isArray(saved.threadOrder) && state.threads.length > 1) {
        const rank = new Map(saved.threadOrder.map((id, i) => [id, i]));
        const unranked = saved.threadOrder.length;
        state.threads.sort((a, b) =>
          (rank.has(a.id) ? rank.get(a.id) : unranked) -
          (rank.has(b.id) ? rank.get(b.id) : unranked));
      }

      state.activeThreadId = saved.activeThreadId || null;
      state.settings = { ...DEFAULT_SETTINGS, ...(saved.settings || {}) };
      state.sidebarOpen = saved.sidebarOpen !== undefined ? saved.sidebarOpen : true;
      state.characterCards = saved.characterCards || [{ ...DEFAULT_CARD }];
      state.activeCardId = saved.activeCardId || 'default';

      // ── PERSONAS ─────────────────────────────────────────────────
      // If the save file is from before personas existed (no personaCards
      // field), migrate the user identity fields out of settings into a
      // freshly-minted default persona. Existing chats keep showing the
      // same name/avatar/colors because getActivePersona() now sources them.
      //
      // If personaCards already exists we honor it verbatim — that's the
      // user's saved roster.
      if (Array.isArray(saved.personaCards) && saved.personaCards.length > 0) {
        // Patch any older entries that predate fields we've added since.
        state.personaCards = saved.personaCards.map(p => ({ ...DEFAULT_PERSONA, ...p }));
        state.activePersonaId = saved.activePersonaId || state.personaCards[0].id;
      } else {
        const legacy = saved.settings || {};
        // Treat the legacy default-but-never-customized 'Guest' as unset.
        // Anyone who really wanted 'Guest' can rename their persona; this
        // covers the much larger group who just never opened settings and
        // gets a sensible 'Anonymous' default instead of an artifact name.
        const legacyName = legacy.userName;
        const personaName = (legacyName && legacyName !== 'Guest') ? legacyName : 'Anonymous';
        const migrated = {
          ...DEFAULT_PERSONA,
          name: personaName,
          avatar: legacy.userAvatar || '',
          textColor: legacy.userTextColor || '',
          dialogColor: legacy.userDialogColor || ''
        };
        state.personaCards = [migrated];
        state.activePersonaId = migrated.id;

        // Strip the moved-out fields from settings so we don't carry two
        // copies of the same data around. Old saves on disk still have
        // them, but they'll be pruned on the next saveState().
        delete state.settings.userName;
        delete state.settings.userAvatar;
        delete state.settings.userTextColor;
        delete state.settings.userDialogColor;
      }

      state.schedules = saved.schedules || [];
      state.searchEnabled = saved.searchEnabled || false;
      state.folders = saved.folders || [];
      state.extensions = migrateExtensions(saved.extensions);
      state.macros = Array.isArray(saved.macros) ? saved.macros : DEFAULT_MACROS.map(m => ({ ...m }));

      // Seed any new DEFAULT_MACROS the user hasn't seen yet.
      //
      // The contract: each default macro is seeded at most once per user.
      // Users who delete a default afterward DON'T get it re-added on the
      // next load — that would be infuriating.
      //
      // For users predating this tracking (saved.seededDefaultMacros is
      // missing), we assume any default macros that shipped before this
      // field existed (continue, fast_forward) were already seen — even
      // if they're not currently in the user's macro list (they might
      // have been deleted). New defaults added after this point will
      // seed normally.
      if (Array.isArray(saved.seededDefaultMacros)) {
        state.seededDefaultMacros = [...saved.seededDefaultMacros];
      } else {
        // Pre-tracking user: backfill with every default trigger that has
        // ever shipped, including ones since removed from DEFAULT_MACROS.
        // 'auto_continue' was shipped briefly as a static macro before
        // being replaced by the {{auto_continue_N}} chain pattern — list
        // it here so anyone who deleted it doesn't get it re-added.
        state.seededDefaultMacros = ['continue', 'fast_forward', 'auto_continue'];
      }
      for (const def of DEFAULT_MACROS) {
        if (state.seededDefaultMacros.includes(def.trigger)) continue;
        // Only inject if the user doesn't already have a macro with the
        // same trigger — don't clobber their customization.
        const exists = state.macros.some(m => m.trigger === def.trigger);
        if (!exists) {
          state.macros.push({ ...def });
        }
        state.seededDefaultMacros.push(def.trigger);
      }

      // Migrate threads: add folder/pin/tag/branch fields if missing
      for (const t of state.threads) {
        if (!t.hasOwnProperty('pinned'))      t.pinned      = false;
        if (!t.hasOwnProperty('folderId'))    t.folderId    = null;
        if (!t.hasOwnProperty('tags'))        t.tags        = [];
        if (!t.hasOwnProperty('forkSource'))  t.forkSource  = null;
      }

      // --- MIGRATIONS ---

      // Migrate old Ollama system prompt into character cards
      if (saved.settings && saved.settings.systemPrompt && !saved.characterCards) {
        state.characterCards = [{
          ...DEFAULT_CARD,
          writingStyle: saved.settings.systemPrompt,
          personality: saved.settings.reminderPrompt || DEFAULT_CARD.personality
        }];
      }

      // Remove stale Ollama-era settings
      delete state.settings.privacyScrub;

      // Fix old Ollama model names
      if (state.settings.modelName && state.settings.modelName.includes(':')) {
        state.settings.modelName = 'auto'; // was old Ollama format
      }

      // Bump old tiny token limits — previous versions defaulted to 2048-4096
      // which starved the model. Most modern models support 128K+; 24K is a
      // safe default that fits comfortably with quantized KV cache on 16 GB.
      if (state.settings.tokenLimit && state.settings.tokenLimit < 8192) {
        console.log('[migration] Bumping tokenLimit from', state.settings.tokenLimit, 'to 24576');
        state.settings.tokenLimit = 24576;
      }

      // Clean up messages: strip runtime flags, fix empty content
      for (const thread of state.threads) {
        if (!thread.messages) continue;
        for (const m of thread.messages) {
          delete m._reasoningDone; // legacy flag from v1 parser
          delete m._parseState;    // v2 parser state
          // If assistant message has reasoning but no content, the old
          // streaming didn't split properly. Move reasoning to content.
          if (m.role === 'assistant' && m.reasoning && !m.content) {
            m.content = m.reasoning;
            m.reasoning = '';
          }
        }
      }

      // Recover orphaned turns. If a thread ends in an assistant message
      // that is completely empty (no content AND no reasoning), it's usually a
      // placeholder from a generation that was killed before a single token
      // landed — the page got navigated away / suspended in the first
      // streaming tick. Leaving it renders as a broken blank bubble and, once
      // present, makes the whole thread "look stuck."
      //
      // BUT an empty top-level assistant message is NOT always a throwaway. A
      // reroll blanks the top-level content/reasoning (so the typing indicator
      // shows) while stashing every prior generation in msg.variants. If the
      // page is saved during that pre-first-token window and then reloaded, the
      // message looks empty up top yet still carries real responses below.
      // Blindly popping it here would silently discard the whole reroll history
      // — exactly the "my responses vanished after a refresh" data loss we must
      // never cause. So we only drop a trailing empty assistant turn when there
      // is nothing to recover ANYWHERE. If it holds variants with real text, we
      // roll the dead (empty) reroll slot back to the last good variant and
      // re-mirror it, so the prior rerolls survive and the thread ends on a
      // real reply instead of a blank bubble.
      //
      // Partial replies (top-level content has *some* text) are untouched by
      // either path — those are legitimately-interrupted answers to keep. The
      // streaming-tick saves make that the common case instead of total loss;
      // only the zero-token race produces a truly empty top-level slot.
      const variantHasText = v =>
        !!v && (((v.content || '').trim()) || ((v.reasoning || '').trim()));
      for (const thread of state.threads) {
        if (!thread.messages || thread.messages.length === 0) continue;
        const last = thread.messages[thread.messages.length - 1];
        if (!last || last.role !== 'assistant') continue;

        const topEmpty =
          !((last.content || '').trim()) && !((last.reasoning || '').trim());
        if (!topEmpty) continue;

        // Interrupted reroll? Prior generations may still live in variants even
        // though the top-level slot was blanked for the typing indicator.
        if (Array.isArray(last.variants) && last.variants.length > 0) {
          // Trim only the trailing empty reroll slot(s) — the in-progress one
          // that never received a token. Earlier variants always hold text
          // (completed generations, or aborts/errors that still wrote a note),
          // so trimming from the end can never eat a real response.
          while (last.variants.length > 0 &&
                 !variantHasText(last.variants[last.variants.length - 1])) {
            last.variants.pop();
          }
          if (last.variants.length > 0) {
            // Roll back to the last surviving variant and mirror it onto the
            // message so content/reasoning/searchData are restored on screen.
            last.activeVariant = last.variants.length - 1;
            applyVariantToMessage(last);
            // One variant left means there's no history left to flip through —
            // collapse back to the plain single-variant shape so the ◀ ▶
            // navigator doesn't surface a lone 1/1. This restores the exact
            // pre-reroll state of the message.
            if (last.variants.length === 1) {
              delete last.variants;
              delete last.activeVariant;
            }
            console.log('[recover] Rolled an interrupted reroll back to its last saved response in thread', thread.id);
            continue;   // message kept — do NOT drop
          }
          // Every variant was empty: nothing to recover, fall through to drop.
        }

        thread.messages.pop();
        console.log('[recover] Dropped an empty trailing assistant placeholder in thread', thread.id);
      }
  } catch (e) {
    console.error('Failed to apply loaded state:', e);
  }
}

// Async loader. Picks a storage backend (IndexedDB preferred, localStorage
// fallback), reads the persisted blob, and feeds it through applyLoadedState.
// On a fresh IndexedDB that has an existing localStorage blob, performs a
// one-time forward migration into IDB (idempotent — after that `meta` exists
// and this branch is skipped). The localStorage blob is intentionally LEFT in
// place for one release as a rollback safety net (see migration plan §5).
//
// TODO(cleanup): once the IDB backend is confirmed in the wild, delete
// STORAGE_KEY after a successful migration to reclaim the ~5 MB localStorage
// cache. Keep SYNC_META_KEY (tiny) regardless.
async function loadState(rawOverride) {
  // Path A — explicit override (server restore feeds a JSON string).
  if (rawOverride !== undefined && rawOverride !== null) {
    try { applyLoadedState(JSON.parse(rawOverride)); }
    catch (e) { console.error('Failed to load state from override:', e); }
    return;
  }

  // Path B — try IndexedDB. On any open failure, degrade to localStorage.
  try {
    _idb = await idbOpen();
    STORAGE_BACKEND = 'idb';
  } catch (e) {
    STORAGE_BACKEND = 'localstorage';
    console.warn('[storage] IndexedDB unavailable — using localStorage fallback:', e && e.message);
  }

  if (STORAGE_BACKEND === 'idb') {
    try {
      const meta = await idbGet('meta', 'app');
      if (meta) {
        // Normal IDB load: reconstruct the blob from meta + per-thread records.
        const threads = await idbGetAll('threads');
        applyLoadedState({ ...meta, threads });
        return;
      }
      // Fresh IDB. If a localStorage blob exists, this is an existing user —
      // migrate it once. (Honor the legacy-key rename first, as before.)
      if (!localStorage.getItem(STORAGE_KEY) && localStorage.getItem(LEGACY_STORAGE_KEY)) {
        localStorage.setItem(STORAGE_KEY, localStorage.getItem(LEGACY_STORAGE_KEY));
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      }
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        applyLoadedState(JSON.parse(raw));      // runs migrations into `state`
        try {
          const blob = buildStateBlob();        // capture the migrated state
          await idbPut('meta', metaPartOf(blob), 'app');
          await idbBulkPutThreads(blob.threads);
          console.log('[storage] Migrated localStorage state into IndexedDB.');
        } catch (mErr) {
          console.warn('[storage] localStorage→IndexedDB migration failed (will retry next save):', mErr && mErr.message);
        }
        return;
      }
      // No IDB record and no localStorage blob → fresh install; defaults stand.
      return;
    } catch (e) {
      // Reads failed after a successful open — fall through to the localStorage
      // path rather than booting empty.
      console.warn('[storage] IndexedDB read failed — falling back to localStorage:', e && e.message);
      STORAGE_BACKEND = 'localstorage';
    }
  }

  // Path C — localStorage fallback (IDB unavailable or read failed).
  try {
    if (!localStorage.getItem(STORAGE_KEY) && localStorage.getItem(LEGACY_STORAGE_KEY)) {
      localStorage.setItem(STORAGE_KEY, localStorage.getItem(LEGACY_STORAGE_KEY));
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) applyLoadedState(JSON.parse(raw));
  } catch (e) {
    console.error('Failed to load state from localStorage:', e);
  }
}

/**
 * Build a JSON string suitable for pushing to the unauthenticated /state
 * endpoint on the file server: same shape as the localStorage blob, but
 * with settings.apiKey stripped. The key stays in localStorage only
 * (same-origin, browser-sandboxed) — the /state file lives on disk in the
 * project root and is readable by any device on the LAN.
 *
 * On restore, checkServerStateOnBoot's
 *   { ...DEFAULT_SETTINGS, ...(saved.settings || {}) }
 * merge handles the missing key gracefully — the user re-enters it once.
 * That's by design; forcing re-entry beats persisting the key in plaintext
 * on an unauthenticated endpoint.
 *
 * Accepts an optional in-memory blob (saveState passes its freshly built
 * object to skip an extra build on the ~2s save loop). With no argument, it
 * builds the blob from live in-memory state via buildStateBlob(); returns '{}'
 * only if that build throws, so we never push garbage upstream.
 */
function redactedSyncJson(blob) {
  if (blob === undefined) {
    // Source from live in-memory state (the single source of truth), NOT the
    // localStorage cache. localStorage is no longer authoritative once the
    // IndexedDB backend is active; buildStateBlob() returns the same shape the
    // old localStorage read produced, so the rest of the sync layer is
    // unaffected by which storage backend is in use.
    try {
      blob = buildStateBlob();
    } catch (e) {
      console.warn('[sync] Could not build state blob for sync:', e.message);
      return '{}';
    }
  }
  if (!blob || !blob.settings) return JSON.stringify(blob);
  const redacted = { ...blob, settings: { ...blob.settings } };
  delete redacted.settings.apiKey;
  return JSON.stringify(redacted);
}

// True once a localStorage write has been refused for lack of space. We
// keep persisting to the on-disk server backup and recover the full history
// from it on reload (see checkServerStateOnBoot / restoreFromServer).
let storageQuotaHit = false;

// localStorage quota errors surface under different names/codes across
// browsers; normalize the check so we never mistake one for a generic error.
function isQuotaError(e) {
  return !!e && (
    e.name === 'QuotaExceededError' ||
    e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||  // Firefox
    e.code === 22 || e.code === 1014
  );
}

// Strip the runtime-only message fields (never persisted) from one thread.
// Single source of truth reused by buildStateBlob and the streaming-tick
// active-thread write.
function cleanThread(t) {
  return {
    ...t,
    messages: (t.messages || []).map(m => {
      const clean = { ...m };
      delete clean._reasoningDone; // legacy runtime flag, not for storage
      delete clean._parseState;    // current parser state, not for storage
      delete clean._smartLimitAt;  // smart-limit crossing marker, runtime only
      return clean;
    })
  };
}

// In-memory `state` → the full persistable blob. The single source of truth
// for both the /state server sync (via redactedSyncJson) and the IDB writes,
// so the on-disk backup format never drifts from what we store locally.
function buildStateBlob() {
  return {
    threads: state.threads.map(cleanThread),
    // Persist the user-arranged order explicitly. The IDB 'threads' store is
    // keyed by id, so idbGetAll('threads') returns records in id order on
    // reload — losing the array order that drag-to-reorder, bump-to-top, and
    // new-thread-unshift produce (array order is the list's source of truth).
    // This id list rides along in the blob (and, via metaPartOf, into the IDB
    // 'meta' record) so applyLoadedState() can restore that order on load.
    threadOrder: state.threads.map(t => t.id),
    activeThreadId: state.activeThreadId,
    settings: state.settings,
    characterCards: state.characterCards,
    activeCardId: state.activeCardId,
    personaCards: state.personaCards,
    activePersonaId: state.activePersonaId,
    schedules: state.schedules,
    sidebarOpen: state.sidebarOpen,
    searchEnabled: state.searchEnabled,
    folders: state.folders,
    extensions: state.extensions,
    macros: state.macros,
    seededDefaultMacros: state.seededDefaultMacros
  };
}

// The blob without `threads` — i.e. the contents of the IDB 'meta' record.
function metaPartOf(blob) {
  const { threads, ...meta } = blob;
  return meta;
}

// ── IDB full-save coalescing ──────────────────────────────────────────────
// A full save rewrites the small meta record plus all thread records. Several
// saveState() calls often fire in a burst (e.g. `saveState(); renderSidebar()`
// repeated across a batch op), so we debounce the bulk write briefly. This is
// a performance nicety, not a correctness requirement — flushPendingIdbSave()
// drains it on page exit so a just-settled action can't be stranded.
let _idbFullSaveTimer = null;
let _idbPendingBlob = null;

function writeFullToIdb(blob) {
  // Sequential (meta then threads) so a failure is logged once with context.
  Promise.resolve()
    .then(() => idbPut('meta', metaPartOf(blob), 'app'))
    .then(() => idbBulkPutThreads(blob.threads))
    .then(() => {
      if (storageQuotaHit) { // recovered (e.g. disk freed up)
        storageQuotaHit = false;
        if (typeof stateSync !== 'undefined' && stateSync.status === 'quota') {
          stateSync.status = 'ok';
          updateSyncIndicator();
        }
      }
    })
    .catch(e => {
      // IDB can still throw QuotaExceededError if the *disk* is genuinely full
      // (rare). Handle it like the old localStorage cap: keep the server backup
      // authoritative and warn — don't throw to the fire-and-forget caller.
      if (isQuotaError(e)) {
        if (!storageQuotaHit) {
          console.warn('[storage] IndexedDB quota exceeded (disk full?) — the ' +
                       'on-disk server backup remains the source of truth.');
        }
        storageQuotaHit = true;
        if (STATE_SYNC_AVAILABLE) { stateSync.status = 'quota'; updateSyncIndicator(); }
      } else {
        console.warn('[storage] IndexedDB full save failed:', e && e.message);
      }
    });
}

function saveFullToIdb(blob) {
  _idbPendingBlob = blob;
  if (_idbFullSaveTimer) clearTimeout(_idbFullSaveTimer);
  _idbFullSaveTimer = setTimeout(() => {
    _idbFullSaveTimer = null;
    const b = _idbPendingBlob; _idbPendingBlob = null;
    if (b) writeFullToIdb(b);
  }, 250);
}

// Drain any pending debounced full save immediately (best-effort). Called from
// the page-exit path: IDB writes are async and may not complete during a
// teardown, but issuing them gives them a chance, and the most recent streaming
// tick plus the settled /state beacon cover the critical cases.
function flushPendingIdbSave() {
  if (STORAGE_BACKEND !== 'idb') return;
  if (_idbFullSaveTimer) {
    clearTimeout(_idbFullSaveTimer);
    _idbFullSaveTimer = null;
    const b = _idbPendingBlob; _idbPendingBlob = null;
    if (b) writeFullToIdb(b);
  }
}

function saveState(opts) {
  // opts.skipServerSchedule: persist locally only, don't arm the debounced
  // /state push. Used by the streaming-tick saves and the visibilitychange /
  // pagehide exit save — during a generation the server push always defers
  // anyway (stateSyncWouldBeTransient). On the IDB backend this flag ALSO
  // selects the cheap active-thread-only write (see below).
  const skipServerSchedule = !!(opts && opts.skipServerSchedule);

  // Build the snapshot once from in-memory state. If serialization fails there
  // is nothing we can persist, so bail rather than half-saving.
  let blob;
  try {
    blob = buildStateBlob();
  } catch (e) {
    console.error('Failed to serialize state for save:', e);
    return;
  }

  // 1) DURABLE server-side backup FIRST, decoupled from the local write.
  //    The /state file on the file server lives on disk and has no ~5MB
  //    ceiling. Scheduling it before (and independent of) the local write
  //    means a local failure can no longer also kill the backup — the complete
  //    conversation still reaches durable storage and a reload can recover it.
  //    apiKey is stripped before sending; see redactedSyncJson().
  //    (Streaming ticks pass skipServerSchedule and defer the push by design.)
  if (!skipServerSchedule) {
    scheduleStateSync(redactedSyncJson(blob));
  }

  // 2) Local persistence.
  if (STORAGE_BACKEND === 'idb') {
    if (skipServerSchedule) {
      // Streaming tick / exit save: rewrite ONLY the active thread (tiny),
      // not the whole multi-MB history every ~2.5 s. This is the cost the
      // migration exists to remove.
      const at = state.threads.find(t => t.id === state.activeThreadId);
      if (at) {
        idbPut('threads', cleanThread(at)).catch(e =>
          console.warn('[storage] active-thread write failed:', e && e.message));
      }
    } else {
      // Full save: meta record + all thread records (debounced/coalesced).
      saveFullToIdb(blob);
    }
    return;
  }

  // 3) localStorage fallback (IDB unavailable). The original synchronous path,
  //    kept intact so private mode / read-failure cases still work. On long
  //    histories this can exceed the quota; if it does we must NOT swallow it
  //    silently (that swallow is what froze the stored copy while the screen
  //    kept growing, so a back/reload showed a stale chat).
  let json;
  try {
    json = JSON.stringify(blob);
  } catch (e) {
    console.error('Failed to serialize state for save:', e);
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, json);
    if (storageQuotaHit) {
      // We fit again (e.g. after deleting some chats). Clear the warning.
      storageQuotaHit = false;
      if (typeof stateSync !== 'undefined' && stateSync.status === 'quota') {
        stateSync.status = 'ok';
        updateSyncIndicator();
      }
    }
  } catch (e) {
    if (isQuotaError(e)) {
      if (!storageQuotaHit) {
        console.warn('[storage] localStorage quota exceeded — the on-disk server ' +
                     'backup is now the source of truth for this conversation. ' +
                     'Reload to pull the full history back.');
      }
      storageQuotaHit = true;
      if (STATE_SYNC_AVAILABLE) { stateSync.status = 'quota'; updateSyncIndicator(); }
    } else {
      console.error('Failed to save state to localStorage:', e);
    }
  }
}

function getActiveCard() {
  return state.characterCards.find(c => c.id === state.activeCardId) || state.characterCards[0] || DEFAULT_CARD;
}

// Returns the currently-active persona. Falls back through the list and
// finally to a synthetic DEFAULT_PERSONA so callers never have to null-check.
// Personas own the user's name, avatar, and text colors — the legacy
// state.settings.userName etc. fields are no longer read anywhere and are
// stripped from settings during migration in loadState.
function getActivePersona() {
  if (!Array.isArray(state.personaCards) || state.personaCards.length === 0) {
    return { ...DEFAULT_PERSONA };
  }
  return state.personaCards.find(p => p.id === state.activePersonaId)
      || state.personaCards[0]
      || { ...DEFAULT_PERSONA };
}

