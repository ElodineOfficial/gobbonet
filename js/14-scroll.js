/* @gobbonet-split js/14-scroll.js
   Moved verbatim from chat.html lines 9139-9481.
   auto-scroll, follow-to-bottom, surgical stream updates
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   SMART AUTO-SCROLL
   scrollToBottom() above is the FORCE variant — always scrolls,
   used by user-initiated actions (send, switch thread, reroll,
   edit-save, etc.). The helpers below are the AUTO variants used
   by streaming-tick calls: they only scroll if the user is still
   pinned at the bottom. If the user scrolled up to read history,
   they stay put and chunks pass underneath until they scroll back
   down — no button, no opt-in, just respect the user's position.
================================================================ */

/** Attach the page-level scroll listener that maintains scrollPinnedToBottom.
 *  Idempotent: the messages container survives across renders (we only
 *  innerHTML it), so a dataset flag prevents duplicate listener attaches. */
function attachScrollPinTracking() {
  const container = document.getElementById('messages');
  if (!container || container.dataset.pinTrackingAttached === '1') return;
  container.dataset.pinTrackingAttached = '1';
  container.addEventListener('scroll', () => {
    // Distance from the bottom in pixels. 32px threshold mirrors the
    // existing image-load re-anchoring logic in scrollToBottom — about
    // one message row of slack, enough to absorb sub-pixel rounding and
    // small layout shifts without flipping the pin spuriously.
    const dist = container.scrollHeight - container.scrollTop - container.clientHeight;
    scrollPinnedToBottom = dist < 32;
    updateFollowButton();
  }, { passive: true });

  // Mobile-first unfollow: a direct touch on the message area during
  // generation immediately drops auto-follow. The previous design relied
  // solely on the scroll listener above noticing an upward scroll, but the
  // per-chunk scrollToBottom() kept yanking the viewport back to the bottom
  // faster than a thumb could drag the 32px clear, so stopping the auto-
  // scroll on a phone was a fight the user usually lost. Reacting to the
  // touch itself — before any drag distance is required — makes it crisp:
  // one touch on the stream and it stops following, then the FAB offers a
  // one-tap way back. Outside generation there's nothing being followed, so
  // normal scrolling is left untouched. The listener is passive (we never
  // preventDefault); native scrolling and text selection still work.
  container.addEventListener('touchstart', () => {
    if (!isGenerating || !scrollPinnedToBottom) return;
    // One touch on the stream = stop following, deterministically. The part
    // that makes this stick is the pin re-check inside scrollToBottom()'s
    // rAF: any auto-scroll queued on the previous streaming tick (while we
    // were still pinned) sees scrollPinnedToBottom === false two frames later
    // and bails instead of yanking the viewport back to the bottom. Combined
    // with dropping the global `scroll-behavior: smooth` (which used to keep
    // an animation perpetually in flight), a single tap now wins — the old
    // version lost a tug-of-war against both the queued scroll and the glide.
    scrollPinnedToBottom = false;
    updateFollowButton();
  }, { passive: true });

  // The FAB's bottom offset is measured from the live layout, so re-anchor
  // it when the viewport changes shape (phone rotation, on-screen keyboard,
  // window resize).
  window.addEventListener('resize', updateFollowButton, { passive: true });
}

/** Streaming-tick page scroll. No-ops if the user has scrolled up.
 *  scrollToBottom() itself still does the work when we are pinned —
 *  this is just a guarded delegate. */
function autoScrollToBottom() {
  if (!scrollPinnedToBottom) return;       // cheap fast-path: skip scheduling entirely...
  scrollToBottom({ respectPin: true });    // ...and re-checked inside the rAF (see scrollToBottom)
}

/** Streaming-tick COT inner-scroll. Same pin-respect pattern, but the
 *  cot-content element is recreated on state transitions (cot-active →
 *  collapsed → next message's fresh cot-active), so pin state lives on
 *  the element itself via dataset. A fresh attach each appearance is
 *  exactly what we want — the user hasn't had a chance to scroll yet. */
function autoScrollCotContent(cotContent) {
  if (!cotContent) return;
  if (cotContent.dataset.pinTrackingAttached !== '1') {
    cotContent.dataset.pinTrackingAttached = '1';
    cotContent.dataset.userPinned = '1';
    cotContent.addEventListener('scroll', () => {
      const dist = cotContent.scrollHeight - cotContent.scrollTop - cotContent.clientHeight;
      cotContent.dataset.userPinned = dist < 32 ? '1' : '0';
    }, { passive: true });
  }
  if (cotContent.dataset.userPinned === '1') {
    cotContent.scrollTop = cotContent.scrollHeight;
  }
}

/* ================================================================
   FOLLOW-TO-BOTTOM CONTROL
   The streaming auto-scroll (autoScrollToBottom) only chases the
   bottom while scrollPinnedToBottom is true. On mobile the old
   "scroll up far enough to unpin" gesture had to win a tug-of-war
   against the per-chunk scrollToBottom(), which kept slamming the
   viewport back to the bottom faster than a thumb could drag a row
   clear — so stopping the auto-scroll on a phone was a fight the
   user usually lost. Unpinning is now ALSO driven by a direct touch
   on the message area during generation (see attachScrollPinTracking),
   which is deterministic: one touch on the stream and following stops.

   Once unpinned, fresh tokens push the latest reply below the fold.
   This FAB then surfaces and, when tapped, re-pins and snaps to the
   bottom so following resumes.
================================================================ */

// How far below the fold (px) before the FAB appears. Comfortably
// larger than the 32px pin threshold so it doesn't flicker in the
// instant the user is basically at the bottom — it shows only once a
// real slice of content has scrolled out of view ("flooding out").
const FOLLOW_BTN_REVEAL_DIST = 120;

// Last thread the FAB reconciled against. A thread switch lands the
// viewport at the bottom (the caller scrollToBottom()s), but
// renderMessages() resets scrollTop to 0 synchronously first, so an
// updateFollowButton() that runs in between (via updateInputState in
// render()) would read "miles from bottom" and flash the button on
// every switch. Treating an id change as freshly-pinned suppresses that.
let _followBtnLastThreadId;

/** Park the FAB at the bottom edge of the .messages viewport — i.e.
 *  just above whatever bottom bars are currently present. #chat is the
 *  offsetParent (position:relative) and .messages is a direct child, so
 *  everything below messages measures as:
 *    chat.clientHeight - (messages.offsetTop + messages.offsetHeight) */
function positionFollowButton(btn, container) {
  const chat = document.getElementById('chat');
  if (!chat) return;
  const belowMessages =
    chat.clientHeight - (container.offsetTop + container.offsetHeight);
  btn.style.bottom = (belowMessages + 16) + 'px';
}

/** Show/hide the FAB based on follow state + distance below the fold.
 *  Cheap layout reads only; safe to call on every streaming tick. */
function updateFollowButton() {
  const btn = document.getElementById('follow-bottom-btn');
  const container = document.getElementById('messages');
  if (!btn || !container) return;

  const thread = getActiveThread();
  const tid = thread ? thread.id : null;
  if (tid !== _followBtnLastThreadId) {
    _followBtnLastThreadId = tid;
    scrollPinnedToBottom = true;   // a fresh thread starts pinned at its end
  }

  const dist =
    container.scrollHeight - container.scrollTop - container.clientHeight;
  // Show only when NOT following and real content sits below the fold.
  // While following (pinned) there's nothing to jump to.
  const show = !!thread && !scrollPinnedToBottom && dist > FOLLOW_BTN_REVEAL_DIST;
  if (show) positionFollowButton(btn, container);
  btn.classList.toggle('visible', show);
}

/** FAB tap: re-engage auto-follow and snap to the latest. A live stream
 *  resumes chasing the bottom from here; a finished one just lands there. */
function followToBottom() {
  scrollPinnedToBottom = true;
  // Instant while a reply is still streaming — a smooth glide would only
  // fight the per-tick instant chase that resumes the moment we re-pin. A
  // gentle glide is fine (and nicer) once the stream has already finished.
  scrollToBottom({ behavior: isGenerating ? 'auto' : 'smooth' });
  updateFollowButton();   // hide now that we're pinned again
}

/** Settle the viewport after a generation-related full re-render.
 *
 *  Why this exists, and why it can't just call autoScrollToBottom():
 *  renderMessages() rebuilds the thread via innerHTML, which resets the
 *  container's scrollTop to 0. The browser then fires a scroll event for that
 *  reset — and per the HTML spec the scroll steps run BEFORE requestAnimation-
 *  Frame callbacks in the same frame. So the scroll listener sees scrollTop≈0,
 *  concludes "miles from the bottom", and clears scrollPinnedToBottom a beat
 *  BEFORE our deferred (pin-respecting) scroll would run. A pin-aware scroll
 *  therefore reads false and bails, stranding the view a few messages up even
 *  though the user never scrolled away. (This is exactly the end-of-stream
 *  "hops up instead of sinking to the bottom" symptom.)
 *
 *  The cure is to decide using the follow state captured BEFORE the rebuild,
 *  then issue a FORCED scrollToBottom() (no respectPin) so the transient flip
 *  can't cancel it. The forced scroll moves the viewport to the true, settled
 *  bottom, and the scroll event that results re-confirms scrollPinnedToBottom
 *  = true. If the user had genuinely scrolled up mid-stream, wasFollowing is
 *  false and we leave them where they're reading, just keeping the FAB offered. */
function settleScrollAfterGeneration(wasFollowing) {
  if (wasFollowing) {
    scrollPinnedToBottom = true;   // restore the pin the innerHTML rebuild clobbered
    scrollToBottom();              // forced jump to the settled final bottom
  }
  updateFollowButton();
}

function goHome() {
  state.activeThreadId = null;
  saveState();
  render();
  scrollToBottom();
}

// Install a default character preset as a new user card.
// Called from the landing page when a preset has writingStyle/personality data.
function installDefaultChar(idx) {
  // Look the preset up by its index in the boot-loaded array. (Previously this
  // took a JSON-serialized copy embedded in the onclick attribute, which broke
  // attribute parsing — the JSON's leading double-quote closed the attribute,
  // so the click was a no-op. See renderLanding's preset map.)
  const preset = defaultCharacters[idx];
  if (!preset) return;
  // Don't install duplicates (match by name)
  if (state.characterCards.find(c => c.name === preset.name)) {
    alert(`"${preset.name}" is already in your character list.`);
    return;
  }
  const card = {
    ...DEFAULT_CARD,
    id: generateId(),
    name: preset.name || 'Unnamed',
    avatar: preset.avatar || '',
    writingStyle: preset.writingStyle || '',
    personality: preset.personality || '',
    startingLore: preset.startingLore || '',
    greeting: preset.greeting || '',
    altGreetingsEnabled: !!preset.altGreetingsEnabled,
    altGreetings: preset.altGreetings || '',
    textColor: preset.textColor || '',
    dialogColor: preset.dialogColor || '',
    temperature: preset.temperature !== undefined ? preset.temperature : 0.7,
    minP: preset.minP !== undefined ? preset.minP : 0.05,
    topK: preset.topK !== undefined ? preset.topK : 40,
    topP: preset.topP !== undefined ? preset.topP : 0.95,
    repeatPenalty: preset.repeatPenalty !== undefined ? preset.repeatPenalty : 1.1,
    repeatLastN: preset.repeatLastN !== undefined ? preset.repeatLastN : 64,
    carouselEnabled: preset.carouselEnabled || false,
    carouselPrompts: preset.carouselPrompts || '',
    carouselMode: preset.carouselMode || 'random',
    carouselIndex: 0,
  };
  state.characterCards.push(card);
  saveState();
  render(); // refresh landing page to show updated character list
}

function toggleSidebar() {
  state.sidebarOpen = !state.sidebarOpen;
  saveState();
  updateSidebarVisibility();
}

/* ================================================================
   STREAMING SURGICAL UPDATE
   Updates only the COT content and message content divs in-place
   during streaming, avoiding full innerHTML replace and its flicker.
   Full renderMessages() is only called at two state transitions:
     1. When the COT block first appears (no .cot-block in DOM yet)
     2. When content starts flowing after reasoning ends (cot-active → done)
================================================================ */
function renderStreamingUpdate(assistantMsg) {
  const container = document.getElementById('messages');
  const thread = getActiveThread();
  if (!thread) return;

  const hasReasoning = !!(assistantMsg.reasoning);
  const hasContent   = !!(assistantMsg.content);

  // Scope every query to the currently streaming message — the LAST
  // .message-assistant in the container. The earlier version used
  // container.querySelector('.cot-block') which matches the FIRST cot-block
  // anywhere in the DOM. On follow-up turns that's a stale, collapsed COT
  // from a previous reply, so cotJustAppeared evaluated to false, the full
  // re-render that creates the new message's COT block never fired, and the
  // surgical update silently injected new reasoning into the OLD message's
  // (collapsed) cot-content. From the user's side the new turn appeared
  // stuck on typing dots until content arrived. Same hazard hits the
  // surgical .cot-content selector below — both must be scoped to lastMsg.
  // Using .message-assistant (not .message:last-child) also dodges the
  // edge case where a system-inject status div is the literal last child.
  const aiMsgs   = container.querySelectorAll('.message-assistant');
  const lastMsg  = aiMsgs[aiMsgs.length - 1];
  const cotBlock = lastMsg && lastMsg.querySelector('.cot-block');

  // ── State-transition: need a full re-render ────────────────────
  // Case 1: reasoning just started and the COT block doesn't exist yet
  const cotJustAppeared = hasReasoning && !cotBlock;
  // Case 2: content just started flowing (COT should collapse/de-activate)
  const contentJustStarted = hasContent && cotBlock && cotBlock.classList.contains('cot-active');

  if (cotJustAppeared || contentJustStarted) {
    // Capture follow intent BEFORE renderMessages() — its innerHTML rebuild
    // resets scrollTop to 0 and the resulting scroll event clears the pin
    // before a pin-aware scroll could run (see settleScrollAfterGeneration).
    const wasFollowing = scrollPinnedToBottom;
    renderMessages();
    // After full re-render, seed the COT scroll position. This is a
    // one-time init right after the cot-content element is created,
    // before the user has had a chance to interact with it — fine to
    // force-seed regardless of pin state.
    const freshCot = container.querySelector('.cot-block.cot-active .cot-content');
    if (freshCot) freshCot.scrollTop = freshCot.scrollHeight;
    // Re-pin and land at the bottom across the transition, but only if the
    // user was still following. If they scrolled up to read history during
    // reasoning, wasFollowing is false and we leave them where they're
    // reading; the FAB stays offered so they can jump back.
    settleScrollAfterGeneration(wasFollowing);
    return;
  }

  // ── Surgical updates ───────────────────────────────────────────
  const card        = getActiveCard();
  const aiTextColor = card.textColor || '';
  const aiDialogColor = card.dialogColor || '';

  // Update COT text — scoped to the active streaming message (see note above).
  if (hasReasoning) {
    const cotContent = lastMsg && lastMsg.querySelector('.cot-content');
    if (cotContent) {
      cotContent.innerHTML = parseMarkdown(assistantMsg.reasoning, aiDialogColor);
      // Auto-pin to the latest reasoning, but only if the user hasn't
      // scrolled up within the COT box itself. The cot-content element
      // has its own pin state tracked on its dataset.
      autoScrollCotContent(cotContent);
    }
  }

  // Update main message content
  if (hasContent) {
    const contentEl = lastMsg && lastMsg.querySelector('.message-content');
    if (contentEl) {
      // Surface clean text live if the model is wrapping its reply in a
      // tool-call envelope (Llama 3.x); plain replies pass through untouched.
      const liveText = unwrapToolCallTextLive(assistantMsg.content);
      contentEl.innerHTML = parseMarkdown(liveText, aiDialogColor);
      if (aiTextColor) contentEl.style.color = aiTextColor;
    }
    // Auto-scroll page while content is streaming — no-ops if the
    // user scrolled up to read earlier in the conversation.
    autoScrollToBottom();
  }
  // While unfollowed, the viewport doesn't move, so no scroll event fires —
  // but each chunk grows the content, pushing the latest reply further below
  // the fold. Drive the FAB from the tick so it surfaces as that happens.
  updateFollowButton();
}

