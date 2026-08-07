/* @gobbonet-split js/07-prompt.js
   Moved verbatim from chat.html lines 4864-5499.
   carousel, greetings, token estimation, lore, context build
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   CAROUSEL PROMPT HELPERS
================================================================ */
function toggleCarouselBody() {
  const cb = document.getElementById('card-carousel-enabled');
  const body = document.getElementById('carousel-body');
  const label = document.getElementById('carousel-toggle-label');
  // Sync checkbox if clicked on the row label (not the checkbox itself)
  // The checkbox fires its own onclick so we just read its current state
  const enabled = cb.checked;
  body.classList.toggle('open', enabled);
  label.classList.toggle('active', enabled);
  updateCarouselCounter(null);
}

function updateCarouselCounter(card) {
  const el = document.getElementById('carousel-counter');
  if (!el) return;
  // Read from editor fields (card may be null when called live)
  const raw = document.getElementById('card-carousel-prompts')?.value || '';
  const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) { el.textContent = ''; return; }
  const isSeq = document.getElementById('carousel-mode-sequential')?.checked;
  const idx = card ? (card.carouselIndex || 0) : 0;
  if (isSeq) {
    el.textContent = `${lines.length} line${lines.length !== 1 ? 's' : ''} — next: line ${(idx % lines.length) + 1}`;
  } else {
    el.textContent = `${lines.length} line${lines.length !== 1 ? 's' : ''} — selected randomly each turn`;
  }
}

function resetCarouselIndex() {
  if (editingCardId) {
    const card = state.characterCards.find(c => c.id === editingCardId);
    if (card) { card.carouselIndex = 0; saveState(); }
  }
  updateCarouselCounter(null);
}

/**
 * Pick the next carousel line for a card.
 * Mutates card.carouselIndex for sequential mode and saves state.
 * Returns the chosen line string, or null if carousel is off/empty.
 */
function pickCarouselLine(card) {
  if (!card || !card.carouselEnabled) return null;
  const raw = (card.carouselPrompts || '').trim();
  if (!raw) return null;
  const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) return null;

  let chosen;
  if (card.carouselMode === 'sequential') {
    const idx = (card.carouselIndex || 0) % lines.length;
    chosen = lines[idx];
    card.carouselIndex = (idx + 1) % lines.length;
  } else {
    // Random — avoid repeating the last pick if possible
    const lastIdx = card._lastCarouselIdx;
    let pick;
    if (lines.length === 1) {
      pick = 0;
    } else {
      do { pick = Math.floor(Math.random() * lines.length); } while (pick === lastIdx);
    }
    chosen = lines[pick];
    card._lastCarouselIdx = pick;
  }
  return chosen;
}

/* ================================================================
   GREETING / ALT GREETINGS HELPERS

   A greeting is a designated opening message set verbatim on the
   card and injected into each new thread as the character's first
   assistant turn. The model never generates it — it's just stamped
   onto thread.messages at creation. Alt greetings are additional
   openings stored as variants on the same injected message so the
   ◀ ▶ navigator already used for rerolls works without any new UI.

   Storage: card.greeting is a single string; card.altGreetings is
   one raw textarea value, blank-line separated (mirrors how
   carouselPrompts is stored as raw newline-separated text). Parsing
   happens on use, not on save, so the user's exact formatting
   round-trips through edit sessions unchanged.
================================================================ */

/** Split the alt-greetings textarea on blank lines (one or more empty
 *  lines between entries). Trims surrounding whitespace and drops
 *  empty results. Multi-paragraph greetings are preserved as a single
 *  entry — separator is a fully blank line, not just a newline. */
function parseAltGreetings(raw) {
  if (!raw || !raw.trim()) return [];
  return raw.split(/\n\s*\n/).map(s => s.trim()).filter(s => s.length > 0);
}

/** Toggle the alt-greetings editor body open/closed. Mirrors the
 *  carousel toggle exactly — same CSS classes, same click pattern. */
function toggleAltGreetingsBody() {
  const cb = document.getElementById('card-alt-greetings-enabled');
  const body = document.getElementById('alt-greetings-body');
  const label = document.getElementById('alt-greetings-toggle-label');
  if (!cb || !body || !label) return;
  const enabled = cb.checked;
  body.classList.toggle('open', enabled);
  label.classList.toggle('active', enabled);
  updateAltGreetingsCounter();
}

/** Live count of how many variants the next new thread will get.
 *  Counts the primary greeting field + each blank-line-separated
 *  entry in the alts textarea. */
function updateAltGreetingsCounter() {
  const el = document.getElementById('alt-greetings-counter');
  if (!el) return;
  const raw = document.getElementById('card-alt-greetings')?.value || '';
  const alts = parseAltGreetings(raw);
  if (alts.length === 0) { el.textContent = ''; return; }
  const greetingFilled = !!(document.getElementById('card-greeting')?.value || '').trim();
  const total = (greetingFilled ? 1 : 0) + alts.length;
  el.textContent = `${alts.length} alt${alts.length !== 1 ? 's' : ''} \u2014 ${total} total opening${total !== 1 ? 's' : ''} per new thread`;
}

/** Push the card's greeting (plus any alt greetings as flippable
 *  variants) onto a freshly-created thread as its first assistant
 *  message. No-op if the card has no greeting and alts are disabled
 *  / empty. The variant data shape (msg.variants / msg.activeVariant)
 *  is the exact one used by rerolls, so the existing ◀ N/M ▶
 *  navigator picks it up with no rendering changes. */
function injectGreeting(thread, card) {
  if (!card) return;
  const persona = getActivePersona();
  const charName = card.name || 'Assistant';
  const userName = persona.name || 'Anonymous';

  const primary = (card.greeting || '').trim();
  const alts = card.altGreetingsEnabled
    ? parseAltGreetings(card.altGreetings || '')
    : [];

  // Nothing on either side — leave the thread empty so the welcome
  // screen renders as it always has.
  if (!primary && alts.length === 0) return;

  // Assemble the visible list. The primary slot may be empty (user
  // only filled out alts) — in that case the first alt becomes the
  // default and we never show an empty bubble.
  const all = [];
  if (primary) all.push(primary);
  for (const a of alts) all.push(a);

  // Resolve {{char}} / {{user}} / macros at injection time so the
  // stored content is final and matches the convention used by every
  // other persistent message in the app.
  const resolved = all.map(g => translateTemplates(g, charName, userName));

  const ts = Date.now();
  const msg = {
    role: 'assistant',
    content: resolved[0],
    timestamp: ts
  };

  // Multiple openings? Promote to the variants shape. Single greeting
  // stays as a plain message — no navigator clutter when there's
  // nothing to flip between.
  if (resolved.length > 1) {
    msg.variants = resolved.map(content => ({
      content,
      reasoning: '',
      timestamp: ts
    }));
    msg.activeVariant = 0;
  }

  thread.messages.push(msg);
}

/** Live "parsed N entities · M tags · K prose chunks" readout for the RAG
 *  Storybook field, so the author sees how their text was interpreted
 *  (structured vs prose) without guessing. Runs the same parser the
 *  retriever uses, so the counts match what actually fires. */
function updateStorybookReadout() {
  const el = document.getElementById('storybook-readout');
  if (!el) return;
  const raw = document.getElementById('card-rag-storybook')?.value || '';
  if (!raw.trim()) { el.textContent = ''; return; }
  let parsed;
  try { parsed = parseStorybook(raw); } catch (e) { el.textContent = 'parse error'; return; }
  const c = parsed.counts;
  const parts = [];
  parts.push(`${c.entities} ${c.entities === 1 ? 'entity' : 'entities'}`);
  if (c.subtrees) parts.push(`${c.subtrees} subtree${c.subtrees !== 1 ? 's' : ''}`);
  parts.push(`${c.tags} tag${c.tags !== 1 ? 's' : ''}`);
  parts.push(`${c.proseChunks} prose chunk${c.proseChunks !== 1 ? 's' : ''}`);
  el.textContent = 'parsed \u2192 ' + parts.join(' \u00b7 ');
}


function renderAvatar(avatarStr, name) {
  if (avatarStr && (avatarStr.startsWith('http') || avatarStr.startsWith('data:') || avatarStr.startsWith('file:'))) {
    return `<img src="${escapeHtml(avatarStr)}" alt="">`;
  }
  // Fallback: first letter of name
  const initial = (name || '?').charAt(0).toUpperCase();
  return initial;
}

function previewAvatar(inputId, previewId) {
  const url = document.getElementById(inputId).value.trim();
  const preview = document.getElementById(previewId);
  if (url && (url.startsWith('http') || url.startsWith('data:') || url.startsWith('file:'))) {
    preview.innerHTML = `<img src="${escapeHtml(url)}" alt="">`;
  } else {
    preview.innerHTML = '--';
  }
}

function handleAvatarFile(fileInput, textInputId, previewId) {
  const file = fileInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    const dataUrl = e.target.result;
    document.getElementById(textInputId).value = dataUrl;
    document.getElementById(previewId).innerHTML = `<img src="${dataUrl}" alt="">`;
  };
  reader.readAsDataURL(file);
}

/* ================================================================
   TOKEN ESTIMATION
   Rough heuristic: 700 words ≈ 1000 tokens
================================================================ */
function estimateTokens(text) {
  if (!text) return 0;
  const words = text.split(/\s+/).filter(w => w.length > 0).length;
  return Math.ceil(words * (1000 / 700));
}

function estimateMessagesTokens(messages) {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content || '') + estimateTokens(m.reasoning || '') + 4;
    if (m.searchData) total += estimateTokens(m.searchData);
    if (m.attachmentText) total += estimateTokens(m.attachmentText);
  }
  return total;
}

/* ================================================================
   LORE SYSTEM
   Compresses older messages into a running summary.
   Keeps last 40 messages verbatim, everything else → lore.
================================================================ */
function getThreadLore(thread) {
  return (thread && thread.lore) || '';
}

function setThreadLore(thread, lore) {
  if (thread) thread.lore = lore;
}

/* Maximum chars we'll retain in lore. Beyond this we trim from the front
   on a sentence boundary so the most recent context is preserved. */
// Backstop only — the prompt targets ~180 words (roughly 1,100 chars), so
// this should never fire in normal operation. It exists to stop a model
// that ignores the word limit from letting lore accrete without bound.
// Lowered from 4000: at that size a runaway summary could occupy ~1,000
// tokens of context, which is most of what the rolling archive was
// supposed to free up in the first place.
const LORE_MAX_CHARS = 2400;

async function summarizeForLore(existingLore, messagesToSummarize) {
  // Instructions go in a SYSTEM message, not the user turn — most modern
  // chat templates weight system content more reliably for format
  // compliance. We also do NOT include m.reasoning: chain-of-thought from
  // earlier turns is working memory the model already discarded, and
  // folding it into lore was poisoning future summaries with CoT-of-CoT.
  //
  // The output is FIELDED rather than a narrative paragraph, and that is
  // the whole point of this prompt. A free-form story paragraph has to
  // re-ground the reader every time it changes subject ("Back at the
  // tavern...", "Still in Ashford..."), so with a recursive fold the
  // location got restated on every single pass — half a dozen times in a
  // long session. Fields carry a standing fact exactly once, in one
  // place, and leave EVENTS free to describe only what changed.
  //
  // The second half of the fix is the word REWRITE. The old prompt said
  // "fold in" and "updated summary", which reads as append-only: the
  // model treated the existing summary as immutable and bolted a new
  // sentence on the end. Nothing ever authorised it to delete, merge or
  // shorten what was already there, so the summary could only accrete.
  const sys = 'You maintain a running summary of a long conversation. You will be '
    + 'given the current summary and the new messages since it was written. '
    + 'Rewrite the summary so it covers all of it.\n\n'
    + 'RULES:\n'
    + '1. REWRITE, never append. You may delete, merge, shorten or reorder '
    + 'anything already in the summary. Facts that no longer matter should be '
    + 'dropped, not carried forward.\n'
    + '2. State each standing fact EXACTLY ONCE. The location, the people and '
    + 'their relationships live in their own fields. Never restate them in '
    + 'EVENTS. If it has not changed, it does not get mentioned again.\n'
    + '3. Keep concrete, load-bearing detail over atmosphere: injuries, items '
    + 'carried, promises made, debts owed, decisions still open, names. Drop '
    + 'small talk, scene-setting prose and anything already resolved.\n'
    + '4. Under 180 words total. Shorter is better.\n'
    + '5. No preamble, no chain-of-thought, no bullet characters, no commentary. '
    + 'Output the fields and nothing else.\n\n'
    + 'Output these fields, one per line, omitting any that do not apply:\n'
    + 'SETTING: where things stand, plus world facts that persist.\n'
    + 'CHARACTERS: who is present or matters, one short clause each.\n'
    + 'OPEN: unresolved threads - injuries, inventory, debts, promises, pending decisions.\n'
    + 'EVENTS: what happened, oldest to newest, essentials only.';

  let body = '';
  if (existingLore) {
    body += '=== CURRENT SUMMARY (rewrite this, do not append to it) ===\n' + existingLore + '\n\n';
    body += '=== NEW MESSAGES SINCE IT WAS WRITTEN ===\n';
  } else {
    body += '=== CONVERSATION TO SUMMARIZE ===\n';
  }
  for (const m of messagesToSummarize) {
    const role = m.role === 'user' ? 'User' : 'Assistant';
    const text = m.content || '';  // intentionally NOT m.reasoning
    if (!text) continue;
    body += `${role}: ${text}\n`;
    // Search results are a repetition source in their own right: web
    // snippets restate the same place and product names in every result,
    // and folding them in whole taught the summariser that those names
    // were the most salient thing in the batch. A short excerpt is enough
    // to record THAT a search happened and roughly what it found.
    if (m.searchData) {
      const sd = m.searchData.length > 600
        ? m.searchData.slice(0, 600) + '\u2026'
        : m.searchData;
      body += `[Search results referenced]:\n${sd}\n`;
    }
    body += '\n';
  }
  body += '=== END ===\nRewrite the complete summary now, covering both sections. Output the fields only.';

  // Visible indicator so the user can see compression is happening rather
  // than the UI appearing frozen. Cleared on completion / error / abort.
  renderLoreIndicator('compressing older messages into lore...');

  try {
    const resp = await privacyFetch(LLAMA_URL + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'local',
        messages: [
          { role: 'system', content: sys },
          { role: 'user',   content: body }
        ],
        // Stream so we don't block the UI for ~30s with zero feedback.
        // The tokens are dropped on the floor — we just want progress.
        stream: true,
        // max_tokens covers REASONING plus content, not content alone. On a
        // card with thinkingFormat 'deepseek' (deepseek-r1, Qwen3.6, GLM-Z1)
        // the chain-of-thought is generated, counted, and only then thrown
        // away by the parser below — so a tight cap does not prevent the
        // model burning budget on CoT, it just guarantees the summary gets
        // truncated mid-sentence when it does. That truncated text then
        // became the next pass's input.
        //
        // 700 leaves room for a moderate CoT and the ~240 tokens a 180-word
        // fielded summary needs. Brevity is enforced by the prompt, not by
        // starving the generation. If CoT still eats everything, content
        // comes back empty and the guard below keeps the previous lore.
        max_tokens: 700,
        // Low temperature: we want stable, repeatable summaries.
        temperature: 0.3
      })
    });
    if (!resp.ok) {
      renderLoreIndicator('');
      return existingLore || '';
    }

    // Reuse the project's existing thinking-format parser. Whatever the
    // model emits — <think> tags, <channel|> markers, harmony channels,
    // server-split reasoning_content — gets routed to tmpMsg.reasoning,
    // and the actual answer to tmpMsg.content. We then throw away
    // .reasoning. This is the fix that keeps CoT out of lore.
    const tmpMsg = { role: 'assistant', content: '', reasoning: '' };
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const tok = extractTokenFromLine(line);
        if (tok) processStreamDelta(tmpMsg, tok.text, tok.field);
      }
    }
    // Flush held-back buffer and scrub stray format markers.
    finalizeStreamMessage(tmpMsg);

    renderLoreIndicator('');

    // If parsing produced nothing, keep the prior lore rather than
    // overwriting it with an empty string (which would silently lose
    // every earlier summary).
    let summary = (tmpMsg.content || '').trim();
    if (!summary) return existingLore || '';

    // Cap lore length. Without this, lore grows indefinitely as new
    // batches get folded in, gradually eating the context budget that
    // should belong to recent messages.
    //
    // This keeps the HEAD, not the tail. That is a change, and it is
    // required by the fielded format: SETTING / CHARACTERS / OPEN are
    // emitted first and hold the durable state, so tail-truncation
    // decapitated exactly the fields worth keeping and left a fragment of
    // EVENTS. Losing the end of EVENTS is the cheap loss — the most recent
    // turns are still present verbatim in the live (non-archived) window.
    // Cut on a line boundary so a field is never left half-written.
    if (summary.length > LORE_MAX_CHARS) {
      const head = summary.slice(0, LORE_MAX_CHARS);
      const cut = head.lastIndexOf('\n');
      summary = (cut > 200 ? head.slice(0, cut) : head).trim();
    }
    return summary;
  } catch (e) {
    console.error('Lore summarization failed:', e);
    renderLoreIndicator('');
    return existingLore || '';
  }
}

/* ================================================================
   BUILD CONTEXT (token-aware with rolling archive)

   Two views of the conversation:
     thread.messages — the user-visible scrollback. Grows forever.
                       Messages marked .archived = true are kept here
                       for the UI but no longer sent to the model.
     [non-archived]  — what we actually send. Compresses periodically
                       as the budget approaches.

   Everything below is token-driven. Message counts are never used as
   thresholds — the user can configure a 16k or a 100k context and the
   same logic scales naturally. The only floors are token reserves:
   we promise to keep AT LEAST RECENT_RESERVE_FACTOR of the budget as
   trailing verbatim messages no matter how aggressively we compress.

   Cycle when liveTokens + overhead would exceed budget:
     1. Walk oldest-first through non-archived messages.
     2. Mark .archived = true until we've freed enough to land at
        TARGET_FACTOR of budget — OR until archiving the next one
        would eat into the trailing reserve, whichever comes first.
     3. Fold those just-archived messages into lore.
     4. Re-render so the UI shows the dimmed + divider state.
================================================================ */
/* ================================================================
   NORMALIZE MESSAGES FOR STRICT TEMPLATES

   Some chat templates — most notably Mistral Nemo's v3-tekken —
   enforce a hard contract on the messages array:
     1. At most ONE system message, only at the very start.
     2. Strict user/assistant/user/assistant alternation after that.
   When violated, the template calls raise_exception(), llama-server
   returns 500, and the file server's reverse proxy passes it to the
   browser as 502. This is what was making MN-Violet-Lotus and other
   Nemo merges fail on existing threads while working on fresh ones.

   Our buildContextMessages above intentionally pushes multiple system
   messages (character prompt, lore, personality reminder, narrative
   direction), and the token-trim safety net can shift messages off
   the front in a way that leaves the array starting with assistant.
   Gemma 4 and Mistral Small v7-tekken silently tolerate both; Nemo
   refuses.

   This pass produces a Nemo-safe array without losing content:
     1. Merge ALL leading system messages into one (joined by \n\n).
     2. Fold any leading assistant message(s) — the opening greeting,
        plus the rare token-trim leftover — into the leading system
        block as a labeled opening, so the array can start on a user
        turn WITHOUT deleting that content from context. (Previously
        these were dropped, which silently lost the greeting.)
     3. Fold mid-conversation system messages into the NEXT user
        message as a [System: ...] prefix. If no user follows, append
        to the previous user message as a trailing note.
     4. Merge consecutive same-role conversation messages with \n\n
        (handles edits/branches that produced user→user pairs).

   Applied universally rather than gating on model family because:
     - The user explicitly wants robust mid-thread model swapping.
     - The transformations are no-ops or near-no-ops on tolerant
       templates (collapsing multiple systems into one is what every
       template ends up doing internally anyway).
     - Keeping the call sites simple is worth more than the small
       fidelity loss from [System: ...] markers on tolerant models.
================================================================ */
function normalizeMessagesForStrictTemplates(messages) {
  if (!messages || !messages.length) return messages || [];

  const VALID_ROLES = new Set(['system', 'user', 'assistant']);
  
  // Distilled reasoning models (DeepSeek, Qwen) frequently ignore the 'system' role.
  // Folding the system prompt directly into the first user message guarantees they read it.
  const fam = (activeModel && activeModel.family) ? String(activeModel.family).toLowerCase() : '';
  const foldLeadingSystem = ['deepseek', 'qwen'].includes(fam);

  let working = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const role = String(m.role || '').toLowerCase().trim();
    if (!VALID_ROLES.has(role)) continue;
    const content = (m.content == null) ? '' : String(m.content);
    working.push({ role, content });
  }
  if (!working.length) return [];

  let i = 0;
  const leadingSystem = [];
  while (i < working.length && working[i].role === 'system') {
    if (working[i].content) leadingSystem.push(working[i].content);
    i++;
  }
  // Leading assistant message(s) — the character's opening greeting, stamped
  // by injectGreeting() at messages[0] as an assistant turn (or, rarely, an
  // old reply orphaned at the front by the trim safety net). Rather than bury
  // it in the system block (the old behavior), we weave it back as a PROPER
  // turn pair: a minimal user anchor followed by the assistant greeting. That
  // keeps the greeting an in-character assistant turn for every template —
  // strict ones (Mistral Nemo et al.) can't open on an assistant turn, so the
  // user anchor is what makes the opening legal — while still giving it a real
  // user-side context. Empty / whitespace greeting slots (e.g. blanked for an
  // in-flight reroll) carry no content and are skipped.
  const leadingAssistant = [];
  while (i < working.length && working[i].role === 'assistant') {
    const c = (working[i].content || '').trim();
    if (c) leadingAssistant.push(working[i].content);
    i++;
  }
  const greetingText = leadingAssistant.length ? leadingAssistant.join('\n\n') : '';
  // The greeting's anchor is itself a user-role message, so for fold models it
  // can double as the carrier for the deferred system block.
  const haveUserTarget = !!greetingText || !!working.find(m => m.role === 'user');

  const out = [];
  let pendingSystem = '';

  if (leadingSystem.length) {
    if (foldLeadingSystem && haveUserTarget) {
      // Defer the system block onto the first user-role message — the greeting
      // anchor if present, otherwise the first real user turn.
      pendingSystem = leadingSystem.join('\n\n');
    } else {
      out.push({ role: 'system', content: leadingSystem.join('\n\n') });
    }
  }

  // Weave the opening greeting as [user anchor] -> [assistant greeting]. The
  // anchor is a minimal cue so the array can legally open user-first; on fold
  // models it also carries the deferred system block.
  if (greetingText) {
    let anchor = '[Start of conversation]';
    if (pendingSystem) { anchor = pendingSystem + '\n\n' + anchor; pendingSystem = ''; }
    out.push({ role: 'user', content: anchor });
    out.push({ role: 'assistant', content: greetingText });
  }

  for (; i < working.length; i++) {
    const m = working[i];
    if (m.role === 'system') {
      if (m.content) {
        pendingSystem = pendingSystem ? pendingSystem + '\n\n' + m.content : m.content;
      }
      continue;
    }
    if (pendingSystem && m.role === 'user') {
      const isFirstUser = m === working.find(w => w.role === 'user');
      // Only add the [System: ] label for mid-conversation injected prompts.
      // For the main folded system block at the start, inject it seamlessly.
      const prefix = (isFirstUser && foldLeadingSystem)
        ? `${pendingSystem}\n\n`
        : `[System: ${pendingSystem}]\n\n`;
      out.push({ role: 'user', content: prefix + m.content });
      pendingSystem = '';
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  if (pendingSystem) {
    for (let j = out.length - 1; j >= 0; j--) {
      if (out[j].role === 'user') {
        out[j].content = out[j].content + `\n\n[System: ${pendingSystem}]`;
        break;
      }
    }
  }

  // Drop empty/whitespace-only assistant messages.
  const nonEmpty = out.filter(m =>
    m.role !== 'assistant' || (m.content || '').trim().length > 0
  );

  // Merge consecutive same-role conversation messages.
  const merged = [];
  for (const m of nonEmpty) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role && m.role !== 'system') {
      prev.content = prev.content + '\n\n' + m.content;
    } else {
      merged.push({ role: m.role, content: m.content });
    }
  }

  // Drop trailing assistant messages so the array terminates cleanly on 'user'.
  while (merged.length && merged[merged.length - 1].role === 'assistant') {
    merged.pop();
  }

  // Re-merge after popping (guarantees strictly alternating array).
  const finalPass = [];
  for (const m of merged) {
    const prev = finalPass[finalPass.length - 1];
    if (prev && prev.role === m.role && m.role !== 'system') {
      prev.content = prev.content + '\n\n' + m.content;
    } else {
      finalPass.push({ role: m.role, content: m.content });
    }
  }

  return finalPass;
}

