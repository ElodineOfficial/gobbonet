<#
================================================================================
 identify-model.ps1  --  single source of truth for model identification
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

$GGUF_TYPE_STRING = 8
$GGUF_TYPE_ARRAY  = 9
$GGUF_FIXED = @{ 0 = 1; 1 = 1; 2 = 2; 3 = 2; 4 = 4; 5 = 4; 6 = 4; 7 = 1; 10 = 8; 11 = 8; 12 = 8 }

function Read-GgufMeta {
    param([string]$Path)
    $res = @{ chat_template = ''; architecture = ''; context_length = [int64]0 }
    try {
        $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    } catch { return $null }

    try {
        $br = New-Object System.IO.BinaryReader($fs)
        $magic = $br.ReadBytes(4)
        if ($magic.Length -lt 4 -or $magic[0] -ne 0x47 -or $magic[1] -ne 0x47 -or $magic[2] -ne 0x55 -or $magic[3] -ne 0x46) { return $null }

        $ver = $br.ReadUInt32()
        if ($ver -lt 2 -or $ver -gt 3) { return $null }

        [void]$br.ReadUInt64()
        $nKv = $br.ReadUInt64()

        for ([uint64]$i = 0; $i -lt $nKv; $i++) {
            $klen = $br.ReadUInt64()
            if ($klen -gt 1048576) { return $null }
            $key = [System.Text.Encoding]::UTF8.GetString($br.ReadBytes([int]$klen))
            $vt = [int]$br.ReadUInt32()

            if ($vt -eq $GGUF_TYPE_STRING) {
                $vlen = $br.ReadUInt64()
                if ($vlen -gt 67108864) {
                    [void]$fs.Seek([int64]$vlen, [System.IO.SeekOrigin]::Current)
                } else {
                    $bytes = $br.ReadBytes([int]$vlen)
                    if ($key -eq 'tokenizer.chat_template') { $res.chat_template = [System.Text.Encoding]::UTF8.GetString($bytes) }
                    elseif ($key -eq 'general.architecture') { $res.architecture = [System.Text.Encoding]::UTF8.GetString($bytes) }
                }
            }
            elseif ($GGUF_FIXED.ContainsKey($vt)) {
                $raw = $br.ReadBytes($GGUF_FIXED[$vt])
                if ($key.EndsWith('.context_length')) {
                    if ($vt -eq 4 -or $vt -eq 5) { $res.context_length = [int64][System.BitConverter]::ToUInt32($raw, 0) }
                    elseif ($vt -eq 10 -or $vt -eq 11) { $res.context_length = [int64][System.BitConverter]::ToUInt64($raw, 0) }
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
                } else { return $null }
            }
            else { return $null }

            if ($res.chat_template -ne '' -and $res.architecture -ne '' -and $res.context_length -gt 0) { break }
        }
    } catch { return $null } finally { $fs.Close() }
    return $res
}

$HashDerivations = @{
    'e10ca381b1ccc5cf9db52e371f3b6651576caee0a630b452e2816b2d404d4b65' = @{ family='llama'; id='llama'; jinja=1; builtin=''; think='none' }
    '5816fce10444e03c2e9ee1ef8a4a1ea61ae7e69e438613f3b17b69d0426223a4' = @{ family='llama'; id='llama'; jinja=1; builtin=''; think='none' }
    '73e87b1667d87ab7d7b579107f01151b29ce7f3ccdd1018fdc397e78be76219d' = @{ family='llama'; id='llama'; jinja=1; builtin=''; think='none' }
    
    # ALL Mistral Hashes updated to use embedded Jinja (jinja=1) to prevent system prompt loss
    'e16746b40344d6c5b5265988e0328a0bf7277be86f1c335156eae07e29c82826' = @{ family='mistral'; id='mistral'; jinja=1; builtin=''; think='none' }
    '26a59556925c987317ce5291811ba3b7f32ec4c647c400c6cc7e3a9993007ba7' = @{ family='mistral'; id='mistral'; jinja=1; builtin=''; think='none' }
    'e4676cb56dffea7782fd3e2b577cfaf1e123537e6ef49b3ec7caa6c095c62272' = @{ family='mistral'; id='mistral-nemo'; jinja=1; builtin=''; think='none' }
    '3c4ad5fa60dd8c7ccdf82fa4225864c903e107728fcaf859fa6052cb80c92ee9' = @{ family='mistral'; id='mistral'; jinja=1; builtin=''; think='none' }
    '3934d199bfe5b6fab5cba1b5f8ee475e8d5738ac315f21cb09545b4e665cc005' = @{ family='mistral'; id='mistral-small'; jinja=1; builtin=''; think='none' }
    
    'ecd6ae513fe103f0eb62e8ab5bfa8d0fe45c1074fa398b089c93a7e70c15cfd6' = @{ family='gemma'; id='gemma3'; jinja=1; builtin=''; think='none' }
    '87fa45af6cdc3d6a9e4dd34a0a6848eceaa73a35dcfe976bd2946a5822a38bf3' = @{ family='gemma'; id='gemma3'; jinja=1; builtin=''; think='none' }
    '7de1c58e208eda46e9c7f86397df37ec49883aeece39fb961e0a6b24088dd3c4' = @{ family='gemma'; id='gemma3'; jinja=1; builtin=''; think='none' }
    '3b54f5c219ae1caa5c0bb2cdc7c001863ca6807cf888e4240e8739fa7eb9e02e' = @{ family='command-r'; id='command-r'; jinja=1; builtin=''; think='none' }
    'ac7498a36a719da630e99d48e6ebc4409de85a77556c2b6159eeb735bcbd11df' = @{ family='tulu'; id='tulu'; jinja=1; builtin=''; think='none' }
    '54d400beedcd17f464e10063e0577f6f798fa896266a912d8a366f8a2fcc0bca' = @{ family='deepseek'; id='deepseek'; jinja=1; builtin=''; think='none' }
    'b6835114b7303ddd78919a82e4d9f7d8c26ed0d7dfc36beeb12d524f6144eab1' = @{ family='deepseek'; id='deepseek-r1'; jinja=1; builtin=''; think='deepseek' }
    '854b703e44ca06bdb196cc471c728d15dbab61e744fe6cdce980086b61646ed1' = @{ family='glm'; id='glm'; jinja=1; builtin=''; think='none' }
    'aab20feb9bc6881f941ea649356130ffbc4943b3c2577c0991e1fba90de5a0fc' = @{ family='moonshot'; id='moonshot'; jinja=1; builtin=''; think='none' }
    '70da0d2348e40aaf8dad05f04a316835fd10547bd7e3392ce337e4c79ba91c01' = @{ family='gpt-oss'; id='gpt-oss'; jinja=1; builtin=''; think='harmony' }
    'a4c9919cbbd4acdd51ccffe22da049264b1b73e59055fa58811a99efbd7c8146' = @{ family='gpt-oss'; id='gpt-oss'; jinja=1; builtin=''; think='harmony' }
}

function Get-TemplateHash {
    param([string]$Template)
    if ($null -eq $Template) { return '' }
    $trimmed = $Template.Trim([char]0).Trim()
    if ($trimmed -eq '') { return '' }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($trimmed)
        $hash  = $sha.ComputeHash($bytes)
    } finally { $sha.Dispose() }
    return ([System.BitConverter]::ToString($hash) -replace '-', '').ToLower()
}

# Does a candidate .jinja actually contain a usable chat template, or is it
# junk we must NOT hand to llama-server?
#
# The motivating bug: a sidecar shipped next to a model was a *failed download*
# whose entire body was the 15-byte HTTP 404 string "Entry not found". Handed to
# llama-server via --chat-template-file, that becomes a constant-string
# "template" -- it renders to the same ~3 words for every turn, the model never
# sees the conversation, and it free-associates (in our case it rambled about
# "tekken", because the only other text in scope was the template's own name).
#
# A real Jinja chat template always contains control/output markers ({% ... %}
# or {{ ... }}). Anything without them (empty file, whitespace, an error body)
# is rejected here so we fall through to the built-in template instead.
function Test-IsUsableTemplate {
    param([string]$Path)
    try {
        if (-not (Test-Path $Path)) { return $false }
        $raw = [System.IO.File]::ReadAllText($Path)
    } catch { return $false }
    if ($null -eq $raw) { return $false }
    $t = $raw.Trim([char]0).Trim()
    if ($t.Length -lt 16) { return $false }              # too short to be real
    if ($t -ieq 'Entry not found') { return $false }     # classic HF/404 body
    if (-not ($t.Contains('{%') -or $t.Contains('{{'))) { return $false }
    return $true
}

# Match a .jinja sidecar to a GGUF stem. The label may be joined to the stem by
# '.', '_' or '-' (e.g. "<stem>.granite.jinja", "<stem>_mistral-v7-tekken.jinja"),
# or be a bare "<stem>.jinja". An earlier version accepted ONLY a literal '.',
# which silently ignored the underscore-joined sidecars people actually ship.
function Test-SidecarNameMatch {
    param([string]$NameLc, [string]$StemLc)
    if ($NameLc -eq ($StemLc + '.jinja')) { return $true }
    return ($NameLc.StartsWith($StemLc + '.') -or
            $NameLc.StartsWith($StemLc + '_') -or
            $NameLc.StartsWith($StemLc + '-'))
}

function Find-SidecarTemplate {
    param([string]$GgufPath)
    $dir = Split-Path $GgufPath -Parent
    if (-not $dir) { $dir = '.' }
    $stemLc = ((Split-Path $GgufPath -Leaf) -replace '(?i)\.gguf$', '').ToLower()
    $files  = Get-ChildItem -Path $dir -Filter '*.jinja' -File -ErrorAction SilentlyContinue
    foreach ($f in $files) {
        if ((Test-SidecarNameMatch $f.Name.ToLower() $stemLc) -and
            (Test-IsUsableTemplate (Join-Path $dir $f.Name))) { return $f.Name }
    }
    return ''
}

function Get-ModelInfo {
    param([string]$Path)
    $file = Split-Path $Path -Leaf
    $name = $file -replace '(?i)\.gguf$', ''
    $rec = [ordered]@{
        file = $file; id = 'custom'; name = $name; family = 'custom'; thinkingFormat = 'none'
        maxCtx = 131072; useJinja = 1; chatTemplate = ''; chatTemplateFile = ''; templateHash = ''
    }

    # --- SIDECAR CHECK FIRST ---
    # Find a sidecar template if one exists, so it overrides the hardcoded
    # safety nets below. We only accept it if (a) its name matches the GGUF
    # stem (',' '_' or '-' separator) AND (b) its CONTENTS are a real Jinja
    # template -- an empty file or a failed-download error body is rejected so
    # we fall through to the built-in instead of feeding llama-server junk.
    $dir = Split-Path $Path -Parent
    if (-not $dir) { $dir = '.' }
    $sidecarFile = Find-SidecarTemplate -GgufPath $Path

    if ($sidecarFile -ne '') {
        $rec.chatTemplateFile = "models\$sidecarFile"
        $rec.useJinja = 1
        if ($sidecarFile -match 'mistral') { $rec.family = 'mistral'; $rec.id = 'mistral' }
        elseif ($sidecarFile -match 'granite') { $rec.family = 'granite'; $rec.id = 'granite' }
    }

    $meta = Read-GgufMeta -Path $Path

    if ($rec.chatTemplateFile -eq '') {
        # --- HARD OVERRIDES ---
        # 1. Mistral variants (Cydonia, Nemo, Lotus)
        #
        # Mistral Small 24B and its mergekit merges (Asmodeus, Cydonia, ...) ship
        # an embedded v7-tekken template, but on mergekit children the embedded
        # template can be malformed (mergekit copies tokenizer_config from one
        # parent at random). The reliable path is llama.cpp's built-in C++
        # Mistral v7 template -- same pattern Nemo uses with mistral-v3-tekken
        # below.
        #
        # IMPORTANT: we use the name "mistral-v7" here, NOT "mistral-v7-tekken".
        # The "-tekken" v7 variant was added to llama.cpp's built-in name table
        # much later than the v3 variants (which landed in PR #10572). On builds
        # that predate it (e.g. b8941, the one this project ships), llama-server
        # does NOT recognise "mistral-v7-tekken" as a built-in name. Because the
        # string still begins with "mistral", llama-server's content-detector
        # treats the literal text "mistral-v7-tekken" as the template body, which
        # renders to that constant ~8-token string for EVERY request -- the model
        # then never sees the conversation and just talks about "tekken". Using
        # "mistral-v7" resolves to the real C++ template and renders correctly.
        # The only difference from true tekken is a trailing space after [INST] /
        # [SYSTEM_PROMPT]; harmless for inference. If you upgrade to a llama.cpp
        # build whose built-in table includes "mistral-v7-tekken", you can switch
        # this back for byte-exact tekken spacing.
        if ($name -match 'cydonia|asmodeus|mistral[-_.]?small') {
            $rec.family = 'mistral'; $rec.id = 'mistral-small'
            $rec.useJinja = 0; $rec.chatTemplate = 'mistral-v7'
            return $rec
        }
        if ($name -match 'nemo|violet[-_]?lotus|rocinante|magnum') {
            $rec.family = 'mistral'; $rec.id = 'mistral-nemo'
            $rec.useJinja = 0; $rec.chatTemplate = 'mistral-v3-tekken'
            return $rec
        }
        # 2. Granite
        if ($name -match 'granite') {
            $rec.family = 'granite'; $rec.id = 'granite'; $rec.useJinja = 1; $rec.chatTemplate = ''
            if ($name -match 'think') { $rec.thinkingFormat = 'deepseek' }
            return $rec
        }
        # 3. Llama 3 / 3.1 / 3.2 (The fix for the "junk" output)
        if ($name -match 'llama[-_]?[3]') {
            $rec.family = 'llama'; $rec.id = 'llama'; $rec.useJinja = 1; $rec.chatTemplate = ''
            return $rec
        }
        # 4. Command R (Cohere) — 7B (12-2024) is Cohere2ForCausalLM, 35B
        # variants (08-2024, v01) are CohereForCausalLM. Both ship a clean
        # embedded jinja template using <|START_OF_TURN_TOKEN|> / <|*_TOKEN|>
        # markers, and the pinned llama.cpp build (b9294) renders them fine
        # with --jinja, so no built-in-template override is needed. Filename
        # match handles the common case (drop the bartowski GGUF into models\)
        # where the GGUF-metadata branch below would also catch it via the
        # arch.StartsWith('cohere') rule; the filename rule is the fast path.
        #
        # No thinking format — Command R is instruct-style output, not
        # chain-of-thought. (Cohere's RAG/tool-calling extensions add a
        # <|START_RESPONSE|> token but that's orthogonal to thinking and
        # the chat-side parser doesn't need to know about it.)
        if ($name -match 'command[-_.]?r|c4ai') {
            $rec.family = 'cohere'; $rec.useJinja = 1; $rec.chatTemplate = ''
            if ($name -match 'r7b|r[-_.]?7b|7b[-_.]?12[-_.]?2024') {
                $rec.id = 'command-r7b'
            } else {
                $rec.id = 'command-r-35b'
            }
            return $rec
        }
        # ----------------------
    }

    if ($null -eq $meta) {
        if ($rec.chatTemplateFile -ne '') { return $rec }
        if ($name -match 'think|reason') { $rec.thinkingFormat = 'deepseek' }
        return $rec
    }

    $t = [string]$meta.chat_template
    $arch = ([string]$meta.architecture).ToLower()
    $ctx = [int64]$meta.context_length
    if ($ctx -gt 0) { $rec.maxCtx = [int][math]::Min($ctx, [int64]262144) }

    $hash = Get-TemplateHash -Template $t
    $rec.templateHash = $hash

    # If we already resolved a sidecar template above, check for thinking formats and return
    if ($rec.chatTemplateFile -ne '') {
        if ($arch -match 'deepseek' -or $t.Contains('<think>')) { $rec.thinkingFormat = 'deepseek' }
        return $rec
    }

    if ($hash -ne '' -and $HashDerivations.ContainsKey($hash)) {
        $d = $HashDerivations[$hash]
        $rec.family = $d.family; $rec.id = $d.id; $rec.useJinja = $d.jinja
        $rec.chatTemplate = $d.builtin; $rec.thinkingFormat = $d.think
        if ($d.family -eq 'gemma' -and $ctx -gt 131072) { $rec.id = 'gemma4'; $rec.thinkingFormat = 'gemma' }
        return $rec
    }

    $hasInst = $t.Contains('[INST]')
    $hasTools = $t.Contains('[AVAILABLE_TOOLS]')

    if ($t.Contains('<|channel|>') -or $arch.Contains('gpt-oss') -or $arch.Contains('gptoss') -or $arch.Contains('gpt_oss')) {
        $rec.family = 'gpt-oss'; $rec.id = 'gpt-oss'; $rec.useJinja = 1; $rec.thinkingFormat = 'harmony'
    } elseif ($t.Contains('<|START_OF_TURN_TOKEN|>') -or $arch.StartsWith('cohere')) {
        # Command R / R+ / R7B. Cohere's tokens are unambiguous -- no other
        # family uses START_OF_TURN_TOKEN. Both Cohere (35B) and Cohere2 (7B)
        # arch values get caught by StartsWith('cohere'). thinkingFormat
        # stays 'none' (Command R doesn't emit chain-of-thought; the
        # <|START_RESPONSE|> token Cohere uses for RAG is a response marker,
        # not a thinking marker, and the chat parser doesn't need it).
        $rec.family = 'cohere'; $rec.useJinja = 1
        # Distinguish 7B from 35B/R+. context_length and arch are the most
        # reliable signals (Cohere2 is 7B-specific), with filename as a
        # secondary check for older 35B GGUFs that happen to ship with a
        # context override.
        if ($arch -eq 'cohere2' -or $name -match 'r7b|r[-_.]?7b') {
            $rec.id = 'command-r7b'
        } else {
            $rec.id = 'command-r-35b'
        }
    } elseif ($t.Contains('<|im_user|>') -and $t.Contains('<|im_middle|>')) {
        $rec.family = 'moonshot'; $rec.id = 'moonshot'; $rec.useJinja = 1
    } elseif ($t.Contains('<|im_start|>')) {
        $rec.useJinja = 1
        if ($arch.StartsWith('qwen')) { $rec.family = 'qwen'; $rec.id = 'qwen' }
        elseif ($arch.StartsWith('glm') -or $arch -eq 'chatglm') { $rec.family = 'glm'; $rec.id = 'glm' }
        elseif ($arch.StartsWith('phi')) { $rec.family = 'phi'; $rec.id = 'phi' }
        elseif ($arch -ne '') { $rec.family = $arch; $rec.id = $arch }
        else { $rec.family = 'custom'; $rec.id = 'custom' }
        if ($t.Contains('<think>') -or $arch -eq 'qwen3' -or $arch -eq 'qwen3moe') { $rec.thinkingFormat = 'deepseek' }
    } elseif ($t.Contains('<start_of_turn>') -or $arch.StartsWith('gemma')) {
        $rec.family = 'gemma'; $rec.useJinja = 1
        if ($ctx -gt 131072) { $rec.id = 'gemma4'; $rec.thinkingFormat = 'gemma' }
        else { $rec.id = 'gemma3'; $rec.thinkingFormat = 'none' }
    } elseif ($hasInst -or $hasTools) {
        $rec.family = 'mistral'; $rec.id = 'mistral'; $rec.useJinja = 1; $rec.chatTemplate = ''
    } else {
        if ($arch.Contains('deepseek')) { $rec.family = 'deepseek'; $rec.id = 'deepseek'; $rec.thinkingFormat = 'deepseek' }
        elseif ($arch.StartsWith('llama') -or $arch -eq '') { $rec.family = 'llama'; $rec.id = 'llama' }
        else { $rec.family = $arch; $rec.id = $arch }
    }

    if ($rec.thinkingFormat -eq 'none' -and $t.Contains('<think>')) { $rec.thinkingFormat = 'deepseek' }
    return $rec
}

if ($ModelsDir) {
    if (-not $OutFile) { throw 'identify-model.ps1: -OutFile is required with -ModelsDir' }
    $files = Get-ChildItem -Path $ModelsDir -Filter '*.gguf' -File -ErrorAction SilentlyContinue | Sort-Object Name
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
    $dn = ($info.name -replace '[%!^&<>|"]', '')
    $setLines = @(
        ('set "MODEL_ID=' + $info.id + '"'),
        ('set "MODEL_DISPLAY=' + $dn + '"'),
        ('set "MODEL_FAMILY=' + $info.family + '"'),
        ('set "MODEL_MAX_CTX=' + $info.maxCtx + '"'),
        ('set "MODEL_THINK_FMT=' + $info.thinkingFormat + '"'),
        ('set "MODEL_USE_JINJA=' + ([int]$info.useJinja) + '"'),
        ('set "MODEL_CHAT_TEMPLATE=' + $info.chatTemplate + '"'),
        ('set "MODEL_CHAT_TEMPLATE_FILE=' + $info.chatTemplateFile + '"'),
        ('set "MODEL_TEMPLATE_HASH=' + $info.templateHash + '"')
    )
    if ($OutFile) {
        $body = ($setLines -join "`r`n") + "`r`n"
        [System.IO.File]::WriteAllText($OutFile, $body, (New-Object System.Text.ASCIIEncoding))
    } else { $setLines | ForEach-Object { Write-Output $_ } }
} else { Write-Output (([PSCustomObject]$info) | ConvertTo-Json -Compress) }