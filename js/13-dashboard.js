/* @gobbonet-split js/13-dashboard.js
   Moved verbatim from chat.html lines 8535-9138.
   landing page
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   LANDING PAGE DASHBOARD
   Shown when no thread is active. Displays scheduled tasks,
   active character cards, and placeholder default characters.
================================================================ */
function renderLandingPage() {
  const now = new Date();
  const currentTime = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');

  // Connection status pill
  const connHtml = serverConnected
    ? `<span class="landing-status-ok">&#9679; LLAMA-SERVER ONLINE</span>`
    : `<span class="landing-status-err">&#9679; OFFLINE — run launch.bat</span>`;

  // ── Scheduled tasks ────────────────────────────────────────────
  let schedHtml = '';
  if (state.schedules.length === 0) {
    schedHtml = `<div class="landing-empty">No scheduled tasks — use // SCHED to create one.</div>`;
  } else {
    schedHtml = state.schedules.map(s => {
      const thread = state.threads.find(t => t.id === s.threadId);
      const threadName = thread ? escapeHtml(thread.name) : '[deleted]';
      const typeLabel = s.recurring === 'daily' ? '&#8635; Daily' : '&#9201; Once';
      const searchLabel = s.useSearch ? ' &#128269;' : '';
      // Fired-today or past-once = dimmed
      const today = now.toDateString();
      const done = (s.lastFired === today) || (s.recurring !== 'daily' && s.time < currentTime);
      return `
        <div class="landing-sched-item ${done ? 'landing-sched-done' : 'landing-sched-active'}"
             onclick="openScheduler()" title="Open scheduler">
          <span class="landing-sched-time">${escapeHtml(s.time)}</span>
          <span class="landing-sched-type">${typeLabel}${searchLabel}</span>
          <span class="landing-sched-thread">&#8594; ${threadName}</span>
          <span class="landing-sched-prompt">${escapeHtml(s.prompt.slice(0, 60))}${s.prompt.length > 60 ? '…' : ''}</span>
        </div>`;
    }).join('');
  }

  // ── Your characters ────────────────────────────────────────────
  const charHtml = state.characterCards.map(c => {
    const isActive = c.id === state.activeCardId;
    const avatarHtml = renderAvatar(c.avatar, c.name);
    const desc = (c.personality || c.writingStyle || '').slice(0, 72);
    return `
      <div class="landing-char-card ${isActive ? 'landing-char-active' : ''}"
           onclick="activateCard('${c.id}')" title="Set as active character">
        <div class="landing-char-avatar">${avatarHtml}</div>
        <div class="landing-char-info">
          <div class="landing-char-name">${escapeHtml(c.name)}</div>
          <div class="landing-char-desc">${escapeHtml(desc)}${desc.length >= 72 ? '…' : ''}</div>
        </div>
        ${isActive ? '<span class="landing-char-badge">ACTIVE</span>' : ''}
      </div>`;
  }).join('');

  // ── Default / preset characters loaded from default-characters.json ──
  let presetHtml = '';
  if (defaultCharacters.length === 0) {
    presetHtml = `<div class="landing-empty">No default characters loaded — add entries to default-characters.json.</div>`;
  } else {
    presetHtml = defaultCharacters.map((p, i) => {
      const icon = p.icon || '&#9864;';
      const name = escapeHtml(p.name || 'Unnamed');
      const desc = escapeHtml((p.desc || '').slice(0, 80));
      // If the preset has full card data, clicking installs it as a new character
      // card. We pass the array INDEX (not a serialized copy) — embedding a
      // JSON.stringify'd object in the onclick attribute broke the handler: the
      // JSON string's leading double-quote closed the attribute, so the click was
      // a no-op. installDefaultChar looks the preset back up by index.
      const hasCardData = !!(p.writingStyle || p.personality);
      const clickAttr = hasCardData
        ? `onclick="installDefaultChar(${i})" title="Install as character card"`
        : `title="${name}"`;
      return `
        <div class="landing-preset-card ${hasCardData ? 'landing-preset-installable' : ''}" ${clickAttr}>
          <div class="landing-preset-icon">${icon}</div>
          <div class="landing-char-info">
            <div class="landing-char-name">${name}</div>
            <div class="landing-char-desc">${desc}</div>
          </div>
          ${hasCardData ? '<span class="landing-preset-badge landing-preset-badge-install">+ ADD</span>' : '<span class="landing-preset-badge">PRESET</span>'}
        </div>`;
    }).join('');
  }

  return `
    <div class="landing-page">

      <div class="landing-header">
        <div class="landing-title">GOBBONET_HQ</div>
        <div class="landing-subtitle">// local inference terminal &nbsp;|&nbsp; ${connHtml}</div>
        <div class="landing-subtitle" style="margin-top:4px; color:var(--green-dim);">&#128274; llama.cpp — zero telemetry, fully offline</div>
      </div>

      <div class="landing-section">
        <div class="landing-section-header">
          <span>&#9201; SCHEDULED TASKS</span>
          <button class="btn btn-sm" onclick="openScheduler()">Manage</button>
        </div>
        <div class="landing-sched-list">${schedHtml}</div>
      </div>

      <div class="landing-section">
        <div class="landing-section-header">
          <span>&#9864; YOUR CHARACTERS</span>
          <button class="btn btn-sm" onclick="openCharacters()">Manage</button>
        </div>
        <div class="landing-char-list">${charHtml}</div>
      </div>

      <div class="landing-section">
        <div class="landing-section-header">
          <span>&#128126; DEFAULT CHARACTERS</span>
          <span class="landing-tag">JSON</span>
        </div>
        <div class="landing-char-list">${presetHtml}</div>
      </div>

      <div class="landing-hint">// select a thread from the sidebar &mdash; or create a new one to begin</div>
    </div>`;
}

function renderMessages() {
  const container = document.getElementById('messages');
  const thread = getActiveThread();
  const title = document.getElementById('thread-title');

  if (!thread) {
    title.textContent = 'GOBBONET';
    container.innerHTML = renderLandingPage();
    const homeBtn = document.getElementById('home-btn');
    if (homeBtn) homeBtn.classList.add('hidden');
    return;
  }

  const homeBtn2 = document.getElementById('home-btn');
  if (homeBtn2) homeBtn2.classList.remove('hidden');
  title.textContent = thread.name;

  if (thread.messages.length === 0) {
    container.innerHTML = `
      <div class="welcome">
        <h2>AWAITING INPUT</h2>
        <p>// type below to begin</p>
      </div>`;
    return;
  }

  const card = getActiveCard();
  const persona = getActivePersona();
  const userName = persona.name || 'Anonymous';
  const cardName = card.name || 'Assistant';

  // Resolve text/dialog colors
  const userTextColor = persona.textColor || '';
  const userDialogColor = persona.dialogColor || '';
  const aiTextColor = card.textColor || '';
  const aiDialogColor = card.dialogColor || '';

  // ── Branch origin banner ────────────────────────────────────────
  let branchBannerHtml = '';
  if (thread.forkSource) {
    const sourceThread = state.threads.find(t => t.id === thread.forkSource.threadId);
    const sourceName = sourceThread ? escapeHtml(sourceThread.name.replace(/^⑂\s*/, '')) : '[deleted]';
    const forkAt = thread.forkSource.at;
    const siblings = getSiblingBranches(thread);
    const myIdx = siblings.findIndex(t => t.id === thread.id);
    const totalSibs = siblings.length;

    let sibNavHtml = '';
    if (totalSibs > 1) {
      const prevSib = siblings[myIdx - 1];
      const nextSib = siblings[myIdx + 1];
      sibNavHtml = `
        <div class="branch-sibling-nav">
          <button class="branch-nav-btn" ${!prevSib ? 'disabled' : ''} onclick="switchToBranch('${prevSib ? prevSib.id : ''}')" title="Previous branch">◀</button>
          <span class="branch-nav-label">Branch ${myIdx + 1} / ${totalSibs}</span>
          <button class="branch-nav-btn" ${!nextSib ? 'disabled' : ''} onclick="switchToBranch('${nextSib ? nextSib.id : ''}')" title="Next branch">▶</button>
        </div>`;
    }

    branchBannerHtml = `
      <div class="branch-origin-bar">
        <span class="branch-origin-icon">⑂</span>
        <span class="branch-origin-label">
          Branched from
          <button class="branch-origin-link" onclick="switchToBranch('${escapeHtml(thread.forkSource.threadId)}')">${sourceName}</button>
          at message ${forkAt + 1}
        </span>
        ${sibNavHtml}
      </div>`;
  }

  // ── Message list with fork-point indicators ──────────────────────
  // Find the boundary index where archived → live transitions, so we
  // can insert a single "folded into lore" divider once instead of
  // marking every message individually.
  let firstLiveIdx = -1;
  for (let i = 0; i < thread.messages.length; i++) {
    if (!thread.messages[i].archived && thread.messages[i].role !== 'system') {
      firstLiveIdx = i;
      break;
    }
  }
  const archivedCount = thread.messages.filter(m => m.archived).length;

  const messageRows = thread.messages.map((m, i) => {
    if (m.role === 'system') return '';
    const isUser = m.role === 'user';
    const roleLabel = isUser ? userName : cardName;
    const avatar = isUser
      ? renderAvatar(persona.avatar, userName)
      : renderAvatar(card.avatar, cardName);
    const archivedClass = m.archived ? ' archived' : '';
    const className = `message message-${m.role}${archivedClass}`;
    const textColor = isUser ? userTextColor : aiTextColor;
    const dialogColor = isUser ? userDialogColor : aiDialogColor;
    // Display-time safety net: assistant messages saved before the unwrap fix
    // (or produced by any path that bypasses finalize) may still hold a raw
    // tool-call envelope. Unwrap for display only; stored content is untouched.
    const displayContent = isUser ? m.content : unwrapToolCallText(m.content);
    const parsed = parseMarkdown(translateTemplates(displayContent, cardName, userName, true), dialogColor);
    const textColorStyle = textColor ? ` style="color:${textColor};"` : '';
    const isLastAI = !isUser && i === thread.messages.length - 1;
    const isEditing = state.editingIndex === i;

    let actionsHtml = '';
    if (!isGenerating) {
      if (isUser) {
        actionsHtml = `
          <button class="msg-action-btn btn-branch" onclick="forkAt(${i})" title="Branch conversation from here">⑂ Branch</button>
          <button class="msg-action-btn btn-edit" onclick="editMessage(${i})" title="Edit">Edit</button>
          <button class="msg-action-btn btn-delete" onclick="deleteMessage(${i})" title="Delete">Del</button>
          <button class="msg-action-btn" onclick="copyMessage(${i})" title="Copy">Copy</button>`;

        // Edit-variant navigator: shown on any user message that has been
        // edited at least once (variants.length > 1 because the first edit
        // promotes the original wording to variant 0 and appends the new
        // one as variant 1). Flipping is visual-only — the AI reply below
        // doesn't auto-regenerate. To explore a different conversational
        // path from a prior wording, flip to it and Reroll the AI reply,
        // or use Branch.
        if (Array.isArray(m.variants) && m.variants.length > 1) {
          const cur = (m.activeVariant ?? 0) + 1;
          const total = m.variants.length;
          const atFirst = (m.activeVariant ?? 0) === 0;
          const atLast  = (m.activeVariant ?? 0) === total - 1;
          actionsHtml += `
          <span class="variant-nav" title="Flip between prior wordings — each keeps its own AI replies and rerolls. Flipping restores that wording's whole branch below; it doesn't regenerate or spend tokens. To branch anew from a wording, flip to it and Edit.">
            <button class="variant-nav-btn" ${atFirst ? 'disabled' : ''} onclick="switchVariant(${i}, -1)" title="Previous wording (restores its branch)">◀</button>
            <span class="variant-nav-label">${cur}/${total}</span>
            <button class="variant-nav-btn" ${atLast ? 'disabled' : ''} onclick="switchVariant(${i}, 1)" title="Next wording (restores its branch)">▶</button>
          </span>`;
        }
      } else {
        actionsHtml = `
          <button class="msg-action-btn btn-branch" onclick="forkAt(${i})" title="Branch from this reply — start a new thread that keeps this reply as its last AI turn, then pick up fresh">⑂ Branch</button>
          <button class="msg-action-btn btn-edit" onclick="editMessage(${i})" title="Edit">Edit</button>
          <button class="msg-action-btn" onclick="copyMessage(${i})" title="Copy">Copy</button>
          <button class="msg-action-btn btn-delete" onclick="deleteMessage(${i})" title="Delete">Del</button>`;

        // Reroll-variant navigator: shown on any AI message that has
        // more than one variant. Lets the user flip back to an earlier
        // regeneration without losing the current one. The navigator
        // is independent of "is this the last message" — earlier
        // messages with stored variants stay flippable too.
        if (Array.isArray(m.variants) && m.variants.length > 1) {
          const cur = (m.activeVariant ?? 0) + 1;
          const total = m.variants.length;
          const atFirst = (m.activeVariant ?? 0) === 0;
          const atLast  = (m.activeVariant ?? 0) === total - 1;
          actionsHtml += `
          <span class="variant-nav" title="Flip between reroll variants — every regeneration is kept">
            <button class="variant-nav-btn" ${atFirst ? 'disabled' : ''} onclick="switchVariant(${i}, -1)" title="Previous variant">◀</button>
            <span class="variant-nav-label">${cur}/${total}</span>
            <button class="variant-nav-btn" ${atLast ? 'disabled' : ''} onclick="switchVariant(${i}, 1)" title="Next variant">▶</button>
          </span>`;
        }

        if (isLastAI) {
          actionsHtml += `\n          <button class="msg-action-btn btn-reroll" onclick="rerollMessage()" title="Regenerate (keeps the current response as a variant you can flip back to)">Reroll</button>`;
        }
      }
    }

    if (isEditing) {
      const saveLabel = isUser ? 'Save &amp; Resend' : 'Save';
      return `
        <div class="${className} editing">
          <div class="msg-header">
            <span class="msg-avatar">${avatar}</span>
            <span class="message-role">${roleLabel}</span>
          </div>
          <textarea class="edit-textarea" id="edit-area">${escapeHtml(m.content || m.reasoning || '')}</textarea>
          <div class="edit-actions">
            <button class="btn btn-sm" onclick="cancelEdit()">Cancel</button>
            <button class="btn btn-sm btn-fill" onclick="saveEdit(${i})">${saveLabel}</button>
          </div>
        </div>`;
    }

    // Show typing indicator only when generating AND no content or reasoning yet
    const isCurrentlyGenerating = isGenerating && !isUser && i === thread.messages.length - 1;
    const showTypingDots = isCurrentlyGenerating && !m.content && !m.reasoning;
    const searchBadge = m.searchData ? '<span class="search-badge" title="Web search results attached">&#128269;</span>' : '';

    // Response timer + smart-limit badges (assistant messages only). While
    // streaming, the ⏱ badge ticks live off genStartedAt (the gen-timer
    // interval refreshes its text each second); once the turn settles it
    // shows the recorded genMs. ✂ marks replies the smart limit trimmed.
    let genBadges = '';
    if (!isUser) {
      if (isCurrentlyGenerating && m.genStartedAt) {
        genBadges += `<span class="gen-time gen-time-live" id="gen-live-timer" data-t0="${m.genStartedAt}" title="Generating&hellip;">&#9201; ${escapeHtml(formatGenTime(Date.now() - m.genStartedAt) || '0s')}</span>`;
      } else if (typeof m.genMs === 'number') {
        genBadges += `<span class="gen-time" title="Response generated in ${escapeHtml(formatGenTime(m.genMs))}">&#9201; ${escapeHtml(formatGenTime(m.genMs))}</span>`;
      }
      if (m.smartCapped && !isCurrentlyGenerating) {
        genBadges += `<span class="gen-cap-badge" title="Smart limit: reply capped at ~${m.smartCapped} tokens (est.), cut at the sentence end — adjust in CONFIG">&#9986; ~${m.smartCapped}</span>`;
      }
    }
    
    // Render search results as a visible, linkified block
    let searchBlock = '';
    if (m.searchData) {
      const searchHtml = parseSearchData(m.searchData);
      searchBlock = `<div class="search-results-card"><div class="search-results-header">&#128269; WEB SEARCH RESULTS</div><div class="search-results-body">${searchHtml}</div></div>`;
    }

    // Build chain-of-thought collapsible block
    let cotBlock = '';
    if (m.reasoning) {
      const cotOpen = isCurrentlyGenerating && !m.content ? ' open' : '';
      const cotStatus = isCurrentlyGenerating && !m.content ? ' cot-active' : '';
      const cotLabel = isCurrentlyGenerating && !m.content
        ? '&#9881; Thinking...'
        : '&#128161; Chain of Thought';
      const cotParsed = parseMarkdown(m.reasoning, dialogColor);
      cotBlock = `
        <details class="cot-block${cotStatus}"${cotOpen}>
          <summary class="cot-summary">${cotLabel}</summary>
          <div class="cot-content">${cotParsed}</div>
        </details>`;
    }

    // Attachment chips (files the user attached to this message)
    let attachmentsHtml = '';
    if (Array.isArray(m.attachments) && m.attachments.length) {
      attachmentsHtml = '<div class="msg-attachments">' + m.attachments.map(a => {
        if (a.kind === 'image' && a.dataUrl) {
          return `<span class="msg-attach-chip" title="${escapeHtml(a.name)} — image, not sent to model"><img class="msg-attach-thumb" src="${a.dataUrl}" alt="${escapeHtml(a.name)}"><span>${escapeHtml(a.name)}</span></span>`;
        }
        const icon = a.kind === 'text' ? '📄' : (a.kind === 'image' ? '🖼️' : '⚠️');
        const note = a.kind === 'text' ? (a.truncated ? ' (truncated)' : '') : (a.kind === 'image' ? ' (not sent)' : ' (not sent)');
        return `<span class="msg-attach-chip" title="${escapeHtml(a.name)}${escapeHtml(note)}">${icon} ${escapeHtml(a.name)}${escapeHtml(note)}</span>`;
      }).join('') + '</div>';
    }

    // Build main content
    let mainContent = '';
    if (showTypingDots) {
      mainContent = '<div class="message-content"><span class="typing-indicator"><span></span><span></span><span></span></span></div>';
    } else if (m.content || !m.reasoning) {
      mainContent = `<div class="message-content"${textColorStyle}>${parsed}</div>${attachmentsHtml}${searchBlock}`;
    } else {
      // Has reasoning but no content yet — show a small waiting indicator
      mainContent = `<div class="message-content" style="opacity:0.5;font-style:italic;">Composing response...</div>${attachmentsHtml}`;
    }

    return `
      <div class="${className}" data-index="${i}">
        <div class="msg-header">
          <span class="msg-avatar">${avatar}</span>
          <span class="message-role">${roleLabel}</span>
          ${searchBadge}
          ${genBadges}
        </div>
        ${cotBlock}
        ${mainContent}
        <div class="message-actions">${actionsHtml}</div>
      </div>`;
  });

  // Inject fork-point indicators after each message where branches diverge,
  // and a single "folded into lore" divider just before the first live
  // message when archive content exists.
  const rowsWithForks = messageRows.map((rowHtml, i) => {
    let prefix = '';
    if (archivedCount > 0 && i === firstLiveIdx) {
      const noun = archivedCount === 1 ? 'message' : 'messages';
      prefix = `
      <div class="lore-divider" title="${archivedCount} earlier ${noun} folded into lore — still visible above, no longer sent to the model">
        <span class="lore-divider-icon">📝</span>
        <span>${archivedCount} ${noun} folded into lore</span>
      </div>`;
    }
    const forksHere = getForksAt(thread.id, i + 1);
    if (forksHere.length === 0) return prefix + rowHtml;
    const forkBtns = forksHere.map(ft =>
      `<button class="branch-fork-btn" onclick="switchToBranch('${ft.id}')" title="${escapeHtml(ft.name)}">⑂ ${escapeHtml(ft.name.replace(/^⑂\s*/, '').slice(0, 28))}</button>`
    ).join('');
    return prefix + rowHtml + `
      <div class="branch-fork-line">
        <span class="branch-fork-line-icon">⑂</span>
        <span class="branch-fork-label">${forksHere.length} branch${forksHere.length > 1 ? 'es' : ''} from here</span>
        ${forkBtns}
      </div>`;
  });

  container.innerHTML = branchBannerHtml + rowsWithForks.join('');

  // Persistent lore-compression marker. summarizeForLore shows a transient
  // "compressing..." indicator while it runs, but that vanishes the moment
  // it returns — and renderMessages's innerHTML reset would wipe it anyway.
  // By re-injecting this banner after every render (gated on a flag set in
  // buildContextMessages and cleared at the next user turn), the compression
  // event stays visible alongside the streaming COT, which is the point of
  // showing it in the first place. Scoped to the active thread so it doesn't
  // leak into other threads on a switch.
  if (pendingLoreCompressionNote && pendingLoreCompressionNote.threadId === thread.id) {
    const n = pendingLoreCompressionNote.count;
    const banner = document.createElement('div');
    banner.className = 'message message-system-inject lore-compressed-banner';
    // Clickable: seeing THAT compression happened is only half the story.
    // What it produced is the part you need when the summary starts
    // repeating itself or dropping the details the character depends on.
    const _lg = Array.isArray(thread.loreLog) ? thread.loreLog[thread.loreLog.length - 1] : null;
    const _delta = _lg ? (_lg.after - _lg.before) : null;
    const _deltaTxt = (_delta === null) ? ''
      : ' &middot; summary ' + (_delta >= 0 ? '+' : '') + _delta + ' chars';
    banner.innerHTML = '&#128221; Lore: folded ' + n + ' older '
      + (n === 1 ? 'message' : 'messages') + ' into the summary' + _deltaTxt
      + ' <span class="lore-inspect-link">inspect</span>';
    banner.setAttribute('role', 'button');
    banner.setAttribute('tabindex', '0');
    banner.title = 'Show the current summary and how it has grown';
    banner.onclick = () => openLoreInspector();
    banner.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLoreInspector(); } };
    // Sit just above the streaming assistant message so the marker is
    // visually adjacent to the COT, not orphaned at the bottom.
    const aiMsgs = container.querySelectorAll('.message-assistant');
    const lastAssistant = aiMsgs[aiMsgs.length - 1];
    if (lastAssistant) container.insertBefore(banner, lastAssistant);
    else container.appendChild(banner);
  }
}

function renderReminderIndicator() {
  const container = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'message message-system-inject';
  div.innerHTML = '&#9888; Reminder prompt injected';
  container.appendChild(div);
}

function renderSearchIndicator(status) {
  const container = document.getElementById('messages');
  // Remove previous search indicator if any
  const prev = container.querySelector('.search-indicator');
  if (prev) prev.remove();
  const div = document.createElement('div');
  div.className = 'message message-system-inject search-indicator';
  div.innerHTML = '&#128269; Web search: ' + escapeHtml(status);
  container.appendChild(div);
  scrollToBottom();
}

/* Lore-compression indicator. Mirrors renderSearchIndicator: pass a
   non-empty status to show, pass '' to clear. Without this the user
   sees the UI freeze for ~30s during summarization with zero feedback. */
function renderLoreIndicator(status) {
  const container = document.getElementById('messages');
  const prev = container.querySelector('.lore-indicator');
  if (prev) prev.remove();
  if (!status) return;
  const div = document.createElement('div');
  div.className = 'message message-system-inject lore-indicator';
  div.innerHTML = '&#128221; Lore: ' + escapeHtml(status);
  container.appendChild(div);
  scrollToBottom();
}

/* ================================================================
   LORE INSPECTOR

   The compression banner tells you a fold happened. This shows what
   came out of it, and — more usefully — how the summary has changed
   across passes.

   The size history is the diagnostic that matters. A summary doing its
   job stays roughly flat: new events displace old ones. A summary that
   grows by a similar amount every pass is appending rather than
   rewriting, which is what makes standing facts like the location get
   restated on every fold. You can read that off the deltas without
   reading a word of the text.
================================================================ */

/** Rough token estimate for display. estimateTokens is the real one. */
function _loreTokens(txt) {
  try { return estimateTokens(txt || ''); } catch (e) { return Math.ceil((txt || '').length / 4); }
}

function openLoreInspector() {
  const thread = getActiveThread();
  if (!thread) return;
  const lore = (thread.lore || '').trim();
  const log = Array.isArray(thread.loreLog) ? thread.loreLog : [];

  const body = document.getElementById('lore-inspect-body');
  if (!body) return;

  let html = '';

  // --- current summary -------------------------------------------------
  html += '<div class="lore-section-label">Current summary</div>';
  if (lore) {
    html += '<div class="lore-meta">' + lore.length + ' chars &middot; ~'
          + _loreTokens(lore) + ' tokens &middot; ' + log.length
          + ' compression' + (log.length === 1 ? '' : 's') + ' recorded</div>';
    html += '<pre class="lore-summary-text">' + escapeHtml(lore) + '</pre>';
  } else {
    html += '<div class="lore-empty">No summary yet. Compression starts once the '
          + 'conversation outgrows the context budget.</div>';
  }

  // --- growth across passes -------------------------------------------
  if (log.length) {
    html += '<div class="lore-section-label">Size across passes</div>';
    const max = Math.max.apply(null, log.map(e => e.after).concat([1]));
    html += '<table class="lore-history"><thead><tr>'
          + '<th>#</th><th>time</th><th>folded</th><th>before</th>'
          + '<th>after</th><th>change</th><th></th></tr></thead><tbody>';
    log.forEach((e, i) => {
      const d = e.after - e.before;
      const cls = d > 0 ? 'lore-grow' : (d < 0 ? 'lore-shrink' : '');
      const t = new Date(e.at).toLocaleTimeString();
      const pct = Math.round((e.after / max) * 100);
      html += '<tr>'
        + '<td>' + (i + 1) + '</td>'
        + '<td>' + escapeHtml(t) + '</td>'
        + '<td>' + e.folded + '</td>'
        + '<td>' + e.before + '</td>'
        + '<td>' + e.after + '</td>'
        + '<td class="' + cls + '">' + (d >= 0 ? '+' : '') + d + '</td>'
        + '<td class="lore-bar-cell"><span class="lore-bar" style="width:' + pct + '%"></span></td>'
        + '</tr>';
    });
    html += '</tbody></table>';

    // Only editorialise when there is enough history to mean something.
    if (log.length >= 3) {
      const grew = log.slice(-3).filter(e => (e.after - e.before) > 0).length;
      if (grew === 3) {
        html += '<div class="lore-warn">Grew on each of the last three passes. '
              + 'A summary that only ever gets longer is appending instead of '
              + 'rewriting, which is what makes fixed details repeat.</div>';
      }
    }
  }

  body.innerHTML = html;
  document.getElementById('lore-inspect-modal').classList.add('open');
}

function closeLoreInspector() {
  const m = document.getElementById('lore-inspect-modal');
  if (m) m.classList.remove('open');
}

/** Copy the current summary, for pasting into a bug report.
 *  There is no shared clipboard helper in this codebase -- copyMessage and
 *  copyCodeBlock each roll their own with a per-button flash -- so this does
 *  the same dance rather than inventing a dependency. */
function copyLoreSummary(btn) {
  const thread = getActiveThread();
  const txt = (thread && thread.lore) || '';
  if (!txt) return;
  const done = (ok) => {
    if (!btn) return;
    const was = btn.textContent;
    btn.textContent = ok ? 'copied' : 'failed';
    setTimeout(() => { btn.textContent = was; }, 1200);
  };
  const fallback = () => {
    try {
      const ta = document.createElement('textarea');
      ta.value = txt;
      ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      done(ok);
    } catch (e) { done(false); }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(txt).then(() => done(true)).catch(fallback);
  } else {
    fallback();
  }
}

/** Header chip: always-available entry point, hidden when there is no lore. */
function updateLoreChip() {
  const chip = document.getElementById('lore-chip');
  if (!chip) return;
  const thread = getActiveThread();
  const lore = (thread && thread.lore) || '';
  if (!lore.trim()) { chip.style.display = 'none'; return; }
  const passes = (thread && Array.isArray(thread.loreLog)) ? thread.loreLog.length : 0;
  chip.style.display = '';
  chip.textContent = 'LORE ~' + _loreTokens(lore) + 't';
  chip.title = 'Running summary: ' + lore.length + ' chars, '
             + passes + ' compression' + (passes === 1 ? '' : 's')
             + '. Click to inspect.';
}

function updateSidebarVisibility() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  sidebar.classList.toggle('collapsed', !state.sidebarOpen);
  overlay.classList.toggle('open', state.sidebarOpen);
}

function updateInputState() {
  const hasThread = !!getActiveThread();
  const inputArea = document.querySelector('.input-area');
  const contextInfo = document.getElementById('context-info');
  if (inputArea)   inputArea.style.display   = hasThread ? '' : 'none';
  if (contextInfo) contextInfo.style.display = hasThread ? '' : 'none';
  document.getElementById('send-btn').style.display = isGenerating ? 'none' : '';
  document.getElementById('stop-btn').style.display = isGenerating ? '' : 'none';
  // Keep the textarea editable while the model is thinking/generating so the
  // user can draft their next message uninterrupted. We only swap Send → Stop
  // (above); the actual send is gated by the isGenerating guard in
  // sendMessage(), so pressing Enter mid-generation simply no-ops rather than
  // interrupting. Generation is halted only via the Stop button.
  document.getElementById('msg-input').disabled = false;
  // Reconcile the follow-to-bottom FAB on every render (thread switches,
  // edits, deletes, generation start/end all route through here). The
  // thread-change guard inside updateFollowButton handles the post-render
  // scrollTop=0 transient so it never flashes on a switch.
  updateFollowButton();
}

function updateContextInfo() {
  const el = document.getElementById('context-info');
  const thread = getActiveThread();
  if (!thread || thread.messages.length === 0) { el.textContent = ''; return; }
  const card = getActiveCard();

  // Mirror buildContextMessages's accounting exactly. Anything less and
  // the display drifts from the value that actually triggers compression.
  const total = thread.messages.length;
  const liveMsgs = thread.messages.filter(m => !m.archived);
  const archivedCount = total - liveMsgs.length;

  const systemTokens = card ? estimateTokens(card.writingStyle) + 4 : 0;
  const liveTokens   = estimateMessagesTokens(liveMsgs);

  // Personality is now a persistent block (counted every turn when present),
  // not a periodic reminder. Mirror buildContextMessages.
  const personalityText = (card && card.personality || '').trim();
  const personalityTokens = personalityText ? estimateTokens(personalityText) + 4 : 0;

  // Authored lore (fresh from card) and the running summary (thread.lore) are
  // now separate blocks; count both.
  const authoredLore = (card && card.loreEnabled && card.startingLore) ? card.startingLore.trim() : '';
  const authoredLoreTokens = authoredLore ? estimateTokens(authoredLore) + 4 : 0;
  const summary = getThreadLore(thread);
  const summaryTokens = (summary && card && card.loreEnabled) ? estimateTokens(summary) + 4 : 0;
  const loreTokens = authoredLoreTokens + summaryTokens;

  const projected = systemTokens + personalityTokens + liveTokens + loreTokens;
  const budget    = Math.floor(state.settings.tokenLimit * 0.9);
  // Mirror RESPONSE_RESERVE_FACTOR from buildContextMessages — keep these
  // in sync. Showing % against `effectiveBudget` makes the readout track
  // the actual compression trigger; otherwise users see compression fire
  // at ~80% and wonder why.
  const effectiveBudget = budget - Math.floor(budget * 0.20);
  const pct       = effectiveBudget > 0 ? Math.round((projected / effectiveBudget) * 100) : 0;

  // Format: "~projected / effectiveBudget tok (pct%)" so the percentage
  // shows how close we are to triggering compression. Add a ⚠ marker
  // when we're inside 10% of the line, and "⚠ over" once we've crossed
  // it (which means compression will fire on the next turn).
  const warn = projected > effectiveBudget ? ' ⚠ over' : (pct >= 90 ? ' ⚠' : '');
  let info = archivedCount > 0
    ? `msgs: ${liveMsgs.length}/${total} | ~${projected}/${effectiveBudget} tok (${pct}%)${warn}`
    : `msgs: ${total} | ~${projected}/${effectiveBudget} tok (${pct}%)${warn}`;
  if (loreTokens > 0) info += ` | lore: ~${loreTokens}`;
  el.textContent = info;
}

function scrollToBottom(opts) {
  // behavior:  'auto' (instant, default) or 'smooth' (animated glide).
  // respectPin: when true, the scroll is abandoned if the user has unpinned
  //             by the time the deferred callback runs. Only the streaming/
  //             auto path passes this; forced actions (send, switch thread,
  //             reroll, FAB) leave it false and always land at the end.
  const behavior   = (opts && opts.behavior) || 'auto';
  const respectPin = !!(opts && opts.respectPin);
  const container = document.getElementById('messages');
  if (!container) return;
  // Double rAF: first fires before paint, second fires after layout has settled.
  // Critical for <details open> blocks whose height isn't known until after paint.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    // Honor the follow-pin at EXECUTION time, not schedule time. During a
    // stream we queue one of these every ~80ms while the user is pinned; two
    // frames later they may have touched the message area to stop following.
    // Re-checking here means a scroll queued a moment before that touch bails
    // instead of slamming the viewport back to the bottom and undoing the
    // stop — the single biggest reason a tap "didn't easily stop" the scroll.
    if (respectPin && !scrollPinnedToBottom) return;

    if (behavior === 'smooth') {
      container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
    } else {
      // Instant. The per-token chase MUST be instant: content grows every
      // tick, so an animated scroll chases a moving target it can never catch
      // and ends up trailing a few messages behind. A snap re-pin each tick
      // stays glued to the true bottom.
      container.scrollTop = container.scrollHeight;
    }
    // Also chase the bottom of the COT content box while it's actively streaming
    const cotContent = container.querySelector('.cot-block.cot-active .cot-content');
    if (cotContent) cotContent.scrollTop = cotContent.scrollHeight;

    // Avatars and markdown <img> tags load asynchronously — when they land
    // they grow scrollHeight and the position we just set is suddenly short
    // of the bottom. Re-anchor as each pending image finishes, but only if
    // the user is still pinned within ~one row of the bottom; if they've
    // scrolled up to read history we leave them alone. The dataset flag
    // guards against attaching duplicate handlers during streaming, where
    // scrollToBottom fires on every chunk.
    const imgs = container.querySelectorAll('img');
    imgs.forEach(img => {
      if (img.complete || img.dataset.scrollAnchored === '1') return;
      img.dataset.scrollAnchored = '1';
      const onDone = () => {
        const atBottom =
          container.scrollHeight - container.scrollTop - container.clientHeight < 32;
        if (atBottom) container.scrollTop = container.scrollHeight;
        img.removeEventListener('load', onDone);
        img.removeEventListener('error', onDone);
      };
      img.addEventListener('load', onDone);
      img.addEventListener('error', onDone);
    });
  }));
}

