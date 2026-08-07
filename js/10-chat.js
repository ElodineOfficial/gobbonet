/* @gobbonet-split js/10-chat.js
   Moved verbatim from chat.html lines 6877-7848.
   streaming, watchdog, edit/delete/reroll, job resume
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   CHAT / STREAMING
================================================================ */
async function sendMessage(overrideContent) {
  const input = document.getElementById('msg-input');
  // overrideContent is passed by the auto-continue chain to fire a
  // programmatic send. When set, we ignore the input field entirely
  // (the user might be mid-draft — don't clobber their work).
  const isProgrammatic = overrideContent !== undefined;
  const content = isProgrammatic ? overrideContent : input.value.trim();
  const hasAttachments = !isProgrammatic && _pendingAttachments.length > 0;
  if ((!content && !hasAttachments) || isGenerating) return;

  // Manual send while a chain is mid-countdown → user is taking back
  // control. Drop the chain before proceeding with their message.
  if (!isProgrammatic && autoContinue) {
    cancelAutoContinue('user sent manually');
  }

  // Clear any stale lore-compression marker from the previous turn. If
  // compression fires again this turn, buildContextMessages will set it
  // again; if not, it stays cleared and no banner renders.
  pendingLoreCompressionNote = null;

  let thread = getActiveThread();
  if (!thread) {
    createThread();
    thread = getActiveThread();
  }

  // A detached job from before a reload may still be attached-or-pending on
  // this thread (resumePendingJobs handles it moments after boot). Starting
  // a fresh generation now would orphan that reply mid-flight.
  if (thread.pendingJob && (!currentJob || currentJob.id !== thread.pendingJob.id)) {
    showModelSwitchToast('A reply is still generating in this thread — reattaching…', 'info', 3500);
    resumePendingJobs();
    return;
  }

  // Detect {{auto_continue_N}} on manual sends only. The chain itself fires
  // {{auto_continue}} (no number) so it can never recursively re-trigger
  // here even though it routes through the same function.
  let workingContent = content;
  if (!isProgrammatic) {
    const ac = detectAutoContinueMacro(content);
    if (ac) {
      workingContent = ac.normalizedContent;
      startAutoContinueChain(thread.id, ac.count);
      console.log(`[auto-continue] chain started: ${ac.count} total posts`);
    }
  }

  // Pre-resolve time-sensitive macros at send time so history stays accurate
  // let, not const: the card-code 'send' hook below may rewrite this.
  let storedContent = workingContent.replace(/\{\{current_DAT\}\}/gi, getCurrentDateTimeString());

  // Pull staged attachments into an embed (text files → model context) plus
  // lightweight metadata (for display chips). Done once, here, then cleared.
  const { embed: attachmentText, meta: attachmentMeta } = isProgrammatic
    ? { embed: '', meta: [] }
    : consumeAttachmentsForSend();

  // Auto-name the thread from the user's first message. Counted by
  // user messages rather than total length so a pre-injected greeting
  // (which lives at messages[0] as an assistant turn) doesn't suppress
  // the rename — without this check, threads with a greeting stay
  // stuck on "New Thread" forever because length is already 1 by the
  // time the user types anything.
  const hasPriorUserMsg = thread.messages.some(m => m.role === 'user');
  if (!hasPriorUserMsg) {
    const nameSrc = storedContent || (attachmentMeta[0] && attachmentMeta[0].name) || 'New Thread';
    thread.name = nameSrc.slice(0, 50) + (nameSrc.length > 50 ? '...' : '');
  }

  // Card code gets first look at the outgoing text. A 'send' hook that
  // returns a string replaces it; anything else leaves it alone. Wrapped
  // so a broken card cannot stop you sending a message.
  try {
    storedContent = transformViaCardHook('send', storedContent,
                                         { card: getActiveCard(), thread: thread });
  } catch (e) { console.error('[card-code] send hook:', e); }

  const userMessage = { role: 'user', content: storedContent, timestamp: Date.now() };
  if (attachmentText) userMessage.attachmentText = attachmentText;
  if (attachmentMeta.length) userMessage.attachments = attachmentMeta;
  thread.messages.push(userMessage);
  // Fresh activity floats this thread to the top of the list, alongside the
  // new threads and forks that already land there — so the threads you're
  // actively working in stay reachable without pinning. No-op if it's already
  // first (e.g. a brand-new thread, or one you just messaged).
  bumpThreadToTop(thread.id);
  saveState();
  if (!isProgrammatic) {
    input.value = '';
    input.style.height = 'auto';
    clearAttachments();
  }
  render();
  scrollToBottom();

  const card = getActiveCard();

  // Web search — runs BEFORE context building so results are saved on the message
  // and included in context/lore automatically. Skipped on programmatic
  // auto-continue sends; the chain prompt isn't a real query and would just
  // waste an API call (and confuse the proxy with prompt-shaped junk).
  const userMsg = thread.messages[thread.messages.length - 1];
  if (searchEnabled && !isProgrammatic) {
    if (!state.settings.apiKey) {
      renderSearchIndicator('search ON but no API key set — go to CONFIG');
    } else {
      renderSearchIndicator('searching...');
      console.log('[search] Search triggered, calling webSearch...');
      const searchResults = await webSearch(content);
      if (searchResults && searchResults.length > 0) {
        const formatted = formatSearchResults(searchResults);
        userMsg.searchData = formatted;
        saveState();
        renderSearchIndicator(`found ${searchResults.length} results — saved to message`);
        console.log('[search] Results saved to user message');
      } else {
        renderSearchIndicator('search returned no results — open F12 console for details');
        console.warn('[search] webSearch returned null/empty');
      }
    }
  }

  // Build token-aware context with lore (now includes any searchData on messages)
  const { apiMessages, tokensUsed, budget } = await buildContextMessages(thread, card);

  isGenerating = true;
  updateInputState();
  renderAutoContinueIndicator();   // flip indicator to "generating post N…"

  // genStartedAt is persisted (unlike genMs it's temporary): if the tab
  // reloads mid-generation, the resume path can keep the clock honest.
  const assistantMsg = { role: 'assistant', content: '', timestamp: Date.now(), genStartedAt: Date.now() };
  thread.messages.push(assistantMsg);
  renderMessages();
  scrollToBottom();
  // New stream → follow it, and clear any stale FAB left over from a
  // previous turn the user had scrolled away from.
  scrollPinnedToBottom = true;
  updateFollowButton();

  abortController = new AbortController();
  _cotCulledFlag = false;
  startCotWatchdog();
  startGenTimerTicker();

  // Tracks whether the generation completed normally vs aborted/errored.
  // Used by the auto-continue chain hook below to decide whether to fire
  // the next post or halt the chain.
  let sendErrored = false;

  const logitBiasParams = await buildLogitBias(card);
  const _stopParams = getStopStrings();
  console.log('[gen] family=' + ((activeModel && activeModel.family) || 'unknown') +
              ' stop=' + JSON.stringify(_stopParams.stop || []) +
              '  (run gobboDiag() to dump the exact prompt the model receives)');
  const requestBody = { model: 'local', messages: apiMessages, stream: true, max_tokens: -1, ...getCardSamplerParams(card), ..._stopParams, ...logitBiasParams };

  // Transport + token parsing live in runGenerationStream: a detached
  // server-side job when the fileserver supports it (the reply survives
  // navigating away — see the DETACHED GENERATION JOBS block), else the
  // legacy in-page stream.
  const outcome = await runGenerationStream(thread, assistantMsg, requestBody);
  // A smart-limit cut arrives as an abort (we cancel the stream ourselves),
  // but it's a *successful* turn — don't let it halt an auto-continue chain.
  sendErrored = outcome.errored || (outcome.aborted && !assistantMsg.smartCapped);

  if (!assistantMsg.content && !assistantMsg.reasoning && !outcome.errored) {
    console.warn('[stream] Response completed but no content extracted.');
  }

  // Flush parser state and scrub format-specific markers, THEN stamp any
  // abort/error note so it lands after the final scrubbed text. (The old
  // send path skipped finalize entirely on abort, silently dropping any
  // pending parser tail — regenerateFromThread always finalized; this now
  // matches the correct behavior everywhere.)
  finalizeStreamMessage(assistantMsg);

  // Card code sees the finished reply, after the format parsers have run
  // and scrubbed their markers, so a hook edits prose rather than
  // half-parsed thinking tags.
  try {
    const _edited = transformViaCardHook('reply', assistantMsg.content || '',
                                         { card: getActiveCard(), thread: thread });
    if (_edited !== assistantMsg.content) assistantMsg.content = _edited;
  } catch (e) { console.error('[card-code] reply hook:', e); }

  applyGenerationOutcome(assistantMsg, outcome, 'diagnostic');

  // Response timer: stamp how long this generation took. The client was
  // attached for the whole turn, so local wall-clock (ms precision) is
  // exact here — server job stamps only matter on the resume path.
  assistantMsg.genMs = Math.max(0, Date.now() - (assistantMsg.genStartedAt || assistantMsg.timestamp));
  delete assistantMsg.genStartedAt;
  console.log('[gen-timer] response took ' + formatGenTime(assistantMsg.genMs));

  // Diagnostic logging
  console.log('[stream] === STREAM COMPLETE ===');
  console.log('[stream] Transport:', outcome.jobMode ? 'detached job' : 'direct stream');
  console.log('[stream] Format:', normalizeThinkingFormat(activeModel && activeModel.thinkingFormat));
  console.log('[stream] Reasoning chars:', (assistantMsg.reasoning || '').length);
  console.log('[stream] Content chars:', (assistantMsg.content || '').length);
  if (assistantMsg.reasoning && !assistantMsg.content) {
    console.log('[stream] Last 500 chars of reasoning:', JSON.stringify((assistantMsg.reasoning || '').slice(-500)));
  }

  clearCotWatchdog();
  stopGenTimerTicker();
  isGenerating = false;
  abortController = null;
  saveState();
  // The turn has settled (content is final, even on abort/error). Push to the
  // server backup NOW instead of waiting out the 2s debounce — if the user
  // navigates away inside that window the completed reply would otherwise
  // never reach /state and a later restore from a cleared origin would blank
  // it. flushStateSync is a no-op if the state is still transient.
  forceServerFlush();
  // Capture follow intent BEFORE the rebuild below — renderMessages() resets
  // scrollTop to 0 and the resulting scroll event clears scrollPinnedToBottom
  // a frame before any pin-aware scroll could run, which would otherwise leave
  // the finished reply stranded a few messages up instead of at the bottom.
  const wasFollowing = scrollPinnedToBottom;
  updateInputState();
  if (thread.id === state.activeThreadId) {
    renderMessages();
    // Land at the settled bottom if the user was still following when the stream
    // ended; if they touched/scrolled away mid-stream we leave them where they're
    // reading. The forced scroll inside settleScrollAfterGeneration overrides the
    // transient pin-flip the rebuild just caused. (updateInputState above already
    // refreshed the FAB so it stays offered in the unfollowed case.)
    settleScrollAfterGeneration(wasFollowing);
  } else {
    // The user wandered to another thread while this one finished (now
    // possible: generations keep running when you look away). Refresh the
    // sidebar preview; the settled reply is waiting when they return.
    renderSidebar();
  }
  updateContextInfo();

  // Advance the auto-continue chain if one is active. Errors (including
  // user-initiated aborts) kill the chain — there's no good reason to
  // keep feeding messages into a broken server, and if the user hit Stop
  // they almost certainly want the whole thing to halt, not just the
  // current generation.
  if (sendErrored) {
    if (autoContinue) cancelAutoContinue('generation errored or aborted');
  } else {
    maybeContinueChain();
  }
}

function stopGeneration(opts = {}) {
  // User explicitly stopped — kill any auto-continue chain too. The abort
  // will trigger the chain-halt path in sendMessage's catch handler, but
  // we cancel here proactively so the indicator hides immediately and
  // tells the user the whole sequence is dead, not just the current gen.
  // (keepChain is set by the smart token limit: trimming one reply is
  // normal operation, and the chain should carry on to the next post.)
  if (autoContinue && !opts.keepChain) cancelAutoContinue('user stopped generation');
  // Detached job: ask the server to abort its upstream call. llama-server
  // frees the slot, the worker marks the job 'cancelled', and the poll loop
  // observes the terminal state (usually within ~300ms).
  if (currentJob && !currentJob.cancelSent) {
    currentJob.cancelSent = true;
    // Tiny JSON body: some HTTP stacks 411 a bodyless POST; '{}' is universal.
    privacyFetch(`${JOBS_URL}/${currentJob.id}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
  }
  // Legacy direct stream: same in-page abort as before.
  if (abortController) abortController.abort();
}

/* ================================================================
   COT INFINITE RUNTIME WATCHDOG
   If cotTimeoutEnabled, sets a timer at generation start.
   If the stream is still running when the timer fires, it aborts
   with a distinct note so the user knows it was auto-culled.
================================================================ */
let _cotWatchdogId = null;

function startCotWatchdog() {
  clearCotWatchdog();
  if (!state.settings.cotTimeoutEnabled) return;
  const mins = Math.max(1, parseInt(state.settings.cotTimeoutMinutes) || 2);
  console.log(`[cot-watchdog] Armed — will auto-stop after ${mins} min`);
  _cotWatchdogId = setTimeout(() => {
    if (isGenerating) {
      console.warn('[cot-watchdog] Runtime limit reached — stopping generation');
      _cotWatchdogId = null;
      // Tag the stop so applyGenerationOutcome can append the timeout-specific
      // note. Routed through stopGeneration so BOTH transports (detached job
      // cancel + direct-stream abort) honor the cull.
      _cotCulledFlag = true;
      stopGeneration();
    }
  }, mins * 60 * 1000);
}

function clearCotWatchdog() {
  if (_cotWatchdogId !== null) {
    clearTimeout(_cotWatchdogId);
    _cotWatchdogId = null;
  }
}

function updateCotTimeoutRow() {
  const enabled = document.getElementById('set-cot-timeout-enabled').checked;
  const wrap = document.getElementById('cot-timeout-timer-wrap');
  if (wrap) {
    wrap.style.opacity = enabled ? '1' : '0.35';
    wrap.style.pointerEvents = enabled ? '' : 'none';
  }
}

function updateSmartLimitRow() {
  const enabled = document.getElementById('set-smart-limit-enabled').checked;
  const wrap = document.getElementById('smart-limit-tokens-wrap');
  if (wrap) {
    wrap.style.opacity = enabled ? '1' : '0.35';
    wrap.style.pointerEvents = enabled ? '' : 'none';
  }
}

/* ================================================================
   EDIT / DELETE / REROLL
================================================================ */
function editMessage(index) {
  state.editingIndex = index;
  renderMessages();
  const area = document.getElementById('edit-area');
  if (area) { area.focus(); area.selectionStart = area.value.length; }
}

function cancelEdit() {
  state.editingIndex = null;
  renderMessages();
}

function saveEdit(index) {
  const area = document.getElementById('edit-area');
  if (!area) return;
  const newContent = area.value.trim();
  if (!newContent) return;
  const thread = getActiveThread();
  if (!thread) return;

  const msg = thread.messages[index];

  if (msg.role === 'user') {
    // Capture the prior wording as a variant BEFORE we overwrite anything,
    // so the user can flip back to it via the ◀ ▶ navigator. Symmetric
    // with rerollMessage() on the assistant side: every edit is preserved.
    //
    // CRUCIAL: a user edit truncates and regenerates everything below this
    // message. That downstream subtree — this message's AI reply and every
    // reroll / turn that followed it — belongs to the wording being edited
    // AWAY from. Snapshot it here, BEFORE the truncation, and park it on
    // that wording's variant as its `continuation`. Flipping the navigator
    // back to that wording restores the whole branch, AI rerolls and all,
    // instead of finding it deleted. (This is the fix for "editing loses
    // the unique AI rerolls": each wording now owns its own conversation
    // tree rather than sharing one destructible tail.)
    const priorDownstream = thread.messages.slice(index + 1);

    // First-time edit on a plain user message: promote the existing content
    // (plus any search results / attachments that belonged to that wording)
    // into variant 0, and hand it the downstream generated under it.
    // Subsequent edits: sync whatever's currently visible into the active
    // slot first (covers the case where the user flipped to an older wording
    // and THEN hit Edit — we'd otherwise drop the flipped-to wording), then
    // re-park the current downstream on that active variant.
    if (!Array.isArray(msg.variants) || msg.variants.length === 0) {
      msg.variants = [{
        content:        msg.content || '',
        timestamp:      msg.timestamp || Date.now(),
        searchData:     msg.searchData,
        attachmentText: msg.attachmentText,
        attachments:    msg.attachments,
        continuation:   priorDownstream
      }];
      msg.activeVariant = 0;
    } else {
      syncActiveVariant(msg);
      const activeIdx = msg.activeVariant ?? 0;
      if (msg.variants[activeIdx]) msg.variants[activeIdx].continuation = priorDownstream;
    }

    // Append the new wording as a fresh variant and switch to it. Its branch
    // starts empty (continuation: []) and is generated below; it gets parked
    // automatically the first time the user flips away from it.
    // Search results and attachments don't carry forward — they belong to
    // the prior wording. If search is enabled and applies to the new wording,
    // the regenerate cycle below will populate searchData on the active
    // message via sendMessage's search step path. (We use the same {} shape
    // the assistant reroll path uses so applyVariantToMessage's
    // delete-when-absent branches fire and the top-level msg drops the stale
    // fields cleanly.)
    msg.variants.push({
      content:      newContent,
      timestamp:    Date.now(),
      continuation: []
    });
    msg.activeVariant = msg.variants.length - 1;
    applyVariantToMessage(msg);

    // Truncate to the edited message (the prior branch is now safely parked
    // on its variant, not lost) and regenerate the new branch.
    thread.messages = thread.messages.slice(0, index + 1);
    state.editingIndex = null;
    saveState();
    renderMessages();
    scrollToBottom();
    regenerateFromThread();
  } else {
    // AI edit: save in place, no regeneration.
    // If this message tracks reroll variants, mirror the edit into
    // the active variant so flipping away and back doesn't revert.
    msg.content = newContent;
    if (Array.isArray(msg.variants)) {
      syncActiveVariant(msg);
    }
    state.editingIndex = null;
    saveState();
    renderMessages();
    scrollToBottom();
  }
}

function deleteMessage(index) {
  const thread = getActiveThread();
  if (!thread) return;
  thread.messages.splice(index, 1);
  saveState();
  renderMessages();
  updateContextInfo();
}

/* ----------------------------------------------------------------
   VARIANTS (in-thread alternative history)

   Both directions of the conversation use the same variant
   machinery, with different triggers:

     ASSISTANT — every Reroll keeps the prior generation as a
     flippable variant on the same message. A good response three
     rerolls back isn't gone, it's just a click away.

     USER — every Edit keeps the prior wording as a flippable
     variant on the same message. Lets you thumb through different
     phrasings without losing them.

   In both cases the ◀ ▶ navigator shows the variants for that
   message. Flipping an ASSISTANT variant is local — it re-selects a
   reroll of that one message and leaves the rest of the conversation
   alone. Flipping a USER variant swaps the whole branch beneath it
   (see `continuation` below): each wording carries its own downstream.
   For "what would the conversation look like if I'd taken a
   different path here?" use Branch — that's the heavier sibling-
   thread tool. Variants are the cheap in-place history.

   Data shape (all fields optional; absent = legacy single-variant):
     msg.variants     = [ {content, reasoning, searchData,
                           attachmentText, attachments, timestamp,
                           continuation}, ... ]
     msg.activeVariant = index into variants

   continuation (USER variants only) is the downstream subtree that
   followed that wording — the array of messages after this one, each
   carrying its own variants / rerolls. It's how a user edit keeps,
   rather than destroys, the AI replies that belonged to the prior
   wording: editing parks the live downstream on the wording being
   left and starts the new wording on a fresh branch; flipping the
   navigator swaps between whole branches. Assistant variants share a
   single downstream and omit it. Messages sitting in a parked
   continuation are NOT in thread.messages, so they don't count toward
   context or tokens until that branch is restored.

   Fields are stored per-variant whether or not they apply to the
   role — reasoning/searchData are typically assistant-side,
   attachmentText/attachments are user-side, but storing all of
   them uniformly keeps sync/apply role-agnostic.

   The top-level msg.* fields always MIRROR the active variant.
   That's deliberate: every other piece of code in this app
   (context builder, token estimator, lore summariser, copy/edit/
   delete, search-results renderer) reads m.content directly.
   Mirroring means none of them needs to learn what a variant is —
   the active one IS the message, from their point of view.
   Variants are an additive layer.

   Flipping a USER variant restores that wording's parked branch (its
   continuation) into thread.messages: msg.content becomes the
   flipped-to wording AND the downstream below it becomes the AI
   replies / rerolls that were generated under that wording. Nothing
   regenerates and no tokens are spent — a flip just re-selects an
   already-built branch — so ◀ ▶ stays cheap and non-destructive while
   no longer losing the tree. To start a NEW branch from a prior
   wording, flip to it and Edit (which forks a fresh continuation off
   that wording) or Reroll the AI reply below. Legacy user variants
   saved before branches were tracked carry no continuation: the active
   branch is captured the first time you flip away from it, and
   wordings whose branches predate this feature (discarded by the old
   edit path) restore empty until regenerated — no NEW loss, just the
   honest state of data the previous code had already dropped.
---------------------------------------------------------------- */

/** Copy the message's current visible fields into the active variant slot. */
function syncActiveVariant(msg) {
  if (!msg || !Array.isArray(msg.variants)) return;
  const idx = msg.activeVariant;
  if (idx == null || idx < 0 || idx >= msg.variants.length) return;
  const v = msg.variants[idx];
  v.content   = msg.content   || '';
  v.reasoning = msg.reasoning || '';
  // Optional fields — store as-is (including undefined) so a variant that
  // had no search results / no attachments doesn't inherit a stale set
  // from whatever was on the message a moment ago. searchData applies to
  // both roles (user messages get it from the web-search step in
  // sendMessage; assistant messages don't currently use it but the field
  // is reserved). attachmentText / attachments are user-only in practice.
  v.searchData     = msg.searchData;
  v.attachmentText = msg.attachmentText;
  v.attachments    = msg.attachments;
  v.genMs          = msg.genMs;        // response-timer readout, per variant
  v.smartCapped    = msg.smartCapped;  // smart-limit ✂ marker, per variant
  v.timestamp  = msg.timestamp || v.timestamp || Date.now();
}

/** Mirror the active variant's fields back onto the top-level message. */
function applyVariantToMessage(msg) {
  if (!msg || !Array.isArray(msg.variants)) return;
  const idx = msg.activeVariant;
  if (idx == null || idx < 0 || idx >= msg.variants.length) return;
  const v = msg.variants[idx];
  msg.content   = v.content   || '';
  msg.reasoning = v.reasoning || '';
  if (v.searchData !== undefined && v.searchData !== null) {
    msg.searchData = v.searchData;
  } else {
    delete msg.searchData;
  }
  // Same delete-when-absent pattern for user-side fields, so flipping
  // back to a variant that didn't have attachments doesn't surface a
  // stale chip row from the next variant over.
  if (v.attachmentText !== undefined && v.attachmentText !== null) {
    msg.attachmentText = v.attachmentText;
  } else {
    delete msg.attachmentText;
  }
  if (Array.isArray(v.attachments)) {
    msg.attachments = v.attachments;
  } else {
    delete msg.attachments;
  }
  // Per-generation metadata: each variant owns its own timer readout and
  // smart-limit marker — same delete-when-absent pattern so a variant
  // generated before these features (or never capped) doesn't inherit a
  // stale badge from the variant the user just flipped away from.
  if (typeof v.genMs === 'number') {
    msg.genMs = v.genMs;
  } else {
    delete msg.genMs;
  }
  if (v.smartCapped) {
    msg.smartCapped = v.smartCapped;
  } else {
    delete msg.smartCapped;
  }
  if (v.timestamp) msg.timestamp = v.timestamp;
}

/**
 * Flip the displayed variant on a message (user or assistant).
 * delta is -1 (previous) or +1 (next). No-op if the move would
 * go out of bounds, if the message has fewer than 2 variants,
 * or if a generation is currently in flight (don't yank the rug
 * out from under streaming).
 */
function switchVariant(messageIndex, delta) {
  const thread = getActiveThread();
  if (!thread || isGenerating) return;
  const msg = thread.messages[messageIndex];
  if (!msg) return;
  if (!Array.isArray(msg.variants) || msg.variants.length < 2) return;

  const cur = msg.activeVariant ?? 0;
  const next = cur + delta;
  if (next < 0 || next >= msg.variants.length) return;

  // Capture any in-place edits the user made to the currently selected
  // variant's own fields before we swap away from it.
  syncActiveVariant(msg);

  // For USER messages, each variant owns the downstream subtree that
  // followed that wording — its AI reply plus every reroll / turn after it.
  // Park the live downstream on the variant we're leaving, then restore the
  // downstream belonging to the variant we're moving to, so the ◀ ▶
  // navigator swaps the WHOLE branch. No regeneration and no token burn —
  // we're just re-selecting an already-generated tree — and, crucially, the
  // AI rerolls that belong to each wording are never lost. Assistant
  // variants are rerolls of a single message and share one downstream, so
  // they carry no continuation and this whole block is skipped for them.
  if (msg.role === 'user') {
    msg.variants[cur].continuation = thread.messages.slice(messageIndex + 1);
  }

  msg.activeVariant = next;
  applyVariantToMessage(msg);

  if (msg.role === 'user') {
    const restored = Array.isArray(msg.variants[next].continuation)
      ? msg.variants[next].continuation
      : [];
    thread.messages = thread.messages.slice(0, messageIndex + 1).concat(restored);
  }

  saveState();
  renderMessages();
  // Don't scroll — the user is reading variants, not chasing the bottom.
}

function rerollMessage() {
  const thread = getActiveThread();
  if (!thread || isGenerating) return;
  if (thread.pendingJob) {   // unresolved detached job — let resume handle it first
    showModelSwitchToast('A reply is still generating in this thread — reattaching…', 'info', 3500);
    resumePendingJobs();
    return;
  }
  const lastIdx = thread.messages.length - 1;
  const msg = thread.messages[lastIdx];
  if (!msg || msg.role !== 'assistant') return;

  // Lazy-init: if this is the first reroll on a plain message,
  // promote its current content to variant 0 so it isn't lost.
  if (!Array.isArray(msg.variants) || msg.variants.length === 0) {
    msg.variants = [{
      content:    msg.content    || '',
      reasoning:  msg.reasoning  || '',
      searchData: msg.searchData,
      genMs:      msg.genMs,
      smartCapped: msg.smartCapped,
      timestamp:  msg.timestamp  || Date.now()
    }];
    msg.activeVariant = 0;
  } else {
    // Already has variants — make sure whatever's on screen right
    // now (could be a different variant the user flipped to) is
    // captured before we move past it.
    syncActiveVariant(msg);
  }

  // Append a fresh empty variant and switch to it. Streaming will
  // fill content/reasoning on the top-level message; on completion
  // we sync those into this new slot.
  msg.variants.push({
    content: '',
    reasoning: '',
    searchData: undefined,
    timestamp: Date.now()
  });
  msg.activeVariant = msg.variants.length - 1;

  // Clear the mirrored fields so the renderer shows a typing
  // indicator instead of the previous variant's text bleeding
  // into the new generation. genMs/smartCapped belong to the OLD
  // variant (already captured above); smartCapped in particular
  // gates the stream feeder and must not leak into the new one.
  msg.content = '';
  msg.reasoning = '';
  delete msg.searchData;
  delete msg.genMs;
  delete msg.smartCapped;
  delete msg._smartLimitAt;
  msg.timestamp = Date.now();

  saveState();
  renderMessages();
  scrollToBottom();
  regenerateFromThread({ rerollIntoLastMessage: true });
}

async function regenerateFromThread(options = {}) {
  const thread = getActiveThread();
  if (!thread || isGenerating) return;
  if (thread.pendingJob && (!currentJob || currentJob.id !== thread.pendingJob.id)) {
    showModelSwitchToast('A reply is still generating in this thread — reattaching…', 'info', 3500);
    resumePendingJobs();
    return;
  }

  // Same reset as sendMessage — fresh turn starts without a stale marker.
  pendingLoreCompressionNote = null;

  const card = getActiveCard();

  // Optional web search — used by scheduler
  // Results saved on the user message so they persist in context/lore
  if (options.withSearch && state.settings.apiKey) {
    const lastUserMsg = [...thread.messages].reverse().find(m => m.role === 'user');
    if (lastUserMsg && !lastUserMsg.searchData) {
      const results = await webSearch(lastUserMsg.content);
      if (results && results.length > 0) {
        lastUserMsg.searchData = formatSearchResults(results);
        saveState();
        console.log(`[sched] Saved ${results.length} search results to message`);
      }
    }
  }

  const { apiMessages } = await buildContextMessages(thread, card);

  isGenerating = true;
  updateInputState();

  // When invoked by rerollMessage(), the last assistant message has
  // already been prepped (active variant slot is empty, content
  // cleared) — stream INTO it rather than pushing a fresh one, so
  // the variants array stays attached to a single message instead
  // of getting split across two.
  let assistantMsg;
  if (options.rerollIntoLastMessage &&
      thread.messages.length > 0 &&
      thread.messages[thread.messages.length - 1].role === 'assistant') {
    assistantMsg = thread.messages[thread.messages.length - 1];
    // Defensive reset — rerollMessage() should have already done
    // this, but if some other call path ever flips the flag we
    // don't want stale text bleeding into the stream. smartCapped
    // MUST be cleared here: it gates the feeder, and a stale flag
    // from the previous variant would freeze the new stream.
    assistantMsg.content = '';
    assistantMsg.reasoning = '';
    delete assistantMsg.searchData;
    delete assistantMsg.smartCapped;
    delete assistantMsg._smartLimitAt;
    delete assistantMsg.genMs;
    assistantMsg.timestamp = Date.now();
  } else {
    assistantMsg = { role: 'assistant', content: '', timestamp: Date.now() };
    thread.messages.push(assistantMsg);
  }
  assistantMsg.genStartedAt = Date.now();   // response timer starts now (persisted — see sendMessage)
  renderMessages();
  scrollToBottom();
  // New stream → follow it (mirrors sendMessage).
  scrollPinnedToBottom = true;
  updateFollowButton();

  abortController = new AbortController();
  _cotCulledFlag = false;
  startCotWatchdog();
  startGenTimerTicker();

  const logitBiasParams = await buildLogitBias(card);
  const _stopParams = getStopStrings();
  console.log('[gen] family=' + ((activeModel && activeModel.family) || 'unknown') +
              ' stop=' + JSON.stringify(_stopParams.stop || []) +
              '  (run gobboDiag() to dump the exact prompt the model receives)');
  const requestBody = { model: 'local', messages: apiMessages, stream: true, max_tokens: -1, ...getCardSamplerParams(card), ..._stopParams, ...logitBiasParams };

  // Shared transport: detached server-side job when available (survives
  // navigation), legacy direct stream otherwise. See sendMessage.
  const outcome = await runGenerationStream(thread, assistantMsg, requestBody);

  // Flush parser state and scrub any format-specific stray markers, then
  // stamp the abort/error note so it lands after the scrubbed text.
  finalizeStreamMessage(assistantMsg);
  applyGenerationOutcome(assistantMsg, outcome, 'plain');

  // Response timer (before the variant sync so the slot captures it).
  assistantMsg.genMs = Math.max(0, Date.now() - (assistantMsg.genStartedAt || assistantMsg.timestamp));
  delete assistantMsg.genStartedAt;
  console.log('[gen-timer] response took ' + formatGenTime(assistantMsg.genMs));

  // If this message has a variants array (i.e. the user has rerolled
  // it at least once), persist the just-streamed content into the
  // currently active variant slot so flipping back to it later shows
  // exactly what was generated — including any error/abort suffixes.
  if (Array.isArray(assistantMsg.variants)) {
    syncActiveVariant(assistantMsg);
  }

  clearCotWatchdog();
  stopGenTimerTicker();
  isGenerating = false;
  abortController = null;
  saveState();
  forceServerFlush();   // collapse the debounce — see sendMessage for rationale
  const wasFollowing = scrollPinnedToBottom;   // capture before the rebuild clobbers the pin
  updateInputState();
  if (thread.id === state.activeThreadId) {
    renderMessages();
    settleScrollAfterGeneration(wasFollowing);   // pin-aware end-of-stream scroll (see sendMessage)
  } else {
    renderSidebar();   // finished off-screen — refresh the preview, leave the view alone
  }
  updateContextInfo();
}

/* ================================================================
   JOB RESUME — pick generations back up after navigation

   Every thread that started a detached job carries a persisted
   `pendingJob` breadcrumb. On boot we follow each one:

     · terminal (done/cancelled/error) → replay the server's SSE
       transcript from byte 0 through the normal parser and fold the
       finished reply into history. Silent, in the background — by
       the time you open the thread, the reply is just... there.
     · still running → re-attach live: the streaming UI, Stop button,
       and watchdog all come back exactly as if you'd never left.
     · vanished (server restarted + swept) → keep whatever partial
       text the periodic saves captured and stamp an honest note.

   Replays are deterministic because the transcript is byte-stable
   and the parser is a pure function of the byte sequence: resuming
   produces character-for-character what live streaming would have.
================================================================ */

/**
 * Fold one job (any state) into its thread. `live` = attach with the full
 * generating UI (isGenerating, watchdog, Stop); otherwise it's a quiet
 * background replay of an already-terminal job.
 */
async function finalizeJobIntoThread(thread, jobId, { live = false } = {}) {
  // Locate the reply message this job was streaming into; recreate it if
  // the breadcrumb outlived the message (e.g. deleted mid-flight).
  let msg = thread.messages.find(m => m.jobId === jobId);
  if (!msg) {
    const last = thread.messages[thread.messages.length - 1];
    if (last && last.role === 'assistant') msg = last;
  }
  if (!msg) {
    msg = { role: 'assistant', content: '', timestamp: Date.now() };
    thread.messages.push(msg);
  }
  msg.jobId = jobId;

  // Clean slate for the replay — the transcript is the source of truth and
  // strictly supersedes any partial text the 2.5s ticker saved. That
  // includes the smart-limit cut marker: it gates the feeder, and the
  // replay re-derives it (deterministically) from the same byte stream.
  msg.content = '';
  msg.reasoning = '';
  delete msg._parseState;
  delete msg.smartCapped;
  delete msg._smartLimitAt;
  delete msg.genMs;
  // Response timer: keep the clock that started before the reload. The
  // message's own persisted stamp is best; the pendingJob breadcrumb is
  // the fallback (both are client wall-clock ms from the original send).
  if (!msg.genStartedAt && thread.pendingJob && thread.pendingJob.startedAt) {
    msg.genStartedAt = thread.pendingJob.startedAt;
  }

  if (live) {
    isGenerating = true;
    abortController = new AbortController();
    _cotCulledFlag = false;
    startCotWatchdog();
    startGenTimerTicker();
    updateInputState();
    if (thread.id === state.activeThreadId) renderMessages();
  }

  const outcome = await runGenerationStream(thread, msg, null, { resumeJobId: jobId });
  finalizeStreamMessage(msg);
  applyGenerationOutcome(msg, outcome, 'plain');

  // Response timer. The server's own stamps are the honest answer here:
  // for a background replay the reply finished at some point while the tab
  // was closed, so client wall-clock would count the whole absence. Only
  // fall back to wall-clock on a LIVE re-attach (clock ran through the
  // reload, same machine) when an older fileserver omits the stamps.
  if (typeof outcome.startedAt === 'number' && typeof outcome.updatedAt === 'number' &&
      outcome.updatedAt >= outcome.startedAt) {
    msg.genMs = (outcome.updatedAt - outcome.startedAt) * 1000;
  } else if (live && msg.genStartedAt) {
    msg.genMs = Math.max(0, Date.now() - msg.genStartedAt);
  }
  delete msg.genStartedAt;
  if (typeof msg.genMs === 'number') console.log('[gen-timer] response took ' + formatGenTime(msg.genMs));

  if (Array.isArray(msg.variants)) syncActiveVariant(msg);

  if (live) {
    clearCotWatchdog();
    stopGenTimerTicker();
    isGenerating = false;
    abortController = null;
  }

  saveState();
  forceServerFlush();
  updateInputState();
  if (thread.id === state.activeThreadId) {
    renderMessages();
    settleScrollAfterGeneration(scrollPinnedToBottom);
  } else {
    renderSidebar();
  }
  updateContextInfo();
  return outcome;
}

// One cheap status peek (no transcript bytes). null = couldn't reach server.
async function _peekJob(jobId) {
  try {
    const r = await privacyFetch(`${JOBS_URL}/${jobId}?from=0&max=0`, { cache: 'no-store' });
    if (r.status === 404) return { status: 'lost' };
    if (!r.ok) return null;
    return await r.json();
  } catch (_) { return null; }
}

// One resume pass at a time. Wake events (visibility / pageshow / focus /
// online) burst on app return, and the boot pass may still be mid-flight —
// two concurrent passes would replay the same transcript into the same
// message twice, interleaved. Latecomers simply drop; whatever they would
// have found, the in-flight pass is already finding.
let _resumingJobs = false;
// Wake-driven resumes hold off until the boot sequence (state load, server
// conflict check, first resume pass) has finished — resuming against a
// state blob that checkServerStateOnBoot may be about to replace would
// stream a reply into thread objects that are about to be swapped out.
let _appBooted = false;

async function resumePendingJobs() {
  if (_resumingJobs) return;
  _resumingJobs = true;
  try {
    if (jobsAvailable === false) return;
    const pending = state.threads.filter(t => t.pendingJob && t.pendingJob.id);
    if (pending.length === 0) return;
    console.log(`[jobs] ${pending.length} pending generation(s) found — resuming`);

    // Newest first so, if several are somehow live, the most recent gets the
    // interactive attach.
    pending.sort((a, b) => ((b.pendingJob.startedAt || 0) - (a.pendingJob.startedAt || 0)));

    const running = [];
    for (const thread of pending) {
      const jobId = thread.pendingJob.id;
      const info = await _peekJob(jobId);
      if (info === null) {
        // Server unreachable right now — keep the breadcrumb; a later boot,
        // reload, or app-wake retries. Don't guess at an outcome we can't see.
        console.warn('[jobs] could not reach server to resume', jobId);
        continue;
      }
      if (info.status === 'running') { running.push(thread); continue; }
      if (info.status === 'lost') {
        // Transcript is gone (restart + sweep). Keep whatever partial text the
        // periodic saves captured, stamp an honest note, clear the breadcrumb.
        const msg = thread.messages.find(m => m.jobId === jobId) ||
                    thread.messages[thread.messages.length - 1];
        if (msg && msg.role === 'assistant') {
          const note = '\n\n*(interrupted — the server no longer has this reply; it was likely restarted while you were away)*';
          if (!(msg.content || '').includes(note)) msg.content = ((msg.content || '')) + note;
          delete msg.jobId;
          delete msg.genStartedAt;   // clock has no honest end point — don't leave it ticking in storage
        }
        delete thread.pendingJob;
        saveState();
        renderSidebar();
        continue;
      }
      // Terminal with a transcript: quiet background replay.
      jobsAvailable = true;
      const outcome = await finalizeJobIntoThread(thread, jobId, { live: false });
      if (!outcome.errored && !outcome.aborted) {
        showModelSwitchToast(`Reply finished while you were away — "${(thread.name || 'thread').slice(0, 32)}"`, 'ok', 5000);
      }
    }

    // Re-attach live to still-running jobs, one at a time (the app's model is
    // one generation in flight; llama-server queues the rest anyway).
    for (const thread of running) {
      if (isGenerating) break;   // something else grabbed the slot (e.g. user already sent)
      jobsAvailable = true;
      showModelSwitchToast(`Still generating in "${(thread.name || 'thread').slice(0, 32)}" — re-attached`, 'info', 4000);
      await finalizeJobIntoThread(thread, thread.pendingJob.id, { live: true });
    }
  } finally {
    _resumingJobs = false;
  }
}

