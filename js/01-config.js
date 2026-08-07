/* @gobbonet-split js/01-config.js
   Moved verbatim from chat.html lines 1394-1558.
   build stamp, API endpoints, model registry
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   BUILD STAMP
   Bumped any time the user-facing behavior of this file changes,
   so a quick glance at DevTools Console tells you which version
   the browser actually loaded. If you swapped chat.html on disk
   but this stamp still shows the old date, you're on a cached
   copy — hard-refresh (Ctrl+Shift+R) to bust it.
================================================================ */
const CHAT_HTML_BUILD = '2026-05-16-nemo-strict-template-fix';
console.log(`%c[chat.html build] ${CHAT_HTML_BUILD}`, 'color:#0a0;font-weight:bold');

/* ================================================================
   API ENDPOINTS
   llama.cpp server exposes an OpenAI-compatible API.
   No telemetry, no phoning home — fully offline by design.
================================================================ */
// Dynamic host: if opened as file://, connect directly to localhost services.
// If served over HTTP (via file server), route through same-origin proxy to avoid CORS.
// The file server reverse-proxies /llm/* → llama-server and /search/* → search proxy.
const IS_SERVED = window.location.protocol.startsWith('http');
const LLAMA_URL = IS_SERVED ? window.location.origin + '/llm' : 'http://127.0.0.1:11434';
/* ================================================================
   MODEL REGISTRY
   Maps model IDs (matching active-model.json) to display metadata.
   thinkingFormat tells the streaming parser how to extract reasoning
   from inline content (see THINKING_FORMAT_ALIASES for valid values).

   Adding a new model? See identifyModelFromFilename() below for the
   regex-based fallback used when launch.bat doesn't recognise a file.
================================================================ */
const MODEL_REGISTRY = {
  // ── Gemma family ────────────────────────────────────────────────
  'gemma4-26b': {
    name: 'Gemma 4 26B-A4B MoE', family: 'gemma',
    maxCtx: 262144, defaultCtx: 16384, thinkingFormat: 'gemma',
    hint: 'Gemma 4 26B supports up to 256K tokens. Actual capacity depends on KV cache quantization and VRAM.'
  },
  'gemma3-4b': {
    name: 'Gemma 3 4B IT', family: 'gemma',
    maxCtx: 131072, defaultCtx: 32768, thinkingFormat: 'none',
    hint: 'Gemma 3 4B supports up to 128K tokens. Runs comfortably on 8 GB VRAM.'
  },
  // ── Llama family ────────────────────────────────────────────────
  'llama32-3b': {
    name: 'Llama 3.2 3B Instruct', family: 'llama',
    maxCtx: 131072, defaultCtx: 32768, thinkingFormat: 'none',
    hint: 'Llama 3.2 3B supports up to 128K tokens. Very fast on modest hardware.'
  },
  'llama31-8b': {
    name: 'Llama 3.1 8B Instruct', family: 'llama',
    maxCtx: 131072, defaultCtx: 32768, thinkingFormat: 'none',
    hint: 'Llama 3.1 8B supports up to 128K tokens. Solid general-purpose model.'
  },
  // ── Mistral family ──────────────────────────────────────────────
  'mistral-7b': {
    name: 'Mistral 7B v0.3', family: 'mistral',
    maxCtx: 32768, defaultCtx: 16384, thinkingFormat: 'none',
    hint: 'Mistral 7B supports up to 32K tokens. Fast and instruction-focused.'
  },
  'mistral-nemo': {
    name: 'Mistral Nemo (12B)', family: 'mistral',
    maxCtx: 131072, defaultCtx: 16384, thinkingFormat: 'none',
    hint: 'Mistral Nemo 12B (and merges like MN-Violet-Lotus, Rocinante, Magnum-v4) supports up to 128K. Launch script runs these without --jinja to dodge a known minja issue with the v3-tekken chat template.'
  },
  'mistral-small': {
    name: 'Mistral Small (24B)', family: 'mistral',
    maxCtx: 131072, defaultCtx: 16384, thinkingFormat: 'none',
    hint: 'Mistral Small 24B and its finetunes (Cydonia v4+, Asmodeus) use the strict v7-tekken chat template. The message normalizer in this app produces compliant arrays so --jinja against the embedded template works fine.'
  },
  // ── Qwen family (think tags) ────────────────────────────────────
  'qwen3-30b': {
    name: 'Qwen3 30B-A3B MoE', family: 'qwen',
    maxCtx: 131072, defaultCtx: 16384, thinkingFormat: 'deepseek',
    hint: 'Qwen3 30B MoE supports up to 128K tokens. Emits chain-of-thought between <think>...</think> tags.'
  },
  'qwq-32b': {
    name: 'QwQ 32B', family: 'qwen',
    maxCtx: 131072, defaultCtx: 16384, thinkingFormat: 'deepseek',
    hint: 'QwQ is a reasoning-focused Qwen variant. Always thinks before responding (<think> tags).'
  },
  // ── DeepSeek family (think tags) ────────────────────────────────
  'deepseek-r1-8b': {
    name: 'DeepSeek-R1 8B', family: 'deepseek',
    maxCtx: 131072, defaultCtx: 32768, thinkingFormat: 'deepseek',
    hint: 'DeepSeek-R1 8B supports up to 128K tokens. Reasoning-focused — shows chain-of-thought by default.'
  },
  // ── GLM family (Z.ai / Zhipu / THUDM) ───────────────────────────
  // Two template eras coexist. 2024-era GLM-4-9B uses llama.cpp's built-in
  // 'chatglm4' template (identify-model.ps1 sets useJinja=0 for it). The
  // 0414-era and 4.5+ era use [gMASK]<sop> + <|user|>/<|assistant|> markers
  // -- llama.cpp has no built-in name for that, so they run with --jinja
  // against the embedded template. The embedded 4.5+ template has known
  // issues with reasoning parsing during tool calls; community workaround
  // is to drop a corrected .jinja next to the GGUF (the launcher picks it
  // up automatically via the sidecar mechanism -- no per-user setup here).
  'glm-4-9b': {
    name: 'GLM-4-9B-Chat', family: 'glm',
    maxCtx: 131072, defaultCtx: 16384, thinkingFormat: 'none',
    hint: 'Z.ai GLM-4-9B-Chat (2024 original, dense). Non-thinking instruct model, fits 8 GB VRAM at Q4_K_M. Launcher uses llama.cpp built-in chatglm4 template (--jinja off) for this one.'
  },
  'glm-z1-9b': {
    name: 'GLM-Z1-9B (0414)', family: 'glm',
    maxCtx: 32768, defaultCtx: 16384, thinkingFormat: 'deepseek',
    hint: 'Z.ai GLM-Z1-9B-0414 reasoning model (April 2025). Emits <think>...</think>. Sweet spot for 8-12 GB cards. Native 32K context; YaRN extends further if needed.'
  },
  'glm-z1-32b': {
    name: 'GLM-Z1-32B (0414)', family: 'glm',
    maxCtx: 32768, defaultCtx: 16384, thinkingFormat: 'deepseek',
    hint: 'Z.ai GLM-Z1-32B-0414 reasoning (also covers Rumination-32B). Needs 24 GB VRAM at Q4_K_M with modest context. Emits <think>...</think>.'
  },
  'glm-4-32b': {
    name: 'GLM-4-32B (0414)', family: 'glm',
    maxCtx: 32768, defaultCtx: 16384, thinkingFormat: 'none',
    hint: 'Z.ai GLM-4-32B-0414 instruct (non-thinking). ~19 GB at Q4_K_M; comfortable on 24 GB cards with 16-32K context.'
  },
  'glm-flash': {
    name: 'GLM-V-Flash 9B', family: 'glm',
    maxCtx: 131072, defaultCtx: 16384, thinkingFormat: 'deepseek',
    hint: 'Z.ai GLM-4.6V-Flash / 4.5V-Flash (9B dense, vision-capable). Text mode works without mmproj. Q4_K_M ~6 GB, Q8_0 ~10 GB. NOTE: Vulkan backend has a known incoherence bug with this model (llama.cpp #18164) -- use CUDA or CPU.'
  },
  'glm-air': {
    name: 'GLM-4.5/4.6 Air (106B MoE)', family: 'glm',
    maxCtx: 131072, defaultCtx: 16384, thinkingFormat: 'deepseek',
    hint: 'Z.ai GLM-4.5-Air / 4.6-Air -- 106B total / 12B active MoE. Workstation tier: Q4_K_M is ~63 GB, Q2_K is 45 GB. Needs VRAM+RAM combined or --n-cpu-moe MoE offload. If the embedded template misbehaves on tool calls, drop a corrected .jinja next to the GGUF (see the unsloth or zai-org repo for one).'
  },
  'glm-big-moe': {
    name: 'GLM-4.5 / 4.6 / 4.7 / 5 (big MoE)', family: 'glm',
    maxCtx: 200000, defaultCtx: 16384, thinkingFormat: 'deepseek',
    hint: 'Z.ai flagship MoE (GLM-4.5: 355B/32B, GLM-5: 744B/40B). Multi-GPU or heavy offload territory -- single-card hobbyists should use Air, Flash, or Z1 instead. Listed so the launcher recognises the GGUF if you have one.'
  },
  // ── OpenAI gpt-oss (Harmony channels) ───────────────────────────
  'gpt-oss-20b': {
    name: 'gpt-oss 20B', family: 'gpt-oss',
    maxCtx: 131072, defaultCtx: 16384, thinkingFormat: 'harmony',
    hint: 'OpenAI gpt-oss 20B uses the Harmony channel format (<|channel|>analysis ... <|channel|>final). Run with --jinja for best results.'
  },
  'gpt-oss-120b': {
    name: 'gpt-oss 120B', family: 'gpt-oss',
    maxCtx: 131072, defaultCtx: 16384, thinkingFormat: 'harmony',
    hint: 'OpenAI gpt-oss 120B (MoE) uses the Harmony channel format. Heavy — needs serious VRAM or CPU offload.'
  },
  // ── Granite (think tags, optional) ──────────────────────────────
  'granite-thinking': {
    name: 'IBM Granite Thinking', family: 'granite',
    maxCtx: 131072, defaultCtx: 16384, thinkingFormat: 'deepseek',
    hint: 'IBM Granite reasoning models emit <think>...</think> blocks when thinking is enabled.'
  },
  // ── Cohere Command R family ─────────────────────────────────────
  'command-r7b': {
    name: 'Command R 7B (12-2024)', family: 'cohere',
    maxCtx: 131072, defaultCtx: 32768, thinkingFormat: 'none',
    hint: 'Cohere Command R 7B (Cohere2 arch) supports 128K context. Strong instruction following, multilingual, no chain-of-thought.'
  },
  'command-r-35b': {
    name: 'Command R 35B (08-2024)', family: 'cohere',
    maxCtx: 131072, defaultCtx: 16384, thinkingFormat: 'none',
    hint: 'Cohere Command R 35B (08-2024 refresh of v01). Heavy chat model; Q4_K_S needs ~20 GB VRAM at modest context.'
  },
  'custom': {
    name: 'Custom GGUF', family: 'custom',
    maxCtx: 131072, defaultCtx: 24576, thinkingFormat: 'none',
    hint: "Custom model. If your model uses thinking tags, set thinkingFormat in active-model.json (none/deepseek/harmony/gemma)."
  }
};

