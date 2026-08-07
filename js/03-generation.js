/* @gobbonet-split js/03-generation.js
   Moved verbatim from chat.html lines 2020-3134.
   detached jobs, token limit, timer, thinking formats, tool-call unwrap
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   DETACHED GENERATION JOBS (survive tab-away / navigation)

   The old model: the browser held the /llm streaming fetch open for
   the whole generation. Navigate anywhere — new URL, tab close, phone
   screen lock — and the fetch died, the proxy link collapsed, and
   llama-server cancelled the slot. The reply died with the page.

   The new model: the file server owns the upstream connection. We
   POST the exact same request body to /llm/jobs, get an id back
   immediately, and then merely OBSERVE the generation by polling
   /llm/jobs/<id>?from=<byteOffset>. The server spools the raw SSE
   bytes to disk; we feed whatever bytes arrive through the SAME
   parser pipeline as before (extractTokenFromLine →
   processStreamDelta → finalizeStreamMessage), so thinking formats,
   tool-call unwrapping, and reasoning routing behave identically.

   Because the transcript is a byte-stable file, ATTACHING IS
   REPEATABLE: after any navigation we can come back, replay from
   byte 0 into a fresh message object, and land on exactly the text
   a live stream would have produced. `thread.pendingJob` (persisted
   in localStorage/IDB/state like everything else) is the breadcrumb
   that tells boot which jobs to pick back up — see
   resumePendingJobs() near the boot block.

   Fallbacks: on file:// there is no file server, and an older
   fileserver.ps1 has no /llm/jobs route. Both cases 404/fail the
   probe and we drop to the legacy direct-stream path automatically.
================================================================ */
const JOBS_URL = LLAMA_URL + '/jobs';

// null = unknown (probe on first send) · true = relay in use · false = legacy.
// Only a definitive 404/405 pins it to false; transient network errors leave
// it null so the next send re-probes.
let jobsAvailable = IS_SERVED ? null : false;

// The one generation this client is currently attached to (global, matching
// the app's one-generation-at-a-time model). stopGeneration() and the CoT
// watchdog reach the job through this.
let currentJob = null;        // { id, threadId, cancelSent }
let _cotCulledFlag = false;   // set by the watchdog so the finalizer can label the stop

const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* Wake-aware sleep for the job poll loop. Mobile browsers throttle or
   fully suspend timers the moment the app is backgrounded; on return, a
   plain setTimeout fires whenever the throttler gets around to it. The
   poll loop sleeps through THIS instead, so handleAppWake() can resolve
   every parked sleep the instant the user comes back (or the network
   returns — the 'online' event routes here too) and the next poll fires
   immediately instead of "eventually". Each waker removes itself on
   either path, so the parked list can't leak across generations. */
let _pollSleepWakers = [];
function _wakeableSleep(ms) {
  return new Promise(resolve => {
    let timer = null;
    const wake = () => {
      if (timer !== null) { clearTimeout(timer); timer = null; }
      const i = _pollSleepWakers.indexOf(wake);
      if (i >= 0) _pollSleepWakers.splice(i, 1);
      resolve();
    };
    timer = setTimeout(wake, ms);
    _pollSleepWakers.push(wake);
  });
}
function wakePendingPolls() {
  const parked = _pollSleepWakers.splice(0);
  for (const wake of parked) wake();
}

function _b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ================================================================
   SMART TOKEN LIMIT
   Optional cap (CONFIG) on how long a single AI reply may get.
   Uses the same rough estimator as the context meter
   (estimateTokens ≈ ¾ word per token), watches msg.content as it
   streams, and — once the cap is reached — lets the sentence in
   progress finish, then cuts exactly at its end and stops the
   generation. Reasoning/chain-of-thought is exempt: the cap is
   about visible reply length, and reasoning models need room to
   think (this is also why we DON'T set a server-side max_tokens —
   it would count thinking tokens and truncate mid-reasoning).

   A short grace window (~15% of the cap) covers the tail of the
   in-progress sentence; if the model is mid-run-on and no sentence
   end shows up inside the grace, we trim BACK to the last finished
   sentence instead, so the cap can never be blown past by much.

   Enforcement lives in the feeder, so it applies identically to
   fresh sends, rerolls, auto-continue chains, live job re-attaches,
   AND background replays of jobs that finished while the tab was
   closed (a detached job has no client to stop it, so trimming at
   fold-in is the only way the cap can hold there).
================================================================ */

// Sentence terminator + any trailing closers (quotes, brackets, markdown
// emphasis) so a cut after "…end.**" or "…end.") keeps the closers.
const _SENT_END_RE = /[.!?…]["'\u201d\u2019)\]*_]*/g;

/**
 * Heuristic: is the match at [matchStart, matchEnd) a real sentence end?
 * Requires a following whitespace char — never end-of-buffer, because a
 * trailing "." mid-stream might be the "3." of "3.5"; the next chunk
 * resolves it. Skips decimals / "1." list markers (digit before the dot)
 * and common abbreviations or single-letter initials.
 */
function _isSentenceEndAt(text, matchStart, matchEnd) {
  if (matchEnd >= text.length) return false;
  if (!/\s/.test(text[matchEnd])) return false;
  if (text[matchStart] === '.') {
    if (matchStart > 0 && /[0-9]/.test(text[matchStart - 1])) return false;
    const before = text.slice(Math.max(0, matchStart - 9), matchStart + 1);
    if (/(?:\b(?:e\.g|i\.e|etc|vs|Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Fig|Vol|No)|\b[A-Za-z])\.$/.test(before)) return false;
  }
  return true;
}

/** Index just past the FIRST sentence end at/after fromIdx, or -1. */
function findSentenceEnd(text, fromIdx) {
  _SENT_END_RE.lastIndex = Math.max(0, fromIdx);
  let m;
  while ((m = _SENT_END_RE.exec(text)) !== null) {
    const end = m.index + m[0].length;
    if (_isSentenceEndAt(text, m.index, end)) return end;
  }
  return -1;
}

/** Index just past the LAST sentence end at/before uptoIdx, or -1. */
function findLastSentenceEnd(text, uptoIdx) {
  const bound = Math.min(text.length, Math.max(0, uptoIdx));
  _SENT_END_RE.lastIndex = 0;
  let best = -1, m;
  while ((m = _SENT_END_RE.exec(text)) !== null) {
    const end = m.index + m[0].length;
    if (end > bound) break;
    if (_isSentenceEndAt(text, m.index, end)) best = end;
  }
  return best;
}

/**
 * Check msg.content against the smart limit; trim + stop when due.
 * Called from the feeder after every parsed delta. Returns true once
 * the cut has happened (callers stop feeding this message).
 *
 * On the first crossing we freeze the approximate char position where
 * the cap landed (proportional — the estimate is word-based, so exact
 * chars don't exist) and hunt forward from there for the end of the
 * sentence that was in progress.
 */
function maybeApplySmartLimit(msg) {
  if (msg.smartCapped) return true;
  const s = state.settings || {};
  if (!s.smartLimitEnabled) return false;
  const text = msg.content || '';
  if (!text) return false;

  const limit = Math.min(8192, Math.max(25, parseInt(s.smartLimitTokens, 10) || 300));
  const est = estimateTokens(text);
  if (est < limit) return false;

  const grace = Math.min(96, Math.max(24, Math.round(limit * 0.15)));

  if (!msg._smartLimitAt) {
    msg._smartLimitAt = Math.max(1, Math.floor(text.length * (limit / est)));
  }

  let cut = findSentenceEnd(text, msg._smartLimitAt);
  // A found end that overshoots the grace (marathon sentence) doesn't count.
  if (cut >= 0 && estimateTokens(text.slice(0, cut)) > limit + grace) cut = -1;
  if (cut < 0) {
    if (est <= limit + grace) return false;   // grace still open — keep streaming
    // Run-on overshoot: fall back to the last sentence that DID finish
    // before the cap; failing that, a word boundary near the cap.
    cut = findLastSentenceEnd(text, msg._smartLimitAt);
    if (cut < 0) {
      const ws = text.lastIndexOf(' ', msg._smartLimitAt);
      cut = ws > 25 ? ws : Math.min(text.length, msg._smartLimitAt);
    }
  }

  msg.content = text.slice(0, cut).replace(/\s+$/, '');
  if (msg._parseState) msg._parseState.pending = '';   // don't let finalize re-append tail bytes
  delete msg._smartLimitAt;
  msg.smartCapped = limit;   // persisted — drives the ✂ badge and the feed gate
  console.log(`[smart-limit] ~${est} est tokens ≥ cap ${limit} — cut at sentence end (${msg.content.length} chars), stopping generation`);
  stopGeneration({ keepChain: true });   // capping one reply shouldn't kill an auto-continue chain
  return true;
}

/* ================================================================
   GENERATION TIMER
   Every AI reply records how long it took to generate (genMs on the
   message, shown as a ⏱ badge in its header). While a generation is
   in flight, a live ticking readout runs off genStartedAt — which is
   persisted, so a reload mid-generation resumes the clock honestly.
   For detached jobs the fileserver's own started_at/updated_at
   stamps are preferred: they stay correct even for replies that
   finished while the tab was closed.
================================================================ */
let _genTimerId = null;

function formatGenTime(ms) {
  if (!(ms >= 0)) return '';
  if (ms < 1000) return '<1s';
  const s = ms / 1000;
  if (s < 10) return s.toFixed(1) + 's';
  if (s < 60) return Math.round(s) + 's';
  const mnt = Math.floor(s / 60);
  const rem = Math.floor(s % 60);
  return mnt + 'm ' + String(rem).padStart(2, '0') + 's';
}

function startGenTimerTicker() {
  stopGenTimerTicker();
  _genTimerId = setInterval(() => {
    const el = document.getElementById('gen-live-timer');
    if (!el) return;   // streaming thread not on screen — data keeps flowing, badge re-appears on switch-back
    const t0 = parseInt(el.dataset.t0, 10);
    if (t0) el.textContent = '\u23F1 ' + (formatGenTime(Date.now() - t0) || '0s');
  }, 1000);
}

function stopGenTimerTicker() {
  if (_genTimerId !== null) {
    clearInterval(_genTimerId);
    _genTimerId = null;
  }
}

/**
 * Byte-chunk consumer shared by BOTH transports (job polling and legacy
 * direct streaming). Owns the TextDecoder + partial-line buffer + the
 * throttled render/save ticks that used to be duplicated inline in
 * sendMessage and regenerateFromThread.
 *
 * The render tick is scoped to the job's own thread: background resumes
 * and mid-generation thread switches must never paint into whatever
 * thread happens to be on screen. (Data always went to the right message
 * object; the DOM writes were the loose end.)
 */
function makeStreamFeeder(assistantMsg, thread) {
  const decoder = new TextDecoder();
  let lineBuf = '';
  let lastRender = 0, lastSave = 0, chunkCount = 0, firstLogged = false;
  const threadIsVisible = () => thread && thread.id === state.activeThreadId;
  return {
    feed(bytes) {
      // Smart limit already cut this reply — freeze it. The job poll keeps
      // draining spooled bytes between our cancel and the server's ack (and
      // replays drain terminal transcripts fully); none of that may append
      // past the cut.
      if (assistantMsg.smartCapped) return;
      const text = decoder.decode(bytes, { stream: true });
      if (!text) return;
      if (!firstLogged) {
        console.log('[stream] First raw chunk:', JSON.stringify(text.slice(0, 500)));
        firstLogged = true;
      }
      lineBuf += text;
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop() || '';
      for (const line of lines) {
        chunkCount++;
        const result = extractTokenFromLine(line);
        if (result) {
          processStreamDelta(assistantMsg, result.text, result.field);
          if (maybeApplySmartLimit(assistantMsg)) {
            // Content was truncated at the sentence end — repaint now so the
            // trimmed text (not the overshoot) is what stays on screen.
            if (threadIsVisible()) renderStreamingUpdate(assistantMsg);
            return;
          }
        } else if (chunkCount <= 3) {
          console.log('[stream] Unparsed line ' + chunkCount + ':', JSON.stringify(line.trim().slice(0, 200)));
        }
      }
      const now = Date.now();
      if (now - lastRender > 80 && threadIsVisible()) {
        renderStreamingUpdate(assistantMsg);
        lastRender = now;
      }
      // Persist partial progress locally every ~2.5s. Less load-bearing than
      // it used to be (the server-side spool is now the source of truth for
      // recovery), but it keeps the thread preview fresh and covers the
      // legacy direct path.
      if (now - lastSave > 2500) {
        saveState({ skipServerSchedule: true });
        lastSave = now;
      }
    },
    // Parse any trailing partial line once the stream/transcript is complete.
    // SSE events are newline-terminated so this is almost always empty, but a
    // final unterminated JSON line (non-stream responses, abrupt closes) still
    // deserves a parse attempt rather than a console shrug.
    flush() {
      if (assistantMsg.smartCapped) { lineBuf = ''; return; }
      const tail = (lineBuf + decoder.decode()).trim();
      lineBuf = '';
      if (tail) {
        const result = extractTokenFromLine(tail);
        if (result) {
          processStreamDelta(assistantMsg, result.text, result.field);
          maybeApplySmartLimit(assistantMsg);
        }
      }
    },
    stats() { return { chunkCount }; }
  };
}

/**
 * Try to create a detached job. Returns the job id, or null when the relay
 * isn't available (file://, old fileserver) — callers then use the legacy
 * direct stream.
 */
async function startGenerationJob(thread, requestBody) {
  if (jobsAvailable === false) return null;
  try {
    const r = await privacyFetch(`${JOBS_URL}?thread=${encodeURIComponent(thread.id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });
    if (r.status === 404 || r.status === 405) {
      // Route doesn't exist: raw llama-server (file://) or a pre-jobs
      // fileserver.ps1. Remember and stop probing.
      jobsAvailable = false;
      console.log('[jobs] /llm/jobs not available — using legacy direct streaming');
      return null;
    }
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`job start failed: HTTP ${r.status}${body ? ' — ' + body.slice(0, 200) : ''}`);
    }
    const j = await r.json();
    if (!j || !j.id) throw new Error('job start: malformed response');
    jobsAvailable = true;
    return j.id;
  } catch (err) {
    if (jobsAvailable === true) throw err;   // relay is known-good → surface the real error
    console.warn('[jobs] probe failed, falling back to direct stream this turn:', err.message);
    return null;                             // stays null → re-probe next send
  }
}

/**
 * Poll a job to a terminal state, feeding transcript bytes to `feeder`.
 * Never gives up on transient network errors alone (the whole point is
 * surviving flaky moments) — but ~30s of continuous unreachability returns
 * 'unreachable' so the UI can tell the user to reload-and-reattach.
 */
async function pollJobToCompletion(jobId, feeder, startOffset = 0) {
  let offset = startOffset;
  let idleDelay = 120;
  let consecutiveFailures = 0;
  while (true) {
    let r, j;
    try {
      r = await privacyFetch(`${JOBS_URL}/${jobId}?from=${offset}`, { cache: 'no-store' });
      if (r.status === 404) return { status: 'lost', offset };
      if (r.status === 401) return { status: 'unauthorized', offset };
      if (!r.ok) throw new Error('HTTP ' + r.status);
      j = await r.json();
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures++;
      if (consecutiveFailures >= 50) return { status: 'unreachable', offset };
      await _wakeableSleep(600);   // 'online' / app-return cuts this short — retry the moment connectivity plausibly returns
      continue;
    }
    if (j.chunk_b64) {
      feeder.feed(_b64ToBytes(j.chunk_b64));
      offset = (typeof j.next === 'number') ? j.next : offset;
      idleDelay = 120;
    }
    const drained = (typeof j.size === 'number') ? (offset >= j.size) : !j.chunk_b64;
    if (j.status === 'running') {
      if (!drained) continue;                       // backlog: pull again immediately
      const cancelPending = currentJob && currentJob.id === jobId && currentJob.cancelSent;
      await _wakeableSleep(j.chunk_b64 ? 90 : (cancelPending ? 120 : Math.min(idleDelay += 40, 450)));
      continue;
    }
    if (!drained) continue;                         // terminal, but bytes remain — drain fully
    // started_at / updated_at ride along on the status file (updated_at is
    // stamped when the worker writes the terminal status) — hand them up so
    // the response timer stays accurate for jobs that finished while the
    // tab was away. Absent on pre-timing fileservers; callers fall back.
    return { status: j.status, error: j.error, offset,
             startedAt: (typeof j.started_at === 'number') ? j.started_at : null,
             updatedAt: (typeof j.updated_at === 'number') ? j.updated_at : null };
  }
}

/**
 * The shared generation transport. Streams one turn into `assistantMsg`,
 * via the job relay when available, else the legacy direct fetch. Pure
 * transport + parsing: finalizeStreamMessage(), isGenerating flips, scroll
 * settling, and chain logic stay with the callers.
 *
 * opts.resumeJobId — reattach to an existing job (skips the POST) and
 * replay/follow its transcript from opts.fromOffset (default 0).
 *
 * Returns { errored, aborted, errorMessage, errorObj, jobMode }.
 */
async function runGenerationStream(thread, assistantMsg, requestBody, opts = {}) {
  const feeder = makeStreamFeeder(assistantMsg, thread);
  let errored = false, aborted = false, errorMessage = null, errorObj = null;

  let jobId = opts.resumeJobId || null;
  if (!jobId && requestBody) {
    try {
      jobId = await startGenerationJob(thread, requestBody);
    } catch (err) {
      return { errored: true, aborted: false, errorMessage: err.message, errorObj: err, jobMode: true };
    }
  }

  if (jobId) {
    currentJob = { id: jobId, threadId: thread.id, cancelSent: false };
    // Breadcrumbs for resume-after-navigation. Persisted immediately: if the
    // user navigates one second from now, these are what boot follows back.
    assistantMsg.jobId = jobId;
    thread.pendingJob = { id: jobId, startedAt: Date.now() };
    saveState({ skipServerSchedule: true });
    renderSidebar();   // surface the generating dot right away

    const res = await pollJobToCompletion(jobId, feeder, opts.fromOffset || 0);
    feeder.flush();

    if (res.status === 'cancelled') {
      aborted = true;
    } else if (res.status === 'error') {
      errored = true; errorMessage = res.error || 'generation failed upstream';
    } else if (res.status === 'interrupted') {
      errored = true; errorMessage = 'the file server restarted mid-generation';
    } else if (res.status === 'lost') {
      errored = true; errorMessage = 'generation record no longer on the server (restarted or cleaned up)';
    } else if (res.status === 'unauthorized') {
      errored = true; errorMessage = 'file-server login session expired — reload the page and sign in to re-attach';
    } else if (res.status === 'unreachable') {
      errored = true; errorMessage = 'lost contact with the file server mid-generation — the reply may still be completing; reload to re-attach';
    }

    // 'unreachable' keeps the breadcrumb ON PURPOSE: the job is likely still
    // running server-side and a reload should re-attach. Every other outcome
    // is terminal — clear the markers and ack so the spool gets cleaned up.
    if (res.status !== 'unreachable') {
      delete thread.pendingJob;
      delete assistantMsg.jobId;
      privacyFetch(`${JOBS_URL}/${jobId}`, { method: 'DELETE' }).catch(() => {});
    }
    if (currentJob && currentJob.id === jobId) currentJob = null;
    return { errored, aborted, errorMessage, errorObj, jobMode: true,
             startedAt: res.startedAt || null, updatedAt: res.updatedAt || null };
  }

  // ── Legacy direct stream (file:// mode, or a fileserver without jobs) ──
  try {
    const resp = await privacyFetch(LLAMA_URL + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: abortController ? abortController.signal : undefined
    });
    if (!resp.ok) throw new Error(`llama-server returned ${resp.status}: ${resp.statusText}`);
    const reader = resp.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      feeder.feed(value);
    }
    feeder.flush();
  } catch (err) {
    if (err.name === 'AbortError') aborted = true;
    else { errored = true; errorMessage = err.message; errorObj = err; }
  }
  return { errored, aborted, errorMessage, errorObj, jobMode: false };
}

/**
 * Shared post-transport bookkeeping for aborts and errors. `style` picks the
 * error voice: 'diagnostic' (sendMessage's connection-triage block) or
 * 'plain'. One deliberate change from the old code: when tokens already
 * arrived, an error APPENDS a note instead of replacing the reply — a
 * mid-stream failure shouldn't vaporize three paragraphs of good text.
 */
function applyGenerationOutcome(assistantMsg, outcome, style) {
  if (outcome.aborted) {
    if (assistantMsg.smartCapped) {
      // Smart token limit trim — expected behavior, not an interruption.
      // The ✂ badge in the message header tells the story; a content note
      // would clutter every capped reply AND get fed back to the model as
      // part of the conversation on later turns.
      return;
    }
    if (_cotCulledFlag) {
      const mins = state.settings.cotTimeoutMinutes || 2;
      assistantMsg.content += `\n\n*(auto-stopped — runtime exceeded ${mins} min limit. If this happens often, raise the timer in CONFIG.)*`;
    } else {
      assistantMsg.content += '\n\n*(generation stopped)*';
    }
    return;
  }
  if (!outcome.errored) return;

  const hadText = !!((assistantMsg.content || '').trim() || (assistantMsg.reasoning || '').trim());
  if (hadText) {
    assistantMsg.content += `\n\n*(interrupted — ${outcome.errorMessage || 'generation failed'})*`;
    return;
  }
  if (style === 'diagnostic') {
    const err = outcome.errorObj || { name: 'Error', message: outcome.errorMessage || 'generation failed' };
    let diag = `**Connection Error**\n\n`;
    diag += `**Error type:** ${err.name}\n**Message:** ${err.message}\n\n`;
    if (err.message === 'Failed to fetch' || err.name === 'TypeError') {
      diag += `**Likely cause:** CORS block or llama-server not running.\n`;
      diag += `Launch chat via **launch.bat**, not by opening chat.html directly.\n`;
    } else if ((err.message || '').includes('404')) {
      diag += `**Cause:** Endpoint not found. Make sure llama-server is running with --api-key disabled.\n`;
    }
    assistantMsg.content = diag;
  } else {
    assistantMsg.content = `**Error:** ${outcome.errorMessage || 'generation failed'}`;
  }
}

/* ================================================================
   THINKING FORMAT REGISTRY
   Each format describes how a model emits its chain-of-thought
   inside the raw content stream. Some servers pre-split reasoning
   into a separate field (handled above as field='reasoning'); this
   registry handles the case where reasoning arrives INLINE in
   field='content' and needs to be extracted client-side.

   Known formats:
     'none'     — no thinking; content is content. Llama, Mistral,
                  Phi, base Gemma 3 (without /think mode), etc.
     'deepseek' — <think>...</think> tags. The de-facto open-weights
                  standard. Covers DeepSeek-R1, Qwen3 thinking, QwQ,
                  GLM-4.5/4.6 thinking, Hunyuan thinking, Granite
                  thinking, and most reasoning distills. Some chat
                  templates force-open <think> in the prompt, so
                  the model's output may start with reasoning and
                  only emit </think> — we detect that case too.
     'harmony'  — gpt-oss channels:
                  <|channel|>analysis<|message|>...<|end|>
                  <|start|>assistant<|channel|>final<|message|>...
                  Used by gpt-oss-20b and gpt-oss-120b.
     'gemma'    — Gemma's <channel|> marker. Mostly historical now
                  that llama.cpp routes Gemma reasoning into the
                  reasoning_content field automatically; kept for
                  backward compatibility with existing chats.

   Aliases (so users typing the older or vendor name still works):
     'qwen', 'qwen3', 'r1', 'reasoning', 'think', 'think_tags' -> 'deepseek'
     'gpt-oss', 'gpt_oss', 'oss', 'openai', 'channels' -> 'harmony'
     '' / null / undefined -> 'none'
================================================================ */
const THINKING_FORMAT_ALIASES = {
  '': 'none', 'off': 'none', 'plain': 'none',
  'qwen': 'deepseek', 'qwen3': 'deepseek',
  'r1': 'deepseek', 'reasoning': 'deepseek',
  'think': 'deepseek', 'think_tags': 'deepseek',
  'thinking': 'deepseek',
  'gpt-oss': 'harmony', 'gpt_oss': 'harmony', 'gptoss': 'harmony',
  'oss': 'harmony', 'openai': 'harmony', 'channels': 'harmony'
};

function normalizeThinkingFormat(fmt) {
  const k = (fmt || 'none').toLowerCase();
  if (k in THINKING_FORMAT_ALIASES) return THINKING_FORMAT_ALIASES[k];
  if (['none', 'deepseek', 'harmony', 'gemma'].includes(k)) return k;
  return 'none';
}

/**
 * Returns the largest prefix of `text` we can safely flush WITHOUT
 * accidentally cutting a marker in half. Holds back up to (marker.length-1)
 * trailing chars in case a marker is mid-stream.
 */
function safeFlushLength(text, markers) {
  // Find the longest possible partial-match suffix across all markers
  let holdBack = 0;
  for (const marker of markers) {
    if (!marker) continue;
    const maxCheck = Math.min(marker.length - 1, text.length);
    for (let n = maxCheck; n > holdBack; n--) {
      if (text.slice(text.length - n) === marker.slice(0, n)) {
        holdBack = n;
        break;
      }
    }
  }
  return Math.max(0, text.length - holdBack);
}

/**
 * Per-message stream parser. Maintains state on msg._parseState,
 * routes reasoning vs content into msg.reasoning / msg.content based
 * on the active thinking format.
 *
 * Call from the streaming loop for every (text, field) extracted.
 *
 * field='reasoning' is trusted as-is (server pre-extracted it).
 * field='content' is parsed according to the format.
 */
function processStreamDelta(msg, deltaText, field) {
  if (!deltaText) return;
  const fmt = normalizeThinkingFormat(activeModel && activeModel.thinkingFormat);

  // Initialize per-message state on first delta
  if (!msg._parseState) {
    msg._parseState = {
      // 'pre'       — haven't decided yet (deepseek/gemma: tokens may be implicit-think)
      // 'thinking'  — buffering into msg.reasoning
      // 'content'   — buffering into msg.content
      // 'between'   — harmony only: between channels
      phase: (fmt === 'deepseek' || fmt === 'harmony' || fmt === 'gemma') ? 'pre' : 'content',
      pending: ''
    };
  }
  const state = msg._parseState;

  // Server already routed this as reasoning — trust it.
  if (field === 'reasoning') {
    msg.reasoning = (msg.reasoning || '') + deltaText;
    // Once we've seen any server-side reasoning, we know subsequent
    // 'content' tokens are the final answer. Skip inline parsing.
    state.serverSplit = true;
    state.phase = 'thinking_done';
    return;
  }

  // field === 'content'
  if (state.serverSplit || fmt === 'none') {
    msg.content += deltaText;
    return;
  }

  // Inline parser based on format
  state.pending += deltaText;
  if (fmt === 'deepseek')      processDeepseekStream(msg, state);
  else if (fmt === 'harmony')  processHarmonyStream(msg, state);
  else if (fmt === 'gemma')    processGemmaStream(msg, state);
  else { msg.content += state.pending; state.pending = ''; }
}

/**
 * deepseek-style: <think>...</think>
 * Handles both explicit (model emits both tags) and implicit (chat
 * template force-opens <think>, so model only emits </think>) cases.
 */
function processDeepseekStream(msg, state) {
  const OPEN  = '<think>';
  const CLOSE = '</think>';
  const markers = [OPEN, CLOSE];

  // Loop because a single delta may close one phase and open another
  while (state.pending) {
    if (state.phase === 'pre') {
      // Look for whichever marker comes first
      const openIdx  = state.pending.indexOf(OPEN);
      const closeIdx = state.pending.indexOf(CLOSE);

      // Found explicit <think> — anything before it is content
      if (openIdx >= 0 && (closeIdx < 0 || openIdx < closeIdx)) {
        if (openIdx > 0) msg.content += state.pending.slice(0, openIdx);
        state.pending = state.pending.slice(openIdx + OPEN.length);
        state.phase = 'thinking';
        continue;
      }

      // Found </think> first → implicit thinking (open tag was in prompt)
      if (closeIdx >= 0) {
        msg.reasoning = (msg.reasoning || '') + state.pending.slice(0, closeIdx);
        state.pending = state.pending.slice(closeIdx + CLOSE.length);
        state.phase = 'content';
        continue;
      }

      // No markers found yet. To allow live streaming of the implicit-
      // thinking case, route 'pre' tokens to reasoning provisionally.
      // If we never see </think>, finalizeStreamMessage() reparents
      // anything mistakenly classified as reasoning back to content.
      const safe = safeFlushLength(state.pending, markers);
      if (safe > 0) {
        msg.reasoning = (msg.reasoning || '') + state.pending.slice(0, safe);
        state.pending = state.pending.slice(safe);
      }
      // Once we've buffered enough without seeing any tag, give up
      // and switch to content — this is a non-thinking model masquerading
      // as one (or thinking was disabled).
      if ((msg.reasoning || '').length > 64 && !state.pending.includes('<')) {
        msg.content += msg.reasoning;
        msg.reasoning = '';
        state.phase = 'content';
        continue;
      }
      break;
    }

    if (state.phase === 'thinking') {
      const closeIdx = state.pending.indexOf(CLOSE);
      if (closeIdx >= 0) {
        msg.reasoning = (msg.reasoning || '') + state.pending.slice(0, closeIdx);
        state.pending = state.pending.slice(closeIdx + CLOSE.length);
        state.phase = 'content';
        continue;
      }
      const safe = safeFlushLength(state.pending, [CLOSE]);
      if (safe > 0) {
        msg.reasoning = (msg.reasoning || '') + state.pending.slice(0, safe);
        state.pending = state.pending.slice(safe);
      }
      break;
    }

    if (state.phase === 'content') {
      // After </think> we still strip stray <think> if a model loops
      const openIdx = state.pending.indexOf(OPEN);
      if (openIdx >= 0) {
        msg.content += state.pending.slice(0, openIdx);
        state.pending = state.pending.slice(openIdx + OPEN.length);
        state.phase = 'thinking';
        continue;
      }
      const safe = safeFlushLength(state.pending, [OPEN]);
      if (safe > 0) {
        msg.content += state.pending.slice(0, safe);
        state.pending = state.pending.slice(safe);
      }
      break;
    }
    break;
  }
}

/**
 * harmony (gpt-oss): channels separated by Harmony tokens.
 *   <|channel|>analysis<|message|>...<|end|>
 *   <|start|>assistant<|channel|>final<|message|>...
 *   <|return|>
 * The 'commentary' channel (tool calls) is folded into reasoning so
 * users can see it but it doesn't pollute the main response.
 */
function processHarmonyStream(msg, state) {
  // Markers we care about. The set of literal sequences that may appear
  // mid-stream — used both for matching and for safe-flush hold-back.
  const ANALYSIS_OPEN  = '<|channel|>analysis<|message|>';
  const FINAL_OPEN     = '<|channel|>final<|message|>';
  const COMMENT_OPEN   = '<|channel|>commentary<|message|>';
  const END            = '<|end|>';
  const RETURN         = '<|return|>';
  const START          = '<|start|>';
  const allMarkers = [ANALYSIS_OPEN, FINAL_OPEN, COMMENT_OPEN, END, RETURN, START,
                      '<|channel|>', '<|message|>'];

  const findFirst = (haystack, needles) => {
    let bestIdx = -1, bestNeedle = null;
    for (const n of needles) {
      const i = haystack.indexOf(n);
      if (i >= 0 && (bestIdx < 0 || i < bestIdx)) { bestIdx = i; bestNeedle = n; }
    }
    return { idx: bestIdx, needle: bestNeedle };
  };

  while (state.pending) {
    if (state.phase === 'pre') {
      // Skip until first channel marker. Anything before it (preamble,
      // role tokens, etc.) is dropped.
      const m = findFirst(state.pending, [ANALYSIS_OPEN, FINAL_OPEN, COMMENT_OPEN]);
      if (m.idx >= 0) {
        state.pending = state.pending.slice(m.idx + m.needle.length);
        state.phase = (m.needle === FINAL_OPEN) ? 'content' : 'thinking';
        continue;
      }
      // Hold back tail in case marker is mid-stream
      const safe = safeFlushLength(state.pending, allMarkers);
      // Drop the safe portion (it's pre-stream noise like role headers)
      state.pending = state.pending.slice(safe);
      break;
    }

    if (state.phase === 'thinking') {
      // End thinking on <|end|>, <|return|>, or transition to final/commentary
      const m = findFirst(state.pending, [END, RETURN, FINAL_OPEN, COMMENT_OPEN]);
      if (m.idx >= 0) {
        msg.reasoning = (msg.reasoning || '') + state.pending.slice(0, m.idx);
        state.pending = state.pending.slice(m.idx + m.needle.length);
        if (m.needle === FINAL_OPEN)        state.phase = 'content';
        else if (m.needle === COMMENT_OPEN) state.phase = 'thinking'; // stay
        else                                 state.phase = 'between'; // <|end|>
        continue;
      }
      const safe = safeFlushLength(state.pending, allMarkers);
      if (safe > 0) {
        msg.reasoning = (msg.reasoning || '') + state.pending.slice(0, safe);
        state.pending = state.pending.slice(safe);
      }
      break;
    }

    if (state.phase === 'between') {
      // After <|end|>, look for next channel marker
      const m = findFirst(state.pending, [ANALYSIS_OPEN, FINAL_OPEN, COMMENT_OPEN]);
      if (m.idx >= 0) {
        // Drop everything before (it's role/start tokens)
        state.pending = state.pending.slice(m.idx + m.needle.length);
        state.phase = (m.needle === FINAL_OPEN) ? 'content' : 'thinking';
        continue;
      }
      const safe = safeFlushLength(state.pending, allMarkers);
      state.pending = state.pending.slice(safe);
      break;
    }

    if (state.phase === 'content') {
      const m = findFirst(state.pending, [END, RETURN]);
      if (m.idx >= 0) {
        msg.content += state.pending.slice(0, m.idx);
        state.pending = state.pending.slice(m.idx + m.needle.length);
        state.phase = 'done';
        continue;
      }
      const safe = safeFlushLength(state.pending, allMarkers);
      if (safe > 0) {
        msg.content += state.pending.slice(0, safe);
        state.pending = state.pending.slice(safe);
      }
      break;
    }

    // 'done' or unknown — drop the rest
    state.pending = '';
    break;
  }
}

/**
 * Gemma channel format: <channel|> separates reasoning from final.
 * Mostly handled by the server-side jinja reasoning extractor (which
 * routes Gemma reasoning into the reasoning_content field), but kept
 * as a fallback for when a user runs without --reasoning-format gemma
 * and the marker arrives inline in content.
 */
function processGemmaStream(msg, state) {
  const MARKER = '<channel|>';
  const HEADER = '<|channel>thought';
  const markers = [MARKER, HEADER];

  while (state.pending) {
    if (state.phase === 'pre' || state.phase === 'thinking') {
      // Strip optional header tag at start
      if (state.pending.startsWith(HEADER)) {
        state.pending = state.pending.slice(HEADER.length).replace(/^\n/, '');
        state.phase = 'thinking';
        continue;
      }
      const idx = state.pending.indexOf(MARKER);
      if (idx >= 0) {
        msg.reasoning = (msg.reasoning || '') + state.pending.slice(0, idx);
        state.pending = state.pending.slice(idx + MARKER.length);
        state.phase = 'content';
        continue;
      }
      const safe = safeFlushLength(state.pending, markers);
      if (safe > 0) {
        msg.reasoning = (msg.reasoning || '') + state.pending.slice(0, safe);
        state.pending = state.pending.slice(safe);
      }
      // Implicit-thinking give-up: if we've buffered a fair amount in 'pre'
      // and there's no '<' anywhere in pending, this isn't a Gemma channel
      // stream — reparent reasoning -> content.
      if (state.phase === 'pre' && (msg.reasoning || '').length > 64 && !state.pending.includes('<')) {
        msg.content += msg.reasoning;
        msg.reasoning = '';
        state.phase = 'content';
        continue;
      }
      break;
    }
    // content phase
    msg.content += state.pending;
    state.pending = '';
    break;
  }
}

/* ================================================================
   TOOL-CALL ENVELOPE UNWRAP

   Some models — most notably Meta's Llama 3.x, whose embedded chat
   template advertises tool/function calling — reply to ordinary chat
   by wrapping the plain text in a JSON "function call" envelope
   instead of just speaking. A bare "hello" comes back as:

       {"name": "print", "parameters": {"s": "Hello, friend!"}}

   We never send a `tools` array on our requests, so llama-server has
   no tool schema to bind this to; it leaves the JSON verbatim in
   `content`, and it renders in the chat box as raw JSON. This unwraps
   that envelope back to the human-facing text ("Hello, friend!").

   It is deliberately strict: it only fires when the ENTIRE message is
   a single such envelope, so a normal reply that merely happens to
   contain JSON is never altered. On any non-matching input it returns
   the original text unchanged (a true no-op), which keeps every other
   model's output untouched.
================================================================ */

// Argument keys that, when present, hold the text the model meant to "say".
// Covers the common shapes across Llama/Mistral/generic tool templates.
const TOOLCALL_TEXT_KEYS = [
  's', 'text', 'content', 'message', 'response',
  'output', 'answer', 'reply', 'value', 'say', 'msg'
];

/**
 * If `raw` is exactly a single tool-call envelope wrapping plain text,
 * return that inner text. Otherwise return null (caller leaves text as-is).
 */
function extractToolCallText(raw) {
  if (!raw) return null;
  const t = raw.trim();
  // Must be a lone JSON object that constitutes the whole message.
  if (t.charAt(0) !== '{' || t.charAt(t.length - 1) !== '}') return null;
  // Cheap structural pre-check so we don't JSON.parse every message.
  if (!/"name"\s*:/.test(t)) return null;
  if (!/"(?:parameters|arguments)"\s*:/.test(t)) return null;

  let obj;
  try { obj = JSON.parse(t); } catch (e) { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (typeof obj.name !== 'string') return null;

  let args = (obj.parameters != null) ? obj.parameters : obj.arguments;
  if (args == null) return null;
  // Some servers double-encode the arguments as a JSON string.
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch (e) { return args; } // plain string arg
  }
  if (typeof args === 'string') return args;
  if (typeof args !== 'object' || Array.isArray(args)) return null;

  // Prefer a recognized "say this" field.
  for (const k of TOOLCALL_TEXT_KEYS) {
    if (typeof args[k] === 'string') return args[k];
  }
  // Fallback: a single string-valued argument is almost certainly the text.
  const strVals = Object.keys(args)
    .map(k => args[k])
    .filter(v => typeof v === 'string');
  if (strVals.length === 1) return strVals[0];

  return null;
}

/** No-op-safe wrapper: returns unwrapped text, or the original if not an envelope. */
function unwrapToolCallText(raw) {
  const inner = extractToolCallText(raw);
  return (inner == null) ? raw : inner;
}

/**
 * Best-effort unwrap for the LIVE streaming view, where `raw` may be a
 * still-incomplete envelope (the closing braces haven't arrived yet).
 * Only engages once the content clearly opens with a tool-call envelope,
 * so normal replies stream exactly as before. While the inner string is
 * mid-stream we surface what we have so the user sees clean text building
 * up instead of raw JSON braces; finalizeStreamMessage() does the strict,
 * authoritative unwrap when the stream ends.
 */
function unwrapToolCallTextLive(raw) {
  if (!raw) return raw;
  const t = raw.trim();
  // Only intervene when this looks like a tool-call envelope from the start.
  if (!/^\{\s*"name"\s*:/.test(t)) return raw;

  // If it's already complete and parseable, use the strict result.
  const strict = extractToolCallText(t);
  if (strict != null) return strict;

  // Partial: tolerantly pull the in-progress text value of the first
  // recognized key. Handles escaped quotes inside the string.
  const keyGroup = TOOLCALL_TEXT_KEYS.join('|');
  const m = t.match(new RegExp('"(?:' + keyGroup + ')"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)'));
  if (m) {
    try { return JSON.parse('"' + m[1] + '"'); } catch (e) { return m[1]; }
  }
  // Envelope opened but no text field yet — show nothing rather than braces.
  return '';
}

/**
 * Called once at end-of-stream to flush any held-back buffer and
 * scrub any stray markers that slipped through (e.g., truncated
 * stream where the model never emitted a closing tag).
 */
function finalizeStreamMessage(msg) {
  const fmt = normalizeThinkingFormat(activeModel && activeModel.thinkingFormat);
  const state = msg._parseState;
  if (state) {
    // Flush any pending bytes to the bucket we were last in
    if (state.pending) {
      if (state.phase === 'thinking' || state.phase === 'pre') {
        msg.reasoning = (msg.reasoning || '') + state.pending;
      } else {
        msg.content += state.pending;
      }
      state.pending = '';
    }

    // Implicit-think give-up: in 'pre' phase for deepseek/gemma, we routed
    // tokens to reasoning provisionally. If we never saw the close marker
    // AND we never collected anything to content, treat this as a non-thinking
    // model and reparent reasoning -> content.
    if ((fmt === 'deepseek' || fmt === 'gemma') && state.phase === 'pre' && !msg.content && msg.reasoning) {
      msg.content = msg.reasoning;
      msg.reasoning = '';
    }
  }

  // Scrub stray markers (per format)
  if (msg.reasoning) {
    if (fmt === 'gemma') {
      msg.reasoning = msg.reasoning
        .replace(/^<\|channel>thought\n?/i, '')
        .replace(/<channel\|>\s*$/i, '');
    } else if (fmt === 'deepseek') {
      msg.reasoning = msg.reasoning
        .replace(/^<think>\s*/i, '')
        .replace(/<\/think>\s*$/i, '');
    } else if (fmt === 'harmony') {
      msg.reasoning = msg.reasoning
        .replace(/<\|(?:end|return|start|message|channel)\|>/g, '');
    }
    msg.reasoning = msg.reasoning.trim();
  }
  if (msg.content) {
    if (fmt === 'gemma') {
      msg.content = msg.content.replace(/^<channel\|>\s*/i, '');
    } else if (fmt === 'deepseek') {
      msg.content = msg.content
        .replace(/^<\/think>\s*/i, '')
        .replace(/^<think>[\s\S]*?<\/think>\s*/i, ''); // belt+suspenders
    } else if (fmt === 'harmony') {
      msg.content = msg.content
        .replace(/<\|(?:end|return|start|message|channel)\|>/g, '');
    }
    msg.content = msg.content.trim();

    // Llama 3.x (and similar) sometimes wrap a plain reply in a JSON
    // function-call envelope, e.g. {"name":"print","parameters":{"s":"Hi"}}.
    // Unwrap it back to the human-facing text. No-op on normal replies.
    msg.content = unwrapToolCallText(msg.content).trim();
  }

  delete msg._parseState;
}

/**
 * DIAGNOSTIC: Make a raw non-streaming request and dump the full response.
 * Run from browser console:  testRawResponse("Hello")
 *
 * Useful for debugging thinking-token formats — shows whether the server
 * is splitting reasoning into reasoning_content (preferred) or leaving
 * it inline in content with raw markers we then need to parse.
 */
async function testRawResponse(prompt) {
  console.log('=== RAW RESPONSE TEST ===');
  console.log('Active model:', activeModel.name, '— format:', normalizeThinkingFormat(activeModel.thinkingFormat));
  try {
    const resp = await fetch(LLAMA_URL + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'local',
        messages: [{ role: 'user', content: prompt || 'Say hello in one sentence.' }],
        stream: false
      })
    });
    const raw = await resp.text();
    console.log('HTTP', resp.status, '— Full response:');
    console.log(raw);
    try {
      const json = JSON.parse(raw);
      if (json.choices && json.choices[0] && json.choices[0].message) {
        const m = json.choices[0].message;
        const content = m.content || '';
        const reasoning = m.reasoning_content || m.reasoning || '';
        console.log('--- message.content:', JSON.stringify(content));
        console.log('--- message.reasoning_content:', JSON.stringify(reasoning));
        // Probe for known thinking markers in either field
        const probes = {
          'deepseek <think>':   /<think>/.test(content) || /<think>/.test(reasoning),
          'deepseek </think>':  /<\/think>/.test(content) || /<\/think>/.test(reasoning),
          'harmony <|channel|>': /<\|channel\|>/.test(content) || /<\|channel\|>/.test(reasoning),
          'gemma <channel|>':    /<channel\|>/.test(content)   || /<channel\|>/.test(reasoning)
        };
        for (const [k, v] of Object.entries(probes)) console.log('---', k, ':', v);
      }
    } catch (e) {}
  } catch (e) { console.error('Fetch failed:', e); }
  console.log('=== END TEST ===');
}

