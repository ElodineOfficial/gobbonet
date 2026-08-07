/* @gobbonet-split js/02-model.js
   Moved verbatim from chat.html lines 1559-2019.
   active model state, identification, models list, hot-swap
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   ACTIVE MODEL STATE
   Populated on startup by fetching /active-model.json (written by
   launch.bat). Falls back to registry defaults if not served.
================================================================ */
let activeModel = MODEL_REGISTRY['custom'];

// Tracks the GGUF filename currently loaded by llama-server. Used by the
// header dropdown to revert the selection if a hot-swap fails, and to
// short-circuit no-op changes (selecting the model that's already active).
let _currentModelFile = null;

async function loadActiveModel() {
  if (!IS_SERVED) return; // file:// — can't fetch
  try {
    const r = await fetch('/active-model.json', { cache: 'no-store' });
    if (!r.ok) return;
    const data = await r.json();
    _currentModelFile = data.ggufFile || null;
    // Prefer registry entry if we know this model, else build from JSON
    activeModel = MODEL_REGISTRY[data.id] || {
      name: data.name || data.ggufFile || 'Unknown Model',
      family: data.family || 'custom',
      maxCtx: data.maxCtx || 131072,
      defaultCtx: data.defaultCtx || 24576,
      thinkingFormat: normalizeThinkingFormat(data.thinkingFormat),
      hint: 'Loaded from active-model.json. Adjust context limit based on your VRAM.'
    };
    // Always normalize the active format (registry entries may use aliases too)
    activeModel.thinkingFormat = normalizeThinkingFormat(activeModel.thinkingFormat);
    // Update the ctx hint (still used in Settings)
    updateModelHint(activeModel);
    // Update About modal stack line
    const aboutModelLine = document.getElementById('about-model-line');
    if (aboutModelLine) aboutModelLine.textContent = activeModel.name;
    // If user hasn't customised the token limit yet, suggest the model default
    const tokInput = document.getElementById('set-tokens');
    if (tokInput && (!state.settings.tokenLimit || state.settings.tokenLimit === 24576)) {
      tokInput.value = activeModel.defaultCtx;
      state.settings.tokenLimit = activeModel.defaultCtx;
      saveState();
    }
  } catch (e) {
    // Silently ignore — file server may not be running (direct file:// access)
  }
}

function updateModelHint(modelDef) {
  const hint = document.getElementById('model-hint');
  if (hint && modelDef) hint.textContent = modelDef.hint;
  const ctxHint = document.getElementById('ctx-hint');
  if (ctxHint && modelDef) {
    const maxK = Math.round(modelDef.maxCtx / 1024);
    ctxHint.textContent = `Input context budget — 90% reserved for system prompt, lore, and history. Max for ${modelDef.name}: ${maxK}K tokens. Actual capacity depends on VRAM and KV cache quantization.`;
  }
  // Update token input max
  const tokInput = document.getElementById('set-tokens');
  if (tokInput && modelDef) tokInput.max = modelDef.maxCtx;
}

/* ================================================================
   MODEL FILENAME IDENTIFICATION (mirrors launch.bat :identify_model)

   Order matters — most specific first so 'gemma-4' isn't caught by
   the looser 'gemma' rule, and 'qwen3' beats plain 'qwen'.

   thinkingFormat values:
     none      — no thinking (Llama, Mistral, Phi, base Gemma 3)
     deepseek  — <think>...</think>  (DeepSeek-R1, Qwen3, QwQ, GLM
                  thinking, Granite thinking, Hunyuan thinking, etc.)
     harmony   — gpt-oss channels   (gpt-oss-20b, gpt-oss-120b)
     gemma     — Gemma <channel|> markers (Gemma 4)
================================================================ */
function identifyModelFromFilename(filename) {
  const f = filename.toLowerCase();

  // gpt-oss — Harmony channel format
  if (/gpt[\-_.]?oss/.test(f))    return { id: 'gpt-oss',  family: 'gpt-oss',  thinkingFormat: 'harmony' };

  // Gemma family — most specific first
  if (/gemma.?4/.test(f))         return { id: 'gemma4',   family: 'gemma',    thinkingFormat: 'gemma' };
  if (/gemma.?3/.test(f))         return { id: 'gemma3',   family: 'gemma',    thinkingFormat: 'none' };

  // DeepSeek-R1 + distills (Qwen3-distill, Llama-distill) — check BEFORE
  // qwen/llama rules, because distill filenames contain those keywords too
  if (/deepseek[\-_.]?r1|r1[\-_.]?distill/.test(f))
                                  return { id: 'deepseek-r1', family: 'deepseek', thinkingFormat: 'deepseek' };
  if (/deepseek/.test(f))         return { id: 'deepseek', family: 'deepseek', thinkingFormat: 'deepseek' };

  // QwQ (always thinking) — check before plain qwen
  if (/qwq/.test(f))              return { id: 'qwq',      family: 'qwen',     thinkingFormat: 'deepseek' };
  if (/qwen.?3/.test(f))          return { id: 'qwen3',    family: 'qwen',     thinkingFormat: 'deepseek' };
  if (/qwen/.test(f))             return { id: 'qwen',     family: 'qwen',     thinkingFormat: 'deepseek' };

  // GLM family (Z.ai / Zhipu / THUDM) -- mirrors the dispatch in
  // identify-model.ps1, kept in sync so MODEL_REGISTRY lookups succeed
  // (ps1 emits id, chat.html displays it). Order: most specific first.
  //
  // Coverage:
  //   glm-flash   - GLM-4.5V-Flash / 4.6V-Flash (9B dense, thinking, vision)
  //   glm-air     - GLM-4.5-Air / 4.6-Air (106B MoE, workstation+)
  //   glm-z1-32b  - GLM-Z1-32B-0414 / Rumination-32B (reasoning, 24 GB)
  //   glm-z1-9b   - GLM-Z1-9B-0414 (reasoning, 8 GB sweet spot)
  //   glm-4-32b   - GLM-4-32B-0414 instruct (non-thinking, 24 GB)
  //   glm-big-moe - GLM-4.5/4.6/4.7/5/5.1 flagship MoE (multi-GPU)
  //   glm-4-9b    - GLM-4-9B-Chat 2024 original (non-thinking, 8 GB)
  if (/glm[\-_.]?\d(?:\.\d)?v[\-_.]?flash|glm[\-_.]?v[\-_.]?flash|glm[\-_.]?flash/.test(f))
                                  return { id: 'glm-flash',   family: 'glm',   thinkingFormat: 'deepseek' };
  if (/glm[\-_.]?\d(?:\.\d)?[\-_.]?air|glm[\-_.]?air/.test(f))
                                  return { id: 'glm-air',     family: 'glm',   thinkingFormat: 'deepseek' };
  if (/glm[\-_.]?z1[\-_.]?32|z1.+32b/.test(f))
                                  return { id: 'glm-z1-32b',  family: 'glm',   thinkingFormat: 'deepseek' };
  if (/glm[\-_.]?z1|z1[\-_.]?9b/.test(f))
                                  return { id: 'glm-z1-9b',   family: 'glm',   thinkingFormat: 'deepseek' };
  if (/glm[\-_.]?4[\-_.]?32b/.test(f))
                                  return { id: 'glm-4-32b',   family: 'glm',   thinkingFormat: 'none' };
  if (/glm[\-_.]?(?:4\.[5-9]|5(?:\.\d+)?)/.test(f))
                                  return { id: 'glm-big-moe', family: 'glm',   thinkingFormat: 'deepseek' };
  // Original GLM-4-9B-Chat and any generic glm-4 / chatglm fallthrough.
  // The /chatglm/ alternative catches THUDM's older naming; the explicit
  // /glm[\-_.]?4[\-_.]?9b/ matches the canonical filename; and the bare
  // /^glm[\-_.]?4(?![\.0-9])/ catches glm-4-base / glm-4-instruct etc.
  // without grabbing glm-4.5 (already handled above by the big-MoE rule).
  if (/glm[\-_.]?4[\-_.]?9b|chatglm|^glm[\-_.]?4(?![\.0-9])/.test(f))
                                  return { id: 'glm-4-9b',    family: 'glm',   thinkingFormat: 'none' };
  // Generic "glm + thinking/reasoning anywhere in filename" finetune.
  // Filename starts with glm and mentions think/reason -> treat as Z1.
  // The ps1 dispatch has the embedded template available and can confirm
  // <think> directly; we don't, so filename signal is best-effort here.
  if (/^glm.*(?:think|reason)/.test(f))
                                  return { id: 'glm-z1-9b',   family: 'glm',   thinkingFormat: 'deepseek' };
  // Anything else starting with glm: best guess is the 9B instruct line.
  if (/^glm[\-_.]/.test(f))       return { id: 'glm-4-9b',    family: 'glm',   thinkingFormat: 'none' };

  // IBM Granite — <think> in thinking variants
  if (/granite/.test(f))          return { id: 'granite',  family: 'granite',
                                           thinkingFormat: /think|reason/.test(f) ? 'deepseek' : 'none' };

  // Hunyuan — <think> in thinking variants
  if (/hunyuan/.test(f))          return { id: 'hunyuan',  family: 'hunyuan',
                                           thinkingFormat: /think|reason/.test(f) ? 'deepseek' : 'none' };

  // Llama, Mistral, Phi — no native thinking
  if (/llama/.test(f))            return { id: 'llama',    family: 'llama',    thinkingFormat: 'none' };

  // Mistral Nemo (and mergekit children) — check BEFORE plain 'mistral'.
  // Most Nemo merges don't contain "mistral" in the filename ("MN-Violet-Lotus",
  // "Rocinante-12B", "Magnum-v4-12B"), so the plain mistral rule below would
  // miss them. The actual --jinja workaround lives in launch.bat; here we
  // just need the id to match MODEL_REGISTRY['mistral-nemo'] for display.
  if (/mistral[\-_.]?nemo|(?:^|[\-_.])mn[\-_]|nemo/.test(f))
                                  return { id: 'mistral-nemo', family: 'mistral', thinkingFormat: 'none' };
  // Mistral Small 24B finetunes (Cydonia v4+, Asmodeus) — none of these
  // carry "mistral" in the filename, so without an explicit rule they fall
  // through to 'custom'. Match by finetune name so the UI labels them
  // correctly. The strict v7-tekken template they use is handled by the
  // message normalizer, so no special launch.bat flags are needed here.
  if (/cydonia|asmodeus|mistral[\-_.]?small/.test(f))
                                  return { id: 'mistral-small', family: 'mistral', thinkingFormat: 'none' };
  if (/mistral|mixtral/.test(f))  return { id: 'mistral',  family: 'mistral',  thinkingFormat: 'none' };
  if (/phi/.test(f))              return { id: 'phi',      family: 'phi',      thinkingFormat: 'none' };

  // Command R (Cohere). Match BEFORE the generic /think|reason/ fallback —
  // Cohere has "reasoning" in some model card copy and we don't want that
  // bleeding into thinkingFormat: 'deepseek'. The 7B (12-2024 release) is
  // Cohere2 arch and the only Command R variant we recommend for typical
  // 8-16 GB VRAM. Filenames in the wild: c4ai-command-r7b-12-2024-Q*.gguf,
  // c4ai-command-r-08-2024-Q*.gguf, c4ai-command-r-v01-Q*.gguf, plus
  // abliterated/finetune variants. Match r7b first so we don't tag a 7B as
  // the 35B; bare "command-r" / "c4ai" falls through to the 35B id.
  if (/c4ai[\-_.]?command[\-_.]?r[\-_.]?7|command[\-_.]?r[\-_.]?7b/.test(f))
                                  return { id: 'command-r7b',  family: 'cohere', thinkingFormat: 'none' };
  if (/command[\-_.]?r|c4ai/.test(f))
                                  return { id: 'command-r-35b', family: 'cohere', thinkingFormat: 'none' };

  // Generic "thinking" or "reasoning" in filename → assume deepseek-style
  if (/think|reason/.test(f))     return { id: 'custom',   family: 'custom',   thinkingFormat: 'deepseek' };

  return                                 { id: 'custom',   family: 'custom',   thinkingFormat: 'none' };
}

function modelDisplayName(filename, detected) {
  // Use registry name if known, else clean the filename
  const reg = MODEL_REGISTRY[detected.id];
  if (reg && reg.name !== 'Custom GGUF') return reg.name;
  // Strip .gguf and prettify
  return filename.replace(/\.gguf$/i, '').replace(/[-_]/g, ' ').trim();
}

/* ================================================================
   MODELS LIST — fetch models-list.json written by launch.bat
================================================================ */
async function loadModelsList() {
  const sel = document.getElementById('header-model-select');
  if (!sel) return;

  if (!IS_SERVED) {
    // Running as file:// — can't fetch. Just show active model name.
    sel.innerHTML = `<option value="${activeModel.id || 'custom'}">${activeModel.name}</option>`;
    return;
  }

  try {
    const r = await fetch('/models-list.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('not found');
    const data = await r.json();

    sel.innerHTML = '';
    const models = data.models || [];
    if (models.length === 0) {
      sel.innerHTML = `<option value="custom">${activeModel.name || 'Unknown'}</option>`;
      return;
    }

    models.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.file; // use filename as value — unambiguous
      opt.textContent = m.name;
      opt.dataset.id = m.id;
      opt.dataset.family = m.family;
      opt.dataset.thinkingFormat = m.thinkingFormat || 'none';
      if (m.active) opt.selected = true;
      sel.appendChild(opt);
    });

    // If nothing was marked active, select by matching activeModel
    if (!data.models.some(m => m.active)) {
      const match = [...sel.options].find(o => o.dataset.id === activeModel.id);
      if (match) sel.value = match.value;
    }
    // Whatever the dropdown ended up showing, that's our "current" for
    // revert-on-failure purposes. Prefer the explicit value from
    // active-model.json (set by loadActiveModel) if we have one.
    if (!_currentModelFile) _currentModelFile = sel.value || null;
  } catch (e) {
    // Fallback — just show what we already know is loaded
    sel.innerHTML = `<option value="${activeModel.id || 'custom'}">${activeModel.name || 'Model'}</option>`;
  }
}

/* ================================================================
   HEADER MODEL CHANGE — hot-swap the active GGUF via the file server.

   Flow:
     1. User picks a different option in the dropdown.
     2. We POST /swap-model {file:"<name>.gguf"} to fileserver.ps1.
     3. Fileserver kills the running llama-server, rewrites the launch
        script + active-model.json, spawns the new server detached,
        and returns 202 immediately.
     4. We poll /swap-status every ~1.5s until phase == "ready" (model
        loaded, /health returns ok) or phase == "error" (timeout, bad
        model, etc).
     5. On success: re-fetch active-model.json so the rest of the UI
        (token limits, thinking format, model hint) picks up the new
        metadata. On failure: revert the dropdown to the previous
        selection and surface the error in the toast.

   The launch.bat monitor loop watches for .swap-in-progress and skips
   its own restart while the lock exists, so we don't race with it.
================================================================ */
let _toastTimer = null;
let _swapInFlight = false;

async function onHeaderModelChange(sel) {
  const opt = sel.options[sel.selectedIndex];
  if (!opt || !opt.value) return;

  const newFile = opt.value;
  const newName = opt.textContent;

  // No-op: user re-selected the model that's already loaded.
  if (newFile === _currentModelFile) return;

  // file:// has no fileserver. Tell the user and revert.
  if (!IS_SERVED) {
    showModelSwitchToast('Hot-swap needs the file server. Open via http://...:8080', 'warn');
    if (_currentModelFile) sel.value = _currentModelFile;
    return;
  }

  // Reject overlapping swap requests.
  if (_swapInFlight) {
    showModelSwitchToast('Already swapping — please wait.', 'warn');
    if (_currentModelFile) sel.value = _currentModelFile;
    return;
  }

  const prevFile = _currentModelFile;
  const wrap = document.getElementById('header-model-wrap');

  _swapInFlight = true;
  sel.disabled = true;
  if (wrap) wrap.classList.add('swapping');
  showModelSwitchToast('Swapping to ' + newName + '...', 'info', 0);

  try {
    const r = await fetch('/swap-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: newFile })
    });
    if (!r.ok) {
      let msg = 'HTTP ' + r.status;
      try {
        const body = await r.json();
        if (body && body.message) msg = body.message;
      } catch (_) {}
      throw new Error(msg);
    }

    // Poll until the new server reports healthy or we hit the timeout.
    const result = await pollSwapStatus(180000); // 3 minutes
    if (!result || result.phase !== 'ready') {
      throw new Error((result && result.message) || 'Swap did not complete.');
    }

    // Refresh the active-model metadata so the rest of the UI updates.
    await loadActiveModel();
    _currentModelFile = newFile;
    showModelSwitchToast('Active: ' + newName, 'ok');
    console.log('[swap] active model is now', newFile);
  } catch (e) {
    console.warn('[swap] failed:', e);
    showModelSwitchToast('Swap failed: ' + e.message, 'err');
    if (prevFile) sel.value = prevFile;
  } finally {
    _swapInFlight = false;
    sel.disabled = false;
    if (wrap) wrap.classList.remove('swapping');
  }
}

/**
 * Poll /swap-status until the server tells us the swap is done.
 * Returns the final status object, or a synthetic error on timeout.
 * Network blips are tolerated — we keep polling until the wall clock
 * elapses past `timeoutMs`.
 */
async function pollSwapStatus(timeoutMs) {
  const start = Date.now();
  // Small grace period before the first poll — the server has just
  // killed and respawned llama-server.exe and may briefly be busy.
  await new Promise(r => setTimeout(r, 800));
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch('/swap-status', { cache: 'no-store' });
      if (r.ok) {
        const st = await r.json();
        if (st && (st.phase === 'ready' || st.phase === 'error')) return st;
      }
    } catch (_) {
      // Server temporarily unreachable — keep trying.
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  return { phase: 'error', message: 'Timed out waiting for model to load.' };
}

/**
 * Show the header toast. `kind` picks a colour: info (cyan), ok (green),
 * warn (amber), err (red). If `ms` is 0 the toast stays up until the
 * next call replaces or clears it (used while a swap is in flight).
 */
function showModelSwitchToast(msg, kind, ms) {
  const t = document.getElementById('model-switch-toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'visible';
  if (kind) t.classList.add('t-' + kind);
  if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }
  const ttl = (ms === 0) ? 0 : (typeof ms === 'number' ? ms : (kind === 'err' ? 6000 : 4000));
  if (ttl > 0) {
    _toastTimer = setTimeout(() => t.classList.remove('visible'), ttl);
  }
}

const SEARCH_PROXY_URL = IS_SERVED ? window.location.origin + '/search' : 'http://127.0.0.1:11435';

// Embedding service (Retriever A + semantic backstop). Mirrors LLAMA_URL /
// SEARCH_PROXY_URL exactly: when served over http, the file server's /embed
// reverse-proxy route reaches the loopback embed llama-server (and inherits
// the session-cookie auth for free); on file:// it talks straight to loopback.
// OPTIONAL INFRA: if this server is down or never installed, embedText()
// returns null, embed_available flips off for the turn, and the retriever
// degrades to tag-only Retriever B. Chat is never gated on embeddings.
const EMBED_URL = IS_SERVED ? window.location.origin + '/embed' : 'http://127.0.0.1:11436';

/**
 * Thin fetch wrapper. llama.cpp has zero telemetry so there's
 * nothing to scrub — this just forwards the call.
 * Kept as a named function so all API paths remain consistent.
 */
function privacyFetch(url, options = {}) {
  return fetch(url, options);
}

/**
 * Extract a token from a single line of streaming response.
 * Returns {text, field} where field is 'content' or 'reasoning',
 * or null if nothing found.
 *
 * Servers may return reasoning in different fields depending on
 * config. We accept several common ones — see THINKING_FORMATS for
 * the parser that handles raw inline tokens.
 */
function extractTokenFromLine(rawLine) {
  const trimmed = rawLine.trim();
  if (!trimmed) return null;
  if (trimmed === 'data: [DONE]' || trimmed === 'data:[DONE]') return null;

  // Strip SSE "data:" prefix if present
  let jsonStr = trimmed;
  if (jsonStr.startsWith('data:')) {
    jsonStr = jsonStr.slice(5).trim();
  }
  if (!jsonStr || jsonStr === '[DONE]') return null;

  try {
    const json = JSON.parse(jsonStr);

    // OpenAI streaming: choices[0].delta
    if (json.choices && json.choices[0]) {
      const c = json.choices[0];
      if (c.delta) {
        // Server-extracted reasoning (llama.cpp with --jinja --reasoning-format X,
        // or any provider exposing a reasoning channel separately).
        // Multiple field names exist in the wild — accept the most common.
        if (typeof c.delta.reasoning_content === 'string')
          return { text: c.delta.reasoning_content, field: 'reasoning' };
        if (typeof c.delta.reasoning === 'string')
          return { text: c.delta.reasoning, field: 'reasoning' };
        // Standard content token
        if (typeof c.delta.content === 'string')
          return { text: c.delta.content, field: 'content' };
      }
      if (c.message && typeof c.message.content === 'string')
        return { text: c.message.content, field: 'content' };
    }

    // Ollama format: message.content (also message.thinking for some builds)
    if (json.message) {
      if (typeof json.message.thinking === 'string')
        return { text: json.message.thinking, field: 'reasoning' };
      if (typeof json.message.content === 'string')
        return { text: json.message.content, field: 'content' };
    }

    // Raw content field
    if (typeof json.content === 'string')
      return { text: json.content, field: 'content' };

    // Response field (some servers)
    if (typeof json.response === 'string')
      return { text: json.response, field: 'content' };

    return null;
  } catch (e) {
    return null;
  }
}

