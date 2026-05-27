# ==============================================================================
# fileserver.ps1 -- Gobbonet web server, reverse proxy, and hot-swap controller
#
# Responsibilities:
#   1. Serve static files (chat.html, style.css, active-model.json, models-list.json, etc.)
#      from the project root on http://+:8080/.
#   2. Reverse-proxy /llm/*    -> http://127.0.0.1:$LlmPort     (llama-server)
#                   /search/*  -> http://127.0.0.1:$SearchPort  (Ollama search proxy)
#   3. Persist a JSON blob at /state for cross-device state sync (GET + POST).
#   4. Hot-swap the active GGUF without rebooting:
#         POST /swap-model   {"file":"<name>.gguf"}  -> kicks off the swap,
#                                                       returns 202 immediately.
#         GET  /swap-status                          -> polls status; promotes
#                                                       phase to "ready" when
#                                                       llama-server /health
#                                                       comes back online.
#
# Coordination with launch.bat's health monitor:
#   While a swap is in flight, this script creates `.swap-in-progress` in
#   $Root and only removes it once the new server is healthy (or the swap
#   has erred out). launch.bat's monitor loop sees that file and skips its
#   own kill+restart cycle, so the two never race.
#
# Configuration is read from environment variables set by launch.bat:
#   GEMMA_ROOT, GEMMA_LLM_PORT, GEMMA_SEARCH_PORT, GEMMA_SERVER_EXE,
#   GEMMA_MODEL_DIR, GEMMA_CTX_SIZE, GEMMA_GPU_LAYERS, GEMMA_KV_CACHE_TYPE,
#   GEMMA_LOG_FILE, GEMMA_LAUNCH_SCRIPT
#
# Everything is ASCII-only on purpose -- the launcher routes some output
# through batch echo, which mangles non-ASCII chars on legacy code pages.
# ==============================================================================

$ErrorActionPreference = 'Continue'

# --- Config ------------------------------------------------------------------

function Get-EnvOrDefault {
    param([string]$Name, $Default)
    $v = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrEmpty($v)) { return $Default } else { return $v }
}

$Root         = Get-EnvOrDefault 'GEMMA_ROOT'           (Split-Path -Parent $MyInvocation.MyCommand.Path)
$LlmPort      = [int](Get-EnvOrDefault 'GEMMA_LLM_PORT'      '11434')
$SearchPort   = [int](Get-EnvOrDefault 'GEMMA_SEARCH_PORT'   '11435')
$ListenPort   = 8080
$ServerExe    = Get-EnvOrDefault 'GEMMA_SERVER_EXE'     ''
$ModelDir     = Get-EnvOrDefault 'GEMMA_MODEL_DIR'      (Join-Path $Root 'models')
$CtxSize      = [int](Get-EnvOrDefault 'GEMMA_CTX_SIZE'      '16384')
$GpuLayers    = [int](Get-EnvOrDefault 'GEMMA_GPU_LAYERS'    '99')
$KvCacheType  = Get-EnvOrDefault 'GEMMA_KV_CACHE_TYPE'  'q8_0'
$LogFile      = Get-EnvOrDefault 'GEMMA_LOG_FILE'       (Join-Path $Root 'llama-server.log')
$LaunchScript = Get-EnvOrDefault 'GEMMA_LAUNCH_SCRIPT'  (Join-Path $Root '.llama-launch.cmd')

$StatePath    = Join-Path $Root '.gobbonet-state.json'
$SwapLock     = Join-Path $Root '.swap-in-progress'
$SwapStatus   = Join-Path $Root '.swap-status.json'
$ModelsListJs = Join-Path $Root 'models-list.json'
$ActiveJson   = Join-Path $Root 'active-model.json'

# --- Access control ----------------------------------------------------------
# A single shared password gates the whole server. Anyone on the LAN can REACH
# port 8080 (the firewall only restricts to LocalSubnet), so a roommate, guest,
# or compromised IoT device on the same Wi-Fi could otherwise read/write chats,
# drive the GPU, and swap models. Requiring a password closes that gap.
#
# The browser authenticates ONCE via a tiny login page, then receives an
# HttpOnly session cookie. Every later request -- including the /llm and
# /search proxy calls made by chat.html -- carries that cookie automatically,
# so none of the existing fetch() calls in chat.html need to change, and the
# .local bookmark keeps working across IP rotations.
#
# $AccessSalt / $AccessHash : the password is NOT stored or transmitted in the
#   clear. launch.bat hands us a "salt:hash" string (salted SHA-256, lowercase
#   hex) via GEMMA_ACCESS_SECRET. At login we recompute SHA256(salt + typed)
#   and constant-time compare to $AccessHash. The plaintext exists only for the
#   instant a login request is being checked.
# $LlmApiKey : optional key for llama-server (empty in the loopback build).
$AccessSecret = Get-EnvOrDefault 'GEMMA_ACCESS_SECRET' ''
$AccessSalt   = ''
$AccessHash   = ''
if ($AccessSecret -match '^([0-9a-fA-F]+):([0-9a-fA-F]+)$') {
    $AccessSalt = $Matches[1].ToLower()
    $AccessHash = $Matches[2].ToLower()
}
if ($AccessHash -eq '') {
    Write-Host "[FATAL] No access secret provided (GEMMA_ACCESS_SECRET missing or malformed)." -Foreground Red
    Write-Host "        Run launch.bat -- it sets the password on first run. Exiting." -Foreground Red
    exit 1
}
$LlmApiKey = Get-EnvOrDefault 'GEMMA_LLM_API_KEY' ''

# Compute the salted hash of a candidate password the same way launch.bat did.
function Get-PasswordHash {
    param([string]$Plain)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($AccessSalt + $Plain)
    return (([BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-').ToLower())
}

# Session tokens live in memory only -- restarting the server logs everyone out,
# which is fine for a single-user home tool. Key = token string, Value = expiry.
$Script:Sessions = @{}
# Session lifetime. This is deliberately SHORT because the cookie crosses the
# LAN over plain HTTP (see the security notice below) -- a shorter window means
# a sniffed cookie stops working sooner. 12h covers a normal day's use; the
# phone re-logs-in roughly once a day, which is a small price for the smaller
# exposure. Bump it if you understand the tradeoff.
$SessionTtlHours = 12

# Hot-swap is only possible when launch.bat handed us enough context to
# rebuild the launch command. If those env vars are missing we still serve
# static + proxy fine, but /swap-model will refuse.
$HotSwapEnabled = ($ServerExe -ne '') -and (Test-Path $ServerExe) -and (Test-Path $ModelDir)

Write-Host ("fileserver.ps1 starting (hotswap-v3) pid={0}  root={1}" -f $PID, $Root)
Write-Host ("  llm-port={0} search-port={1} listen-port={2}" -f $LlmPort, $SearchPort, $ListenPort)
Write-Host ("  hot-swap={0}" -f $(if ($HotSwapEnabled) { 'enabled' } else { 'disabled (missing server exe or model dir)' }))

# Boot-time hygiene: stale lock/status files from a previous crash would
# confuse both the monitor loop and any chat tab polling /swap-status.
if (Test-Path $SwapLock)   { Remove-Item $SwapLock   -Force -ErrorAction SilentlyContinue }
if (Test-Path $SwapStatus) { Remove-Item $SwapStatus -Force -ErrorAction SilentlyContinue }

# --- Helpers -----------------------------------------------------------------

# Map a few common extensions to MIME types so the browser doesn't refuse
# to execute .js as a module or treat .css as text/html. Anything we don't
# know about falls back to application/octet-stream which is the safe default.
$MimeMap = @{
    '.html' = 'text/html; charset=utf-8'
    '.htm'  = 'text/html; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.js'   = 'application/javascript; charset=utf-8'
    '.mjs'  = 'application/javascript; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.svg'  = 'image/svg+xml'
    '.png'  = 'image/png'
    '.jpg'  = 'image/jpeg'
    '.jpeg' = 'image/jpeg'
    '.gif'  = 'image/gif'
    '.webp' = 'image/webp'
    '.ico'  = 'image/x-icon'
    '.txt'  = 'text/plain; charset=utf-8'
    '.woff' = 'font/woff'
    '.woff2'= 'font/woff2'
    '.map'  = 'application/json; charset=utf-8'
}

function Get-MimeType {
    param([string]$Path)
    $ext = [System.IO.Path]::GetExtension($Path).ToLower()
    if ($MimeMap.ContainsKey($ext)) { return $MimeMap[$ext] }
    return 'application/octet-stream'
}

function Add-CommonHeaders {
    param($Response)
    # Permissive CORS so phones on the LAN, file:// chat.html, and any future
    # variant all share the same backend without preflight headaches.
    $Response.AddHeader('Access-Control-Allow-Origin',  '*')
    $Response.AddHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    $Response.AddHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    $Response.AddHeader('Cache-Control', 'no-store')
}

function Write-Json {
    param($Response, [int]$Status, $Object)
    $Response.StatusCode = $Status
    $Response.ContentType = 'application/json; charset=utf-8'
    $json = ($Object | ConvertTo-Json -Depth 8 -Compress)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $Response.ContentLength64 = $bytes.Length
    $Response.OutputStream.Write($bytes, 0, $bytes.Length)
}

function Write-Text {
    param($Response, [int]$Status, [string]$ContentType, [string]$Body)
    $Response.StatusCode = $Status
    $Response.ContentType = $ContentType
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Body)
    $Response.ContentLength64 = $bytes.Length
    $Response.OutputStream.Write($bytes, 0, $bytes.Length)
}

# Windows PowerShell 5.1's `Set-Content -Encoding UTF8` writes a BOM, which
# some JSON consumers handle and others don't. Always write BOM-less.
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Write-FileUtf8 {
    param([string]$Path, [string]$Content)
    [System.IO.File]::WriteAllText($Path, $Content, $Utf8NoBom)
}
function Write-FileAscii {
    param([string]$Path, [string]$Content)
    [System.IO.File]::WriteAllText($Path, $Content, [System.Text.Encoding]::ASCII)
}

# --- Auth helpers ------------------------------------------------------------

# Constant-time string compare so a network attacker can't time-probe the
# password character by character. Both sides are short, but it's cheap to
# do correctly.
function Test-SecretEqual {
    param([string]$A, [string]$B)
    if ($null -eq $A -or $null -eq $B) { return $false }
    $ba = [System.Text.Encoding]::UTF8.GetBytes($A)
    $bb = [System.Text.Encoding]::UTF8.GetBytes($B)
    $diff = $ba.Length -bxor $bb.Length
    $max = [Math]::Max($ba.Length, $bb.Length)
    for ($i = 0; $i -lt $max; $i++) {
        $va = if ($i -lt $ba.Length) { $ba[$i] } else { 0 }
        $vb = if ($i -lt $bb.Length) { $bb[$i] } else { 0 }
        $diff = $diff -bor ($va -bxor $vb)
    }
    return ($diff -eq 0)
}

function Get-ClientId {
    # A coarse fingerprint of the requesting client: source IP + User-Agent,
    # hashed. Not a strong identity (an on-path attacker can spoof both), but it
    # means a cookie sniffed off the plaintext LAN can't simply be replayed from
    # a different device/browser without also matching these. Cheap extra bar.
    param($Request)
    $ip = ''
    try { $ip = $Request.RemoteEndPoint.Address.ToString() } catch { }
    $ua = [string]$Request.Headers['User-Agent']
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($ip + '|' + $ua)
    return (([BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-').ToLower())
}

function New-SessionToken {
    param([string]$ClientId)
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $tok = [Convert]::ToBase64String($bytes).Replace('+','-').Replace('/','_').TrimEnd('=')
    $Script:Sessions[$tok] = @{ Expiry = (Get-Date).AddHours($SessionTtlHours); ClientId = $ClientId }
    return $tok
}

function Test-SessionToken {
    param([string]$Token, [string]$ClientId)
    if ([string]::IsNullOrEmpty($Token)) { return $false }
    if (-not $Script:Sessions.ContainsKey($Token)) { return $false }
    $sess = $Script:Sessions[$Token]
    if ((Get-Date) -gt $sess.Expiry) {
        $Script:Sessions.Remove($Token)
        return $false
    }
    if ($sess.ClientId -ne $ClientId) { return $false }
    return $true
}

# Pull the session token from the Cookie header (browser) or, as a fallback,
# an "X-Gobbonet-Token" header (for scripted/curl access).
function Get-RequestToken {
    param($Request)
    $cookie = $Request.Headers['Cookie']
    if ($cookie) {
        foreach ($part in $cookie.Split(';')) {
            $kv = $part.Trim().Split('=', 2)
            if ($kv.Length -eq 2 -and $kv[0] -eq 'gobbonet_session') {
                return $kv[1]
            }
        }
    }
    $hdr = $Request.Headers['X-Gobbonet-Token']
    if ($hdr) { return $hdr }
    return $null
}

function Test-Authenticated {
    param($Request)
    return (Test-SessionToken (Get-RequestToken $Request) (Get-ClientId $Request))
}

# Minimal login page. Self-contained, themed to match the app's dark palette.
# Posts the password to /login; on success the server sets the cookie and the
# page redirects to /.
function Get-LoginPageHtml {
    param([bool]$Failed)
    $err = if ($Failed) { '<p class="err">Wrong password. Try again.</p>' } else { '' }
    return @"
<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>gobbonet -- sign in</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#0a0e0a; color:#7fd97f; font-family:ui-monospace,Menlo,Consolas,monospace; }
  .box { width:min(92vw,360px); padding:28px; border:1px solid #1f3a1f; border-radius:10px; background:#0d140d; }
  h1 { font-size:18px; margin:0 0 4px; color:#9cffa0; letter-spacing:1px; }
  p.sub { margin:0 0 20px; font-size:12px; color:#4f7d4f; }
  label { display:block; font-size:12px; margin-bottom:6px; color:#6fbf6f; }
  input { width:100%; box-sizing:border-box; padding:11px 12px; font-size:15px; background:#060a06;
          border:1px solid #2a4a2a; border-radius:6px; color:#cfeccf; outline:none; }
  input:focus { border-color:#4f9d4f; }
  button { margin-top:16px; width:100%; padding:11px; font-size:14px; font-weight:600; cursor:pointer;
           background:#1c3a1c; color:#bdf5bd; border:1px solid #3a6a3a; border-radius:6px; }
  button:hover { background:#234a23; }
  .err { color:#ff8a8a; font-size:12px; margin:14px 0 0; }
  .note { margin:18px 0 0; padding-top:14px; border-top:1px solid #1f3a1f;
          font-size:11px; line-height:1.5; color:#5a7d5a; }
</style></head>
<body><form class="box" method="POST" action="/login">
  <h1>gobbonet</h1>
  <p class="sub">This server is password-protected. Sign in to continue.</p>
  <label for="pw">Password</label>
  <input type="password" id="pw" name="password" autofocus autocomplete="current-password">
  <button type="submit">Sign in</button>
  $err
  <p class="note">This connection is over your local network in plain text
  (not encrypted). It's fine for a home network you trust. Avoid using it on
  shared or public Wi-Fi, and don't reuse a password that matters elsewhere.</p>
</form></body></html>
"@
}

# Resolve a request URL path to an absolute path inside $Root, refusing
# anything that escapes the root via .. traversal or absolute paths.
# Returns $null if the path is unsafe or doesn't exist.
function Resolve-StaticPath {
    param([string]$UrlPath)
    if ([string]::IsNullOrEmpty($UrlPath) -or $UrlPath -eq '/') { $UrlPath = '/chat.html' }
    # URL-decode and strip leading slash. We then join under $Root and
    # canonicalize, checking the result still starts with $Root.
    $rel = [System.Web.HttpUtility]::UrlDecode($UrlPath.TrimStart('/'))
    if ($rel -match '(^|[\\/])\.\.([\\/]|$)') { return $null }
    $candidate = Join-Path $Root $rel
    try {
        $full = [System.IO.Path]::GetFullPath($candidate)
    } catch { return $null }
    $rootFull = [System.IO.Path]::GetFullPath($Root)
    if (-not $full.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $null
    }
    if (-not (Test-Path $full -PathType Leaf)) { return $null }
    return $full
}

# --- Reverse proxy -----------------------------------------------------------

# Pass a request through to an upstream HTTP server, streaming the response
# back unchanged. Used for /llm/* (llama-server) and /search/* (ollama
# search proxy). We deliberately do NOT pre-buffer the body -- streaming is
# how the chat UI gets token-by-token replies.
function Invoke-Proxy {
    param(
        $Request,
        $Response,
        [string]$Prefix,
        [int]$UpstreamPort,
        [bool]$InjectLlmKey = $false
    )

    # Strip the routing prefix to get the upstream path.
    $absPath = $Request.Url.AbsolutePath
    if ($absPath.StartsWith($Prefix)) {
        $upstreamPath = $absPath.Substring($Prefix.Length)
        if (-not $upstreamPath.StartsWith('/')) { $upstreamPath = '/' + $upstreamPath }
    } else {
        $upstreamPath = $absPath
    }
    $query = $Request.Url.Query
    $upstreamUrl = ('http://127.0.0.1:{0}{1}{2}' -f $UpstreamPort, $upstreamPath, $query)

    try {
        $req = [System.Net.HttpWebRequest]::Create($upstreamUrl)
        $req.Method = $Request.HttpMethod
        $req.KeepAlive = $false
        $req.AllowAutoRedirect = $false
        # Streaming responses (SSE) can sit open for minutes during long
        # generations. Keep the timeout generous.
        $req.Timeout = 600000
        $req.ReadWriteTimeout = 600000

        # Forward headers, skipping ones .NET sets itself or that don't make
        # sense to pass through.
        foreach ($key in $Request.Headers.AllKeys) {
            $val = $Request.Headers[$key]
            switch -Regex ($key) {
                '^(Host|Content-Length|Connection|Keep-Alive|Transfer-Encoding|Expect|Proxy-Connection)$' { continue }
                '^Content-Type$' { $req.ContentType = $val; continue }
                '^User-Agent$'   { $req.UserAgent   = $val; continue }
                '^Accept$'       { $req.Accept      = $val; continue }
                default {
                    try { $req.Headers.Add($key, $val) } catch { }
                }
            }
        }

        # For the LLM upstream, replace any client Authorization with the
        # server-side llama-server key. The browser never sees this key, and
        # llama-server (bound to loopback + requiring --api-key) rejects anything
        # that reaches it without it.
        if ($InjectLlmKey -and $LlmApiKey -ne '') {
            try { $req.Headers.Remove('Authorization') } catch { }
            $req.Headers.Add('Authorization', ('Bearer {0}' -f $LlmApiKey))
        }

        # Pipe the request body through for non-GET methods.
        if ($Request.HasEntityBody) {
            $reqStream = $req.GetRequestStream()
            $buf = New-Object byte[] 8192
            while (($n = $Request.InputStream.Read($buf, 0, $buf.Length)) -gt 0) {
                $reqStream.Write($buf, 0, $n)
            }
            $reqStream.Close()
        }
        try {
            $upResp = $req.GetResponse()
        } catch [System.Net.WebException] {
            # llama-server returns 4xx/5xx for some chat conditions, and we
            # want to forward those instead of synthesizing our own error.
            if ($_.Exception.Response) {
                $upResp = $_.Exception.Response
            } else {
                throw
            }
        }

        $Response.StatusCode = [int]$upResp.StatusCode
        # Copy response headers across.
        foreach ($key in $upResp.Headers.AllKeys) {
            $val = $upResp.Headers[$key]
            switch -Regex ($key) {
                '^(Transfer-Encoding|Connection|Keep-Alive|Content-Length)$' { continue }
                '^Content-Type$' { $Response.ContentType = $val; continue }
                default {
                    try { $Response.Headers.Add($key, $val) } catch { }
                }
            }
        }

        # Stream the body. Don't buffer -- we want SSE chunks to flush.
        $Response.SendChunked = $true
        $upStream = $upResp.GetResponseStream()
        $buf = New-Object byte[] 4096
        while (($n = $upStream.Read($buf, 0, $buf.Length)) -gt 0) {
            $Response.OutputStream.Write($buf, 0, $n)
            try { $Response.OutputStream.Flush() } catch { }
        }
        $upStream.Close()
        try { $upResp.Close() } catch { }
    } catch {
        Write-Host ("[proxy] {0} {1} -> {2}" -f $Request.HttpMethod, $upstreamUrl, $_.Exception.Message)
        try {
            Write-Json $Response 502 @{ error = 'upstream unreachable'; detail = $_.Exception.Message }
        } catch { }
    }
}

# --- State sync --------------------------------------------------------------

function Handle-State {
    param($Request, $Response)
    if ($Request.HttpMethod -eq 'GET') {
        if (Test-Path $StatePath) {
            $text = Get-Content $StatePath -Raw -Encoding UTF8
            $mtime = (Get-Item $StatePath).LastWriteTimeUtc
            $mtimeMs = [int64]($mtime - [DateTime]'1970-01-01').TotalMilliseconds
            $Response.AddHeader('X-State-Mtime', "$mtimeMs")
            Write-Text $Response 200 'application/json; charset=utf-8' $text
        } else {
            Write-Json $Response 404 @{ error = 'no state on server' }
        }
        return
    }
    if ($Request.HttpMethod -eq 'POST' -or $Request.HttpMethod -eq 'PUT') {
        $reader = New-Object System.IO.StreamReader($Request.InputStream, [System.Text.Encoding]::UTF8)
        $body = $reader.ReadToEnd()
        $reader.Close()
        try {
            # Validate it parses as JSON before persisting -- never write garbage.
            $null = $body | ConvertFrom-Json
        } catch {
            Write-Json $Response 400 @{ error = 'body is not valid JSON' }
            return
        }
        try {
            Write-FileUtf8 $StatePath $body
            $mtime = (Get-Item $StatePath).LastWriteTimeUtc
            $mtimeMs = [int64]($mtime - [DateTime]'1970-01-01').TotalMilliseconds
            Write-Json $Response 200 @{ status = 'ok'; mtime = $mtimeMs }
        } catch {
            Write-Json $Response 500 @{ error = 'write failed'; detail = $_.Exception.Message }
        }
        return
    }
    Write-Json $Response 405 @{ error = 'method not allowed' }
}

# --- Hot model swap ----------------------------------------------------------

# Read models-list.json and return the record for $File, or $null if not
# present. The list is built by launch.bat at boot time, so anything in the
# models/ folder should be in there with its identification metadata.
function Get-ModelRecord {
    param([string]$File)
    if (-not (Test-Path $ModelsListJs)) { return $null }
    try {
        $json = Get-Content $ModelsListJs -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        return $null
    }
    foreach ($m in $json.models) {
        if ($m.file -eq $File) { return $m }
    }
    return $null
}

# Build the launch command line for a given model record. Mirrors the
# argument set that launch.bat constructs in its :start_server block --
# context size, GPU layers, KV cache type, parallel slots, optional jinja
# vs built-in chat template, and the reasoning-format split. The output is
# the contents of the .cmd file the monitor loop re-runs on crash.
function Build-LaunchScript {
    param($Model, [string]$ModelPath)

    $useJinja      = $true
    $chatTemplate  = ''
    $chatTemplateFile = ''
    if ($Model.PSObject.Properties.Match('useJinja').Count -gt 0) {
        # JSON ints come through as Int64 -- coerce defensively.
        $useJinja = [bool]([int]$Model.useJinja)
    }
    if ($Model.PSObject.Properties.Match('chatTemplate').Count -gt 0 -and $Model.chatTemplate) {
        $chatTemplate = [string]$Model.chatTemplate
    }
    if ($Model.PSObject.Properties.Match('chatTemplateFile').Count -gt 0 -and $Model.chatTemplateFile) {
        $chatTemplateFile = [string]$Model.chatTemplateFile
    }

    # Safety net for stale records. identify-model.ps1 now tags Mistral Nemo
    # with useJinja=0 + mistral-v3-tekken, but a models-list.json generated
    # before that fix may still carry a mis-identified Nemo as 'custom' with
    # useJinja=1. Launching such a record with --jinja makes llama-server abort
    # on the startup tool-call-example check ("did not stay running"). Detect
    # Nemo by name here and force the built-in template so the swap works even
    # without regenerating models-list.json. Honors an explicit non-empty
    # chatTemplate if one is already set; only overrides the broken --jinja path.
    $nameForMatch = ''
    if ($Model.PSObject.Properties.Match('name').Count -gt 0 -and $Model.name) { $nameForMatch = [string]$Model.name }
    $fileForMatch = ''
    if ($Model.PSObject.Properties.Match('file').Count -gt 0 -and $Model.file) { $fileForMatch = [string]$Model.file }
    if (($nameForMatch -match 'nemo|(^|[-_])mn-') -or ($fileForMatch -match 'nemo|(^|[-_])mn-')) {
        if ($useJinja -or -not $chatTemplate) {
            $useJinja = $false
            if (-not $chatTemplate) { $chatTemplate = 'mistral-v3-tekken' }
            Write-Host "[swap] Nemo safety net: forcing built-in template '$chatTemplate' (--jinja disabled)"
        }
    }

    # Same class of failure for Granite, but with an extra twist. Its embedded
    # tool-calling Jinja template makes the new-engine startup autoparser abort
    # ("failed to generate tool call example"), AND the bare built-in name
    # (--chat-template granite) does NOT resolve on current llama.cpp builds --
    # it gets treated as a literal template, so the model is fed just the word
    # "granite" and talks about the rock. The fix is a cleaned no-tools template
    # FILE (granite.jinja, shipped in $Root) passed via --chat-template-file with
    # --jinja on. This safety net catches stale models-list.json records (written
    # before the identify-model.ps1 fix, carrying useJinja=1 / no file / or the
    # old bare 'granite' name) and forces the file path so the swap works without
    # regenerating the list.
    if (($nameForMatch -match 'granite') -or ($fileForMatch -match 'granite')) {
        if (-not $chatTemplateFile) {
            $chatTemplateFile = 'granite.jinja'
            # Drop a stale bare-name template ('granite' / 'granite-4.0') so the
            # file path below takes precedence cleanly.
            if ($chatTemplate -match '^granite') { $chatTemplate = '' }
            $useJinja = $true
            Write-Host "[swap] Granite safety net: forcing template file 'granite.jinja' (--jinja on, embedded template overridden)"
        }
    }

    $argList = @(
        ('"{0}"' -f $ServerExe),
        '--model',     ('"{0}"' -f $ModelPath),
        '--port',      "$LlmPort",
        '--host',      '127.0.0.1',
        '--ctx-size',  "$CtxSize",
        '--n-gpu-layers', "$GpuLayers",
        '--cache-type-k', $KvCacheType,
        '--cache-type-v', $KvCacheType,
        '--parallel',  '1'
    )
    # Template source precedence (mirrors launch.bat):
    #   1. chatTemplateFile -> --jinja --chat-template-file "<$Root\file>"
    #      (a real .jinja shipped with the project; --jinja is REQUIRED for
    #       --chat-template-file to be honored). Overrides the embedded template.
    #   2. chatTemplate (built-in NAME) -> --chat-template <name>, --jinja off.
    #   3. neither -> plain --jinja (embedded template) if useJinja.
    if ($chatTemplateFile) {
        $resolvedTemplatePath = Join-Path $Root $chatTemplateFile
        if (Test-Path $resolvedTemplatePath) {
            $argList += '--jinja'
            $argList += @('--chat-template-file', ('"{0}"' -f $resolvedTemplatePath))
        } else {
            Write-Host "[swap] WARNING: chat-template file not found: $resolvedTemplatePath -- falling back to --jinja (embedded template)"
            $argList += '--jinja'
        }
    } else {
        if ($useJinja)     { $argList += '--jinja' }
        if ($chatTemplate) { $argList += @('--chat-template', $chatTemplate) }
    }
    $argList += @('--reasoning-format', 'auto')
    # Require the API key so only this proxy (which injects it) can talk to the
    # model. Bound to 127.0.0.1 above, so it's off the LAN regardless.
    if ($LlmApiKey -ne '') { $argList += @('--api-key', ('"{0}"' -f $LlmApiKey)) }

    $line = ($argList -join ' ')
    # Redirect both stdout and stderr to the shared log file so the monitor
    # loop and post-mortems can read it.
    $line = $line + (' > "{0}" 2>&1' -f $LogFile)

    # Plain CRLF batch file. No fancy quoting -- everything that needs
    # escaping is already wrapped in double quotes above.
    return "@echo off`r`n" + $line + "`r`n"
}

# Stop the currently-running llama-server process(es). We match by image
# name because the process is started detached and we don't always have a
# PID to wait on. Any process named "llama-server" is fair game.
#
# CRITICAL: Stop-Process returns before Windows has actually released the
# listening socket on port 11434. If we spawn the replacement before that,
# the new server's bind() fails and it exits silently within ~50ms --
# /swap-status then sits at "starting" until the 180s timeout, which looks
# like the model is loading when really it's already dead. So we poll the
# port itself and only return once nothing is listening, plus a small grace
# margin to make sure the kernel-side cleanup is done.
function Stop-LlamaServer {
    $procs = @(Get-Process -Name 'llama-server' -ErrorAction SilentlyContinue)
    foreach ($p in $procs) {
        try {
            $p | Stop-Process -Force -ErrorAction SilentlyContinue
        } catch { }
    }

    $deadline = (Get-Date).AddSeconds(5)
    while ((Get-Date) -lt $deadline) {
        $stillUp = $false
        try {
            $tc  = New-Object System.Net.Sockets.TcpClient
            $iar = $tc.BeginConnect('127.0.0.1', $LlmPort, $null, $null)
            $ok  = $iar.AsyncWaitHandle.WaitOne(200)
            if ($ok -and $tc.Connected) { $stillUp = $true }
            $tc.Close()
        } catch { }
        if (-not $stillUp) { break }
        Start-Sleep -Milliseconds 250
    }
    # Belt-and-suspenders: kernel sometimes lingers a moment past the
    # last accept() refusal. Match launch.bat's 3s post-taskkill pause
    # to keep behaviour identical between boot-restart and hot-swap.
    Start-Sleep -Milliseconds 1500
}

# Write the swap-status file. Used both to surface progress to the polling
# client and to communicate to launch.bat's monitor loop (via the lock
# file) that it should hold off restarting.
function Write-SwapStatus {
    param(
        [string]$Phase,    # 'starting' | 'ready' | 'error'
        [string]$File,
        [string]$Name,
        [string]$Message,
        [int64]$StartedAt
    )
    $obj = @{
        phase      = $Phase
        file       = $File
        name       = $Name
        message    = $Message
        started_at = $StartedAt
        updated_at = [int64](([DateTime]::UtcNow - [DateTime]'1970-01-01').TotalSeconds)
    }
    $json = $obj | ConvertTo-Json -Compress
    Write-FileUtf8 $SwapStatus $json
}

function Read-SwapStatus {
    if (-not (Test-Path $SwapStatus)) { return $null }
    try {
        return Get-Content $SwapStatus -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch { return $null }
}

# Best-effort extraction of a human-meaningful reason from the tail of
# llama-server.log after the process died on startup. Returns $null if the
# log can't be read or nothing useful is found, in which case the caller
# falls back to the generic "did not stay running" message.
#
# The signature table maps known fatal log strings to a plain-English cause +
# next step. The patterns are matched case-insensitively against the tail,
# scanning bottom-up so the most recent fatal line wins. If no signature
# matches we surface the last non-empty log line verbatim -- still far more
# actionable than "check the log".
function Get-LlamaStartupError {
    param([int]$TailLines = 40)

    if (-not (Test-Path $LogFile)) { return $null }
    try {
        $lines = @(Get-Content -LiteralPath $LogFile -Tail $TailLines -ErrorAction Stop)
    } catch {
        return $null
    }
    if ($lines.Count -eq 0) { return $null }

    $signatures = @(
        @{ pat = 'failed to generate tool call example';       msg = "The model's chat template failed llama-server's startup validation (tool-call example) -- the classic Mistral Nemo / tool-template case. Launch it with a built-in template (mistral-v3-tekken) instead of --jinja." },
        @{ pat = 'unable to generate parser for this template'; msg = "llama-server couldn't parse the model's Jinja chat template. Use a built-in --chat-template (mistral-v3-tekken for Nemo) instead of --jinja." },
        @{ pat = 'error parsing grammar';                       msg = "llama-server rejected the chat-template grammar. Use a built-in --chat-template instead of --jinja." },
        @{ pat = 'raise_exception';                             msg = "The chat template raised an exception during startup validation. Use a built-in --chat-template instead of --jinja." },
        @{ pat = 'out of memory';                               msg = "llama-server ran out of VRAM loading this model. Lower GEMMA_GPU_LAYERS or GEMMA_CTX_SIZE." },
        @{ pat = 'cudamalloc';                                  msg = "CUDA allocation failed (out of VRAM). Lower GEMMA_GPU_LAYERS or GEMMA_CTX_SIZE." },
        @{ pat = 'failed to allocate';                          msg = "A memory buffer allocation failed loading the model. Lower GEMMA_GPU_LAYERS or GEMMA_CTX_SIZE." },
        @{ pat = 'unknown model architecture';                  msg = "This GGUF's architecture isn't supported by your llama.cpp build. Update llama.cpp." },
        @{ pat = 'failed to load model';                        msg = "llama-server couldn't load the GGUF (corrupt, truncated, or unsupported file)." },
        @{ pat = 'error loading model';                         msg = "llama-server couldn't load the GGUF (corrupt, truncated, or unsupported file)." },
        @{ pat = 'unknown argument';                            msg = "llama-server rejected a command-line flag -- your llama.cpp build may be older than the launch arguments expect." },
        @{ pat = 'invalid argument';                            msg = "llama-server rejected a command-line flag. Check GEMMA_KV_CACHE_TYPE and the launch flags against your llama.cpp build." }
    )

    for ($i = $lines.Count - 1; $i -ge 0; $i--) {
        $low = $lines[$i].ToLower()
        foreach ($s in $signatures) {
            if ($low.Contains($s.pat)) { return $s.msg }
        }
    }

    for ($i = $lines.Count - 1; $i -ge 0; $i--) {
        $t = $lines[$i].Trim()
        if ($t -ne '') {
            if ($t.Length -gt 240) { $t = $t.Substring(0, 240) + '...' }
            return ('llama-server log: ' + $t)
        }
    }
    return $null
}

# Update active-model.json so chat.html's loadActiveModel() picks up the
# new metadata on the post-swap refresh.
function Write-ActiveModel {
    param($Model)
    $obj = [ordered]@{
        id             = [string]$Model.id
        name           = [string]$Model.name
        family         = [string]$Model.family
        ggufFile       = [string]$Model.file
        maxCtx         = [int]$Model.maxCtx
        defaultCtx     = $CtxSize
        thinkingFormat = [string]$Model.thinkingFormat
    }
    Write-FileUtf8 $ActiveJson ($obj | ConvertTo-Json)
}

# Flip the `active` flag in models-list.json to the chosen file.
function Update-ModelsListActive {
    param([string]$File)
    if (-not (Test-Path $ModelsListJs)) { return }
    try {
        $list = Get-Content $ModelsListJs -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch { return }
    $list.active = $File
    foreach ($m in $list.models) {
        if ($m.PSObject.Properties.Match('active').Count -eq 0) {
            $m | Add-Member -MemberType NoteProperty -Name 'active' -Value $false -Force
        }
        $m.active = ($m.file -eq $File)
    }
    Write-FileUtf8 $ModelsListJs (($list | ConvertTo-Json -Depth 6))
}

# Handle POST /swap-model. Kicks off the swap, returns 202 immediately.
# The actual readiness check happens lazily in /swap-status when the
# client polls.
function Handle-SwapModel {
    param($Request, $Response)

    if (-not $HotSwapEnabled) {
        Write-Json $Response 503 @{ phase = 'error'; message = 'Hot-swap is not configured. Restart launch.bat.' }
        return
    }

    if ($Request.HttpMethod -ne 'POST') {
        Write-Json $Response 405 @{ phase = 'error'; message = 'POST only' }
        return
    }

    # Refuse to start a second swap while one is in flight.
    if (Test-Path $SwapLock) {
        $existing = Read-SwapStatus
        Write-Json $Response 409 @{
            phase = 'error'
            message = 'A swap is already in progress.'
            current = $existing
        }
        return
    }

    # Parse body.
    $reader = New-Object System.IO.StreamReader($Request.InputStream, [System.Text.Encoding]::UTF8)
    $body = $reader.ReadToEnd()
    $reader.Close()
    try {
        $bodyObj = $body | ConvertFrom-Json
    } catch {
        Write-Json $Response 400 @{ phase = 'error'; message = 'Body is not valid JSON.' }
        return
    }
    $file = [string]$bodyObj.file
    if ([string]::IsNullOrEmpty($file)) {
        Write-Json $Response 400 @{ phase = 'error'; message = 'Missing "file" field.' }
        return
    }
    # Sanity check the filename. Names from models/ should be a single
    # basename with the .gguf extension -- no path separators, no traversal.
    if ($file -match '[\\/]' -or $file -match '\.\.' -or $file -notmatch '\.gguf$') {
        Write-Json $Response 400 @{ phase = 'error'; message = 'Invalid filename.' }
        return
    }

    $modelPath = Join-Path $ModelDir $file
    if (-not (Test-Path $modelPath -PathType Leaf)) {
        Write-Json $Response 404 @{ phase = 'error'; message = "GGUF not found: $file" }
        return
    }

    $model = Get-ModelRecord -File $file
    if ($null -eq $model) {
        Write-Json $Response 404 @{ phase = 'error'; message = "Model not listed in models-list.json: $file" }
        return
    }

    $startedAt = [int64](([DateTime]::UtcNow - [DateTime]'1970-01-01').TotalSeconds)

    # Create the lock FIRST. Even if subsequent steps throw, the lock will
    # be cleaned up either by /swap-status's timeout path or by the next
    # launch.bat startup.
    Write-FileUtf8 $SwapLock $file
    Write-SwapStatus -Phase 'starting' -File $file -Name $model.name -Message 'Stopping current model' -StartedAt $startedAt

    try {
        Stop-LlamaServer
        Write-SwapStatus -Phase 'starting' -File $file -Name $model.name -Message 'Loading new model' -StartedAt $startedAt

        $launchText = Build-LaunchScript -Model $model -ModelPath $modelPath
        Write-FileAscii $LaunchScript $launchText

        Update-ModelsListActive -File $file
        Write-ActiveModel -Model $model

        # Spawn the new server detached, mirroring launch.bat's invocation
        # exactly: `cmd /c start /min "title" "<launch script>"`.
        #
        # We had to drop the more direct `Start-Process cmd.exe /c <script>`
        # form -- when this fileserver runs as a -WindowStyle Hidden child
        # of launch.bat, that hidden state propagates to children created
        # by Start-Process, and the spawned cmd never allocates a console
        # for llama-server. Going through cmd's own `start` builtin opens
        # a fresh window with its own console host and detaches cleanly,
        # which is the same recipe launch.bat uses at boot.
        $startCmd = ('/c start "llama-server" /min "{0}"' -f $LaunchScript)
        Start-Process -FilePath 'cmd.exe' `
                      -ArgumentList $startCmd `
                      -WindowStyle Hidden `
                      -WorkingDirectory $Root | Out-Null

        Write-Host ("[swap] dispatched: {0} -> {1}" -f $model.name, $file)
        Write-Host ("[swap]   launch script: {0}" -f $LaunchScript)

        Write-Json $Response 202 @{
            phase = 'starting'
            file  = $file
            name  = $model.name
            message = 'Loading new model'
            started_at = $startedAt
        }
    } catch {
        Write-Host ("[swap] failed during dispatch: {0}" -f $_.Exception.Message)
        Write-SwapStatus -Phase 'error' -File $file -Name $model.name -Message $_.Exception.Message -StartedAt $startedAt
        if (Test-Path $SwapLock) { Remove-Item $SwapLock -Force -ErrorAction SilentlyContinue }
        Write-Json $Response 500 @{ phase = 'error'; message = $_.Exception.Message }
    }
}

# Handle GET /swap-status. This is also where we promote "starting" ->
# "ready" once llama-server's /health endpoint comes back online, so the
# expensive readiness check only runs when somebody actually cares.
# Times out at 180 seconds (consistent with the client-side budget).
function Handle-SwapStatus {
    param($Request, $Response)

    $st = Read-SwapStatus
    if ($null -eq $st) {
        Write-Json $Response 200 @{ phase = 'idle' }
        return
    }

    if ($st.phase -eq 'starting') {
        $isReady = $false
        try {
            $hr = [System.Net.HttpWebRequest]::Create(("http://127.0.0.1:{0}/health" -f $LlmPort))
            $hr.Method = 'GET'
            $hr.Timeout = 1500
            $hr.ReadWriteTimeout = 1500
            $hresp = $hr.GetResponse()
            if ([int]$hresp.StatusCode -eq 200) { $isReady = $true }
            $hresp.Close()
        } catch {
            # Not ready yet, or starting up -- expected during model load.
        }

        if ($isReady) {
            Write-SwapStatus -Phase 'ready' -File $st.file -Name $st.name -Message 'Ready' -StartedAt $st.started_at
            if (Test-Path $SwapLock) { Remove-Item $SwapLock -Force -ErrorAction SilentlyContinue }
            $st = Read-SwapStatus
        } else {
            $now     = [int64](([DateTime]::UtcNow - [DateTime]'1970-01-01').TotalSeconds)
            $elapsed = $now - [int64]$st.started_at

            # Fail-fast: if llama-server.exe isn't even running a few
            # seconds in, the spawn died (bad args, missing dependency,
            # port already in use, etc). Surface the error immediately
            # instead of waiting the full 180s timeout -- the user is
            # staring at a "swapping..." toast and the process is
            # already dead, so there's nothing to wait for.
            #
            # We grace-period 5s because Stop-LlamaServer + spawn can
            # legitimately have a brief window where no process exists.
            $procs = @(Get-Process -Name 'llama-server' -ErrorAction SilentlyContinue)
            if ($procs.Count -eq 0 -and $elapsed -gt 5) {
                $hint = Get-LlamaStartupError
                if ($hint) {
                    $msg = 'llama-server exited during startup. ' + $hint
                } else {
                    $msg = 'llama-server did not stay running. Check llama-server.log for startup errors.'
                }
                Write-SwapStatus -Phase 'error' -File $st.file -Name $st.name -Message $msg -StartedAt $st.started_at
                if (Test-Path $SwapLock) { Remove-Item $SwapLock -Force -ErrorAction SilentlyContinue }
                $st = Read-SwapStatus
            }
            elseif ($elapsed -gt 180) {
                Write-SwapStatus -Phase 'error' -File $st.file -Name $st.name -Message 'Model did not respond within 3 minutes.' -StartedAt $st.started_at
                if (Test-Path $SwapLock) { Remove-Item $SwapLock -Force -ErrorAction SilentlyContinue }
                $st = Read-SwapStatus
            }
        }
    }

    Write-Json $Response 200 $st
}

# --- Main loop ---------------------------------------------------------------

# Make sure System.Web is available for UrlDecode.
Add-Type -AssemblyName System.Web -ErrorAction SilentlyContinue

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://+:$ListenPort/")
try {
    $listener.Start()
} catch {
    Write-Host ("[fatal] could not bind http://+:{0}/ -- {1}" -f $ListenPort, $_.Exception.Message)
    Write-Host '         Run setup-lan.bat as Administrator to add the URL ACL.'
    exit 1
}

Write-Host ("[ok] listening on http://+:{0}/" -f $ListenPort)
Write-Host ("[ok] access password required (salted-hash verified; set via launch.bat)")
if ($LlmApiKey -eq '') {
    Write-Host "[warn] GEMMA_LLM_API_KEY not set -- llama-server running without --api-key (loopback bind still protects it)."
} else {
    Write-Host "[ok] llama-server protected with --api-key (injected by proxy)"
}

while ($listener.IsListening) {
    $ctx = $null
    try {
        $ctx = $listener.GetContext()
    } catch {
        # Listener was closed mid-accept; just exit cleanly.
        break
    }
    $request  = $ctx.Request
    $response = $ctx.Response
    try {
        Add-CommonHeaders $response

        if ($request.HttpMethod -eq 'OPTIONS') {
            $response.StatusCode = 204
            $response.Close()
            continue
        }

        $path = $request.Url.AbsolutePath

        # --- Auth gate -------------------------------------------------------
        # A few routes are reachable without a session: the login page/handler,
        # logout, OPTIONS preflight (already handled above), and the favicon
        # (so the login tab isn't ugly). Everything else requires a valid
        # session cookie.
        if ($path -eq '/login') {
            if ($request.HttpMethod -eq 'POST') {
                $body = ''
                if ($request.HasEntityBody) {
                    $reader = New-Object System.IO.StreamReader($request.InputStream, $request.ContentEncoding)
                    $body = $reader.ReadToEnd(); $reader.Close()
                }
                # Body is application/x-www-form-urlencoded: password=...
                $pw = ''
                foreach ($pair in $body.Split('&')) {
                    $kv = $pair.Split('=', 2)
                    if ($kv.Length -eq 2 -and $kv[0] -eq 'password') {
                        $pw = [System.Web.HttpUtility]::UrlDecode($kv[1])
                    }
                }
                if (Test-SecretEqual (Get-PasswordHash $pw) $AccessHash) {
                    $tok = New-SessionToken (Get-ClientId $request)
                    # HttpOnly: JS can't read it (blunts XSS token theft).
                    # SameSite=Lax + Path=/: sent on same-origin navigations and
                    # the proxy fetches. No Secure flag -- traffic is plain HTTP
                    # on the LAN (see startup notice); Secure would stop the
                    # cookie entirely. We compensate with a short TTL and a
                    # client fingerprint bound to this session.
                    $response.AddHeader('Set-Cookie',
                        ("gobbonet_session={0}; Path=/; HttpOnly; SameSite=Lax; Max-Age={1}" -f $tok, ($SessionTtlHours*3600)))
                    $response.StatusCode = 302
                    $response.AddHeader('Location', '/')
                } else {
                    Write-Text $response 401 'text/html; charset=utf-8' (Get-LoginPageHtml -Failed $true)
                }
            } else {
                $code = 200
                Write-Text $response $code 'text/html; charset=utf-8' (Get-LoginPageHtml -Failed $false)
            }
        }
        elseif ($path -eq '/logout') {
            $tok = Get-RequestToken $request
            if ($tok -and $Script:Sessions.ContainsKey($tok)) { $Script:Sessions.Remove($tok) }
            $response.AddHeader('Set-Cookie', 'gobbonet_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0')
            $response.StatusCode = 302
            $response.AddHeader('Location', '/login')
        }
        elseif ($path -eq '/favicon.ico' -and -not (Test-Authenticated $request)) {
            # Serve favicon unauthenticated if present, else 404 quietly.
            $fav = Resolve-StaticPath -UrlPath '/favicon.ico'
            if ($null -eq $fav) {
                Write-Json $response 404 @{ error = 'not found' }
            } else {
                $bytes = [System.IO.File]::ReadAllBytes($fav)
                $response.StatusCode = 200
                $response.ContentType = 'image/x-icon'
                $response.ContentLength64 = $bytes.Length
                $response.OutputStream.Write($bytes, 0, $bytes.Length)
            }
        }
        elseif (-not (Test-Authenticated $request)) {
            # Not logged in. Browsers navigating to a page get the login screen;
            # API/proxy calls get a clean 401 so chat.html can detect it.
            $accept = [string]$request.Headers['Accept']
            if ($request.HttpMethod -eq 'GET' -and $accept -like '*text/html*') {
                Write-Text $response 401 'text/html; charset=utf-8' (Get-LoginPageHtml -Failed $false)
            } else {
                Write-Json $response 401 @{ error = 'authentication required'; login = '/login' }
            }
        }

        # --- Routing ---------------------------------------------------------
        # Order matters: more-specific prefixes must come before catch-alls.

        elseif ($path -eq '/health-fileserver') {
            Write-Json $response 200 @{ status = 'ok'; pid = $PID; hotswap = $HotSwapEnabled }
        }
        elseif ($path -eq '/state' -or $path -like '/state/*') {
            Handle-State -Request $request -Response $response
        }
        elseif ($path -eq '/swap-model') {
            Handle-SwapModel -Request $request -Response $response
        }
        elseif ($path -eq '/swap-status') {
            Handle-SwapStatus -Request $request -Response $response
        }
        elseif ($path -eq '/llm' -or $path -like '/llm/*') {
            Invoke-Proxy -Request $request -Response $response -Prefix '/llm' -UpstreamPort $LlmPort -InjectLlmKey $true
        }
        elseif ($path -eq '/search' -or $path -like '/search/*') {
            Invoke-Proxy -Request $request -Response $response -Prefix '/search' -UpstreamPort $SearchPort
        }
        else {
            # Static fallthrough.
            $full = Resolve-StaticPath -UrlPath $path
            if ($null -eq $full) {
                Write-Json $response 404 @{ error = 'not found'; path = $path }
            } else {
                $bytes = [System.IO.File]::ReadAllBytes($full)
                $response.StatusCode  = 200
                $response.ContentType = Get-MimeType -Path $full
                $response.ContentLength64 = $bytes.Length
                $response.OutputStream.Write($bytes, 0, $bytes.Length)
            }
        }
    } catch {
        Write-Host ("[err] {0} {1} -> {2}" -f $request.HttpMethod, $request.Url.AbsolutePath, $_.Exception.Message)
        try {
            Write-Json $response 500 @{ error = 'server error'; detail = $_.Exception.Message }
        } catch { }
    } finally {
        try { $response.Close() } catch { }
    }
}
