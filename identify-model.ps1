<#
================================================================================
 identify-model.ps1  --  single source of truth for model identification
================================================================================

 WHY THIS EXISTS
 ---------------
 The chat template a model expects is BAKED INTO THE GGUF (the
 'tokenizer.chat_template' metadata key). The filename is not authoritative:
 popular Mistral-Nemo merges ship as "Rocinante-12B", "Magnum-v4-12B",
 "Violet_Twilight" -- none of which contain "nemo" or "mistral", so the old
 filename-keyword matcher silently missed them and let them launch under
 --jinja against a template minja can't render. Conversely, some "...Nemo..."
 merges are retrained on ChatML, and force-applying mistral-v3-tekken to those
 produced garbage. Both bugs have the same root cause: guessing the template
 from the name instead of reading it.

 This script reads the embedded chat template (and architecture / context
 length) straight out of the GGUF header and decides:
   - family            (gemma / llama / mistral / qwen / glm / granite / ...)
   - useJinja          (1 = use the embedded template; 0 = use a C++ built-in)
   - chatTemplate      (the built-in name to pass to --chat-template, if any)
   - thinkingFormat    (none / deepseek / gemma / harmony)
   - maxCtx            (capped advertised context length)

 The mistral branch is a direct port of llama.cpp's own content sniffer
 (src/llama-chat.cpp :: llm_chat_detect_template), so the variant we pick
 (v3-tekken vs v7-tekken vs v1) matches what the engine would detect itself.

 MODES
 -----
   identify-model.ps1 -GgufPath <file> -Emit batch
       Prints a block of `set "MODEL_..."` statements for launch.bat to CALL.

   identify-model.ps1 -GgufPath <file> -Emit json
       Prints one compact JSON object (handy for debugging / other callers).

   identify-model.ps1 -ModelsDir <dir> -Active <name> -OutFile <path>
       Enumerates every *.gguf in <dir> and writes models-list.json
       ({ active, models:[...] }) for the header dropdown + hot-swap.

 All three modes share Get-ModelInfo, so they can never drift.
================================================================================
#>

param(
    [string]$GgufPath,
    [ValidateSet('json','batch')]
    [string]$Emit = 'json',
    [string]$ModelsDir,
    [string]$Active = '',
    [string]$OutFile
)

$ErrorActionPreference = 'Stop'

# GGUF metadata value-type ids (see ggml/docs gguf.md)
$GGUF_TYPE_STRING = 8
$GGUF_TYPE_ARRAY  = 9
# byte sizes of the fixed-width scalar types, keyed by type id
$GGUF_FIXED = @{ 0 = 1; 1 = 1; 2 = 2; 3 = 2; 4 = 4; 5 = 4; 6 = 4; 7 = 1; 10 = 8; 11 = 8; 12 = 8 }

# ------------------------------------------------------------------------------
# Read-GgufMeta: pull chat_template / architecture / context_length out of a
# GGUF file's metadata block. Skips large arrays (e.g. the token vocab) by
# seeking past them instead of materialising them. Returns $null on any error
# so callers can fall back gracefully.
# ------------------------------------------------------------------------------
function Read-GgufMeta {
    param([string]$Path)

    $res = @{ chat_template = ''; architecture = ''; context_length = [int64]0 }

    try {
        $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open,
                                            [System.IO.FileAccess]::Read,
                                            [System.IO.FileShare]::ReadWrite)
    } catch {
        return $null
    }

    try {
        $br = New-Object System.IO.BinaryReader($fs)

        # magic 'GGUF'
        $magic = $br.ReadBytes(4)
        if ($magic.Length -lt 4 -or
            $magic[0] -ne 0x47 -or $magic[1] -ne 0x47 -or
            $magic[2] -ne 0x55 -or $magic[3] -ne 0x46) {
            return $null
        }

        # version: v2/v3 use uint64 counts/lengths (v1 used uint32 and is extinct)
        $ver = $br.ReadUInt32()
        if ($ver -lt 2 -or $ver -gt 3) { return $null }

        [void]$br.ReadUInt64()              # tensor count (unused)
        $nKv = $br.ReadUInt64()             # metadata kv count

        for ([uint64]$i = 0; $i -lt $nKv; $i++) {

            # --- key ---
            $klen = $br.ReadUInt64()
            if ($klen -gt 1048576) { return $null }     # 1 MB key = corrupt
            $key = [System.Text.Encoding]::UTF8.GetString($br.ReadBytes([int]$klen))

            # --- value type ---
            $vt = [int]$br.ReadUInt32()

            if ($vt -eq $GGUF_TYPE_STRING) {
                $vlen = $br.ReadUInt64()
                if ($vlen -gt 67108864) {               # 64 MB string = skip, not ours
                    [void]$fs.Seek([int64]$vlen, [System.IO.SeekOrigin]::Current)
                } else {
                    $bytes = $br.ReadBytes([int]$vlen)
                    if ($key -eq 'tokenizer.chat_template') {
                        $res.chat_template = [System.Text.Encoding]::UTF8.GetString($bytes)
                    } elseif ($key -eq 'general.architecture') {
                        $res.architecture = [System.Text.Encoding]::UTF8.GetString($bytes)
                    }
                }
            }
            elseif ($GGUF_FIXED.ContainsKey($vt)) {
                $raw = $br.ReadBytes($GGUF_FIXED[$vt])
                if ($key.EndsWith('.context_length')) {
                    if ($vt -eq 4 -or $vt -eq 5) {
                        $res.context_length = [int64][System.BitConverter]::ToUInt32($raw, 0)
                    } elseif ($vt -eq 10 -or $vt -eq 11) {
                        $res.context_length = [int64][System.BitConverter]::ToUInt64($raw, 0)
                    }
                }
            }
            elseif ($vt -eq $GGUF_TYPE_ARRAY) {
                $et  = [int]$br.ReadUInt32()
                $cnt = $br.ReadUInt64()
                if ($et -eq $GGUF_TYPE_STRING) {
                    for ([uint64]$j = 0; $j -lt $cnt; $j++) {
                        $elen = $br.ReadUInt64()
                        [void]$fs.Seek([int64]$elen, [System.IO.SeekOrigin]::Current)
                    }
                } elseif ($GGUF_FIXED.ContainsKey($et)) {
                    [void]$fs.Seek([int64]$GGUF_FIXED[$et] * [int64]$cnt, [System.IO.SeekOrigin]::Current)
                } else {
                    return $null                         # nested arrays: not used in metadata
                }
            }
            else {
                return $null                             # unknown value type
            }

            # We have everything we need; the chat template is the last of the
            # three to appear (it sits after the token arrays), so this exits
            # as soon as it's been read.
            if ($res.chat_template -ne '' -and $res.architecture -ne '' -and $res.context_length -gt 0) {
                break
            }
        }
    } catch {
        return $null
    } finally {
        $fs.Close()
    }

    return $res
}

# ------------------------------------------------------------------------------
# KNOWN-TEMPLATE HASH TABLE  (modeled on the SillyTavern approach)
#
# SillyTavern identifies a model's prompt format by hashing its embedded chat
# template and matching against a table of known-good templates -- NOT by
# sniffing substrings. The reason is the Mistral lineage: '[INST]' and
# '[AVAILABLE_TOOLS]' appear in V2&V3 (spaced), V3-Tekken (unspaced), AND V7,
# so a substring match cannot tell them apart, and guessing the wrong variant
# produces coherent-but-wrong ("garbage") output. An exact hash match is the
# only way to *know* the variant.
#
# Hashes are SHA-256 of the trimmed chat-template string, transcribed verbatim
# from SillyTavern (public/scripts/chat-templates.js) so we inherit their
# testing. For each we record the precise llama.cpp built-in to pass to
# --chat-template. For the Mistral entries we disable jinja and use the C++
# built-in (clean single-BOS, known-correct spacing); for everything else the
# embedded jinja template is fine, so we leave jinja on and only tag metadata.
#
# 'think' is the chat.html thinking format: none / deepseek / gemma / harmony.
# ------------------------------------------------------------------------------
$HashDerivations = @{
    # --- Meta Llama 3.x (jinja is fine; just tag family) ---
    'e10ca381b1ccc5cf9db52e371f3b6651576caee0a630b452e2816b2d404d4b65' = @{ family='llama'; id='llama'; jinja=1; builtin=''; think='none' }   # Llama-3.1-8B/70B-Instruct
    '5816fce10444e03c2e9ee1ef8a4a1ea61ae7e69e438613f3b17b69d0426223a4' = @{ family='llama'; id='llama'; jinja=1; builtin=''; think='none' }   # Llama-3.2-1B/3B-Instruct
    '73e87b1667d87ab7d7b579107f01151b29ce7f3ccdd1018fdc397e78be76219d' = @{ family='llama'; id='llama'; jinja=1; builtin=''; think='none' }   # Nemotron 70B

    # --- Mistral (force the matching C++ built-in: known variant => safe) ---
    'e16746b40344d6c5b5265988e0328a0bf7277be86f1c335156eae07e29c82826' = @{ family='mistral'; id='mistral'; jinja=0; builtin='mistral-v3';        think='none' }   # Small-2409 / Large-2407  (V2&V3, spaced)
    '26a59556925c987317ce5291811ba3b7f32ec4c647c400c6cc7e3a9993007ba7' = @{ family='mistral'; id='mistral'; jinja=0; builtin='mistral-v3';        think='none' }   # Mistral-7B-Instruct-v0.3 (V2&V3, spaced)
    'e4676cb56dffea7782fd3e2b577cfaf1e123537e6ef49b3ec7caa6c095c62272' = @{ family='mistral'; id='mistral'; jinja=0; builtin='mistral-v3-tekken'; think='none' }   # Mistral-Nemo-2407       (V3-Tekken, unspaced)
    '3c4ad5fa60dd8c7ccdf82fa4225864c903e107728fcaf859fa6052cb80c92ee9' = @{ family='mistral'; id='mistral'; jinja=0; builtin='mistral-v7';        think='none' }   # Large-2411              (V7)
    '3934d199bfe5b6fab5cba1b5f8ee475e8d5738ac315f21cb09545b4e665cc005' = @{ family='mistral'; id='mistral'; jinja=0; builtin='mistral-v7-tekken'; think='none' }   # Small 24B               (V7, tekken tokenizer)

    # --- Gemma (jinja fine; gemma4-vs-3 refined by context length below) ---
    'ecd6ae513fe103f0eb62e8ab5bfa8d0fe45c1074fa398b089c93a7e70c15cfd6' = @{ family='gemma'; id='gemma3'; jinja=1; builtin=''; think='none' }   # gemma-2-9b/27b-it
    '87fa45af6cdc3d6a9e4dd34a0a6848eceaa73a35dcfe976bd2946a5822a38bf3' = @{ family='gemma'; id='gemma3'; jinja=1; builtin=''; think='none' }   # gemma-2-2b-it
    '7de1c58e208eda46e9c7f86397df37ec49883aeece39fb961e0a6b24088dd3c4' = @{ family='gemma'; id='gemma3'; jinja=1; builtin=''; think='none' }   # gemma-3

    # --- Others (jinja fine; tag family + thinking) ---
    '3b54f5c219ae1caa5c0bb2cdc7c001863ca6807cf888e4240e8739fa7eb9e02e' = @{ family='command-r'; id='command-r'; jinja=1; builtin=''; think='none' }       # command-r-08-2024
    'ac7498a36a719da630e99d48e6ebc4409de85a77556c2b6159eeb735bcbd11df' = @{ family='tulu';      id='tulu';      jinja=1; builtin=''; think='none' }       # Tulu-3
    '54d400beedcd17f464e10063e0577f6f798fa896266a912d8a366f8a2fcc0bca' = @{ family='deepseek';  id='deepseek';  jinja=1; builtin=''; think='none' }       # DeepSeek-V2.5
    'b6835114b7303ddd78919a82e4d9f7d8c26ed0d7dfc36beeb12d524f6144eab1' = @{ family='deepseek';  id='deepseek-r1'; jinja=1; builtin=''; think='deepseek' } # DeepSeek-R1
    '854b703e44ca06bdb196cc471c728d15dbab61e744fe6cdce980086b61646ed1' = @{ family='glm';       id='glm';       jinja=1; builtin=''; think='none' }       # GLM-4
    'aab20feb9bc6881f941ea649356130ffbc4943b3c2577c0991e1fba90de5a0fc' = @{ family='moonshot';  id='moonshot';  jinja=1; builtin=''; think='none' }       # Kimi K2 / Moonshot
    '70da0d2348e40aaf8dad05f04a316835fd10547bd7e3392ce337e4c79ba91c01' = @{ family='gpt-oss';   id='gpt-oss';   jinja=1; builtin=''; think='harmony' }    # gpt-oss (unsloth)
    'a4c9919cbbd4acdd51ccffe22da049264b1b73e59055fa58811a99efbd7c8146' = @{ family='gpt-oss';   id='gpt-oss';   jinja=1; builtin=''; think='harmony' }    # gpt-oss (ggml-org)
}

# ------------------------------------------------------------------------------
# Get-TemplateHash: SHA-256 of the chat template
# Two gotchas: the template "must be trimmed to match the
# llama.cpp metadata value", and llama.cpp's reported template can carry a
# trailing NUL. We strip NULs and surrounding whitespace, then hash UTF-8.
# Returns '' for an empty template.
# ------------------------------------------------------------------------------
function Get-TemplateHash {
    param([string]$Template)
    if ($null -eq $Template) { return '' }
    $trimmed = $Template.Trim([char]0).Trim()
    if ($trimmed -eq '') { return '' }
    $sha   = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($trimmed)
        $hash  = $sha.ComputeHash($bytes)
    } finally {
        $sha.Dispose()
    }
    return ([System.BitConverter]::ToString($hash) -replace '-', '').ToLower()
}

# ------------------------------------------------------------------------------
# Get-ModelInfo: classify a GGUF in three tiers:
#   1. EXACT HASH  -> we know the precise template variant; act with confidence.
#   2. SAFE HEURISTIC for unambiguous families (ChatML / Harmony / Gemma).
#   3. UNKNOWN MISTRAL -> DO NOT guess a variant. Trust the author's embedded
#      template via --jinja (modern llama.cpp auto-patches the old minja
#      tool-call breakage), which is what fixes the "still garbage" merges.
# Returns an ordered hashtable matching the models-list.json record shape.
# ------------------------------------------------------------------------------
function Get-ModelInfo {
    param([string]$Path)

    $file = Split-Path $Path -Leaf
    $name = $file -replace '(?i)\.gguf$', ''

    $rec = [ordered]@{
        file           = $file
        id             = 'custom'
        name           = $name
        family         = 'custom'
        thinkingFormat = 'none'
        maxCtx         = 131072
        useJinja       = 1
        chatTemplate   = ''
        templateHash   = ''
    }

    $meta = Read-GgufMeta -Path $Path
    if ($null -eq $meta) {
        # Last-resort safety net only -- GGUF unreadable. Don't guess the
        # template; just let llama-server use its chatml fallback under --jinja.
        if ($name -match 'think|reason') { $rec.thinkingFormat = 'deepseek' }
        return $rec
    }

    $t    = [string]$meta.chat_template
    $arch = ([string]$meta.architecture).ToLower()
    $ctx  = [int64]$meta.context_length
    if ($ctx -gt 0) { $rec.maxCtx = [int][math]::Min($ctx, [int64]262144) }

    $hash = Get-TemplateHash -Template $t
    $rec.templateHash = $hash

    # ---- TIER 1: exact hash match. We KNOW the variant. -------------------
    if ($hash -ne '' -and $HashDerivations.ContainsKey($hash)) {
        $d = $HashDerivations[$hash]
        $rec.family         = $d.family
        $rec.id             = $d.id
        $rec.useJinja       = $d.jinja
        $rec.chatTemplate   = $d.builtin
        $rec.thinkingFormat = $d.think
        # Gemma 4 ships a >128K window and channel thinking; the gemma-2/3
        # hashes above default to gemma3, so promote by context length.
        if ($d.family -eq 'gemma' -and $ctx -gt 131072) {
            $rec.id = 'gemma4'; $rec.thinkingFormat = 'gemma'
        }
        return $rec
    }

    # ---- TIER 2 & 3: no exact match -- heuristics, but NEVER guess a
    #      Mistral variant. -------------------------------------------------
    $hasInst  = $t.Contains('[INST]')
    $hasTools = $t.Contains('[AVAILABLE_TOOLS]')

    if ($t.Contains('<|channel|>') -or $arch.Contains('gpt-oss') -or $arch.Contains('gptoss') -or $arch.Contains('gpt_oss')) {
        # ---- gpt-oss / Harmony channels. ----
        $rec.family = 'gpt-oss'; $rec.id = 'gpt-oss'; $rec.useJinja = 1; $rec.thinkingFormat = 'harmony'
    }
    elseif ($t.Contains('<|im_user|>') -and $t.Contains('<|im_middle|>')) {
        # ---- Moonshot / Kimi (ST substring heuristic). ----
        $rec.family = 'moonshot'; $rec.id = 'moonshot'; $rec.useJinja = 1
    }
    elseif ($t.Contains('<|im_start|>')) {
        # ---- ChatML-based (Qwen, GLM-chatml, Phi-4, many merges). Renders
        #      fine under --jinja, so leave jinja on. ----
        $rec.useJinja = 1
        if     ($arch.StartsWith('qwen'))                        { $rec.family = 'qwen'; $rec.id = 'qwen' }
        elseif ($arch.StartsWith('glm') -or $arch -eq 'chatglm') { $rec.family = 'glm';  $rec.id = 'glm'  }
        elseif ($arch.StartsWith('phi'))                         { $rec.family = 'phi';  $rec.id = 'phi'  }
        elseif ($arch -ne '')                                    { $rec.family = $arch;  $rec.id = $arch  }
        else                                                     { $rec.family = 'custom'; $rec.id = 'custom' }
        if ($t.Contains('<think>') -or $arch -eq 'qwen3' -or $arch -eq 'qwen3moe') {
            $rec.thinkingFormat = 'deepseek'
        }
    }
    elseif ($t.Contains('<start_of_turn>') -or $arch.StartsWith('gemma')) {
        # ---- Gemma. Gemma 4 ships a 256K+ window and uses channel thinking. ----
        $rec.family   = 'gemma'
        $rec.useJinja = 1
        if ($ctx -gt 131072) { $rec.id = 'gemma4'; $rec.thinkingFormat = 'gemma' }
        else                 { $rec.id = 'gemma3'; $rec.thinkingFormat = 'none'  }
    }
    elseif ($hasInst -or $hasTools) {
        # ---- Mistral family, UNKNOWN exact variant. This is the case that was
        #      breaking: '[INST]'+'[AVAILABLE_TOOLS]' is shared by V2&V3,
        #      V3-Tekken and V7, so we CANNOT tell which spacing the merge
        #      wants. We refuse to guess and instead trust
        #      the template the model author baked in (--jinja). Modern
        #      llama.cpp auto-patches the [TOOL_CALLS] minja block at load, so
        #      this no longer errors the way the old override assumed. If a
        #      specific merge still misbehaves, add its templateHash (logged in
        #      models-list build) to $HashDerivations with the right built-in.
        $rec.family = 'mistral'; $rec.id = 'mistral'; $rec.useJinja = 1; $rec.chatTemplate = ''
    }
    else {
        # ---- Llama / DeepSeek / Granite / generic. Trust embedded template. ----
        if     ($arch.Contains('deepseek')) { $rec.family = 'deepseek'; $rec.id = 'deepseek'; $rec.thinkingFormat = 'deepseek' }
        elseif ($arch.Contains('granite'))  { $rec.family = 'granite';  $rec.id = 'granite'  }
        elseif ($arch.StartsWith('llama') -or $arch -eq '') { $rec.family = 'llama'; $rec.id = 'llama' }
        else                                { $rec.family = $arch; $rec.id = $arch }
    }

    # Final thinking catch for any path that left it 'none'.
    if ($rec.thinkingFormat -eq 'none' -and $t.Contains('<think>')) {
        $rec.thinkingFormat = 'deepseek'
    }

    return $rec
}

# ------------------------------------------------------------------------------
# Mode dispatch
# ------------------------------------------------------------------------------
if ($ModelsDir) {
    # ---- folder mode: build models-list.json ----
    if (-not $OutFile) { throw 'identify-model.ps1: -OutFile is required with -ModelsDir' }
    $files  = Get-ChildItem -Path $ModelsDir -Filter '*.gguf' -File -ErrorAction SilentlyContinue | Sort-Object Name
    $models = @()
    foreach ($f in $files) {
        $rec = Get-ModelInfo -Path $f.FullName
        $rec.active = ($f.Name -eq $Active)
        $models += [PSCustomObject]$rec
    }
    $payload = [PSCustomObject]@{ active = $Active; models = $models }
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($OutFile, ($payload | ConvertTo-Json -Depth 6), $enc)
    Write-Host ('  [OK] ' + $models.Count + ' model(s) listed (GGUF chat-template detection)')

    # Diagnostic: surface any model whose template hash is
    # NOT in $HashDerivations. These run on the safe "trust embedded jinja"
    # fallback. If one misbehaves, copy its hash into $HashDerivations with the
    # correct built-in and it becomes an exact, confident match next launch.
    foreach ($m in $models) {
        if ($m.family -eq 'mistral' -and -not $HashDerivations.ContainsKey([string]$m.templateHash)) {
            Write-Host ('  [i] ' + $m.file + ': unknown Mistral template (hash ' + $m.templateHash + ')')
            Write-Host ('      -> using embedded jinja. To pin a built-in, add this hash to identify-model.ps1.')
        }
    }
    return
}

if (-not $GgufPath) { throw 'identify-model.ps1: provide -GgufPath or -ModelsDir' }

$info = Get-ModelInfo -Path $GgufPath

if ($Emit -eq 'batch') {
    # Strip characters that would break `set "K=V"` / echo inside a
    # delayed-expansion batch context.
    $dn = ($info.name -replace '[%!^&<>|"]', '')
    $setLines = @(
        ('set "MODEL_ID=' + $info.id + '"'),
        ('set "MODEL_DISPLAY=' + $dn + '"'),
        ('set "MODEL_FAMILY=' + $info.family + '"'),
        ('set "MODEL_MAX_CTX=' + $info.maxCtx + '"'),
        ('set "MODEL_THINK_FMT=' + $info.thinkingFormat + '"'),
        ('set "MODEL_USE_JINJA=' + ([int]$info.useJinja) + '"'),
        ('set "MODEL_CHAT_TEMPLATE=' + $info.chatTemplate + '"'),
        ('set "MODEL_TEMPLATE_HASH=' + $info.templateHash + '"')
    )
    if ($OutFile) {
        # Write the snippet ourselves as plain ASCII with CRLF. Relying on
        # `powershell ... > file.cmd` redirection is unsafe: Windows
        # PowerShell 5.1 can emit UTF-16, which `call` cannot parse.
        $body = ($setLines -join "`r`n") + "`r`n"
        [System.IO.File]::WriteAllText($OutFile, $body, (New-Object System.Text.ASCIIEncoding))
    } else {
        $setLines | ForEach-Object { Write-Output $_ }
    }
} else {
    Write-Output (([PSCustomObject]$info) | ConvertTo-Json -Compress)
}
