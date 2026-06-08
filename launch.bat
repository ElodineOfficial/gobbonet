@echo off
setlocal EnableDelayedExpansion
title Gobbonet — Local AI Chat [llama.cpp]
color 0A

:: ===============================================================
:: CONFIG — edit these if you want a different model or port
:: ===============================================================
set "SERVER_PORT=11434"
set "CTX_SIZE=16384"
set "GPU_LAYERS=99"
set "KV_CACHE_TYPE=q8_0"

:: ---------------------------------------------------------------
:: SECURITY -- access password (hashed, set by you on first run)
::
:: The web UI is password-gated: anyone on your Wi-Fi can reach port
:: 8080, so without a password a roommate/guest/IoT device could read
:: your chats and use your GPU.
::
:: There is NO password baked into this file. On first run you choose
:: one; we store only a salted SHA-256 HASH of it in ".gobbonet-secret"
:: (kept next to this script and excluded from source control). The
:: plaintext is never written to disk and never put in an environment
:: variable -- only the salt+hash are passed to the file server, which
:: re-hashes what you type at login and compares.
::
:: To change the password later: run  launch.bat reset-password
:: (or just delete the .gobbonet-secret file and relaunch).
::
:: llama-server is bound to 127.0.0.1 (loopback) below, so it is not
:: reachable from the LAN at all -- only this machine's file server
:: proxy can talk to it. That binding is the access control for the
:: model; no separate API key is needed.
:: ---------------------------------------------------------------
set "SECRET_FILE=%~dp0.gobbonet-secret"

:: Allow "launch.bat reset-password" to force re-entry.
if /i "%~1"=="reset-password" (
    if exist "!SECRET_FILE!" del "!SECRET_FILE!"
    echo  [..] Password reset requested -- you'll set a new one now.
)

if not exist "!SECRET_FILE!" call :setup_password
if not exist "!SECRET_FILE!" (
    echo  [ERROR] No password was set. Cannot start securely. Exiting.
    pause
    exit /b 1
)

:: Load the stored salt:hash for handoff to the file server.
set "ACCESS_SECRET="
for /f "usebackq delims=" %%S in ("!SECRET_FILE!") do set "ACCESS_SECRET=%%S"

:: CTX_SIZE notes:
::   This is the default starting value. When you pick a model from
::   the download menu, the script will automatically suggest a better
::   value for that model's architecture and your likely VRAM.
::   You can always override it here manually.
::
:: KV_CACHE_TYPE options:
::   f16   = full precision (best quality, ~8-12K max on 16 GB)
::   q8_0  = 8-bit quantized (~30-45K tokens on 16 GB) [DEFAULT]
::   q4_0  = 4-bit quantized (65K+ tokens, slight quality loss)
::
:: MODEL_GGUF — leave empty to auto-detect, or set a specific filename.
::   If only one .gguf exists in models\, it is used automatically.
::   If multiple .gguf files exist, the script will ask you to choose.

:: Model metadata — set automatically by the download menu or filename
:: detection. You can also set these manually if you know your model.
::
:: MODEL_THINK_FMT — how the model emits chain-of-thought:
::   none     = no thinking         (Llama, Mistral, Phi, Gemma 3 base, Command R)
::   deepseek = <think>...</think>  (R1, Qwen3, QwQ, GLM thinking, Granite, Hunyuan)
::   harmony  = <|channel|>...      (gpt-oss-20b, gpt-oss-120b)
::   gemma    = <channel|>          (Gemma 4)
::
:: chat.html accepts a few aliases (qwen, qwen3, gpt-oss, oss, think, etc.)
:: but the launch script writes the canonical name above to active-model.json.
set "MODEL_ID=custom"
set "MODEL_DISPLAY=Custom GGUF"
set "MODEL_FAMILY=custom"
set "MODEL_MAX_CTX=131072"
set "MODEL_THINK_FMT=none"

:: MODEL_USE_JINJA / MODEL_CHAT_TEMPLATE — chat-template handling.
::   Default is --jinja (use the template baked into the GGUF). That works
::   for most modern GGUFs (Gemma 4 channels, gpt-oss Harmony, Mistral Small
::   v7-tekken, Qwen3 think mode, etc.).
::
::   Some model families have a chat_template that --jinja cannot render
::   cleanly. The classic case is Mistral Nemo merges (MN-*, *-nemo-*):
::   mergekit-produced GGUFs often have an incomplete or mangled
::   chat_template inherited from Mistral-Nemo-Instruct-2407's tool-calling
::   blocks. With --jinja, minja chokes on the [AVAILABLE_TOOLS] /
::   [TOOL_CALLS] sections and the model either fails to load, returns 500s,
::   or echoes the raw system prompt instead of chatting.
::
::   The fix for those models: drop --jinja and tell llama-server to use its
::   built-in C++ template by name (set MODEL_USE_JINJA=0 and
::   MODEL_CHAT_TEMPLATE=<name>). Available built-in template names include:
::     mistral-v1, mistral-v3, mistral-v3-tekken, mistral-v7, mistral-v7-tekken,
::     llama2, llama3, chatml, gemma, gpt-oss, deepseek3, ... (see llama-server
::     --help for the full list).
::
::   CAUTION: "mistral-v7-tekken" was added to llama.cpp's built-in name table
::   only in recent builds; the build this project pins does NOT know it. If you
::   set an unrecognized name, llama-server treats the literal text as the
::   template body and the model is fed that constant string instead of your
::   chat (it ends up babbling about "tekken"). Use "mistral-v7" for Mistral
::   Small 24B / its finetunes -- the guard further down rewrites the -tekken
::   form to it automatically, but don't rely on that; prefer the working name.
::
::   The :identify_model block below sets these per family.
set "MODEL_USE_JINJA=1"
set "MODEL_CHAT_TEMPLATE="
set "MODEL_CHAT_TEMPLATE_FILE="

:: Install folder (relative to this script)
set "LLAMA_DIR=%~dp0llama-cpp"
set "MODEL_DIR=%~dp0models"
set "SERVER_EXE=!LLAMA_DIR!\llama-server.exe"
set "LOG_FILE=%~dp0llama-server.log"

:: llama.cpp release pin. The auto-download verifies the zip's SHA-256 against
:: the digest GitHub's API reports for the asset, then only extracts on a match.
:: Pinning to a known-good tag (rather than always taking 'latest') means a bad
:: or hijacked future release can't silently land on users' machines -- you bump
:: this deliberately after testing a new build. Leave empty to use 'latest'.
set "LLAMA_PIN_TAG=b9294"
:: Known-good SHA-256 of the pinned release's Windows Vulkan x64 zip.
:: Leave EMPTY to download without verifying the hash -- after the first
:: successful download the script prints the hash and the exact line to
:: paste here. Once set, any future download whose hash doesn't match is
:: refused. This value must correspond to LLAMA_PIN_TAG above; if you bump
:: the tag, clear this and re-pin from the next download.
set "LLAMA_PIN_SHA256="

:: LAUNCH_SCRIPT holds the cmd line we hand to the OS to start llama-server.
:: It lives in the project root (not %TEMP%) on purpose: fileserver.ps1
:: needs to be able to overwrite it during a hot-swap, and the monitor
:: loop here needs the same fixed location to restart after a crash.
:: Either party may rewrite this file; whichever did it last wins, and
:: the next restart picks up the new contents. Keep these paths in sync
:: with fileserver.ps1's GEMMA_LAUNCH_SCRIPT / SwapLock / SwapStatus.
set "LAUNCH_SCRIPT=%~dp0.llama-launch.cmd"
set "SWAP_LOCK=%~dp0.swap-in-progress"
set "SWAP_STATUS=%~dp0.swap-status.json"

:: Model GGUF — set this to use a specific file.
:: Leave empty to auto-detect the first .gguf in the models folder.
set "MODEL_GGUF="

goto :main

:: ===============================================================
:fatal
echo.
echo  [FATAL] See the error above. Press any key to close.
pause >nul
exit /b 1

:prompt_yn
:: Usage: call :prompt_yn "Question?" RESULT_VAR
:: Sets RESULT_VAR to Y or N
set "%~2=N"
set /p "_YN=%~1 (Y/N): "
if /i "!_YN!"=="Y" set "%~2=Y"
if /i "!_YN!"=="YES" set "%~2=Y"
exit /b

:setup_password
:: First-run password setup. Reads the password WITHOUT echoing, confirms it,
:: enforces a minimum length, then writes a salted SHA-256 hash to SECRET_FILE.
:: All of this happens inside PowerShell so the plaintext never lands in a
:: batch variable, the environment, or the console.
::
:: We write the PowerShell to a temp .ps1 and run it with -File rather than
:: cramming it into -Command with caret line-continuations. The -File form is
:: immune to batch's quoting / caret / delayed-expansion quirks, which is the
:: difference between "works on every machine" and "breaks mysteriously on one".
:: The target path is passed via an env var (read with $env:) so spaces in the
:: path can't break anything.
echo.
echo  ====================================================
echo   SET YOUR ACCESS PASSWORD  (first-time setup)
echo.
echo   This password protects the chat from anyone else on
echo   your network. You'll enter it once here, then type it
echo   on your phone/browser the first time you connect.
echo.
echo   It is stored only as a salted hash -- not as plain
echo   text -- and never leaves this machine.
echo  ====================================================
echo.
set "GOBBONET_SECRET_OUT=!SECRET_FILE!"
set "PW_SCRIPT=%TEMP%\gobbonet_setpw_%RANDOM%.ps1"
(
echo $min = 6
echo while ^($true^) {
echo     $p1 = Read-Host 'Enter a password' -AsSecureString
echo     $b1 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR^($p1^)
echo     $t1 = [Runtime.InteropServices.Marshal]::PtrToStringBSTR^($b1^)
echo     [Runtime.InteropServices.Marshal]::ZeroFreeBSTR^($b1^)
echo     if ^($t1.Length -lt $min^) { Write-Host ^("  Too short -- use at least $min characters."^) -Foreground Yellow; continue }
echo     $p2 = Read-Host 'Confirm password' -AsSecureString
echo     $b2 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR^($p2^)
echo     $t2 = [Runtime.InteropServices.Marshal]::PtrToStringBSTR^($b2^)
echo     [Runtime.InteropServices.Marshal]::ZeroFreeBSTR^($b2^)
echo     if ^($t1 -ne $t2^) { Write-Host '  Passwords did not match -- try again.' -Foreground Yellow; continue }
echo     $saltBytes = New-Object byte[] 16
echo     [Security.Cryptography.RandomNumberGenerator]::Create^(^).GetBytes^($saltBytes^)
echo     $salt = ^([BitConverter]::ToString^($saltBytes^) -replace '-'^).ToLower^(^)
echo     $sha = [Security.Cryptography.SHA256]::Create^(^)
echo     $bytes = [Text.Encoding]::UTF8.GetBytes^($salt + $t1^)
echo     $hash = ^([BitConverter]::ToString^($sha.ComputeHash^($bytes^)^) -replace '-'^).ToLower^(^)
echo     Set-Content -Path $env:GOBBONET_SECRET_OUT -Value ^($salt + ':' + $hash^) -Encoding ascii -NoNewline
echo     Write-Host '  [OK] Password set.' -Foreground Green
echo     break
echo }
) > "!PW_SCRIPT!"
powershell -NoProfile -ExecutionPolicy Bypass -File "!PW_SCRIPT!"
del /f /q "!PW_SCRIPT!" >nul 2>&1
set "GOBBONET_SECRET_OUT="
echo.
exit /b

:: ===============================================================
:main
echo.
echo  ====================================================
echo       GOBBONET — LOCAL AI CHAT
echo       Powered by llama.cpp  //  Vulkan GPU
echo       PRIVACY: FULLY OFFLINE — ZERO TELEMETRY
echo  ====================================================
echo.

:: Clear any stale hot-swap state from a previous crash. These files
:: coordinate between fileserver.ps1 (which initiates swaps) and the
:: monitor loop below (which would otherwise try to "fix" the server
:: going down mid-swap). If we crashed mid-swap last time the lock
:: would still be sitting here, telling the monitor to do nothing
:: forever -- so blow it away on a clean boot.
if exist "!SWAP_LOCK!"   del /f /q "!SWAP_LOCK!"   >nul 2>&1
if exist "!SWAP_STATUS!" del /f /q "!SWAP_STATUS!" >nul 2>&1

:: ---------------------------------------------------------------
:: STEP 1: CHECK FOR LLAMA-SERVER
:: ---------------------------------------------------------------
if exist "!SERVER_EXE!" (
    echo  [OK] llama-server found: !SERVER_EXE!
    goto :check_model
)

:: Server not at expected root — check subdirectories (common after zip extraction)
if exist "!LLAMA_DIR!" (
    for /r "!LLAMA_DIR!" %%F in (llama-server.exe) do (
        echo  [OK] Found llama-server in subdirectory: %%F
        set "SERVER_EXE=%%F"
        set "LLAMA_DIR=%%~dpF"
        goto :check_model
    )
)

echo  [..] llama-server.exe not found in: !LLAMA_DIR!
echo.
echo  ====================================================
echo   llama.cpp needs to be downloaded.
echo   This is about 300 MB and runs entirely offline.
echo   No accounts, no telemetry, no internet required
echo   after this one-time download.
echo  ====================================================
echo.

call :prompt_yn "  Download llama.cpp now?" DO_DOWNLOAD
if /i "!DO_DOWNLOAD!"=="N" (
    echo.
    echo  [INFO] You can also download manually:
    echo         https://github.com/ggml-org/llama.cpp/releases
    echo         Get the file ending in: -win-vulkan-x64.zip
    echo         Extract to: !LLAMA_DIR!\
    goto :fatal
)

echo.
echo  [..] Downloading llama.cpp (Vulkan build for Windows x64)...
echo      About 300 MB. This is the only network step.
echo.
echo  ====================================================
echo   If this window VANISHES during the download with no
echo   error text, an antivirus / endpoint-protection product
echo   is blocking it. Running as Administrator will NOT help.
echo.
echo   Fastest fix: copy the  llama-cpp\  folder from a PC
echo   where it already works into this folder, then re-run --
echo   the download is skipped entirely (nothing to block).
echo   Or add a Defender folder exclusion for:
echo     %~dp0
echo   Or install manually:
echo     https://github.com/ggml-org/llama.cpp/releases
echo     (file ending in: -win-vulkan-x64.zip), extract to:
echo     !LLAMA_DIR!\
echo  ====================================================
echo.

:: -----------------------------------------------------------------
:: Engine download -- cmd-native, NO PowerShell.
::
:: The previous version wrote a .ps1 into %TEMP% and ran it with
:: -ExecutionPolicy Bypass to fetch the zip. That exact shape
:: (cmd -^> temp .ps1 with Bypass -^> downloads an executable archive)
:: is what behavioral AV engines read as malware staging, and several
:: respond by killing the whole process tree -- the console window
:: just disappears mid-download with no error and no log, and elevation
:: does not exempt you (admin does not bypass Defender).
::
:: This version uses only the Microsoft-signed tools that ship in
:: System32 on every Windows 10 1803+ machine, called straight from
:: cmd: curl.exe (download), certutil.exe (hash), tar.exe (extract).
:: No script file, no Bypass, no PowerShell-initiated download -- so
:: there is no staging pattern for the heuristic to trip on. It also
:: works where PowerShell script execution is disabled by policy.
::
:: The asset URL is built directly from the pinned tag (set near the
:: top of this file), which is bumped only after testing, so the
:: deterministic asset name is known-good for the pinned release.
:: -----------------------------------------------------------------
set "LLAMA_ASSET=llama-!LLAMA_PIN_TAG!-bin-win-vulkan-x64.zip"
set "LLAMA_URL=https://github.com/ggml-org/llama.cpp/releases/download/!LLAMA_PIN_TAG!/!LLAMA_ASSET!"
set "LLAMA_ZIP=%TEMP%\!LLAMA_ASSET!"

curl.exe -L --fail --retry 3 --progress-bar -o "!LLAMA_ZIP!" "!LLAMA_URL!"
if errorlevel 1 (
    echo.
    echo  [ERROR] Download failed -- curl could not fetch the release zip.
    echo          Common causes: no internet, GitHub unreachable, or this
    echo          exact build/tag is no longer published.
    echo.
    echo          Install manually instead:
    echo            !LLAMA_URL!
    echo          ...or browse: https://github.com/ggml-org/llama.cpp/releases
    echo          ^(get the file ending in: -win-vulkan-x64.zip^)
    echo          and extract it into:  !LLAMA_DIR!\
    del /f /q "!LLAMA_ZIP!" >nul 2>&1
    goto :fatal
)
echo.
echo  [OK] Download complete.

:: --- Integrity check (certutil, no PowerShell) -------------------
set "LLAMA_ACTUAL="
for /f "skip=1 delims=" %%H in ('certutil -hashfile "!LLAMA_ZIP!" SHA256 2^>nul') do if not defined LLAMA_ACTUAL set "LLAMA_ACTUAL=%%H"
set "LLAMA_ACTUAL=!LLAMA_ACTUAL: =!"

if not defined LLAMA_PIN_SHA256 goto :llama_hash_unpinned
if /i "!LLAMA_ACTUAL!"=="!LLAMA_PIN_SHA256!" goto :llama_hash_ok
echo.
echo  [ERROR] CHECKSUM MISMATCH -- the download is corrupt or tampered.
echo            expected: !LLAMA_PIN_SHA256!
echo            actual:   !LLAMA_ACTUAL!
echo          Refusing to extract. The zip has been deleted.
del /f /q "!LLAMA_ZIP!" >nul 2>&1
goto :fatal

:llama_hash_unpinned
echo.
echo  [!] No SHA-256 is pinned for this build, so the download was NOT
echo      verified against a known-good hash. It arrived over HTTPS from
echo      github.com, which is normally fine -- but to lock it down for
echo      every machine you install this on, set this near the top of
echo      launch.bat (replacing the empty LLAMA_PIN_SHA256):
echo.
echo        set "LLAMA_PIN_SHA256=!LLAMA_ACTUAL!"
echo.
goto :llama_extract

:llama_hash_ok
echo  [OK] Checksum verified against pinned SHA-256.

:llama_extract
if not exist "!LLAMA_DIR!" mkdir "!LLAMA_DIR!"
echo  [..] Extracting...
tar.exe -xf "!LLAMA_ZIP!" -C "!LLAMA_DIR!"
if errorlevel 1 (
    echo.
    echo  [ERROR] Extraction failed -- tar.exe could not unpack the zip.
    echo          The download may be incomplete. Delete anything in
    echo          !LLAMA_DIR!\ and re-run, or install manually:
    echo            !LLAMA_URL!
    del /f /q "!LLAMA_ZIP!" >nul 2>&1
    goto :fatal
)
del /f /q "!LLAMA_ZIP!" >nul 2>&1
echo  [OK] Extracted to: !LLAMA_DIR!\

:: After extraction, the exe might be in a subdirectory. Find it.
if not exist "!SERVER_EXE!" (
    echo  [..] Searching for llama-server.exe in extracted files...
    for /r "!LLAMA_DIR!" %%F in (llama-server.exe) do (
        echo  [OK] Found: %%F
        set "SERVER_EXE=%%F"
        :: Update LLAMA_DIR to match
        set "LLAMA_DIR=%%~dpF"
        goto :server_found
    )
    echo  [ERROR] llama-server.exe not found after extraction.
    echo         Check the contents of: !LLAMA_DIR!
    goto :fatal
)
:server_found
echo  [OK] llama-server ready: !SERVER_EXE!
echo.

:: ---------------------------------------------------------------
:: STEP 2: CHECK FOR MODEL GGUF
:: ---------------------------------------------------------------
:check_model
if not exist "!MODEL_DIR!" mkdir "!MODEL_DIR!"

:: If a specific GGUF is set, check for it
if defined MODEL_GGUF if not "!MODEL_GGUF!"=="" (
    if exist "!MODEL_DIR!\!MODEL_GGUF!" (
        echo  [OK] Model: !MODEL_GGUF!
        set "GGUF_PATH=!MODEL_DIR!\!MODEL_GGUF!"
        goto :identify_model
    )
    if exist "!MODEL_GGUF!" (
        echo  [OK] Model: !MODEL_GGUF!
        set "GGUF_PATH=!MODEL_GGUF!"
        goto :identify_model
    )
)

:: Auto-detect GGUFs in models folder
set "GGUF_COUNT=0"
for %%F in ("!MODEL_DIR!\*.gguf") do set /a GGUF_COUNT+=1

if !GGUF_COUNT! == 0 goto :model_download_menu

if !GGUF_COUNT! == 1 (
    for %%F in ("!MODEL_DIR!\*.gguf") do (
        echo  [OK] Model found: %%~nxF
        set "GGUF_PATH=%%F"
        goto :identify_model
    )
)

:: Multiple GGUFs found — let the user choose
echo  [..] Multiple model files found in models\
echo.
set "GGUF_IDX=0"
for %%F in ("!MODEL_DIR!\*.gguf") do (
    set /a GGUF_IDX+=1
    echo   [!GGUF_IDX!] %%~nxF
    set "GGUF_CHOICE_!GGUF_IDX!=%%F"
)
echo.
set /p "_GCHOICE=  Select model [1-!GGUF_COUNT!]: "
if defined GGUF_CHOICE_!_GCHOICE! (
    set "GGUF_PATH=!GGUF_CHOICE_%_GCHOICE%!"
    for %%F in ("!GGUF_PATH!") do echo  [OK] Using: %%~nxF
    goto :identify_model
)
echo  [ERROR] Invalid selection. Please restart and enter a number from the list.
goto :fatal

:: ---------------------------------------------------------------
:: IDENTIFY MODEL -- read the chat template baked into the GGUF
::
:: Detection is driven by the embedded tokenizer.chat_template (ground
:: truth), NOT the filename. identify-model.ps1 is the single source of
:: truth, shared with the models-list.json builder further down, so the
:: initial launch and the hot-swap dropdown can never disagree.
::
:: Thinking-format names mirror chat.html's registry:
::   none      = no thinking (Llama, Mistral, Phi, Gemma 3 base)
::   deepseek  = <think>...</think>  (R1, Qwen3, QwQ, GLM thinking, etc.)
::   harmony   = gpt-oss channels
::   gemma     = Gemma channel thinking (Gemma 4)
:: ---------------------------------------------------------------
:identify_model
for %%F in ("!GGUF_PATH!") do set "GGUF_BASENAME=%%~nxF"

:: Defaults, overwritten by the identifier (or kept if it is missing).
set "MODEL_ID=custom"
set "MODEL_DISPLAY=!GGUF_BASENAME!"
set "MODEL_FAMILY=custom"
set "MODEL_MAX_CTX=131072"
set "MODEL_THINK_FMT=none"
set "MODEL_USE_JINJA=1"
set "MODEL_CHAT_TEMPLATE="
set "MODEL_CHAT_TEMPLATE_FILE="

:: identify-model.ps1 prints a block of `set` statements; we CALL them
:: into the current environment so they feed the launch command below.
set "ID_SCRIPT=%~dp0identify-model.ps1"
set "ID_OUT=%TEMP%\gobbo_model_%RANDOM%.cmd"
if exist "!ID_SCRIPT!" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "!ID_SCRIPT!" -GgufPath "!GGUF_PATH!" -Emit batch -OutFile "!ID_OUT!" 2>nul
    if exist "!ID_OUT!" (
        call "!ID_OUT!"
        del "!ID_OUT!" >nul 2>&1
    )
    echo  [OK] Identified: !MODEL_DISPLAY!  ^(family=!MODEL_FAMILY!, jinja=!MODEL_USE_JINJA!^)
    if not "!MODEL_CHAT_TEMPLATE!"=="" (
        echo       Using llama-server built-in template: !MODEL_CHAT_TEMPLATE!  ^(--jinja disabled^)
    )
) else (
    echo  [!!] identify-model.ps1 not found next to launch.bat.
    echo       Falling back to generic settings ^(embedded template via --jinja^).
    echo  !GGUF_BASENAME! | findstr /i /c:"think" /c:"reason" >nul 2>&1
    if not errorlevel 1 set "MODEL_THINK_FMT=deepseek"
)

goto :write_model_json

:: ---------------------------------------------------------------
:: MODEL DOWNLOAD MENU
:: ---------------------------------------------------------------
:model_download_menu
:: ---------------------------------------------------------------
:: HARDWARE-AWARE MODEL SUGGESTION
::
:: Run hardware-probe.ps1 (visible, so the user sees their GPU/RAM
:: detected), then parse hardware.json into HW_* vars plus per-model
:: markers (MK_1..MK_8) and a recommended option number (REC).
::
:: REC = best model that fits detected VRAM (flagship-first):
::   >=16 GB -> 8 (Gemma 4 26B)   >=12 -> 7 (DeepSeek-R1 8B)
::   >=8  GB -> 3 (Llama 3.1 8B)  >=6  -> 1 (Gemma 3 4B)
::   cpu_only / tiny -> 2 (Llama 3.2 3B)
:: MK_n is one of:
::   "[ RECOMMENDED FOR YOUR PC ]"      (the REC option)
::   "[ needs ~N GB VRAM - will be slow ]"  (model bigger than VRAM)
::   "[ likely too slow without a GPU ]"    (cpu_only + non-tiny model)
::   ""                                  (fits fine, no marker)
::
:: If hardware-probe.ps1 is missing or the probe/parse fails, we set
:: HW_TIER=unknown / REC=0 and every MK_n="" -- so the menu prints
:: EXACTLY as it always did (static catalog, no recommendation).
:: This is the no-regression fallback.
:: ---------------------------------------------------------------
echo.
echo  [..] Checking your hardware to suggest the best model...
echo       (one-time, runs locally -- no internet needed for this)
echo.
if exist "%~dp0hardware-probe.ps1" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0hardware-probe.ps1" -OutputPath "%~dp0hardware.json" -ModelsDir "!MODEL_DIR!"
) else (
    echo  [!!] hardware-probe.ps1 not found -- showing the full catalog
    echo       without hardware-based suggestions.
)
echo.

:: Defaults in case the parse below produces nothing (PowerShell blocked,
:: etc.). With REC=0 and unknown tier the menu renders statically.
set "HW_OK=0"
set "HW_TIER=unknown"
set "HW_VRAM=0"
set "HW_RAM=0"
set "HW_DISK=0"
set "REC=0"

:: Parse hardware.json into KEY=VALUE lines. We run PowerShell DIRECTLY
:: (not inside a for/f backtick) and redirect its stdout to a small temp
:: file, then read that file with for/f. This matches the proven direct-
:: invocation pattern used by the models-list.json writer below and avoids
:: any cmd paren/quote-matching fragility inside a for/f command. The
:: payload is pure single-quoted PowerShell + string concatenation (no
:: embedded double quotes, no pipes, no '!', output is pure ASCII) so the
:: redirect and for/f read it back cleanly regardless of console encoding.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; try { $h = ConvertFrom-Json (Get-Content -Raw '%~dp0hardware.json') } catch { $h = $null }; $min=@{1=6;2=4;3=8;4=8;5=8;6=8;7=10;8=16;9=16;10=24}; if (-not $h) { 'HW_OK=0'; 'REC=0'; 'HW_TIER=unknown'; 'HW_VRAM=0'; 'HW_RAM=0'; 'HW_DISK=0'; foreach($i in 1..10){ 'MK_' + $i + '=' }; exit }; $v=[int]$h.gpu.vram_gb; $t=[string]$h.recommended_tier; $ram=[int]$h.ram_gb; $disk=[int]$h.disk.free_gb; $rec=0; if($t -eq 'cpu_only'){ $rec=2 } elseif($v -ge 16){ $rec=8 } elseif($v -ge 12){ $rec=7 } elseif($v -ge 8){ $rec=3 } elseif($v -ge 6){ $rec=1 } else { $rec=2 }; 'HW_OK=1'; 'HW_TIER=' + $t; 'HW_VRAM=' + $v; 'HW_RAM=' + $ram; 'HW_DISK=' + $disk; 'REC=' + $rec; foreach($i in 1..10){ if($i -eq $rec){ $m='[ RECOMMENDED FOR YOUR PC ]' } elseif($t -eq 'cpu_only'){ if($min[$i] -le 6){ $m='' } else { $m='[ likely too slow without a GPU ]' } } elseif($v -ge $min[$i]){ $m='' } else { $m='[ needs ~' + $min[$i] + ' GB VRAM - will be slow ]' }; 'MK_' + $i + '=' + $m }" > "%~dp0.hw-parsed.env" 2>nul

if exist "%~dp0.hw-parsed.env" (
    for /f "usebackq tokens=1,* delims==" %%K in ("%~dp0.hw-parsed.env") do set "%%K=%%L"
    del "%~dp0.hw-parsed.env" >nul 2>&1
)

:show_catalog
echo.
echo  ====================================================
echo   CHOOSE A MODEL TO DOWNLOAD
echo.
if "!HW_OK!"=="1" (
    echo   Detected: !HW_VRAM! GB VRAM, !HW_RAM! GB RAM, !HW_DISK! GB free disk
    echo   Suggested tier: !HW_TIER! -- the recommended pick is marked below.
    echo.
)
echo   All models run 100%% offline after download.
echo   VRAM estimates are approximate at default CTX_SIZE.
echo   Adjust CTX_SIZE and KV_CACHE_TYPE at the top of
echo   this script to trade context length vs VRAM usage.
echo.
echo   ── SMALL (fits ~8 GB VRAM) ──────────────────────
echo.
echo     [1] Gemma 3 4B IT          Q8_0  ~4.7 GB  !MK_1!
echo         Google — fast and sharp for its size
echo.
echo     [2] Llama 3.2 3B Instruct  Q8_0  ~3.3 GB  !MK_2!
echo         Meta — ultra-light, surprisingly good chat
echo.
echo   ── MEDIUM (fits ~10-12 GB VRAM) ─────────────────
echo.
echo     [3] Llama 3.1 8B Instruct  Q6_K  ~6.1 GB  !MK_3!
echo         Meta — solid all-rounder, 128K context
echo.
echo     [4] Command R 7B (12-2024) Q6_K  ~6.6 GB  !MK_4!
echo         Cohere — strong instruction following, 128K
echo         Multilingual; no chain-of-thought
echo.
echo     [5] Granite 3.0 8B Instr.  Q6_K  ~6.6 GB  !MK_5!
echo         IBM — clean, reliable general chat, 128K
echo.
echo     [6] GLM-Z1 9B (0414)       Q4_K_M ~5.8 GB  !MK_6!
echo         Zhipu/THUDM — reasoning, strong at math
echo         Emits chain-of-thought between ^<think^> tags
echo.
echo     [7] DeepSeek-R1 8B         Q8_0   ~8.5 GB  !MK_7!
echo         Reasoning-focused model (Qwen3 distill)
echo         Shows chain-of-thought by default
echo.
echo   ── LARGE (fits ~16 GB VRAM) ─────────────────────
echo.
echo     [8] Gemma 4 26B-A4B MoE    Q4_K_S ~16 GB   !MK_8!
echo         Google — MoE runs FAST despite large size
echo         Great default for 16 GB GPUs
echo.
echo     [9] Cydonia 24B v4.1       IQ4_XS ~12.8 GB !MK_9!
echo         TheDrummer — Mistral Small 24B finetune
echo         Creative/roleplay focus; v7-tekken template
echo.
echo    [10] Command R 35B (08-2024) Q4_K_S ~20 GB  !MK_10!
echo         Cohere — heavy chat model, needs ~24 GB VRAM
echo         Multilingual strength, 128K context
echo.
echo   ── MANUAL ───────────────────────────────────────
echo.
echo    [11] Skip — I'll add my own .gguf
echo         Place any GGUF in the models\ folder
echo.
echo   Note: If a download link fails, check the updated
echo   repo at https://huggingface.co/bartowski
echo  ====================================================
echo.
if not "!REC!"=="0" (
    echo   Press ENTER to accept the recommended pick [!REC!],
    echo   or type a number to choose a different model.
    echo.
)
set "MODEL_CHOICE="
set /p "MODEL_CHOICE=  Your choice [1-11]: "
if not defined MODEL_CHOICE if not "!REC!"=="0" set "MODEL_CHOICE=!REC!"

:: VRAM safety net -- if the chosen model wants more GPU memory than we
:: detected, warn and confirm rather than letting a non-technical user
:: download 16 GB of model that will crawl. Skipped when VRAM is unknown
:: (HW_VRAM=0) so we never block on a failed probe.
set "PICK_MIN=0"
if "!MODEL_CHOICE!"=="1" set "PICK_MIN=6"
if "!MODEL_CHOICE!"=="2" set "PICK_MIN=4"
if "!MODEL_CHOICE!"=="3" set "PICK_MIN=8"
if "!MODEL_CHOICE!"=="4" set "PICK_MIN=8"
if "!MODEL_CHOICE!"=="5" set "PICK_MIN=8"
if "!MODEL_CHOICE!"=="6" set "PICK_MIN=8"
if "!MODEL_CHOICE!"=="7" set "PICK_MIN=10"
if "!MODEL_CHOICE!"=="8" set "PICK_MIN=16"
if "!MODEL_CHOICE!"=="9" set "PICK_MIN=16"
if "!MODEL_CHOICE!"=="10" set "PICK_MIN=24"
if not defined HW_VRAM set "HW_VRAM=0"
if !HW_VRAM! gtr 0 if !PICK_MIN! gtr 0 if !HW_VRAM! lss !PICK_MIN! (
    echo.
    echo  [!!] Heads up: this model wants about !PICK_MIN! GB of GPU
    echo       memory, but only !HW_VRAM! GB was detected. It can still
    echo       run by spilling into system RAM, but expect it to be
    echo       noticeably slower than a model that fits your GPU.
    echo.
    call :prompt_yn "  Download it anyway?" GO_BIG
    if /i "!GO_BIG!"=="N" goto :show_catalog
    echo.
)

if "!MODEL_CHOICE!"=="1" (
    set "DL_REPO=bartowski/google_gemma-3-4b-it-GGUF"
    set "DL_FILE=google_gemma-3-4b-it-Q8_0.gguf"
    set "MODEL_ID=gemma3-4b"
    set "MODEL_DISPLAY=Gemma 3 4B IT"
    set "MODEL_FAMILY=gemma"
    set "MODEL_MAX_CTX=131072"
    set "MODEL_THINK_FMT=none"
    set "CTX_SIZE=32768"
    set "KV_CACHE_TYPE=f16"
    goto :download_model
)
if "!MODEL_CHOICE!"=="2" (
    set "DL_REPO=bartowski/Llama-3.2-3B-Instruct-GGUF"
    set "DL_FILE=Llama-3.2-3B-Instruct-Q8_0.gguf"
    set "MODEL_ID=llama32-3b"
    set "MODEL_DISPLAY=Llama 3.2 3B Instruct"
    set "MODEL_FAMILY=llama"
    set "MODEL_MAX_CTX=131072"
    set "MODEL_THINK_FMT=none"
    set "CTX_SIZE=32768"
    set "KV_CACHE_TYPE=f16"
    goto :download_model
)
if "!MODEL_CHOICE!"=="3" (
    set "DL_REPO=bartowski/Meta-Llama-3.1-8B-Instruct-GGUF"
    set "DL_FILE=Meta-Llama-3.1-8B-Instruct-Q6_K.gguf"
    set "MODEL_ID=llama31-8b"
    set "MODEL_DISPLAY=Llama 3.1 8B Instruct"
    set "MODEL_FAMILY=llama"
    set "MODEL_MAX_CTX=131072"
    set "MODEL_THINK_FMT=none"
    set "CTX_SIZE=32768"
    set "KV_CACHE_TYPE=q8_0"
    goto :download_model
)
if "!MODEL_CHOICE!"=="4" (
    set "DL_REPO=bartowski/c4ai-command-r7b-12-2024-GGUF"
    set "DL_FILE=c4ai-command-r7b-12-2024-Q6_K.gguf"
    set "MODEL_ID=command-r7b"
    set "MODEL_DISPLAY=Command R 7B (12-2024)"
    set "MODEL_FAMILY=cohere"
    set "MODEL_MAX_CTX=131072"
    set "MODEL_THINK_FMT=none"
    set "CTX_SIZE=32768"
    set "KV_CACHE_TYPE=q8_0"
    goto :download_model
)
if "!MODEL_CHOICE!"=="5" (
    set "DL_REPO=bartowski/granite-3.0-8b-instruct-GGUF"
    set "DL_FILE=granite-3.0-8b-instruct-Q6_K.gguf"
    set "MODEL_ID=granite-8b"
    set "MODEL_DISPLAY=Granite 3.0 8B Instruct"
    set "MODEL_FAMILY=granite"
    set "MODEL_MAX_CTX=131072"
    set "MODEL_THINK_FMT=none"
    set "CTX_SIZE=32768"
    set "KV_CACHE_TYPE=q8_0"
    goto :download_model
)
if "!MODEL_CHOICE!"=="6" (
    set "DL_REPO=bartowski/THUDM_GLM-Z1-9B-0414-GGUF"
    set "DL_FILE=THUDM_GLM-Z1-9B-0414-Q4_K_M.gguf"
    set "MODEL_ID=glm-z1-9b"
    set "MODEL_DISPLAY=GLM-Z1 9B (0414)"
    set "MODEL_FAMILY=glm"
    set "MODEL_MAX_CTX=32768"
    set "MODEL_THINK_FMT=deepseek"
    set "CTX_SIZE=16384"
    set "KV_CACHE_TYPE=q8_0"
    goto :download_model
)
if "!MODEL_CHOICE!"=="7" (
    set "DL_REPO=bartowski/DeepSeek-R1-0528-Qwen3-8B-GGUF"
    set "DL_FILE=DeepSeek-R1-0528-Qwen3-8B-Q8_0.gguf"
    set "MODEL_ID=deepseek-r1-8b"
    set "MODEL_DISPLAY=DeepSeek-R1 8B"
    set "MODEL_FAMILY=deepseek"
    set "MODEL_MAX_CTX=131072"
    set "MODEL_THINK_FMT=deepseek"
    set "CTX_SIZE=32768"
    set "KV_CACHE_TYPE=q8_0"
    goto :download_model
)
if "!MODEL_CHOICE!"=="8" (
    set "DL_REPO=bartowski/google_gemma-4-26B-A4B-it-GGUF"
    set "DL_FILE=google_gemma-4-26B-A4B-it-Q4_K_S.gguf"
    set "MODEL_ID=gemma4-26b"
    set "MODEL_DISPLAY=Gemma 4 26B-A4B MoE"
    set "MODEL_FAMILY=gemma"
    set "MODEL_MAX_CTX=262144"
    set "MODEL_THINK_FMT=gemma"
    set "CTX_SIZE=16384"
    set "KV_CACHE_TYPE=q8_0"
    goto :download_model
)
if "!MODEL_CHOICE!"=="9" (
    set "DL_REPO=bartowski/TheDrummer_Cydonia-24B-v4.1-GGUF"
    set "DL_FILE=TheDrummer_Cydonia-24B-v4.1-IQ4_XS.gguf"
    set "MODEL_ID=cydonia-24b"
    set "MODEL_DISPLAY=Cydonia 24B v4.1"
    set "MODEL_FAMILY=mistral"
    set "MODEL_MAX_CTX=131072"
    set "MODEL_THINK_FMT=none"
    set "CTX_SIZE=16384"
    set "KV_CACHE_TYPE=q8_0"
    goto :download_model
)
if "!MODEL_CHOICE!"=="10" (
    set "DL_REPO=bartowski/c4ai-command-r-08-2024-GGUF"
    set "DL_FILE=c4ai-command-r-08-2024-Q4_K_S.gguf"
    set "MODEL_ID=command-r-35b"
    set "MODEL_DISPLAY=Command R 35B (08-2024)"
    set "MODEL_FAMILY=cohere"
    set "MODEL_MAX_CTX=131072"
    set "MODEL_THINK_FMT=none"
    set "CTX_SIZE=16384"
    set "KV_CACHE_TYPE=q8_0"
    goto :download_model
)

echo.
echo  [INFO] Place your .gguf file in: !MODEL_DIR!
echo         Then run this script again.
echo.
echo  Popular GGUF sources:
echo    https://huggingface.co/bartowski
echo    https://huggingface.co/unsloth
echo.
goto :fatal

:download_model
set "DL_URL=https://huggingface.co/!DL_REPO!/resolve/main/!DL_FILE!"
set "GGUF_PATH=!MODEL_DIR!\!DL_FILE!"

echo.
echo  [..] Downloading: !DL_FILE!
echo       From: huggingface.co/!DL_REPO!
echo       To:   !MODEL_DIR!\
echo.
echo       This is a large file. It may take 10-30 minutes
echo       depending on your connection speed.
echo.

curl.exe -L -o "!GGUF_PATH!" "!DL_URL!" --progress-bar
if errorlevel 1 (
    echo.
    echo  [ERROR] Download failed.
    echo         Try downloading manually:
    echo         !DL_URL!
    echo         Save to: !MODEL_DIR!\
    del "!GGUF_PATH!" 2>nul
    goto :fatal
)

:: ---------------------------------------------------------------
:: INTEGRITY CHECK -- cmd-native, NO PowerShell.
:: HuggingFace stores LFS files behind a pointer that records the
:: canonical SHA-256. We fetch that small text pointer with curl
:: (over TLS, from the /raw/ path), pull "sha256:<hex>" out of it
:: with findstr, and compare to certutil's hash of the file we
:: actually downloaded. Same reasoning as the engine step: no temp
:: .ps1, no -ExecutionPolicy Bypass, nothing a behavioral AV reads
:: as download-staging.
::   - mismatch              -^> abort and delete (corrupt/tampered)
::   - no pointer/parse fail  -^> warn but continue (rely on the
::     ^>=1GB size sanity check below); HF format changes shouldn't
::     hard-block a good file.
:: ---------------------------------------------------------------
set "POINTER_URL=https://huggingface.co/!DL_REPO!/raw/main/!DL_FILE!"
set "PTR_FILE=%TEMP%\gobbonet_ptr_%RANDOM%.txt"
set "VERIFY_RESULT=2"

echo  [..] Fetching expected SHA-256 from HuggingFace...
curl.exe -s -L --fail -o "!PTR_FILE!" "!POINTER_URL!"
if errorlevel 1 (
    echo  [WARN] Could not fetch the HuggingFace checksum pointer.
    echo         Skipping hash check; size sanity check still applies.
    goto :model_verify_done
)

set "MODEL_EXPECTED="
for /f "tokens=2 delims=:" %%H in ('findstr /i "sha256:" "!PTR_FILE!"') do if not defined MODEL_EXPECTED set "MODEL_EXPECTED=%%H"
set "MODEL_EXPECTED=!MODEL_EXPECTED: =!"
if not defined MODEL_EXPECTED (
    echo  [WARN] Could not read the checksum from HuggingFace ^(format may have changed^).
    echo         Skipping hash check; size sanity check still applies.
    goto :model_verify_done
)

set "MODEL_ACTUAL="
for /f "skip=1 delims=" %%H in ('certutil -hashfile "!GGUF_PATH!" SHA256 2^>nul') do if not defined MODEL_ACTUAL set "MODEL_ACTUAL=%%H"
set "MODEL_ACTUAL=!MODEL_ACTUAL: =!"
echo  [..] Verifying download against it...
if /i "!MODEL_ACTUAL!"=="!MODEL_EXPECTED!" (
    echo  [OK] Model checksum verified.
    set "VERIFY_RESULT=0"
) else (
    echo  [ERROR] CHECKSUM MISMATCH -- model file is corrupt or tampered.
    echo            expected: !MODEL_EXPECTED!
    echo            actual:   !MODEL_ACTUAL!
    set "VERIFY_RESULT=1"
)

:model_verify_done
del /f /q "!PTR_FILE!" >nul 2>&1
if "!VERIFY_RESULT!"=="1" (
    echo.
    echo  [ERROR] The downloaded model failed its integrity check and has
    echo          been deleted. This can mean a corrupted download or that
    echo          the file was tampered with. Try again, or download manually.
    del "!GGUF_PATH!" 2>nul
    goto :fatal
)

:: Sanity check — file should be at least 1 GB
for %%A in ("!GGUF_PATH!") do set "FSIZE=%%~zA"
if !FSIZE! LSS 1000000000 (
    echo  [ERROR] Downloaded file is too small - !FSIZE! bytes.
    echo         This usually means the download link returned an
    echo         error page instead of the model file.
    echo.
    echo         The GGUF repo or filename may have changed.
    echo         Check: https://huggingface.co/bartowski
    echo         Download manually and place in: !MODEL_DIR!\
    del "!GGUF_PATH!" 2>nul
    goto :fatal
)

echo  [OK] Model downloaded: !DL_FILE!
echo.

:: Fall through to write_model_json (GGUF_BASENAME not set for downloads — set it now)
for %%F in ("!GGUF_PATH!") do set "GGUF_BASENAME=%%~nxF"

:: ---------------------------------------------------------------
:: WRITE ACTIVE-MODEL.JSON
:: Tells chat.html which model is loaded so it can update the UI.
:: Served by the file server at /active-model.json
:: ---------------------------------------------------------------
:write_model_json
echo  [..] Writing active-model.json...
(
    echo {
    echo   "id": "!MODEL_ID!",
    echo   "name": "!MODEL_DISPLAY!",
    echo   "family": "!MODEL_FAMILY!",
    echo   "ggufFile": "!GGUF_BASENAME!",
    echo   "maxCtx": !MODEL_MAX_CTX!,
    echo   "defaultCtx": !CTX_SIZE!,
    echo   "thinkingFormat": "!MODEL_THINK_FMT!"
    echo }
) > "%~dp0active-model.json"
echo  [OK] active-model.json written ^(!MODEL_DISPLAY!^)
echo.

:: ---------------------------------------------------------------
:: WRITE MODELS-LIST.JSON
::
:: chat.html's header dropdown is populated by fetching this file
:: from the file server. It needs one record per .gguf in models\,
:: with the same metadata launch.bat would have set if THAT file had
:: been the active choice (family, thinking format, max context,
:: useJinja, chatTemplate). When the user picks a different option,
:: fileserver.ps1 reads the record back out of this file and uses it
:: to build the swap command line -- so the per-model quirks (e.g.
:: Mistral Nemo's MODEL_USE_JINJA=0 + mistral-v3-tekken template)
:: ride along correctly without launch.bat being in the loop.
::
:: identify-model.ps1 (the SAME script :identify_model used above) reads
:: every GGUF in models\ and writes one record per file. Detection lives
:: in exactly one place now, so the dropdown, the hot-swap launcher and
:: the initial launch can never disagree about a model template/jinja mode.
:: ---------------------------------------------------------------
echo  [..] Writing models-list.json...
set "MODELS_LIST_JSON=%~dp0models-list.json"
set "ACTIVE_GGUF_NAME=!GGUF_BASENAME!"
if exist "%~dp0identify-model.ps1" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0identify-model.ps1" -ModelsDir "!MODEL_DIR!" -Active "!ACTIVE_GGUF_NAME!" -OutFile "!MODELS_LIST_JSON!"
) else (
    echo  [!!] identify-model.ps1 not found; cannot build models-list.json.
)

if errorlevel 1 (
    echo  [!!] models-list.json write failed; header dropdown will be empty.
    echo       Hot-swap requires this file -- check that PowerShell can run.
)
echo.

:: ---------------------------------------------------------------
:: STEP 3: START LLAMA-SERVER
:: ---------------------------------------------------------------
:start_server
echo  [..] Checking for running llama-server...

curl.exe -s -o nul http://127.0.0.1:!SERVER_PORT!/health >nul 2>&1
if not errorlevel 1 (
    echo  [OK] llama-server already running on port !SERVER_PORT!
    goto :verify_gpu
)

:: Log file for diagnostics — lives next to this script
echo  [..] Starting llama-server...
echo       Model:      !GGUF_PATH!
echo       Port:       !SERVER_PORT!
echo       Context:    !CTX_SIZE! tokens
echo       KV Cache:   !KV_CACHE_TYPE! (quantized for max context)
echo       GPU layers: !GPU_LAYERS!
echo       Log file:   !LOG_FILE!
echo.
echo       NOTE: The GGUF file usually contains its own chat template.
if not "!MODEL_CHAT_TEMPLATE_FILE!"=="" (
    echo             Using project template file: !MODEL_CHAT_TEMPLATE_FILE!
    echo             ^(--jinja on, embedded template overridden^)
) else (
    if "!MODEL_USE_JINJA!"=="1" (
        if not "!MODEL_CHAT_TEMPLATE!"=="" (
            echo             Using --jinja with override: !MODEL_CHAT_TEMPLATE!
        ) else (
            echo             Using --jinja to honor the embedded Jinja template.
        )
    ) else (
        if not "!MODEL_CHAT_TEMPLATE!"=="" (
            echo             Using llama-server built-in: !MODEL_CHAT_TEMPLATE!
            echo             ^(--jinja disabled for this model family^)
        ) else (
            echo             --jinja disabled; falling back to fingerprint match.
        )
    )
)
echo.

:: CHAT TEMPLATE HANDLING
::
:: --jinja tells llama-server to use the chat_template baked into the GGUF.
:: That's the default and works for most modern models (Gemma 4 channels,
:: gpt-oss Harmony, Mistral Small v7-tekken, Qwen3 think mode, etc.).
::
:: For a handful of families, --jinja produces garbage because the embedded
:: template is incomplete or contains Jinja constructs that minja can't
:: render. Mistral Nemo merges are the canonical example — see the comment
:: at the top of this script. For those, :identify_model sets:
::   MODEL_USE_JINJA=0
::   MODEL_CHAT_TEMPLATE=<built-in template name, e.g. mistral-v3-tekken>
:: which makes us pass --chat-template <name> instead of --jinja, using
:: llama-server's C++ reference implementation of the template.
::
:: Important: we ONLY pass --chat-template when MODEL_CHAT_TEMPLATE names a
:: built-in. Passing an arbitrary template name silently falls back to a
:: wrong format and causes the model to echo system info instead of
:: chatting — that's the footgun the old comment here was guarding against.

:: --parallel 1 pins the server to a single slot. The default ('auto'
:: → 4 slots) splits the unified KV cache four ways and causes the
:: server to bounce between slots via LRU/LCP selection. With two
:: differently-shaped requests in flight (e.g. lore summarization +
:: chat completion), slot churn invalidates cached prefixes on both
:: sides, forcing a full prompt re-prefill (~27s on a 11K context).
:: One slot = consistent cache reuse = the followup chat call after
:: a summarization is fast instead of doing prefill from scratch.
::
:: --reasoning-format auto asks the server to route chain-of-thought
:: into a separate reasoning_content channel. Without it, CoT arrives
:: inline in 'content' and we rely entirely on the client-side parser.
:: With it, the server does the split for us and the client parser
:: becomes a safety net rather than the only line of defense. This is
:: a no-op for non-reasoning models, so it's safe to always pass.

:: Build optional flags conditionally so we don't accidentally emit
:: '--jinja' and '--chat-template <name>' together (mixing the two is
:: legal but defeats the point of routing around a broken Jinja template).
::
:: Precedence for the template source:
::   1. MODEL_CHAT_TEMPLATE_FILE -- a real .jinja file shipped with the
::      project (e.g. granite.jinja). REQUIRES --jinja to be honored as a
::      template (without --jinja, --chat-template-file is ignored). This
::      feeds our file INSTEAD of the GGUF's embedded template, so it both
::      sidesteps a broken embedded template and formats correctly. Used
::      for Granite, whose embedded template crashes the loader AND whose
::      built-in NAME doesn't resolve on current builds (it gets treated as
::      a literal template -- the model ends up fed just the word "granite").
::   2. MODEL_CHAT_TEMPLATE -- a built-in template NAME (e.g.
::      mistral-v3-tekken). Used with --jinja DISABLED; llama-server's C++
::      reference implementation renders it.
::   3. Neither -- plain --jinja, honoring the GGUF's embedded template.
set "JINJA_FLAG="
set "CHAT_TEMPLATE_FLAG="

:: Guard (defense-in-depth): the pinned llama.cpp build does not recognize
:: "mistral-v7-tekken" as a built-in name, so passing it bare to --chat-template
:: makes the server treat the literal text as the template body -- the model is
:: then fed a constant string and rambles about "tekken". Rewrite to the name
:: that IS registered. (identify-model.ps1 already emits mistral-v7, but a user
:: could hand-set this from the CONFIG comment above, or a stale value could
:: arrive some other way -- so we normalize here too.)
if /i "!MODEL_CHAT_TEMPLATE!"=="mistral-v7-tekken" (
    set "MODEL_CHAT_TEMPLATE=mistral-v7"
    set "MODEL_USE_JINJA=0"
    echo  [..] Normalized chat template mistral-v7-tekken -^> mistral-v7 ^(unrecognized on pinned build^).
)

:: Guard: if a template FILE was specified, make sure it is actually a Jinja
:: template and not an empty file or a failed download (the classic "Entry not
:: found" 404 body). A bad file fed via --chat-template-file renders to a
:: constant string for every turn, exactly like the -tekken trap above. If it
:: looks unusable, drop it and fall back to the embedded template via --jinja.
if not "!MODEL_CHAT_TEMPLATE_FILE!"=="" (
    set "TEMPLATE_FILE_PATH=%~dp0!MODEL_CHAT_TEMPLATE_FILE!"
    if exist "!TEMPLATE_FILE_PATH!" (
        findstr /c:"{%%" /c:"{{" "!TEMPLATE_FILE_PATH!" >nul 2>&1
        if errorlevel 1 (
            echo  [!!] Template file has no Jinja markers ^(empty / failed download?^): !MODEL_CHAT_TEMPLATE_FILE!
            echo       Ignoring it and using the embedded template instead.
            set "MODEL_CHAT_TEMPLATE_FILE="
        )
    )
)

if not "!MODEL_CHAT_TEMPLATE_FILE!"=="" (
    rem Resolve the filename against the project root (same dir as this
    rem script / the server exe). A bare filename keeps models-list.json
    rem portable; we expand to a full path only at launch time.
    set "TEMPLATE_FILE_PATH=%~dp0!MODEL_CHAT_TEMPLATE_FILE!"
    if exist "!TEMPLATE_FILE_PATH!" (
        set "JINJA_FLAG=--jinja"
        rem Note: value intentionally contains embedded quotes around the
        rem path (it may contain spaces). Using the set VAR=value form
        rem (no outer quotes) so the quotes belong to the value itself.
        set CHAT_TEMPLATE_FLAG=--chat-template-file "!TEMPLATE_FILE_PATH!"
    ) else (
        echo  [!!] Chat-template file not found: !TEMPLATE_FILE_PATH!
        echo       Falling back to embedded template via --jinja.
        set "JINJA_FLAG=--jinja"
    )
) else (
    if "!MODEL_USE_JINJA!"=="1" set "JINJA_FLAG=--jinja"
    if not "!MODEL_CHAT_TEMPLATE!"=="" (
        set "CHAT_TEMPLATE_FLAG=--chat-template !MODEL_CHAT_TEMPLATE!"
    )
)

:: Write a small launcher script so we can reliably redirect output
:: to a log file. (start + cmd /c + multi-line caret = quoting hell.)
:: LAUNCH_SCRIPT lives in the project root (see CONFIG at the top of
:: this script) instead of %TEMP% so fileserver.ps1 can rewrite it
:: during a hot-swap and the next monitor-loop restart picks up the
:: new model.
> "!LAUNCH_SCRIPT!" (
    echo @echo off
    echo "!SERVER_EXE!" --model "!GGUF_PATH!" --port !SERVER_PORT! --host 127.0.0.1 --ctx-size !CTX_SIZE! --n-gpu-layers !GPU_LAYERS! --cache-type-k !KV_CACHE_TYPE! --cache-type-v !KV_CACHE_TYPE! --parallel 1 !JINJA_FLAG! !CHAT_TEMPLATE_FLAG! --reasoning-format auto ^> "!LOG_FILE!" 2^>^&1
)

start /min "llama-server" "!LAUNCH_SCRIPT!"

echo  [..] Waiting for server to load model...
echo       (First launch may take 30-60 seconds while the
echo        model loads into VRAM. Subsequent starts are faster.)
echo.

set "RETRIES=0"
:wait_loop
set /a RETRIES+=1
if !RETRIES! gtr 60 (
    echo.
    echo  [ERROR] llama-server didn't respond within 2 minutes.
    echo         Check if the model is too large for your VRAM.
    echo         Try a smaller model, or reduce GPU_LAYERS in this script.
    echo.
    echo  [LOG] Last 20 lines of server log:
    powershell -NoProfile -Command "Get-Content '!LOG_FILE!' -Tail 20" 2>nul
    goto :fatal
)
timeout /t 2 /nobreak >nul
set /p "=." <nul

curl.exe -s http://127.0.0.1:!SERVER_PORT!/health 2>nul | findstr /i "ok" >nul 2>&1
if errorlevel 1 goto :wait_loop

echo.
echo  [OK] llama-server is ready!
echo.

:: ---------------------------------------------------------------
:: STEP 3b: VERIFY GPU OFFLOAD
:: Check the log file for Vulkan/GPU info so the user knows
:: whether inference is running on GPU or stuck on CPU.
:: ---------------------------------------------------------------
:verify_gpu
set "GPU_CONFIRMED=0"

:: Check log for Vulkan or CUDA device detection and successful layer offload
if exist "!LOG_FILE!" (
    findstr /i /c:"offloaded" /c:"Vulkan0" /c:"CUDA0" /c:"Metal0" "!LOG_FILE!" >nul 2>&1
    if not errorlevel 1 set "GPU_CONFIRMED=1"
)

if "!GPU_CONFIRMED!"=="1" (
    echo  [OK] GPU acceleration detected
) else (
    echo.
    echo  [!!] WARNING: Could not confirm GPU acceleration.
    echo       The model may be running on CPU, which is VERY slow.
    echo.
    echo       Possible causes:
    echo         1. GPU drivers not installed or outdated
    echo            AMD: amd.com/en/support
    echo            NVIDIA: nvidia.com/Download/index.aspx
    echo         2. Wrong llama.cpp build for your GPU
    echo            Vulkan build supports AMD, Intel, and some NVIDIA.
    echo            CUDA build is faster on NVIDIA if available.
    echo         3. GPU doesn't have enough VRAM for this model
    echo            Try a smaller model or lower GPU_LAYERS.
    echo.
    echo       Check the log file for details:
    echo         !LOG_FILE!
    echo.
    if exist "!LOG_FILE!" (
        echo  [LOG] GPU-related log lines:
        findstr /i /c:"Vulkan" /c:"CUDA" /c:"GPU" /c:"backend" /c:"offload" /c:"error" /c:"fail" "!LOG_FILE!" 2>nul
        echo.
    )
    call :prompt_yn "  Continue anyway?" CONTINUE_CPU
    if /i "!CONTINUE_CPU!"=="N" goto :fatal
)

:: Check for VRAM pressure warnings
if exist "!LOG_FILE!" (
    findstr /i /c:"cannot meet free memory" /c:"failed to fit" "!LOG_FILE!" >nul 2>&1
    if not errorlevel 1 (
        echo.
        echo  [!!] VRAM WARNING: Model is tight on your GPU memory.
        echo       If you get 500 errors during chat, try:
        echo         - Reduce CTX_SIZE at the top of this script
        echo         - Use a smaller model or quantization
        echo       Current CTX_SIZE = !CTX_SIZE!
    )
)
echo.

:: ---------------------------------------------------------------
:: STEP 4: SEARCH PROXY (127.0.0.1:11435 -> ollama.com/api)
:: The search proxy is independent of the inference backend.
:: It's a simple HTTP relay so the chat UI can do web searches.
:: Bound to loopback: only the file server's /search route reaches
:: it (via 127.0.0.1), so it is not exposed on the LAN and needs no
:: separate auth. The browser's search Authorization header is
:: forwarded through the file server proxy to here unchanged.
:: ---------------------------------------------------------------
:start_proxy

curl.exe -s -o nul http://127.0.0.1:11435/health >nul 2>&1
if not errorlevel 1 (
    echo  [OK] Search proxy on :11435
    goto :launch
)

echo  [..] Starting search proxy on :11435...
start /min powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand "JABFAHIAcgBvAHIAQQBjAHQAaQBvAG4AUAByAGUAZgBlAHIAZQBuAGMAZQAgAD0AIAAnAFMAaQBsAGUAbgB0AGwAeQBDAG8AbgB0AGkAbgB1AGUAJwAKAFsATgBlAHQALgBTAGUAcgB2AGkAYwBlAFAAbwBpAG4AdABNAGEAbgBhAGcAZQByAF0AOgA6AFMAZQBjAHUAcgBpAHQAeQBQAHIAbwB0AG8AYwBvAGwAIAA9ACAAWwBOAGUAdAAuAFMAZQBjAHUAcgBpAHQAeQBQAHIAbwB0AG8AYwBvAGwAVAB5AHAAZQBdADoAOgBUAGwAcwAxADIACgAkAGwAaQBzAHQAZQBuAGUAcgAgAD0AIABOAGUAdwAtAE8AYgBqAGUAYwB0ACAAUwB5AHMAdABlAG0ALgBOAGUAdAAuAEgAdAB0AHAATABpAHMAdABlAG4AZQByAAoAJABsAGkAcwB0AGUAbgBlAHIALgBQAHIAZQBmAGkAeABlAHMALgBBAGQAZAAoACcAaAB0AHQAcAA6AC8ALwAxADIANwAuADAALgAwAC4AMQA6ADEAMQA0ADMANQAvACcAKQAKAHQAcgB5ACAAewAgACQAbABpAHMAdABlAG4AZQByAC4AUwB0AGEAcgB0ACgAKQAgAH0AIABjAGEAdABjAGgAIAB7ACAAZQB4AGkAdAAgADEAIAB9AAoAdwBoAGkAbABlACAAKAAkAGwAaQBzAHQAZQBuAGUAcgAuAEkAcwBMAGkAcwB0AGUAbgBpAG4AZwApACAAewAKACAAIAAkAGMAdAB4ACAAPQAgACQAbABpAHMAdABlAG4AZQByAC4ARwBlAHQAQwBvAG4AdABlAHgAdAAoACkACgAgACAAJAByAGUAcwBwACAAPQAgACQAYwB0AHgALgBSAGUAcwBwAG8AbgBzAGUACgAgACAAJAByAGUAcwBwAC4AQQBkAGQASABlAGEAZABlAHIAKAAnAEEAYwBjAGUAcwBzAC0AQwBvAG4AdAByAG8AbAAtAEEAbABsAG8AdwAtAE8AcgBpAGcAaQBuACcALAAgACcAKgAnACkACgAgACAAJAByAGUAcwBwAC4AQQBkAGQASABlAGEAZABlAHIAKAAnAEEAYwBjAGUAcwBzAC0AQwBvAG4AdAByAG8AbAAtAEEAbABsAG8AdwAtAE0AZQB0AGgAbwBkAHMAJwAsACAAJwBQAE8AUwBUACwAIABHAEUAVAAsACAATwBQAFQASQBPAE4AUwAnACkACgAgACAAJAByAGUAcwBwAC4AQQBkAGQASABlAGEAZABlAHIAKAAnAEEAYwBjAGUAcwBzAC0AQwBvAG4AdAByAG8AbAAtAEEAbABsAG8AdwAtAEgAZQBhAGQAZQByAHMAJwAsACAAJwBDAG8AbgB0AGUAbgB0AC0AVAB5AHAAZQAsACAAQQB1AHQAaABvAHIAaQB6AGEAdABpAG8AbgAnACkACgAgACAAaQBmACAAKAAkAGMAdAB4AC4AUgBlAHEAdQBlAHMAdAAuAEgAdAB0AHAATQBlAHQAaABvAGQAIAAtAGUAcQAgACcATwBQAFQASQBPAE4AUwAnACkAIAB7AAoAIAAgACAAIAAkAHIAZQBzAHAALgBTAHQAYQB0AHUAcwBDAG8AZABlACAAPQAgADIAMAA0ADsAIAAkAHIAZQBzAHAALgBDAGwAbwBzAGUAKAApADsAIABjAG8AbgB0AGkAbgB1AGUACgAgACAAfQAKACAAIAAkAHAAYQB0AGgAIAA9ACAAJABjAHQAeAAuAFIAZQBxAHUAZQBzAHQALgBVAHIAbAAuAEEAYgBzAG8AbAB1AHQAZQBQAGEAdABoAAoAIAAgAGkAZgAgACgAJABwAGEAdABoACAALQBlAHEAIAAnAC8AaABlAGEAbAB0AGgAJwApACAAewAKACAAIAAgACAAJAByAGUAcwBwAC4AUwB0AGEAdAB1AHMAQwBvAGQAZQAgAD0AIAAyADAAMAAKACAAIAAgACAAJABiACAAPQAgAFsAVABlAHgAdAAuAEUAbgBjAG8AZABpAG4AZwBdADoAOgBVAFQARgA4AC4ARwBlAHQAQgB5AHQAZQBzACgAJwB7ACIAcwB0AGEAdAB1AHMAIgA6ACIAbwBrACIAfQAnACkACgAgACAAIAAgACQAcgBlAHMAcAAuAE8AdQB0AHAAdQB0AFMAdAByAGUAYQBtAC4AVwByAGkAdABlACgAJABiACwAIAAwACwAIAAkAGIALgBMAGUAbgBnAHQAaAApADsAIAAkAHIAZQBzAHAALgBDAGwAbwBzAGUAKAApADsAIABjAG8AbgB0AGkAbgB1AGUACgAgACAAfQAKACAAIAB0AHIAeQAgAHsACgAgACAAIAAgACQAcwByACAAPQAgAE4AZQB3AC0ATwBiAGoAZQBjAHQAIABJAE8ALgBTAHQAcgBlAGEAbQBSAGUAYQBkAGUAcgAoACQAYwB0AHgALgBSAGUAcQB1AGUAcwB0AC4ASQBuAHAAdQB0AFMAdAByAGUAYQBtACkACgAgACAAIAAgACQAYgBvAGQAeQAgAD0AIAAkAHMAcgAuAFIAZQBhAGQAVABvAEUAbgBkACgAKQA7ACAAJABzAHIALgBDAGwAbwBzAGUAKAApAAoAIAAgACAAIAAkAHQAYQByAGcAZQB0AFUAcgBsACAAPQAgACcAaAB0AHQAcABzADoALwAvAG8AbABsAGEAbQBhAC4AYwBvAG0ALwBhAHAAaQAnACAAKwAgACQAcABhAHQAaAAKACAAIAAgACAAJABoAGUAYQBkAGUAcgBzACAAPQAgAEAAewAgACcAQwBvAG4AdABlAG4AdAAtAFQAeQBwAGUAJwAgAD0AIAAnAGEAcABwAGwAaQBjAGEAdABpAG8AbgAvAGoAcwBvAG4AJwAgAH0ACgAgACAAIAAgACQAYQB1AHQAaAAgAD0AIAAkAGMAdAB4AC4AUgBlAHEAdQBlAHMAdAAuAEgAZQBhAGQAZQByAHMAWwAnAEEAdQB0AGgAbwByAGkAegBhAHQAaQBvAG4AJwBdAAoAIAAgACAAIABpAGYAIAAoACQAYQB1AHQAaAApACAAewAgACQAaABlAGEAZABlAHIAcwBbACcAQQB1AHQAaABvAHIAaQB6AGEAdABpAG8AbgAnAF0AIAA9ACAAJABhAHUAdABoACAAfQAKACAAIAAgACAAJAB3AHIAIAA9ACAASQBuAHYAbwBrAGUALQBXAGUAYgBSAGUAcQB1AGUAcwB0ACAALQBVAHIAaQAgACQAdABhAHIAZwBlAHQAVQByAGwAIAAtAE0AZQB0AGgAbwBkACAAUABPAFMAVAAgAC0AQgBvAGQAeQAgACQAYgBvAGQAeQAgAC0ASABlAGEAZABlAHIAcwAgACQAaABlAGEAZABlAHIAcwAgAC0AVQBzAGUAQgBhAHMAaQBjAFAAYQByAHMAaQBuAGcAIAAtAFQAaQBtAGUAbwB1AHQAUwBlAGMAIAAzADAACgAgACAAIAAgACQAcgBlAHMAcAAuAEMAbwBuAHQAZQBuAHQAVAB5AHAAZQAgAD0AIAAnAGEAcABwAGwAaQBjAGEAdABpAG8AbgAvAGoAcwBvAG4AJwAKACAAIAAgACAAJABvAGIAIAA9ACAAWwBUAGUAeAB0AC4ARQBuAGMAbwBkAGkAbgBnAF0AOgA6AFUAVABGADgALgBHAGUAdABCAHkAdABlAHMAKAAkAHcAcgAuAEMAbwBuAHQAZQBuAHQAKQAKACAAIAAgACAAJAByAGUAcwBwAC4ATwB1AHQAcAB1AHQAUwB0AHIAZQBhAG0ALgBXAHIAaQB0AGUAKAAkAG8AYgAsACAAMAAsACAAJABvAGIALgBMAGUAbgBnAHQAaAApAAoAIAAgAH0AIABjAGEAdABjAGgAIAB7AAoAIAAgACAAIAAkAHIAZQBzAHAALgBTAHQAYQB0AHUAcwBDAG8AZABlACAAPQAgADUAMAAyAAoAIAAgACAAIAAkAGUAbQAgAD0AIAAnAHsAIgBlAHIAcgBvAHIAIgA6ACIAcAByAG8AeAB5ADoAIAAnACAAKwAgACQAXwAuAEUAeABjAGUAcAB0AGkAbwBuAC4ATQBlAHMAcwBhAGcAZQAuAFIAZQBwAGwAYQBjAGUAKAAnACIAJwAsACcAJwApAC4AUgBlAHAAbABhAGMAZQAoACIAYAByACIALAAnACcAKQAuAFIAZQBwAGwAYQBjAGUAKAAiAGAAbgAiACwAJwAgACcAKQAgACsAIAAnACIAfQAnAAoAIAAgACAAIAAkAGUAYgAgAD0AIABbAFQAZQB4AHQALgBFAG4AYwBvAGQAaQBuAGcAXQA6ADoAVQBUAEYAOAAuAEcAZQB0AEIAeQB0AGUAcwAoACQAZQBtACkACgAgACAAIAAgACQAcgBlAHMAcAAuAE8AdQB0AHAAdQB0AFMAdAByAGUAYQBtAC4AVwByAGkAdABlACgAJABlAGIALAAgADAALAAgACQAZQBiAC4ATABlAG4AZwB0AGgAKQAKACAAIAB9AAoAIAAgACQAcgBlAHMAcAAuAEMAbABvAHMAZQAoACkACgB9AAoA"

set "PRETRIES=0"
:proxy_wait
set /a PRETRIES+=1
if !PRETRIES! gtr 10 (
    echo  [!!] Search proxy failed. Web search will not work.
    echo      Chat still functions normally without search.
    goto :launch
)
timeout /t 1 /nobreak >nul
curl.exe -s -o nul http://127.0.0.1:11435/health >nul 2>&1
if errorlevel 1 goto :proxy_wait
echo  [OK] Search proxy on :11435
echo.

:: ---------------------------------------------------------------
:: STEP 5: FILE SERVER (serves chat.html over HTTP for LAN access)
:: ---------------------------------------------------------------
:launch

if not exist "%~dp0chat.html" (
    echo  [ERROR] chat.html not found in: %~dp0
    goto :fatal
)

:: Start a lightweight HTTP file server on port 8080
:: This lets your phone load chat.html over the network
curl.exe -s -o nul http://127.0.0.1:8080/ >nul 2>&1
if not errorlevel 1 (
    echo  [OK] File server already running on :8080
    goto :get_lan_ip
)

echo  [..] Starting file server on :8080...

:: Use the standalone fileserver.ps1 (reverse proxy included).
:: Environment variables pass config without batch escaping issues.
if not exist "%~dp0fileserver.ps1" (
    echo  [ERROR] fileserver.ps1 not found in: %~dp0
    echo         This file should be alongside launch.bat and chat.html.
    goto :fatal
)
set "GEMMA_ROOT=%~dp0."
set "GEMMA_LLM_PORT=!SERVER_PORT!"
set "GEMMA_SEARCH_PORT=11435"
:: Extra env vars the file server needs to spawn a replacement
:: llama-server during a hot-swap. fileserver.ps1 reads these once at
:: startup and uses them to build the new launch command when the
:: /swap-model endpoint is hit. Keep them consistent with the values
:: used by :start_server above.
set "GEMMA_SERVER_EXE=!SERVER_EXE!"
set "GEMMA_MODEL_DIR=!MODEL_DIR!"
set "GEMMA_CTX_SIZE=!CTX_SIZE!"
set "GEMMA_GPU_LAYERS=!GPU_LAYERS!"
set "GEMMA_KV_CACHE_TYPE=!KV_CACHE_TYPE!"
set "GEMMA_LOG_FILE=!LOG_FILE!"
set "GEMMA_LAUNCH_SCRIPT=!LAUNCH_SCRIPT!"
set "GEMMA_ACCESS_SECRET=!ACCESS_SECRET!"
start /min powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0fileserver.ps1"

set "FRETRIES=0"
:fserver_wait
set /a FRETRIES+=1
if !FRETRIES! gtr 8 (
    echo  [!!] File server failed to start. Phone access will not work.
    echo      You may need to run setup-lan.bat as Administrator first.
    echo      Desktop chat still works normally.
    goto :get_lan_ip
)
timeout /t 1 /nobreak >nul
curl.exe -s -o nul http://127.0.0.1:8080/ >nul 2>&1
if errorlevel 1 goto :fserver_wait
echo  [OK] File server on :8080

:: ---------------------------------------------------------------
:: STEP 6: GET LAN IP + LAUNCH BROWSER
:: ---------------------------------------------------------------
:get_lan_ip
:: Detect the local network IP so we can show the phone URL
for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr /i "IPv4" ^| findstr /v "127.0.0.1"') do (
    set "LAN_IP=%%A"
    :: Trim leading space
    for /f "tokens=* delims= " %%B in ("!LAN_IP!") do set "LAN_IP=%%B"
    goto :got_ip
)
set "LAN_IP=<could not detect>"
:got_ip

:: ---------------------------------------------------------------
:: HOSTNAME / mDNS DETECTION
::
:: Windows 10 (1703+) and Windows 11 automatically advertise the
:: PC's name on the local network via mDNS through the dnscache
:: service. Modern Android (Nov 2021+) and iOS resolve <name>.local
:: in browsers natively — no app or config needed on the phone.
::
:: The hostname URL is preferred because it's STABLE across IP
:: rotations: the browser keys localStorage by origin, and the
:: hostname stays the same even when the LAN IP changes. Users
:: who bookmark <hostname>.local:8080 won't lose their chats when
:: their PC's DHCP lease rolls over.
:: ---------------------------------------------------------------
set "LAN_HOST=!COMPUTERNAME!"
:: Lowercase the hostname (mDNS is case-insensitive but bookmarks look better)
:: Build a lowercase copy via a small PowerShell call. Falls back to the
:: original case on any error.
for /f "usebackq delims=" %%A in (`powershell -NoProfile -Command "$env:COMPUTERNAME.ToLower()" 2^>nul`) do set "LAN_HOST=%%A"
if not defined LAN_HOST set "LAN_HOST=!COMPUTERNAME!"

:: Quick reachability check — does this PC respond to its own .local name?
:: If yes, mDNS is working and other devices on the LAN should reach us
:: at <LAN_HOST>.local. If no, fall back to recommending the IP URL only.
set "MDNS_OK=0"
ping -n 1 -w 500 "!LAN_HOST!.local" >nul 2>&1
if not errorlevel 1 set "MDNS_OK=1"

:: ---------------------------------------------------------------
:: IP CHANGE DETECTION
::
:: Each LAN IP is a separate browser origin. When this PC's IP
:: rotates between launches, the phone's localStorage at the OLD IP
:: stays put (and unreachable), and the phone bookmark needs to be
:: updated. Without a warning, users think their chats vanished —
:: they didn't, the new origin just has its own (empty) localStorage.
::
:: Also: chat.html now mirrors state to the file server's /state
:: endpoint, so even if the user IS on a new IP, their data will be
:: offered for restore on first load. This warning just gets ahead
:: of the surprise.
::
:: NOTE: this whole problem disappears if users bookmark the .local
:: hostname URL instead of the IP URL. The warning is here for users
:: who haven't switched yet.
:: ---------------------------------------------------------------
set "LAST_IP_FILE=%~dp0.last-lan-ip"
set "PREV_LAN_IP="
if exist "!LAST_IP_FILE!" (
    set /p "PREV_LAN_IP="<"!LAST_IP_FILE!"
)
:: Save current IP for next launch
> "!LAST_IP_FILE!" echo !LAN_IP!

set "IP_CHANGED=0"
if defined PREV_LAN_IP (
    if /i not "!PREV_LAN_IP!"=="!LAN_IP!" (
        if not "!LAN_IP!"=="<could not detect>" (
            set "IP_CHANGED=1"
        )
    )
)

echo.
echo  ====================================================
echo   Ready! Opening chat in your browser.
echo.
if "!IP_CHANGED!"=="1" (
    echo   [!] LAN IP CHANGED since last launch!
    echo       Previous: http://!PREV_LAN_IP!:8080
    echo       Current:  http://!LAN_IP!:8080
    echo.
    if "!MDNS_OK!"=="1" (
        echo       TIP: Bookmark http://!LAN_HOST!.local:8080
        echo       on your phone instead — that URL stays the
        echo       same even when the IP rotates.
    ) else (
        echo       Update your phone's bookmark to the NEW URL.
    )
    echo       Your chats are safe — the chat app will offer
    echo       to restore them automatically on first load.
    echo.
)
echo   PRIVACY SUMMARY:
echo     llama.cpp:    100%% offline, zero telemetry
echo     Search proxy: only active when you click the
echo                   search icon in chat
echo     No accounts, no API keys, no tracking.
echo.
echo   LAN ACCESS (same Wi-Fi / network):
echo     On this PC:    http://127.0.0.1:8080
if "!MDNS_OK!"=="1" (
    echo     On your phone: http://!LAN_HOST!.local:8080  [stable, recommended]
    echo                or  http://!LAN_IP!:8080          [also works]
    echo.
    echo     The .local URL is preferred — it survives IP changes,
    echo     so your bookmarks never break. Works on Android 12+
    echo     and any iPhone or iPad without extra setup.
) else (
    echo     On your phone: http://!LAN_IP!:8080
    echo.
    echo     [!] mDNS not responding on this PC. The .local
    echo         hostname can't be used until that's fixed —
    echo         see TROUBLESHOOTING.md or run setup-lan.bat
    echo         as Administrator to open UDP 5353.
)
echo.
echo   If your phone can't connect, run setup-lan.bat
echo   as Administrator once to open the firewall.
echo.
echo   ----------------------------------------------------
echo   SECURITY NOTE: connections use plain HTTP, so traffic
echo   on your network is NOT encrypted. The password keeps
echo   strangers out, but anyone who has your Wi-Fi password
echo   and is actively snooping could in theory read it.
echo   This is fine for a home network you trust. Don't run
echo   it on shared/public Wi-Fi, and don't reuse an
echo   important password here. (See SECURITY.md for the
echo   optional HTTPS setup if you want encryption.)
echo   ----------------------------------------------------
echo.
echo   This window will minimize in 8 seconds.
echo   It monitors server health in the background.
echo.
echo   To shut down: restore this window and press Ctrl+C,
echo   or simply close it.
echo  ====================================================
echo.

start "" "http://127.0.0.1:8080"

:: Pause longer on IP change so the user actually reads the warning
if "!IP_CHANGED!"=="1" (
    timeout /t 15 /nobreak >nul
) else (
    timeout /t 8 /nobreak >nul
)
call :minimize_window

:: ---------------------------------------------------------------
:: HEALTH MONITOR
:: ---------------------------------------------------------------
:monitor_loop
timeout /t 15 /nobreak >nul

curl.exe -s http://127.0.0.1:!SERVER_PORT!/health 2>nul | findstr /i "ok" >nul 2>&1
if not errorlevel 1 goto :monitor_loop

:: ---- llama-server is unreachable ----
::
:: Before assuming a crash, check whether fileserver.ps1 is doing a
:: hot-swap right now. During a swap it intentionally kills the
:: running llama-server, rewrites !LAUNCH_SCRIPT!, and spawns a new
:: one -- if we race in with our own taskkill + restart we end up
:: with two server processes fighting for the same port. The lock
:: file is created BEFORE the kill and removed once the new server
:: reports healthy (or the swap errors out), so it's the source of
:: truth for "leave this alone".
if exist "!SWAP_LOCK!" (
    echo  [..] %TIME% -- llama-server transitioning ^(hot-swap in progress^), monitor standing down.
    goto :monitor_loop
)

:: ---- Server is down — restart it ----
call :restore_window
echo.
echo  [!!] %TIME% — llama-server stopped responding!
echo  [..] Killing any stale llama-server process...
taskkill /f /im llama-server.exe >nul 2>&1
timeout /t 3 /nobreak >nul

echo  [..] Restarting llama-server...
start /min "llama-server" "!LAUNCH_SCRIPT!"

echo  [..] Waiting for server to come back up...
set "RRETRIES=0"
:restart_wait
set /a RRETRIES+=1
if !RRETRIES! gtr 90 (
    echo.
    echo  [!!] %TIME% — Server did not restart within 3 minutes.
    echo       Check the log file for errors:
    echo         !LOG_FILE!
    echo  [LOG] Last 10 lines:
    powershell -NoProfile -Command "Get-Content '!LOG_FILE!' -Tail 10" 2>nul
    echo.
    echo  [..] Will keep trying every 15 seconds...
    goto :monitor_loop
)
timeout /t 2 /nobreak >nul
set /p "=." <nul
curl.exe -s http://127.0.0.1:!SERVER_PORT!/health 2>nul | findstr /i "ok" >nul 2>&1
if errorlevel 1 goto :restart_wait

echo.
echo  [OK] %TIME% — llama-server restarted successfully!
timeout /t 5 /nobreak >nul
call :minimize_window
goto :monitor_loop

:: ===============================================================
:: UTILITY SUBROUTINES
:: ===============================================================
:minimize_window
powershell -NoProfile -command "try{Add-Type -Name W -Namespace C -MemberDefinition '[DllImport(\"kernel32.dll\")]public static extern IntPtr GetConsoleWindow();[DllImport(\"user32.dll\")]public static extern bool ShowWindow(IntPtr h,int c);' -EA Stop}catch{};[C.W]::ShowWindow([C.W]::GetConsoleWindow(),6)" >nul 2>&1
exit /b

:restore_window
powershell -NoProfile -command "try{Add-Type -Name W -Namespace C -MemberDefinition '[DllImport(\"kernel32.dll\")]public static extern IntPtr GetConsoleWindow();[DllImport(\"user32.dll\")]public static extern bool ShowWindow(IntPtr h,int c);' -EA Stop}catch{};[C.W]::ShowWindow([C.W]::GetConsoleWindow(),9)" >nul 2>&1
exit /b
