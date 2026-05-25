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
# Get-ModelInfo: classify a single GGUF by the CONTENT of its embedded chat
# template (with architecture as a tie-breaker). Returns an ordered hashtable
# matching the models-list.json record shape.
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

    $hasInst  = $t.Contains('[INST]')
    $hasTools = $t.Contains('[AVAILABLE_TOOLS]')

    if ($hasInst -or $hasTools) {
        # ---- Mistral family: the minja danger zone. Route to the matching
        #      C++ built-in (port of llama.cpp llm_chat_detect_template). ----
        $rec.family   = 'mistral'
        $rec.id       = 'mistral'
        $rec.useJinja = 0
        if ($t.Contains('[SYSTEM_PROMPT]')) {
            $rec.chatTemplate = 'mistral-v7-tekken'        # v7 (Small-3.x / Large-2411)
        } elseif ($hasTools -or $t.Contains("' [INST] ' + system_message")) {
            if     ($t.Contains('"[INST]"')) { $rec.chatTemplate = 'mistral-v3-tekken' }
            elseif ($t.Contains(' [INST]'))  { $rec.chatTemplate = 'mistral-v1' }
            else                             { $rec.chatTemplate = 'mistral-v3-tekken' }
        } else {
            $rec.chatTemplate = 'mistral-v3-tekken'
        }
    }
    elseif ($t.Contains('<|im_start|>')) {
        # ---- ChatML-based (Qwen, GLM-chatml, Phi-4, many merges). Renders
        #      fine under --jinja, so leave jinja on. ----
        $rec.useJinja = 1
        if     ($arch.StartsWith('qwen'))                     { $rec.family = 'qwen'; $rec.id = 'qwen' }
        elseif ($arch.StartsWith('glm') -or $arch -eq 'chatglm') { $rec.family = 'glm';  $rec.id = 'glm'  }
        elseif ($arch.StartsWith('phi'))                      { $rec.family = 'phi';  $rec.id = 'phi'  }
        elseif ($arch -ne '')                                 { $rec.family = $arch;  $rec.id = $arch  }
        else                                                  { $rec.family = 'custom'; $rec.id = 'custom' }
        if ($t.Contains('<think>') -or $arch -eq 'qwen3' -or $arch -eq 'qwen3moe') {
            $rec.thinkingFormat = 'deepseek'
        }
    }
    elseif ($t.Contains('<start_of_turn>') -or $arch.StartsWith('gemma')) {
        # ---- Gemma. Gemma 4 ships a 256K+ window and uses channel thinking;
        #      Gemma 3 does not. ----
        $rec.family   = 'gemma'
        $rec.useJinja = 1
        if ($ctx -gt 131072) { $rec.id = 'gemma4'; $rec.thinkingFormat = 'gemma' }
        else                 { $rec.id = 'gemma3'; $rec.thinkingFormat = 'none'  }
    }
    elseif ($t.Contains('<|channel|>') -or $arch.Contains('gpt-oss') -or $arch.Contains('gptoss') -or $arch.Contains('gpt_oss')) {
        # ---- gpt-oss / Harmony channels. ----
        $rec.family = 'gpt-oss'; $rec.id = 'gpt-oss'; $rec.useJinja = 1; $rec.thinkingFormat = 'harmony'
    }
    else {
        # ---- Llama / DeepSeek / Granite / generic. ----
        if     ($arch.Contains('deepseek')) { $rec.family = 'deepseek'; $rec.id = 'deepseek'; $rec.thinkingFormat = 'deepseek' }
        elseif ($arch.Contains('granite'))  { $rec.family = 'granite';  $rec.id = 'granite'  }
        elseif ($arch.StartsWith('llama') -or $arch -eq '') { $rec.family = 'llama'; $rec.id = 'llama' }
        else                                { $rec.family = $arch; $rec.id = $arch }
        if ($t.Contains('<think>')) { $rec.thinkingFormat = 'deepseek' }
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
        ('set "MODEL_CHAT_TEMPLATE=' + $info.chatTemplate + '"')
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
