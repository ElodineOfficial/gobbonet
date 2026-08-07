/* @gobbonet-split js/06-state-sync.js
   Moved verbatim from chat.html lines 4015-4863.
   server-side state sync
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   SERVER-SIDE STATE SYNC

   Why: each LAN IP is a separate browser origin. When the PC's IP
   rotates (DHCP lease expires, reboot grabs a new one), the phone
   sees an empty localStorage at the new origin even though its old
   data is still sitting on disk at the old origin. Painful UX.

   Fix: mirror state to a server-side rolling backup at /state.
   On boot, if local is empty or the server has newer data, offer
   to restore. On every save, debounced push to the server.

   The local copy stays authoritative for performance — we never
   wait on the network for a save. Server sync is best-effort.
================================================================ */

// /state lives on the file server (same origin as chat.html when served).
// On file:// it's not available; sync is silently disabled.
const STATE_SYNC_AVAILABLE = IS_SERVED;
const STATE_SYNC_URL = IS_SERVED ? (window.location.origin + '/state') : null;

const stateSync = {
  // Last mtime we successfully read from or wrote to the server.
  // Used to detect "the server has data we haven't seen" on next boot.
  lastKnownMtime: 0,
  // Status for UI: 'idle' | 'syncing' | 'ok' | 'error' | 'disabled'
  status: STATE_SYNC_AVAILABLE ? 'idle' : 'disabled',
  lastError: null,
  pushTimer: null,
  pendingJson: null,
  inFlight: false
};

// Persist lastKnownMtime in localStorage so we remember it across
// reloads at the same origin. Keyed separately so a state restore
// doesn't clobber it.
const SYNC_META_KEY = 'gobbonet_sync_meta';
try {
  const meta = JSON.parse(localStorage.getItem(SYNC_META_KEY) || '{}');
  if (typeof meta.lastKnownMtime === 'number') stateSync.lastKnownMtime = meta.lastKnownMtime;
} catch (_) {}

function persistSyncMeta() {
  try {
    localStorage.setItem(SYNC_META_KEY, JSON.stringify({
      lastKnownMtime: stateSync.lastKnownMtime
    }));
  } catch (_) {}
}

// True when the in-memory state is mid-flight and therefore unsafe to publish
// as the cross-device source of truth: a generation is currently streaming, OR
// the active thread ends in an empty assistant placeholder (a fresh send slot
// or a freshly-blanked reroll slot) that hasn't been filled yet. Local saves
// still happen normally; only the server push is held back until the state
// settles. A settled thread never ends in an empty assistant message --
// generation always fills content, and even aborts/errors write text -- so
// this can defer a push but never starve a legitimate one.
function stateSyncWouldBeTransient() {
  if (isGenerating) return true;
  try {
    const t = getActiveThread();
    if (t && Array.isArray(t.messages) && t.messages.length > 0) {
      const last = t.messages[t.messages.length - 1];
      if (last && last.role === 'assistant' && !((last.content || '').trim())) {
        return true;
      }
    }
  } catch (_) {}
  return false;
}

/**
 * Debounced push to /state. Called from saveState(). Coalesces rapid
 * saves (typing, streaming tokens) into one network write every ~2s.
 */
function scheduleStateSync(json) {
  if (!STATE_SYNC_AVAILABLE) return;
  stateSync.pendingJson = json;
  if (stateSync.pushTimer) clearTimeout(stateSync.pushTimer);
  stateSync.pushTimer = setTimeout(flushStateSync, 2000);
}

async function flushStateSync() {
  if (!STATE_SYNC_AVAILABLE) return;
  if (stateSync.inFlight) {
    // Another push is happening. Re-arm so we capture the latest.
    stateSync.pushTimer = setTimeout(flushStateSync, 2000);
    return;
  }
  // Never publish a mid-flight snapshot as the cross-device source of truth.
  // While a generation is streaming -- or a fresh/rerolled assistant slot is
  // still empty -- the latest state contains a blank reply. Defer and keep
  // re-checking; the settled saveState() that runs when generation finishes
  // leaves a complete snapshot in pendingJson for us to send safely. This is
  // the fix for replies that "went blank" after a refresh: the server was
  // being handed an in-progress snapshot that other devices then restored.
  if (stateSyncWouldBeTransient()) {
    stateSync.pushTimer = setTimeout(flushStateSync, 2000);
    return;
  }
  const json = stateSync.pendingJson;
  if (!json) return;
  stateSync.pendingJson = null;
  stateSync.pushTimer = null;
  stateSync.inFlight = true;
  stateSync.status = 'syncing';
  updateSyncIndicator();
  try {
    const resp = await fetch(STATE_SYNC_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: json
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json().catch(() => ({}));
    if (data && typeof data.mtime === 'number') {
      stateSync.lastKnownMtime = data.mtime;
      persistSyncMeta();
    }
    stateSync.status = 'ok';
    stateSync.lastError = null;
  } catch (e) {
    stateSync.status = 'error';
    stateSync.lastError = e.message || String(e);
    console.warn('[sync] Push failed:', stateSync.lastError);
    // Don't drop the update. Requeue this snapshot (unless a newer one was
    // queued while we were in flight) and retry with a short backoff, so a
    // transient network blip can't leave the server holding a stale copy that
    // a later boot might restore over good local data.
    if (stateSync.pendingJson == null) stateSync.pendingJson = json;
    if (stateSync.pushTimer) clearTimeout(stateSync.pushTimer);
    stateSync.pushTimer = setTimeout(flushStateSync, 4000);
  } finally {
    stateSync.inFlight = false;
    updateSyncIndicator();
  }
}

/**
 * Collapse the 2s debounce and push the pending snapshot to /state right
 * away. Called the instant a generation settles, so a completed reply can't
 * be stranded in local-only purgatory if the user navigates away during the
 * debounce window. The orphaned debounce timer (if any) is cleared so it
 * can't fire a redundant second push; flushStateSync itself still defers
 * cleanly if the state somehow isn't settled yet.
 */
function forceServerFlush() {
  if (!STATE_SYNC_AVAILABLE) return;
  if (stateSync.pushTimer) { clearTimeout(stateSync.pushTimer); stateSync.pushTimer = null; }
  // Fire and forget — sync is best-effort and we never block the UI on it.
  flushStateSync();
}

/**
 * Last-chance flush when the page is being hidden or torn down. The browser
 * gives us no async budget here, so we do the two things that survive:
 *
 *   1. A synchronous localStorage write (saveState) — this is what lets THIS
 *      origin recover the in-progress reply on reload. localStorage.setItem
 *      completes inline even inside pagehide.
 *   2. A navigator.sendBeacon to /state, but ONLY when the state is settled.
 *      A mid-stream / empty-placeholder snapshot must never become the
 *      cross-device source of truth (that's the original blanking bug), so we
 *      gate the beacon behind stateSyncWouldBeTransient() exactly like the
 *      debounced path does.
 *
 * beacon=false skips the network beacon entirely — used on visibilitychange,
 * which fires on every tab switch and would otherwise spam the server.
 */
function flushBeforeExit(opts) {
  const beacon = !!(opts && opts.beacon);
  try {
    // Local save always. Skip arming the debounced push — the page is going
    // away, so the timer would never fire; the beacon below is the real push.
    saveState({ skipServerSchedule: true });
    // If a debounced full IDB save is still pending, issue it now (best-effort)
    // so a just-settled action isn't stranded by the teardown.
    flushPendingIdbSave();
    if (beacon && STATE_SYNC_AVAILABLE && !stateSyncWouldBeTransient() &&
        typeof navigator !== 'undefined' && navigator.sendBeacon) {
      const json = redactedSyncJson();
      if (json && json !== '{}') {
        navigator.sendBeacon(STATE_SYNC_URL, new Blob([json], { type: 'application/json' }));
      }
    }
  } catch (_) {}
}

/**
 * Boot-time check. Called once after loadState(). If the server has
 * a backup we don't have (or one strictly newer than ours), prompt
 * the user before clobbering local data.
 *
 * Decision matrix:
 *   local empty + server has data    -> auto-restore (no prompt)
 *   local has data + server matches  -> noop
 *   local has data + server newer    -> prompt user
 *   local has data + server older    -> noop, push will catch up
 *   local empty + server empty       -> noop (fresh install)
 */
// Loop guard for the silent auto-restore paths below. A silent restore ends in
// location.reload(), so any backup that never satisfies the boot check after
// being applied (e.g. a thread-less or otherwise non-converging blob) would
// reload-loop forever. sessionStorage survives reloads but is cleared when the
// tab closes, so this caps boot-time silent auto-restores at one per tab
// session: if the first attempt didn't make the page converge, we stop trying
// and leave local as-is rather than thrash. A real restore (server actually has
// chats) converges on its first reload — localEmpty becomes false and we never
// consult the guard again — so legitimate cross-device restore is unaffected.
function bootRestoreAlreadyTried() {
  try { return !!sessionStorage.getItem('gobbonet_boot_restore_attempted'); }
  catch (_) { return false; }
}
function markBootRestoreTried() {
  try { sessionStorage.setItem('gobbonet_boot_restore_attempted', '1'); }
  catch (_) {}
}
async function checkServerStateOnBoot() {
  if (!STATE_SYNC_AVAILABLE) return;
  let info;
  try {
    const resp = await fetch(STATE_SYNC_URL + '/info', { cache: 'no-store' });
    if (resp.status === 404) {
      // No backup yet — nothing to restore. Push current state to seed.
      if (state.threads && state.threads.length > 0) {
        scheduleStateSync(redactedSyncJson());
      }
      return;
    }
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    info = await resp.json();
  } catch (e) {
    console.warn('[sync] Boot check failed:', e.message);
    stateSync.status = 'error';
    stateSync.lastError = e.message;
    updateSyncIndicator();
    return;
  }

  const localEmpty = !state.threads || state.threads.length === 0;
  const serverMtime = (info && typeof info.mtime === 'number') ? info.mtime : 0;
  const serverSize = (info && typeof info.size === 'number') ? info.size : 0;
  let localSize = 0;
  try { localSize = redactedSyncJson().length; } catch (_) {}

  // Server has a backup that's newer than what we last synced (i.e. another
  // origin/device wrote after we last read), OR local is empty.
  const serverIsNewer = serverMtime > stateSync.lastKnownMtime;
  // Server holds materially more than our local copy. With "not newer than
  // what we last synced", this is the signature of a localStorage quota
  // truncation on THIS origin: we pushed the full conversation to the server,
  // but the local cache write was refused for space and froze a partial copy.
  // Retained after the IndexedDB migration (plan §7): on the IDB backend this
  // rarely triggers (IDB doesn't truncate at a 5 MB cap the way localStorage
  // did), but it still guards the localStorage-fallback path and genuine
  // cross-origin recovery, so it's kept deliberately rather than removed.
  const serverHasMore = localSize > 0 && serverSize > localSize * 1.2;

  if (localEmpty && serverSize > 0) {
    // Auto-restore — nothing to lose
    if (bootRestoreAlreadyTried()) {
      console.warn('[sync] Skipping boot auto-restore: already attempted this ' +
                   'session (loop guard). Server backup may have no threads.');
      stateSync.status = 'ok';
      updateSyncIndicator();
    } else {
      console.log('[sync] Local empty, restoring from server backup');
      markBootRestoreTried();
      await restoreFromServer({ silent: true });
    }
  } else if (!localEmpty && !serverIsNewer && serverHasMore) {
    // Quota-truncation recovery (the bug this fix targets). The server copy
    // is complete and is not a competing newer edit, so pull it back and the
    // replies that never fit into localStorage reappear. restoreFromServer
    // applies in memory if it still cannot fit locally.
    if (bootRestoreAlreadyTried()) {
      console.warn('[sync] Skipping quota-recovery restore: already attempted ' +
                   'this session (loop guard).');
      stateSync.status = 'ok';
      updateSyncIndicator();
    } else {
      console.warn('[sync] Local copy (' + localSize + ') smaller than server backup (' +
                   serverSize + ') with no newer remote edit — recovering full history ' +
                   'from server (local was truncated by the storage quota).');
      markBootRestoreTried();
      await restoreFromServer({ silent: true });
    }
  } else if (!localEmpty && serverIsNewer) {
    // Conflict: server has newer data than we know about. Don't auto-clobber.
    //
    // Defense in depth: a "newer" snapshot that is dramatically smaller than
    // our local copy is almost always a partial/mid-flight snapshot (or a
    // stale shape) rather than a legitimately newer conversation. Restoring it
    // would blank out replies we still hold locally -- the exact failure this
    // patch guards against. In that case keep local authoritative and
    // re-publish it to heal the server, instead of prompting to overwrite good
    // data. Trade-off: legitimately deleting >50% of your chats on another
    // device won't propagate to this one on the next boot (re-do the delete
    // and it will). Preserving data beats silently dropping it.
    if (localSize > 0 && serverSize < localSize * 0.5) {
      console.warn('[sync] Server is newer but much smaller (' + serverSize +
                   ' vs local ' + localSize + ') — keeping local, re-publishing.');
      stateSync.lastKnownMtime = serverMtime;
      persistSyncMeta();
      scheduleStateSync(redactedSyncJson());
      stateSync.status = 'ok';
      updateSyncIndicator();
    } else {
      showRestorePrompt(info);
    }
  } else {
    // Local matches or is ahead. Mark as ok.
    stateSync.lastKnownMtime = Math.max(stateSync.lastKnownMtime, serverMtime);
    persistSyncMeta();
    stateSync.status = 'ok';
    updateSyncIndicator();
  }
}

/**
 * Pull state from the server and apply it. Used by both auto-restore
 * (silent) and the manual restore button.
 */
async function restoreFromServer(opts) {
  opts = opts || {};
  if (!STATE_SYNC_AVAILABLE) {
    if (!opts.silent) alert('Server backup is only available when launched via launch.bat.');
    return false;
  }
  try {
    const resp = await fetch(STATE_SYNC_URL, { cache: 'no-store' });
    if (resp.status === 404) {
      if (!opts.silent) alert('No backup found on the server yet.');
      return false;
    }
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const text = await resp.text();
    const mtimeHeader = resp.headers.get('X-State-Mtime');
    // Sanity-check: must parse and have at least the threads array
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') throw new Error('malformed backup');

    // Loop stopper: a backup with no threads must NEVER trigger a reload. The
    // boot check treats "local has no threads" as a reason to restore, so
    // reloading into a thread-less restore lands right back in that branch ->
    // check/reload thrash. There is nothing to recover from an empty backup, so
    // sync the mtime, mark the backend in good standing, and return without
    // reloading. (Settings-only backups are non-zero bytes, which is exactly
    // why the size-based boot check can't catch this and we must catch it here.)
    const restoredThreads = Array.isArray(parsed.threads) ? parsed.threads : [];
    if (restoredThreads.length === 0) {
      if (mtimeHeader) {
        stateSync.lastKnownMtime = parseInt(mtimeHeader, 10) || stateSync.lastKnownMtime;
        persistSyncMeta();
      }
      stateSync.status = 'ok';
      updateSyncIndicator();
      console.warn('[sync] Server backup has no threads — nothing to restore; ' +
                   'not reloading (loop stopper).');
      if (!opts.silent) alert('The server backup contains no chats — nothing to restore.');
      return false;
    }

    if (mtimeHeader) {
      stateSync.lastKnownMtime = parseInt(mtimeHeader, 10) || stateSync.lastKnownMtime;
      persistSyncMeta();
    }
    // Repopulate the active storage backend from the restored blob, then
    // reload so the async boot re-reads it cleanly.
    if (STORAGE_BACKEND === 'idb') {
      // No 5 MB cap here, so the localStorage in-memory fallback below isn't
      // needed on this path — just rewrite the records and reload.
      await idbPut('meta', metaPartOf(parsed), 'app');
      await idbClearThreads();
      await idbBulkPutThreads(parsed.threads || []);
      location.reload();
      return true;
    }
    // localStorage fallback. Prefer caching locally and reloading for a
    // perfectly clean apply. But if the backup is too big for localStorage —
    // the exact case that caused the data loss we are recovering from — the
    // write throws; reloading then would just re-read the truncated copy and
    // lose the data again. So on a quota error, apply the restored state IN
    // MEMORY and re-render instead.
    try {
      localStorage.setItem(STORAGE_KEY, text);
      location.reload();
      return true;
    } catch (e) {
      if (!isQuotaError(e)) throw e;
      console.warn('[sync] Restored backup is larger than localStorage allows; ' +
                   'applying in memory (local cache stays partial, server backup ' +
                   'is complete).');
      storageQuotaHit = true;
      await loadState(text);        // parse + migrate the full blob into state
      state.activeThreadId = null;  // land on the dashboard like a normal boot
      if (STATE_SYNC_AVAILABLE) stateSync.status = 'quota';
      updateSyncIndicator();
      if (typeof render === 'function') render();
      return true;
    }
  } catch (e) {
    console.error('[sync] Restore failed:', e);
    if (!opts.silent) alert('Could not restore from server: ' + e.message);
    stateSync.status = 'error';
    stateSync.lastError = e.message;
    updateSyncIndicator();
    return false;
  }
}

function showRestorePrompt(info) {
  // Lightweight modal — uses the existing modal pattern
  const mtime = info && info.mtime ? new Date(info.mtime) : null;
  const when = mtime ? mtime.toLocaleString() : 'unknown';
  const sizeKB = info && info.size ? Math.round(info.size / 1024) : '?';
  const msg =
    'A newer chat backup was found on the server.\n\n' +
    'Saved: ' + when + '\n' +
    'Size: ' + sizeKB + ' KB\n\n' +
    'This usually means the server\'s LAN IP changed and your\n' +
    'browser is now seeing a fresh empty chat at the new address.\n\n' +
    'Restore it? (Your current local chat will be replaced.)';
  if (confirm(msg)) {
    restoreFromServer();
  } else {
    // User declined — accept local as authoritative and push to overwrite
    stateSync.lastKnownMtime = info.mtime || 0;
    persistSyncMeta();
    scheduleStateSync(redactedSyncJson());
  }
}

/**
 * Update the small sync-status indicator in the UI. Created lazily on
 * first call. Tucks into the sidebar footer; hidden on file://.
 */
function updateSyncIndicator() {
  if (!STATE_SYNC_AVAILABLE) return;
  let el = document.getElementById('sync-indicator');
  if (!el) {
    el = document.createElement('div');
    el.id = 'sync-indicator';
    el.className = 'sync-indicator';
    el.title = 'Click to manually restore from the server backup';
    el.addEventListener('click', () => {
      if (confirm('Replace your current chat with the version saved on the server?')) {
        restoreFromServer();
      }
    });
    // Place it in the sidebar footer if that exists; otherwise body
    const footer = document.querySelector('.sidebar-footer') || document.querySelector('.sidebar') || document.body;
    footer.appendChild(el);
  }
  const icons = { idle: '○', syncing: '⟳', ok: '✓', error: '!', quota: '⚠', disabled: '' };
  const labels = {
    idle: 'sync idle',
    syncing: 'syncing…',
    ok: 'synced',
    error: 'sync error: ' + (stateSync.lastError || 'unknown'),
    quota: 'local storage full — backed up to server (click to restore full history)',
    disabled: ''
  };
  el.textContent = (icons[stateSync.status] || '') + ' ' + (labels[stateSync.status] || '');
  el.dataset.status = stateSync.status;
}

/**
 * Parse a numeric input value, returning the default only if the input
 * is genuinely empty or NaN — NOT when it's zero. Fixes the bug where
 * `parseFloat(x) || default` treats 0 as falsy.
 */
function safeParse(raw, fallback, asInt) {
  const v = asInt ? parseInt(raw) : parseFloat(raw);
  return (isNaN(v) || raw === '' || raw == null) ? fallback : v;
}

/**
 * Build sampler parameters from the active character card.
 * Returns an object to spread into the llama.cpp API body.
 *
 * Existing cards without XTC/DRY fields fall through to off-by-default
 * values, so adding these samplers doesn't change behavior for anyone
 * who hasn't opted in via the UI or a preset.
 *
 * XTC (Exclude Top Choices) - removes high-prob tokens with some chance
 *   per step, forcing the model down less-trodden paths. Best lever for
 *   "model keeps reaching for the same word" on peaky distributions.
 *   xtc_probability = 0 disables.
 *
 * DRY (Don't Repeat Yourself) - penalizes repeated SEQUENCES rather than
 *   single tokens. Lets function words / names repeat naturally while
 *   blocking the model from re-using whole descriptive phrases.
 *   dry_multiplier = 0 disables.
 */
function getCardSamplerParams(card) {
  card = card || getActiveCard();
  return {
    temperature: card.temperature !== undefined ? card.temperature : 0.7,
    min_p:       card.minP !== undefined ? card.minP : 0.05,
    top_k:       card.topK !== undefined ? card.topK : 40,
    top_p:       card.topP !== undefined ? card.topP : 0.95,
    repeat_penalty:  card.repeatPenalty !== undefined ? card.repeatPenalty : 1.1,
    repeat_last_n:   card.repeatLastN !== undefined ? card.repeatLastN : 64,
    // XTC — off by default
    xtc_probability: card.xtcProbability !== undefined ? card.xtcProbability : 0,
    xtc_threshold:   card.xtcThreshold !== undefined ? card.xtcThreshold : 0.1,
    // DRY — off by default. Base/allowed-length use community-standard
    // values; only the multiplier is user-facing in the UI.
    dry_multiplier:     card.dryMultiplier !== undefined ? card.dryMultiplier : 0,
    dry_base:           card.dryBase !== undefined ? card.dryBase : 1.75,
    dry_allowed_length: card.dryAllowedLength !== undefined ? card.dryAllowedLength : 2,
    dry_penalty_last_n: -1
  };
}

/**
 * Family-aware STOP STRINGS.
 *
 * Why this exists: '[INST]' / '[/INST]' are NOT special tokens in Mistral's
 * format — they're plain text. When a model leaks them into a visible reply
 * ("Tekken junk"), it means generation ran PAST the turn boundary because the
 * EOS the model emits doesn't match what llama-server stops on. This is the
 * classic roleplay-merge artifact (mismatched/wrong EOS in the GGUF). The
 * embedded template can be perfectly correct and the model still runs on.
 *
 * SillyTavern's universal fix is custom stop strings: the instruct template's
 * turn delimiters double as stopping strings, so a runaway gets cut at the
 * first delimiter regardless of EOS health. We mirror that here.
 *
 * SAFETY: every string below is a TURN DELIMITER that must never appear inside
 * a valid assistant reply. Stopping on them is a pure backstop — it only fires
 * when the model misbehaves, so it can't truncate legitimate output and can't
 * regress models that already stop cleanly (the server still honors real EOS
 * first). Delimiters are stripped from the output, not echoed.
 *
 * We deliberately leave the delicate reasoning formats (harmony / deepseek)
 * to the server's own parsing and add no extra stops for them, since their
 * channel/think markers are consumed mid-turn, not at the boundary.
 */
const STOP_STRINGS_BY_FAMILY = {
  // Mistral V1/V2/V3/Tekken/V7 — the family that leaks "[INST]" junk.
  mistral:    ['</s>', '[INST]', '[/INST]'],
  // Llama 3.x header format (also covers llama2-lineage [INST] merges).
  llama:      ['<|eot_id|>', '<|start_header_id|>', '[INST]', '[/INST]'],
  // ChatML and friends.
  qwen:       ['<|im_end|>', '<|im_start|>'],
  glm:        ['<|im_end|>', '<|im_start|>', '<|user|>', '<|assistant|>'],
  phi:        ['<|im_end|>', '<|im_start|>', '<|end|>'],
  moonshot:   ['<|im_end|>', '<|im_user|>', '<|im_assistant|>'],
  // Gemma turn markers (thinking is channel-based *within* the turn, so these
  // boundary markers don't clip reasoning).
  gemma:      ['<end_of_turn>', '<start_of_turn>'],
  // Cohere Command R / R+ / R7B. Keyed by 'cohere' to match the family
  // identifier used in MODEL_REGISTRY / identify-model.ps1 / launch.bat —
  // the lookup is by activeModel.family.toLowerCase(), so the key has to
  // match exactly or getStopStrings() returns {} and the END_OF_TURN_TOKEN
  // marker leaks into the rendered output.
  cohere:     ['<|END_OF_TURN_TOKEN|>', '<|START_OF_TURN_TOKEN|>'],
  // tulu uses the same <|...|> role markers as its base.
  tulu:       ['<|user|>', '<|assistant|>', '<|system|>'],
  // harmony (gpt-oss), deepseek, granite, custom: intentionally no extra stops.
};

/**
 * Returns { stop: [...] } for the active model's family, or {} when we have no
 * safe delimiters to add (custom / reasoning formats). Spread into the request
 * body alongside the sampler params.
 */
function getStopStrings() {
  const fam = (activeModel && activeModel.family) ? String(activeModel.family).toLowerCase() : '';
  const stops = STOP_STRINGS_BY_FAMILY[fam];
  return (stops && stops.length) ? { stop: stops.slice() } : {};
}

/**
 * gobboDiag() — GROUND-TRUTH PROMPT DIAGNOSTIC.
 *
 * Eyeballing model output can't tell us what framing the model actually
 * received — only the server knows that. This pulls the two facts that settle
 * any "wrong template / garbage output" question:
 *
 *   1. GET  /props          -> the chat template llama-server actually loaded
 *                              (plus the tool-use template, if any).
 *   2. POST /apply-template -> the EXACT prompt string the model is fed for the
 *                              current conversation (formats, does not infer).
 *
 * If /apply-template shows the turns wrapped in '[INST]' but the model's own
 * output uses '<|user|>' / '<|assistant|>', the embedded template and the
 * model's training disagree — that's the bug, proven rather than guessed.
 *
 * Run it from the browser console (F12) after a bad reply:  gobboDiag()
 * The report is printed and copied to the clipboard when possible.
 */
async function gobboDiag() {
  const out = { when: new Date().toISOString(), model: null, family: null,
                stop: null, props: null, appliedPrompt: null, notes: [] };

  if (!IS_SERVED) {
    console.warn('[gobboDiag] Not served over http — open via the LAN/server URL, not file://. Cannot reach llama-server.');
    return out;
  }

  out.model  = (activeModel && activeModel.name)   || _currentModelFile || 'unknown';
  out.family = (activeModel && activeModel.family) || 'unknown';
  out.stop   = getStopStrings().stop || [];

  // 1) What template did the server actually load?
  try {
    const r = await fetch(LLAMA_URL + '/props', { cache: 'no-store' });
    if (r.ok) {
      const p = await r.json();
      out.props = {
        chat_template:          p.chat_template || '(none reported)',
        chat_template_tool_use: p.chat_template_tool_use || null,
        bos: (p.bos_token ?? (p.default_generation_settings && p.default_generation_settings.bos_token)) ?? null,
        eos: (p.eos_token ?? (p.default_generation_settings && p.default_generation_settings.eos_token)) ?? null,
        n_ctx: (p.default_generation_settings && (p.default_generation_settings.n_ctx ?? p.default_generation_settings.n_ctx_train)) ?? null
      };
    } else if (r.status === 401) {
      // The /llm/* proxy rejects this because the file-server login session
      // has expired (NOT a llama-server API key problem). Reload the page,
      // log in, and re-run gobboDiag().
      out.notes.push('/props returned 401 — your file-server login session has expired. Reload the page, log in again, then re-run gobboDiag().');
    } else {
      out.notes.push('/props returned ' + r.status);
    }
  } catch (e) {
    out.notes.push('/props fetch failed: ' + e.message);
  }

  // 2) What exact prompt does the current conversation produce?
  try {
    const thread = getActiveThread();
    const card   = getActiveCard();
    if (thread) {
      const { apiMessages } = await buildContextMessages(thread, card, { diag: true });
      const r = await fetch(LLAMA_URL + '/apply-template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: apiMessages })
      });
      if (r.ok) {
        const j = await r.json();
        out.appliedPrompt = (typeof j.prompt === 'string') ? j.prompt : JSON.stringify(j);
      } else if (r.status === 401) {
        const already = out.notes.some(n => n.indexOf('/props returned 401') === 0);
        if (!already) {
          out.notes.push('/apply-template returned 401 — file-server login session expired. Reload the page, log in, then re-run gobboDiag().');
        } else {
          out.notes.push('/apply-template also 401 (same session-expiry cause as /props).');
        }
      } else {
        out.notes.push('/apply-template returned ' + r.status + ' (older build? then use /props template above)');
      }
    } else {
      out.notes.push('no active thread — open a chat first to capture an applied prompt');
    }
  } catch (e) {
    out.notes.push('/apply-template fetch failed: ' + e.message);
  }

  // ---- pretty report ----
  const tmpl = out.props && out.props.chat_template ? out.props.chat_template : '(unknown)';
  const looksMistral = /\[INST\]|\[SYSTEM_PROMPT\]|\[AVAILABLE_TOOLS\]/.test(tmpl) || (out.appliedPrompt && /\[INST\]/.test(out.appliedPrompt));
  const looksPipe    = /<\|user\|>|<\|assistant\|>|<\|system\|>/.test(tmpl) || (out.appliedPrompt && /<\|user\|>|<\|assistant\|>/.test(out.appliedPrompt));
  const looksChatML  = /<\|im_start\|>/.test(tmpl) || (out.appliedPrompt && /<\|im_start\|>/.test(out.appliedPrompt));
  let verdict = 'inconclusive — compare the applied framing below against what the model emits';
  if (looksMistral && !looksPipe && !looksChatML) verdict = 'server is applying MISTRAL [INST] framing';
  else if (looksChatML) verdict = 'server is applying CHATML <|im_start|> framing';
  else if (looksPipe)   verdict = 'server is applying <|role|> (Zephyr/Tulu-style) framing';

  console.log('%c=== gobboDiag ===', 'font-weight:bold');
  console.log('model:  ' + out.model + '   family(client): ' + out.family);
  console.log('stop strings sent: ' + JSON.stringify(out.stop));
  console.log('verdict: ' + verdict);
  if (out.props) {
    console.log('--- /props ---');
    console.log('bos=' + out.props.bos + '  eos=' + out.props.eos + '  n_ctx=' + out.props.n_ctx);
    console.log('chat_template (server-loaded):\n' + tmpl);
    if (out.props.chat_template_tool_use) console.log('chat_template_tool_use present (tools variant differs).');
  }
  if (out.appliedPrompt != null) {
    console.log('--- /apply-template (EXACT prompt fed to model) ---');
    console.log(out.appliedPrompt);
  }
  if (out.notes.length) console.log('notes: ' + out.notes.join(' | '));

  try {
    await navigator.clipboard.writeText(JSON.stringify(out, null, 2));
    console.log('(full report copied to clipboard)');
  } catch (_) { /* clipboard may be blocked over plain http — report is above */ }

  return out;
}
// Expose for console use and log a one-time hint.
if (typeof window !== 'undefined') {
  window.gobboDiag = gobboDiag;
}

/**
 * Tokenize banned phrases and build a logit_bias object for the API request.
 * Tries the llama.cpp /tokenize endpoint; if unavailable, skips silently.
 *
 * NOTE on capitalization: BPE/SentencePiece tokenizers encode case INSIDE
 * the token — `[ blue]` and `[ Blue]` are different IDs. An earlier version
 * of this function only generated lowercase variants, which silently let
 * the banned word through whenever it landed at the start of a sentence,
 * proper-noun position, after a quote, etc. We now generate 8 variants
 * per phrase: {lower, Title, UPPER, as-typed} x {no-space, leading-space}.
 *
 * CEILING (worth knowing): logit_bias only suppresses canonical token IDs.
 * The model can still emit the same surface string via a multi-token
 * decomposition (e.g. "blue" -> [bl][ue]). For a hard string-level ban,
 * use a GBNF grammar or a streaming post-filter — neither is wired up here.
 *
 * Returns { logit_bias: {"tokenId": strength, ...} } or {} if nothing to bias.
 */
async function buildLogitBias(card) {
  const raw = (card && card.bannedPhrases) ? card.bannedPhrases.trim() : '';
  if (!raw) return {};

  const phrases = raw.split('\n').map(p => p.trim()).filter(p => p.length > 0);
  if (phrases.length === 0) return {};

  const strength = (card.logitBiasStrength !== undefined) ? Number(card.logitBiasStrength) : -20;
  const logitBias = {};
  const tokenizeUrl = LLAMA_URL + '/tokenize';

  // Per-phrase debug record so the user can see exactly what got banned.
  // Keyed by phrase, value is { variants: [...], tokenIds: [...] }.
  const debugByPhrase = {};

  // Build full case-coverage variant set. Title-case fills the gap that
  // bit us before (capitalized at sentence start, dialogue, proper nouns).
  function caseVariants(phrase) {
    const lower = phrase.toLowerCase();
    const upper = phrase.toUpperCase();
    // Title-case the first character; leave the rest of the lowered form
    // as-is so multi-word phrases don't get mangled (we want "Blue sky",
    // not "Blue Sky", since the second word's banned token usually starts
    // with a space character anyway).
    const title = lower.length ? lower[0].toUpperCase() + lower.slice(1) : lower;
    const bases = [...new Set([phrase, lower, title, upper])];
    const out = [];
    for (const b of bases) {
      out.push(b);
      out.push(' ' + b);
    }
    return [...new Set(out)];
  }

  for (const phrase of phrases) {
    const variants = caseVariants(phrase);
    debugByPhrase[phrase] = { variants, tokenIds: [] };

    for (const variant of variants) {
      try {
        const resp = await privacyFetch(tokenizeUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: variant })
        });
        if (!resp.ok) continue;
        const data = await resp.json();
        if (data.tokens && Array.isArray(data.tokens)) {
          for (const id of data.tokens) {
            logitBias[String(id)] = strength;
            debugByPhrase[phrase].tokenIds.push(id);
          }
        }
      } catch (e) {
        // Tokenizer endpoint not available — skip gracefully
        console.warn('[logit_bias] /tokenize unavailable, skipping banned phrases:', e.message);
        return {}; // No point retrying every variant if the endpoint is down
      }
    }
  }

  const count = Object.keys(logitBias).length;
  if (count > 0) {
    console.log(`[logit_bias] Suppressing ${count} token IDs at strength ${strength} (${phrases.length} phrase(s))`);
    console.log('[logit_bias] Per-phrase breakdown:', debugByPhrase);
    return { logit_bias: logitBias };
  }
  return {};
}

function resetSamplerDefaults() {
  applySamplerPreset('precise');
}

/**
 * Apply one of three sampler presets to the card editor sliders.
 * Does NOT save — user still has to hit Save in the modal. This way
 * they can preview / tweak before committing.
 *
 *   precise  - factory defaults; deterministic, good for code & facts
 *   balanced - looser knobs; good general-purpose chat
 *   creative - high variety; XTC + DRY engaged; fiction & roleplay
 *
 * Designed against the observation that confident models (Gemma family
 * in particular) collapse to near-deterministic output under the tight
 * defaults. The Creative preset disables top_k and top_p, raises temp,
 * lowers min_p, swaps repeat_penalty for DRY, and turns on XTC.
 */
function applySamplerPreset(name) {
  const presets = {
    precise: {
      temperature: 0.7, minP: 0.05, topK: 40, topP: 0.95,
      repeatPenalty: 1.1, repeatLastN: 64,
      xtcProbability: 0, xtcThreshold: 0.1,
      dryMultiplier: 0
    },
    balanced: {
      temperature: 1.0, minP: 0.03, topK: 0, topP: 1.0,
      repeatPenalty: 1.05, repeatLastN: 64,
      xtcProbability: 0.3, xtcThreshold: 0.1,
      dryMultiplier: 0
    },
    creative: {
      temperature: 1.2, minP: 0.02, topK: 0, topP: 1.0,
      repeatPenalty: 1.0, repeatLastN: 64,
      xtcProbability: 0.5, xtcThreshold: 0.1,
      dryMultiplier: 0.8
    }
  };
  const p = presets[name] || presets.precise;

  const setSlider = (inputId, valId, value) => {
    const el = document.getElementById(inputId);
    if (el) el.value = value;
    const lbl = document.getElementById(valId);
    if (lbl) lbl.textContent = value;
  };

  setSlider('card-temperature',     'card-temp-val',          p.temperature);
  setSlider('card-min-p',           'card-minp-val',          p.minP);
  setSlider('card-top-p',           'card-topp-val',          p.topP);
  setSlider('card-repeat-penalty',  'card-rep-val',           p.repeatPenalty);
  setSlider('card-xtc-prob',        'card-xtc-prob-val',      p.xtcProbability);
  setSlider('card-xtc-threshold',   'card-xtc-threshold-val', p.xtcThreshold);
  setSlider('card-dry-mult',        'card-dry-mult-val',      p.dryMultiplier);
  // top-k and repeat-last-n are number inputs with no separate label
  const tk = document.getElementById('card-top-k');           if (tk) tk.value = p.topK;
  const rn = document.getElementById('card-repeat-last-n');   if (rn) rn.value = p.repeatLastN;
}

