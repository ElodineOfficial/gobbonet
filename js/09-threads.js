/* @gobbonet-split js/09-threads.js
   Moved verbatim from chat.html lines 6420-6876.
   branching, thread management, auto-continue
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   BRANCHING / FORKING
   Each thread can fork from any message index in another thread.
   Forked threads carry a forkSource { threadId, at } so we can
   reconstruct the navigation relationship at render time.
================================================================ */

/**
 * Create a fork (branch) of the current thread at messageIndex. The new
 * thread carries a `forkSource: { threadId, at }` where `at` is the
 * index of the FIRST DIVERGENT message in the source thread. Two shapes:
 *
 *   USER msg → share everything BEFORE this message; pre-fill the input
 *              with this message's text so the user can tweak the
 *              wording and resend (the fork starts by re-running this
 *              turn, possibly differently).
 *   AI msg   → share everything UP TO AND INCLUDING this reply; leave
 *              the input empty so the user picks up from after the AI's
 *              turn (the fork starts by adding the next user message,
 *              with this AI reply preserved as the new thread's tail).
 *
 * Both shapes deposit at the same `at` for adjacent messages — an
 * AI-msg fork at index N and a user-msg fork at index N+1 share the
 * same branch point and show up as siblings in the navigator. That's
 * correct: they describe the same divergence in the conversation.
 */
function forkAt(messageIndex) {
  const thread = getActiveThread();
  if (!thread) return;

  const sourceMsg = thread.messages[messageIndex];
  const isAiBranch = !!(sourceMsg && sourceMsg.role === 'assistant');

  // `cutoff` is the index where the new thread diverges from the source
  // (i.e. the first message NOT included in the shared history). For an
  // AI branch we include `messageIndex` itself, so cutoff = messageIndex + 1.
  const cutoff = isAiBranch ? messageIndex + 1 : messageIndex;

  // Pre-fill input only when re-running a user turn. For AI branches the
  // input stays empty — the user is continuing forward, not re-asking.
  const defaultInput = isAiBranch ? '' : (sourceMsg ? (sourceMsg.content || '') : '');

  // Deep-copy shared history. The spread on `m` handles primitives, but two
  // nested structures need explicit cloning or the fork would share mutable
  // state with the source:
  //   • msg.variants (reroll / edit history) — an array of objects.
  //   • each variant's `continuation` (the parked downstream subtree a user
  //     wording owns) — an array of message objects that can themselves carry
  //     variants and continuations. Mutating a restored branch in the fork
  //     (e.g. rerolling one of its replies) must not bleed back into source.
  // Clone defensively even on messages without variants today, since they
  // might gain them later via edit / reroll in either thread. continuation is
  // deep-cloned with a JSON round-trip — the same shape this data already
  // takes through saveState, so nothing meaningful is lost.
  const sharedMessages = thread.messages.slice(0, cutoff).map(m => {
    const copy = { ...m };
    if (Array.isArray(m.variants)) {
      copy.variants = m.variants.map(v => {
        const vc = { ...v };
        if (Array.isArray(v.continuation)) {
          vc.continuation = JSON.parse(JSON.stringify(v.continuation));
        }
        return vc;
      });
    }
    return copy;
  });

  const baseName = thread.name.replace(/^⑂\s*/, '').slice(0, 38);
  const forks = getAllForksOf(thread.id);
  const branchNum = forks.filter(t => t.forkSource && t.forkSource.at === cutoff).length + 1;

  const newThread = {
    id: generateId(),
    name: `⑂ ${baseName}`,
    messages: sharedMessages,
    lore: thread.lore || '',
    createdAt: Date.now(),
    pinned: false,
    folderId: thread.folderId,
    tags: [...(thread.tags || [])],
    forkSource: { threadId: thread.id, at: cutoff }
  };

  state.threads.unshift(newThread);
  state.activeThreadId = newThread.id;

  if (window.innerWidth <= 700 && state.sidebarOpen) {
    state.sidebarOpen = false;
    updateSidebarVisibility();
  }

  saveState();
  render();
  applyActiveCardBackground();

  // Pre-fill the textarea with the message content that was at forkPoint
  if (defaultInput !== undefined && defaultInput !== null) {
    const input = document.getElementById('msg-input');
    if (input) {
      input.value = defaultInput;
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 200) + 'px';
    }
  }
  document.getElementById('msg-input')?.focus();
}

/** All fork threads that branched from threadId (any branch point) */
function getAllForksOf(threadId) {
  return state.threads.filter(t => t.forkSource && t.forkSource.threadId === threadId);
}

/** Fork threads that branched from threadId at a specific message index */
function getForksAt(threadId, at) {
  return state.threads.filter(t =>
    t.forkSource &&
    t.forkSource.threadId === threadId &&
    t.forkSource.at === at
  );
}

/**
 * All sibling branches of the given thread — other threads that share
 * the same forkSource (threadId + at). Includes the given thread itself.
 */
function getSiblingBranches(thread) {
  if (!thread || !thread.forkSource) return [];
  const { threadId, at } = thread.forkSource;
  return state.threads.filter(t =>
    t.forkSource &&
    t.forkSource.threadId === threadId &&
    t.forkSource.at === at
  );
}

/** Navigate directly to a thread (used by branch navigation buttons) */
function switchToBranch(threadId) {
  if (autoContinue && autoContinue.threadId !== threadId) {
    cancelAutoContinue('user switched to a branch');
  }
  state.activeThreadId = threadId;
  if (window.innerWidth <= 700 && state.sidebarOpen) {
    state.sidebarOpen = false;
    updateSidebarVisibility();
  }
  saveState();
  render();
  applyActiveCardBackground();
  document.getElementById('msg-input')?.focus();
  scrollToBottom();
}

/* ================================================================
   THREAD MANAGEMENT
================================================================ */
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function createThread() {
  const card = getActiveCard();
  const thread = {
    id: generateId(),
    name: 'New Thread',
    messages: [],
    // thread.lore now holds ONLY the running conversation summary (built up
    // by compression). Authored world/setting lore lives on the card
    // (card.startingLore) and is injected fresh each build, so we no longer
    // seed it here — that kept the two cleanly separated (see buildContextMessages).
    lore: '',
    createdAt: Date.now(),
    pinned: false,
    folderId: null,
    tags: [],
    forkSource: null
  };
  // Stamp the character's opening greeting (and any alt greetings as
  // flippable variants) onto the thread. No-op if the active card has
  // no greeting configured — the thread stays empty and the welcome
  // screen renders as before.
  injectGreeting(thread, card);
  state.threads.unshift(thread);
  state.activeThreadId = thread.id;
  // Auto-close sidebar on mobile after creating a thread
  if (window.innerWidth <= 700 && state.sidebarOpen) {
    state.sidebarOpen = false;
    updateSidebarVisibility();
  }
  saveState();
  render();
  document.getElementById('msg-input').focus();
}

/**
 * Activity-based ordering: float a thread to the top of the list. Called
 * when a thread sees fresh activity (a message sent) so the threads you're
 * actively working in rise on their own — the same spot new threads and
 * forks already land via unshift. This keeps the in-use threads reachable
 * without anyone having to pin them.
 *
 * Operates on state.threads directly. Array order is the list's source of
 * truth — the very order drag-to-reorder edits — so this coexists with
 * manual arranging: a drag sets an order, and the next message in a thread
 * floats it back to the top. No-op when the thread is already first or isn't
 * found, so it's cheap to call on every send.
 *
 * The pinned / folder / unfiled sections each render a filtered view of this
 * one array in its existing order, so a bumped thread rises to the top of
 * WHICHEVER section it lives in (its folder, the pinned group, or unfiled)
 * without leaking across sections.
 */
function bumpThreadToTop(threadId) {
  const idx = state.threads.findIndex(t => t.id === threadId);
  if (idx > 0) {
    const [t] = state.threads.splice(idx, 1);
    state.threads.unshift(t);
  }
}

function deleteThread(id, event) {
  if (event) event.stopPropagation();
  // If the chain was running on this thread, it has nowhere to go now.
  if (autoContinue && autoContinue.threadId === id) {
    cancelAutoContinue('chain thread deleted');
  }
  // A detached job for a deleted thread has no home to land in — tell the
  // server to stop burning GPU on it. (Fire-and-forget; the retention sweep
  // collects the spool either way.)
  const doomed = state.threads.find(t => t.id === id);
  if (doomed && doomed.pendingJob && doomed.pendingJob.id) {
    privacyFetch(`${JOBS_URL}/${doomed.pendingJob.id}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
    if (currentJob && currentJob.id === doomed.pendingJob.id) currentJob.cancelSent = true;
  }
  state.threads = state.threads.filter(t => t.id !== id);
  if (state.activeThreadId === id) {
    state.activeThreadId = state.threads.length > 0 ? state.threads[0].id : null;
  }
  saveState();
  render();
}

function switchThread(id) {
  // Switching threads kills any active auto-continue chain. The chain is
  // tied to a specific thread; firing into a thread the user isn't looking
  // at would be surprising at best, hostile at worst.
  if (autoContinue && autoContinue.threadId !== id) {
    cancelAutoContinue('user switched threads');
  }
  state.activeThreadId = id;
  // Auto-close sidebar on mobile after selecting a thread
  if (window.innerWidth <= 700 && state.sidebarOpen) {
    state.sidebarOpen = false;
    updateSidebarVisibility();
  }
  saveState();
  render();
  applyActiveCardBackground();
  document.getElementById('msg-input').focus();
  // Park at the bottom — the natural place when opening a chat is the most
  // recent message. Without this the freshly-rendered container sits at
  // scrollTop=0 and the user has to scroll down manually. (switchToBranch
  // does this already; switchThread was missing the call.)
  scrollToBottom();
}

function getActiveThread() {
  return state.threads.find(t => t.id === state.activeThreadId) || null;
}

function startRename(id, event) {
  event.stopPropagation();
  const el = document.querySelector(`[data-thread-id="${id}"] .thread-name`);
  const thread = state.threads.find(t => t.id === id);
  if (!el || !thread) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename-input';
  input.value = thread.name;
  input.addEventListener('blur', () => finishRename(id, input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { input.value = thread.name; input.blur(); }
  });
  el.replaceWith(input);
  input.focus();
  input.select();
}

function finishRename(id, newName) {
  const thread = state.threads.find(t => t.id === id);
  if (thread && newName.trim()) thread.name = newName.trim();
  saveState();
  render();
}

/* ================================================================
   AUTO-CONTINUE CHAIN

   `{{auto_continue_N}}` in a user message triggers an automated
   chain: the current send counts as post 1, then N-1 more sends
   fire automatically with AUTO_CONTINUE_DELAY_MS between them.

   The chain is runtime-only state (`autoContinue`). It dies on
   reload, on thread switch/delete, on manual send, on Stop, and
   on generation error. That keeps it predictable — no surprise
   background firing after you walked away.

   AUTO_CONTINUE_TEXT is the prompt the LLM actually sees. The
   stored user message keeps the short {{auto_continue}} form
   so message bubbles don't display a wall of instructions on
   every continued post. translateTemplates expands it at context-
   build time so the model receives the full prompt.
================================================================ */

const AUTO_CONTINUE_TEXT = "Continue the work as instructed, without waiting for further input. Play the roles of all parties as the situation requires: if you are coding, you are both the developer and the bug hunter; if you are telling a story, you play every character; if you are reasoning through a problem, you challenge your own conclusions. Keep going until the task reaches a natural completion point.";

const AUTO_CONTINUE_DELAY_MS = 20000;
const AUTO_CONTINUE_MAX_CHAIN = 50;   // safety cap; {{auto_continue_9999}} would otherwise be a foot-gun

// Runtime state. Null when no chain is active.
// Shape: { threadId, total, remaining, sendTimer, countdownTimer, secsLeft }
let autoContinue = null;

/**
 * Look for {{auto_continue_N}} in user input. Returns an object with
 * the parsed count and a normalized version of the content where every
 * {{auto_continue_N}} occurrence (any N) is collapsed to {{auto_continue}}
 * so the rendered bubble stays short and consistent with subsequent
 * auto-fired sends. Returns null if no chain macro is found.
 *
 * If multiple {{auto_continue_N}} occurrences appear, we use the count
 * from the first one and ignore the rest. Mixing counts in one message
 * is an obvious user error and the result would be unpredictable;
 * picking the first is at least deterministic.
 */
function detectAutoContinueMacro(content) {
  const re = /\{\{auto_continue_(\d+)\}\}/i;
  const m = content.match(re);
  if (!m) return null;
  let count = parseInt(m[1], 10);
  if (!isFinite(count) || count < 1) count = 1;
  if (count > AUTO_CONTINUE_MAX_CHAIN) count = AUTO_CONTINUE_MAX_CHAIN;
  const normalized = content.replace(/\{\{auto_continue_\d+\}\}/gi, '{{auto_continue}}');
  return { count, normalizedContent: normalized };
}

/**
 * Begin a new chain. The current send counts as post 1, so the
 * `remaining` counter is total - 1 (number of auto-fired follow-ups).
 * Any existing chain is cancelled first.
 */
function startAutoContinueChain(threadId, total) {
  cancelAutoContinue('superseded by new chain');
  autoContinue = {
    threadId,
    total,
    remaining: total - 1,
    sendTimer: null,
    countdownTimer: null,
    secsLeft: 0
  };
  renderAutoContinueIndicator();
}

/**
 * Tear down whatever's pending and clear the indicator. Safe to call
 * with no active chain.
 */
function cancelAutoContinue(reason) {
  if (!autoContinue) return;
  if (autoContinue.sendTimer)      clearTimeout(autoContinue.sendTimer);
  if (autoContinue.countdownTimer) clearInterval(autoContinue.countdownTimer);
  console.log(`[auto-continue] cancelled: ${reason} (was ${autoContinue.remaining}/${autoContinue.total} remaining)`);
  autoContinue = null;
  renderAutoContinueIndicator();
}

/**
 * Called at the end of a successful generation. If a chain is active
 * on this thread and has posts remaining, schedule the next send.
 * Otherwise clear the chain (we've finished, or context moved).
 */
function maybeContinueChain() {
  if (!autoContinue) return;
  const thread = getActiveThread();
  if (!thread || thread.id !== autoContinue.threadId) {
    cancelAutoContinue('active thread changed');
    return;
  }
  if (autoContinue.remaining <= 0) {
    console.log(`[auto-continue] chain complete (${autoContinue.total} posts)`);
    autoContinue = null;
    renderAutoContinueIndicator();
    return;
  }

  // Spin up the visible countdown + the actual send timer.
  autoContinue.secsLeft = Math.ceil(AUTO_CONTINUE_DELAY_MS / 1000);
  renderAutoContinueIndicator();

  autoContinue.countdownTimer = setInterval(() => {
    if (!autoContinue) return;            // cancelled out from under us
    autoContinue.secsLeft = Math.max(0, autoContinue.secsLeft - 1);
    renderAutoContinueIndicator();
  }, 1000);

  autoContinue.sendTimer = setTimeout(() => {
    if (!autoContinue) return;
    clearInterval(autoContinue.countdownTimer);
    autoContinue.countdownTimer = null;
    autoContinue.sendTimer = null;
    // Decrement BEFORE sending so the indicator shows post-fire counts
    // accurately while the next response is streaming in.
    autoContinue.remaining--;
    renderAutoContinueIndicator();
    // Fire the auto-continue user message. The stored content is the
    // short {{auto_continue}} form; translateTemplates expands it to
    // AUTO_CONTINUE_TEXT when building the context for the LLM.
    sendMessage('{{auto_continue}}');
  }, AUTO_CONTINUE_DELAY_MS);
}

/**
 * Render (or remove) the small status banner above the input. Reads
 * from `autoContinue` directly — call this whenever the chain state
 * changes (start, tick, cancel, end).
 */
function renderAutoContinueIndicator() {
  const el = document.getElementById('auto-continue-indicator');
  if (!el) return;
  if (!autoContinue) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  const ac = autoContinue;
  const posted = ac.total - ac.remaining;   // including the one currently streaming or just done
  // While generation is in flight there's no countdown; show "generating…" instead.
  let statusBit;
  if (isGenerating) {
    statusBit = `generating post ${posted}…`;
  } else if (ac.sendTimer) {
    statusBit = `next in ${ac.secsLeft}s`;
  } else if (ac.remaining > 0) {
    statusBit = 'queued';
  } else {
    statusBit = 'finishing';
  }
  el.style.display = 'flex';
  el.innerHTML = `
    <span class="auto-continue-pulse"></span>
    <span class="auto-continue-text">AUTO-CONTINUE · ${posted} / ${ac.total} · ${statusBit}</span>
    <button class="auto-continue-cancel" onclick="cancelAutoContinue('user cancel')" title="Stop the chain — current generation finishes first if one is running">CANCEL</button>
  `;
}

