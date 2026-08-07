# ===============================================================
# hardware-probe.ps1   (schema 2)
#
# Detects GPU / CPU / RAM / free-disk and writes hardware.json
# next to itself. Consumed by launch.bat's menu generator to
# filter the model catalog to entries that will actually fit.
#
# ---------------------------------------------------------------
# WHY THIS WAS REWRITTEN (read before "simplifying" it again)
#
# v1 was a first-hit-wins chain: nvidia-smi -> registry -> dxdiag.
# On an NVIDIA dev box layer 1 always wins, so layers 2-4 were
# effectively never executed and shipped broken:
#
#   * FLOOR BUG (hit EVERY machine, including NVIDIA).
#     v1 did floor(bytes / 1GB). A nominal 16 GB card reports
#     16368 MiB -> 15. launch.bat then tests `vram_gb >= 16`,
#     which no real 16 GB card could ever satisfy. 8 GB cards
#     reported 7, a 12 GB RTX 4070 reported 11. Every GPU got
#     recommended one tier too small. Capacity is now reported
#     NOMINALLY (rounded), while free disk stays floored.
#
#   * dxdiag returned ~1.6 MILLION GB.
#     v1 concatenated two XML fields, "16368 MB" + "32665 MB",
#     stripped non-digits, and parsed "1636832665" as MiB. Any
#     non-NVIDIA machine that fell through to dxdiag was told it
#     had 1,598,469 GB of VRAM and offered the largest model in
#     the catalog.
#
#   * $ErrorActionPreference = 'Stop' with unguarded code in MAIN.
#     One hiccup anywhere (unwritable folder, odd registry value,
#     missing WMI) aborted the script with no hardware.json at
#     all -- which is the "no suggestion at all" symptom.
#
#   * [uint64] casts threw on negative values. Several WMI and
#     registry memory fields surface as a NEGATIVE int32 for any
#     card over 2 GB. [uint64]-2147483648 is a terminating error,
#     not a 0, so the registry layer died and fell through to the
#     broken dxdiag layer.
#
#   * dxdiag was launched with Start-Process -Wait and NO timeout.
#     A hung dxdiag hung launch.bat forever, with the console
#     sitting on "Checking your hardware...".
#
#   * No Win32_VideoController layer, and no fallback for RAM /
#     disk / CPU when the WMI repository is broken (common on
#     older consumer installs).
#
# ---------------------------------------------------------------
# HOW v2 WORKS: gather evidence, then reconcile.
#
# Every layer runs (cheap ones first) and contributes CANDIDATE
# adapter records. Nothing is trusted blindly: each value is
# sanity-clamped (0.25-256 GB) and tagged with the source's
# reliability rank. Then Merge-GpuEvidence picks a winner and
# records which sources agreed. A single bad layer can no longer
# poison the result, and disagreements are logged rather than
# silently resolved.
#
#   RANK  LAYER          WHY
#   100   llama.cpp      `llama-server.exe --list-devices` is the
#                        actual backend that will run the model.
#                        Vendor-neutral (Vulkan + CUDA), and its
#                        stderr exposes `uma: 0|1`, the definitive
#                        integrated-vs-discrete signal.
#    90   nvidia-smi     exact, NVIDIA only. Now also probed at
#                        its known install paths, not just PATH.
#    70   registry       qwMemorySize. Covers AMD/Intel/NVIDIA.
#                        Now decodes REG_QWORD, REG_BINARY and
#                        negative-int32 forms without throwing.
#    40   CIM/WMI        Win32_VideoController. Always names the
#                        adapter; AdapterRAM is a uint32 so it
#                        CAPS AT 4 GB -- used as a floor only.
#    30   dxdiag         last resort, timeout-guarded, parses
#                        DedicatedMemory only, unit-aware.
#
# Integrated GPUs are detected and handled separately: an iGPU
# reporting "29696 MiB" is quoting a shared system-RAM heap, not
# dedicated VRAM, and must not be sold a 26B model.
#
# ---------------------------------------------------------------
# OUTPUT SCHEMA (hardware.json)
#
# Every schema-1 field is still present, same name, same type, so
# the existing launch.bat parser keeps working untouched. New
# fields are additive.
#
#   {
#     "schema_version": 2,
#     "probed_at": "<iso8601>",
#     "probe_ms": 1840,
#     "gpu": {
#       "name":             "AMD Radeon RX 7800 XT",
#       "vendor":           "nvidia" | "amd" | "intel" | "unknown",
#       "vram_gb":          16,        <- NOMINAL, safe to compare
#       "vram_bytes":       17163091968,
#       "vram_mib":         16368,     <- NEW, exact
#       "detection_method": "llama.cpp" | "nvidia-smi" | "registry" |
#                           "cim" | "dxdiag" | "none",
#       "is_integrated":    false,     <- NEW
#       "shared_gb":        0,         <- NEW
#       "sources":          ["llama.cpp","registry"],
#       "confidence":       "high" | "medium" | "low"
#     },
#     "gpus": [ ... every adapter seen ... ],
#     "ram_gb":   32,
#     "ram_bytes": 34359738368,
#     "ram_source": "Win32_PhysicalMemory",
#     "disk": {
#       "models_drive": "C:", "free_gb": 423,
#       "free_bytes": 454116933632, "known": true
#     },
#     "cpu": { "name": "AMD Ryzen 7 7800X3D", "cores": 8, "logical": 16 },
#     "is_virtualized":   false,
#     "recommended_tier": "small" | "medium" | "large" | "cpu_only",
#     "usable_budget_gb": 16,          <- NEW, what a model may occupy
#     "budget_source":    "gpu" | "shared" | "ram",
#     "cpu_ram_tier":     "small",     <- NEW, tier if run on CPU
#     "warnings": ["..."],
#     "warning_count": 0,
#     "probe_log": ["llama.cpp: ok, 1 device(s)", "dxdiag: skipped"]
#   }
#
# recommended_tier keeps its exact v1 meaning (GPU-driven, and
# cpu_only still means "no usable GPU offload") so launch.bat's
# existing markers do not change behaviour. usable_budget_gb is
# the improved number to switch to when you're ready.
#
# EXIT CODES:
#   0 = a usable hardware.json was written (a machine with no GPU
#       is a SUCCESS: cpu_only is a real answer)
#   1 = could not write the file anywhere at all
#
# USAGE:
#   powershell -NoProfile -ExecutionPolicy Bypass -File hardware-probe.ps1
#   ... -File hardware-probe.ps1 -Quiet
#   ... -File hardware-probe.ps1 -LlamaServer "C:\...\llama-server.exe"
#   ... -File hardware-probe.ps1 -EmitEnv ".hw-parsed.env"
#   ... -File hardware-probe.ps1 -SelfTest      (no hardware needed)
#
# Windows PowerShell 5.1 compatible (Win10 1607+ / Win11, stock).
# No .NET compilation, no external modules, no admin rights.
# ===============================================================

[CmdletBinding()]
param(
    # Where to write hardware.json. Falls back to LOCALAPPDATA then
    # TEMP if this path is not writable (Program Files, read-only
    # share, OneDrive lock, SmartScreen-quarantined extract...).
    [string]$OutputPath,

    # Drive that holds models\ -- may be a junction to another disk.
    [string]$ModelsDir,

    # Path to llama-server.exe. launch.bat should pass !SERVER_EXE!.
    # Left empty, we look under .\llama-cpp\.
    [string]$LlamaServer,

    # Optional: also write KEY=VALUE lines here for launch.bat to
    # read with for/f, so it needs no inline PowerShell JSON parser.
    [string]$EmitEnv,

    # Per-external-tool timeout. Nothing may hang the launcher.
    [int]$TimeoutSec = 12,

    [switch]$Quiet,
    [switch]$NoLlama,
    [switch]$NoDxdiag,
    [switch]$SelfTest
)

# CRITICAL: 'Continue', not 'Stop'. A probe is a best-effort
# reporter -- it must degrade field by field, never abort. Each
# risky operation gets its own try/catch instead.
$ErrorActionPreference = 'Continue'
$ProgressPreference    = 'SilentlyContinue'   # keeps output clean

$script:StartedAt  = Get-Date
$script:ProbeLog   = New-Object System.Collections.ArrayList
$script:Warnings   = New-Object System.Collections.ArrayList

# Resolve script directory without relying on $PSScriptRoot being
# populated (it is empty when dot-sourced or piped, and v1's param
# defaults threw in exactly that case).
$script:HereDir = $PSScriptRoot
if (-not $script:HereDir) {
    if ($MyInvocation.MyCommand.Path) {
        $script:HereDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    }
}
if (-not $script:HereDir) { $script:HereDir = (Get-Location).Path }

if (-not $OutputPath) { $OutputPath = Join-Path $script:HereDir 'hardware.json' }
if (-not $ModelsDir)  { $ModelsDir  = Join-Path $script:HereDir 'models' }

# ---------------------------------------------------------------
# STATUS OUTPUT -- matches launch.bat / setup-lan.bat style
# ---------------------------------------------------------------
function Write-Status($msg) { if (-not $Quiet) { Write-Host "  [..] $msg" } }
function Write-Ok($msg)     { if (-not $Quiet) { Write-Host "  [OK] $msg" -ForegroundColor Green } }
function Write-Warn($msg)   { if (-not $Quiet) { Write-Host "  [!!] $msg" -ForegroundColor Yellow } }
function Write-Err($msg)    { Write-Host "  [ERROR] $msg" -ForegroundColor Red }

function Add-Log([string]$msg) {
    # .NET exception text is often several lines with a "Check the
    # spelling of the name..." tail. Keep the first line only, capped,
    # so probe_log stays skimmable when a user pastes it in a report.
    $one = ([string]$msg) -split "`r?`n" | Select-Object -First 1
    $one = ($one -replace '\s+', ' ').Trim()
    if ($one.Length -gt 180) { $one = $one.Substring(0, 177) + '...' }
    [void]$script:ProbeLog.Add($one)
    Write-Verbose $msg
}
function Add-ProbeWarning([string]$msg) {
    if (-not $script:Warnings.Contains($msg)) { [void]$script:Warnings.Add($msg) }
}

# ---------------------------------------------------------------
# Invoke-Safe -- run a scriptblock, swallow ANY failure, log it.
#
# This is the single most important change from v1. Every layer is
# wrapped, so a broken WMI repository or a hostile registry value
# costs us one field instead of the whole file.
# ---------------------------------------------------------------
function Invoke-Safe {
    param([string]$Label, [scriptblock]$Body, $Default = $null)
    try {
        return & $Body
    } catch {
        Add-Log ("{0}: FAILED -- {1}" -f $Label, $_.Exception.Message)
        return $Default
    }
}

# ===============================================================
# UNIT CONVERSION
#
# v1 had one helper that floored everything. Capacity and free
# space need OPPOSITE rounding:
#
#   CAPACITY (VRAM, RAM) -> round to NOMINAL size.
#     Hardware never reports its full marketing number: a 16 GB
#     card exposes 16368 MiB (16368/1024 = 15.98) because the
#     driver reserves a slice, and Win32 RAM totals exclude
#     hardware-reserved pages. Flooring turns every "16 GB" into
#     15 and breaks every >= threshold downstream. We round, but
#     only across a small gap, so a genuine 15.2 GB oddity is not
#     inflated into 16.
#
#   FREE SPACE (disk) -> floor.
#     Never promise room that is not there.
# ===============================================================

# Round a VRAM capacity to its nominal GB by snapping to the
# nearest standard card size within a TIGHT 2.5% tolerance.
#
# Snapping to standard sizes beats "round up if the fraction is big
# enough", because the shortfall is not uniform across cards:
#   RTX 4090   24564 MiB -> 23.99 GiB  (0.05% short)
#   RX 7800XT  16368 MiB -> 15.98 GiB  (0.10% short)
#   Arc A770   16256 MiB -> 15.88 GiB  (0.78% short)
# A fixed fractional gap either misses the A770 or starts rounding
# genuinely odd sizes up. Measured against the nominal capacity,
# all three are comfortably inside 2.5%, while a real 15.2 GB
# oddity is 4.9% short and correctly stays at 15.
$script:StandardVramGB = @(1,2,3,4,5,6,8,10,11,12,14,16,20,24,32,40,48,64,80,96,128,141,192,256)

function ConvertTo-NominalGB([uint64]$bytes) {
    if ($bytes -eq 0) { return 0 }
    $exact = [double]$bytes / 1GB
    foreach ($std in $script:StandardVramGB) {
        if ($std -lt $exact) { continue }
        if ((($std - $exact) / $std) -le 0.025) { return [int]$std }
        break
    }
    return [int][math]::Floor($exact)
}

function ConvertTo-FloorGB([uint64]$bytes) {
    if ($bytes -eq 0) { return 0 }
    return [int][math]::Floor([double]$bytes / 1GB)
}

# RAM needs a LOOSER snap than VRAM, and gets its own function.
#
# A GPU reports within ~0.2% of its nominal size (16368 of 16384
# MiB), so the tight 6% gap above is right for VRAM. System RAM
# totals are different: Windows subtracts hardware-reserved pages,
# and on an APU the iGPU carve-out can be a whole gigabyte, so a
# 16 GB machine legitimately reports 15.2-15.95 GiB.
#
# Rather than widen the generic threshold (which would start
# inflating real VRAM values), snap to the nearest STANDARD memory
# total at or above the measured figure. Installed RAM only ever
# comes in these steps, so this is a safe inference rather than a
# guess -- and it keeps `ram_gb` comparable to the round numbers
# users read off Task Manager.
$script:StandardRamGB = @(1,2,3,4,6,8,10,12,16,20,24,32,40,48,64,96,128,192,256,384,512,768,1024)

function ConvertTo-NominalRamGB([uint64]$bytes) {
    if ($bytes -eq 0) { return 0 }
    $exact = [double]$bytes / 1GB
    foreach ($std in $script:StandardRamGB) {
        if ($std -lt $exact) { continue }
        if ((($std - $exact) / $std) -le 0.08) { return [int]$std }
        break
    }
    return [int][math]::Floor($exact)
}

function ConvertTo-Mib([uint64]$bytes) {
    if ($bytes -eq 0) { return 0 }
    return [int][math]::Round([double]$bytes / 1MB, 0)
}

# ---------------------------------------------------------------
# ConvertTo-UInt64Safe -- the cast that v1 died on.
#
# Memory sizes arrive as: uint64, int64, a NEGATIVE int32 (uint32
# reinterpreted -- anything over 2 GB), a byte[] (REG_BINARY, 4 or
# 8 bytes little-endian), or a decimal string. [uint64]$x throws on
# the negative case, which is why v1's registry layer collapsed on
# machines with a card larger than 2 GB.
# ---------------------------------------------------------------
function ConvertTo-UInt64Safe($value) {
    if ($null -eq $value) { return [uint64]0 }
    try {
        if ($value -is [byte[]]) {
            if ($value.Length -ge 8) { return [BitConverter]::ToUInt64($value, 0) }
            if ($value.Length -ge 4) { return [uint64][BitConverter]::ToUInt32($value, 0) }
            if ($value.Length -ge 2) { return [uint64][BitConverter]::ToUInt16($value, 0) }
            return [uint64]0
        }
        if ($value -is [string]) {
            $parsed = [uint64]0
            if ([uint64]::TryParse($value.Trim(), [ref]$parsed)) { return $parsed }
            return [uint64]0
        }
        # Numeric. Negative means a uint32/uint64 came back signed;
        # reinterpret the bits rather than throwing.
        $d = [double]$value
        if ($d -lt 0) {
            $i64 = [int64]$value
            if ($i64 -ge -2147483648L) {
                return [uint64][BitConverter]::ToUInt32([BitConverter]::GetBytes([int32]$i64), 0)
            }
            return [BitConverter]::ToUInt64([BitConverter]::GetBytes($i64), 0)
        }
        if ($d -gt 1.8e19) { return [uint64]0 }
        return [uint64]$value
    } catch {
        return [uint64]0
    }
}

# ---------------------------------------------------------------
# SANITY CLAMP -- the guard that would have caught the dxdiag bug.
#
# No consumer or workstation GPU has less than 256 MB or more than
# 256 GB of memory. A source reporting outside that band is lying
# (bad parse, truncated field, synthetic adapter) and is discarded
# with a log entry instead of being averaged in.
# ---------------------------------------------------------------
$script:VramMinBytes = [uint64]256MB
$script:VramMaxBytes = [uint64]256GB

function Test-CredibleVram([uint64]$bytes) {
    return ($bytes -ge $script:VramMinBytes -and $bytes -le $script:VramMaxBytes)
}

# ---------------------------------------------------------------
# ASCII SANITISE
#
# GPU names carry (R), (TM) and, on localised Windows, Cyrillic or
# CJK. Those flow into hardware.json and into the KEY=VALUE file
# that launch.bat reads with for/f under whatever console codepage
# the user has. Non-ASCII there produces mojibake at best and a
# broken parse at worst, so names are folded to ASCII.
# ---------------------------------------------------------------
function ConvertTo-SafeAscii([string]$s) {
    if (-not $s) { return '' }
    $t = $s -replace '\(R\)', '' -replace '\(TM\)', '' -replace '\(C\)', ''
    $t = $t -replace '[^\x20-\x7E]', ''      # drop non-printable-ASCII
    $t = $t -replace '["\\]', ''             # keep JSON trivially safe
    $t = ($t -replace '\s+', ' ').Trim()
    if ($t.Length -gt 96) { $t = $t.Substring(0, 96).Trim() }
    return $t
}

# ---------------------------------------------------------------
# VENDOR + INTEGRATED CLASSIFICATION
# ---------------------------------------------------------------
function Get-GpuVendor([string]$name) {
    if (-not $name) { return 'unknown' }
    if ($name -match '(?i)NVIDIA|GeForce|Quadro|\bRTX\b|\bGTX\b|\bTesla\b|TITAN') { return 'nvidia' }
    if ($name -match '(?i)\bAMD\b|Radeon|\bRX\s?\d|RADV|Advanced Micro')          { return 'amd' }
    if ($name -match '(?i)\bIntel\b|\bArc\b|UHD Graphics|Iris|HD Graphics')       { return 'intel' }
    if ($name -match '(?i)Apple|\bMali\b|Adreno|Qualcomm')                        { return 'other' }
    return 'unknown'
}

# Is this adapter an integrated / unified-memory GPU?
#
# This matters more than it looks. On an iGPU the "total memory"
# every API reports is a SHARED system-RAM heap: llama.cpp says
# "AMD Radeon 780M Graphics (29696 MiB, 28598 MiB free)" on a
# 32 GB laptop. Treating 29 GB as dedicated VRAM would offer that
# laptop the 26B model. Three independent signals, any one is enough:
#
#   1. the model name is a known integrated part
#   2. llama.cpp's Vulkan line said `uma: 1`  (authoritative)
#   3. reported memory is an implausible share of system RAM
#
# Name matching is vendor-gated on purpose: "760M" is an AMD iGPU
# but also an ancient NVIDIA discrete mobile chip.
function Test-LooksIntegrated {
    param([string]$Name, [uint64]$TotalBytes, [uint64]$RamBytes, $Uma = $null)

    if ($null -ne $Uma) { return [bool]$Uma }          # signal 2 wins outright
    if (-not $Name) { return $false }

    $vendor = Get-GpuVendor $Name

    # Strip the trademark markers FIRST. Without this, "Intel(R)
    # Arc(TM) Graphics" never matches /Arc\s*Graphics/ because the
    # literal "(TM) " sits between the two words -- which is exactly
    # how Windows names every Intel adapter.
    $n = $Name -replace '(?i)\((R|TM|C)\)', ' '
    $n = ($n -replace '\s+', ' ').Trim()

    # Vendor-neutral integrated markers.
    if ($n -match '(?i)UHD Graphics|\bHD Graphics\b|\bIris\b|Vega \d+ Graphics|Microsoft Basic|Adreno|\bMali\b') { return $true }

    if ($vendor -eq 'intel') {
        # Meteor Lake "Arc Graphics" and Lunar Lake "Arc 140V" are
        # integrated; discrete Arc always carries an A### or B###
        # model number, so requiring bare "Arc Graphics" separates them.
        if ($n -match '(?i)Intel\s+Graphics')  { return $true }
        if ($n -match '(?i)Arc\s+Graphics')    { return $true }
        if ($n -match '(?i)Arc\s+\d{3}V')      { return $true }
    }
    if ($vendor -eq 'amd') {
        if ($n -match '(?i)Radeon\s+Graphics\s*$') { return $true }
        if ($n -match '(?i)\b[6-9]\d{2}M\b')      { return $true }  # 680M/780M/890M
        if ($n -match '(?i)Radeon\s*8\d{3}S')      { return $true }  # Strix Halo
        if ($n -match '(?i)RADV\s*(PHOENIX|REMBRANDT|RAPHAEL|VANGOGH|RENOIR|CEZANNE|STRIX)') { return $true }
    }

    # Signal 3: nothing discrete carries most of your system RAM.
    if ($RamBytes -gt 0 -and $TotalBytes -gt 0) {
        if (($TotalBytes / [double]$RamBytes) -ge 0.80) { return $true }
    }
    return $false
}

# ===============================================================
# PURE PARSERS
#
# Split out from the collectors so -SelfTest can exercise them on
# fixtures with no hardware present. This is how we avoid shipping
# another layer that only ever ran on one machine.
# ===============================================================

# ---------------------------------------------------------------
# llama.cpp `--list-devices`
#
#   Available devices:
#     Vulkan0: AMD Radeon RX 7900 XT (20464 MiB, 20464 MiB free)
#     Vulkan1: Intel(R) Graphics (ARL) (11577 MiB, 8251 MiB free)
#     CUDA0: NVIDIA GeForce RTX 5060 (7708 MiB, 7573 MiB free)
#
# GOTCHA: device names contain their own parentheses -- "Intel(R)",
# "(RADV PHOENIX)". A greedy \((.+)\) grabs the wrong pair. We
# anchor the memory group to end-of-line and keep the name lazy.
#
# stderr additionally carries, per device:
#   ggml_vulkan: 0 = Radeon 8060S Graphics (radv) | uma: 1 | fp16: 1
# `uma` is the definitive integrated flag, so we harvest it too.
# ---------------------------------------------------------------
function ConvertFrom-LlamaDeviceList {
    param([string]$StdOut, [string]$StdErr)

    $devices = @()
    $umaByIndex = @{}

    foreach ($line in ([string]$StdErr -split "`r?`n")) {
        if ($line -match '^\s*ggml_vulkan:\s*(?<idx>\d+)\s*=\s*(?<name>.+?)\s*\|\s*uma:\s*(?<uma>[01])') {
            $umaByIndex[('Vulkan' + $Matches['idx'])] = [bool][int]$Matches['uma']
        }
    }

    $both = (([string]$StdOut) + "`n" + ([string]$StdErr)) -split "`r?`n"
    foreach ($line in $both) {
        if ($line -notmatch '(?i)MiB\s*free\s*\)\s*$') { continue }
        if ($line -match '^\s*(?<dev>[A-Za-z][A-Za-z0-9]*\d)\s*:\s*(?<name>.+?)\s*\(\s*(?<total>\d+)\s*MiB\s*,\s*(?<free>\d+)\s*MiB\s+free\s*\)\s*$') {
            $dev  = $Matches['dev']
            $name = $Matches['name']
            $tot  = [uint64]$Matches['total'] * 1MB
            $fre  = [uint64]$Matches['free']  * 1MB
            if ($dev -match '(?i)^CPU') { continue }   # not a GPU device

            $uma = $null
            if ($umaByIndex.ContainsKey($dev)) { $uma = $umaByIndex[$dev] }

            $devices += [pscustomobject]@{
                Device     = $dev
                Name       = $name
                TotalBytes = $tot
                FreeBytes  = $fre
                Uma        = $uma
            }
        }
    }
    return $devices
}

# ---------------------------------------------------------------
# nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits
#   "NVIDIA GeForce RTX 4090, 24564"
# memory.total is MiB. Older/vGPU drivers can emit "[N/A]".
# Names may themselves contain a comma, so split on the LAST one.
# ---------------------------------------------------------------
function ConvertFrom-NvidiaSmiCsv {
    param([string]$Text)

    $out = @()
    foreach ($line in ([string]$Text -split "`r?`n")) {
        $l = $line.Trim()
        if (-not $l) { continue }
        $idx = $l.LastIndexOf(',')
        if ($idx -lt 1) { continue }
        $name = $l.Substring(0, $idx).Trim()
        $mem  = $l.Substring($idx + 1).Trim()
        $mib  = 0
        if (-not [int]::TryParse($mem, [ref]$mib)) { continue }   # skips [N/A]
        if ($mib -le 0) { continue }
        $out += [pscustomobject]@{
            Name       = $name
            TotalBytes = [uint64]$mib * 1MB
        }
    }
    return $out
}

# ---------------------------------------------------------------
# dxdiag /x XML
#
# THE v1 BUG LIVED HERE. dxdiag emits BOTH fields:
#   <DedicatedMemory>16368 MB</DedicatedMemory>   <- real VRAM
#   <SharedMemory>16297 MB</SharedMemory>
#   <DisplayMemory>32665 MB</DisplayMemory>       <- dedicated+shared
# v1 concatenated Dedicated+Display, stripped non-digits, and read
# "1636832665" as MiB: 1,598,469 GB.
#
# v2 reads DedicatedMemory only, parses ONE number with its unit,
# keeps DisplayMemory aside as the shared figure, and lets the
# sanity clamp reject anything absurd.
# ---------------------------------------------------------------
function ConvertFrom-DxdiagMemoryString {
    param([string]$Text)
    if (-not $Text) { return [uint64]0 }
    if ($Text -notmatch '(?<num>\d+(?:[.,]\d+)?)\s*(?<unit>[KMGT]?i?B)?') { return [uint64]0 }
    $numText = $Matches['num'] -replace ',', '.'
    $unit    = $Matches['unit']
    $num = 0.0
    if (-not [double]::TryParse($numText,
              [System.Globalization.NumberStyles]::Float,
              [System.Globalization.CultureInfo]::InvariantCulture,
              [ref]$num)) { return [uint64]0 }
    if ($num -le 0) { return [uint64]0 }
    switch -Regex ($unit) {
        '(?i)^Gi?B$' { return [uint64]($num * 1GB) }
        '(?i)^Ti?B$' { return [uint64]($num * 1TB) }
        '(?i)^Ki?B$' { return [uint64]($num * 1KB) }
        default      { return [uint64]($num * 1MB) }   # dxdiag default is MB
    }
}

function ConvertFrom-DxdiagXml {
    param([xml]$Xml)

    $out = @()
    $nodes = @($Xml.DxDiag.DisplayDevices.DisplayDevice)
    foreach ($d in $nodes) {
        if (-not $d) { continue }
        $name = [string]$d.CardName
        if (-not $name) { continue }
        if ($name -match '(?i)Microsoft Basic|Remote Display') { continue }

        $dedicated = ConvertFrom-DxdiagMemoryString ([string]$d.DedicatedMemory)
        $display   = ConvertFrom-DxdiagMemoryString ([string]$d.DisplayMemory)
        $shared    = ConvertFrom-DxdiagMemoryString ([string]$d.SharedMemory)

        # Prefer dedicated. Only fall back to DisplayMemory when
        # dedicated is absent, and flag it as shared-inclusive.
        $total = $dedicated
        $isShared = $false
        if ($total -eq 0) { $total = $display; $isShared = ($total -gt 0) }
        if ($total -eq 0) { continue }

        $out += [pscustomobject]@{
            Name        = $name
            TotalBytes  = $total
            SharedBytes = $shared
            SharedOnly  = $isShared
        }
    }
    return $out
}

# ---------------------------------------------------------------
# Registry display-adapter memory.
#
# HKLM\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-...}\NNNN
#   HardwareInformation.qwMemorySize  REG_QWORD  -- modern, correct
#   HardwareInformation.MemorySize    REG_BINARY -- legacy, caps 4 GB
#
# Property lookup is done case-insensitively against the real
# property list because drivers are inconsistent about casing, and
# every value goes through ConvertTo-UInt64Safe so a REG_BINARY
# blob or a signed-negative DWORD cannot throw.
# ---------------------------------------------------------------
function Get-RegistryAdapterMemory {
    param($Props)

    if (-not $Props) { return [uint64]0 }
    $names = @($Props.PSObject.Properties.Name)

    $pick = { param($wanted)
        foreach ($n in $names) { if ($n -eq $wanted) { return $n } }
        foreach ($n in $names) { if ($n -like "*$wanted*") { return $n } }
        return $null
    }

    $qw = & $pick 'qwMemorySize'
    if ($qw) {
        $bytes = ConvertTo-UInt64Safe $Props.$qw
        if ($bytes -gt 0) { return $bytes }
    }
    $legacy = & $pick 'MemorySize'
    if ($legacy) {
        $bytes = ConvertTo-UInt64Safe $Props.$legacy
        if ($bytes -gt 0) { return $bytes }
    }
    return [uint64]0
}

# ===============================================================
# EXTERNAL TOOL RUNNER
#
# Every external call is timeout-guarded and killed on overrun.
# v1 used `Start-Process -Wait` for dxdiag with no timeout, so a
# hung dxdiag hung launch.bat indefinitely with the console parked
# on "Checking your hardware...".
#
# stdout/stderr go to temp FILES rather than pipes on purpose: a
# synchronous pipe read while waiting can deadlock when the child
# fills the buffer, and ggml prints a lot of banner text.
# ===============================================================
function Invoke-ToolCapture {
    param(
        [string]$FilePath,
        [string[]]$Arguments = @(),
        [int]$TimeoutSec = 12
    )

    $res = @{ Ran = $false; TimedOut = $false; ExitCode = -1; StdOut = ''; StdErr = '' }

    $tmpRoot = $env:TEMP
    if (-not $tmpRoot -or -not (Test-Path $tmpRoot)) { $tmpRoot = $script:HereDir }
    $stamp = "$PID-" + (Get-Random -Maximum 999999)
    $outFile = Join-Path $tmpRoot "hwprobe-$stamp.out"
    $errFile = Join-Path $tmpRoot "hwprobe-$stamp.err"

    try {
        $sp = @{
            FilePath               = $FilePath
            RedirectStandardOutput = $outFile
            RedirectStandardError  = $errFile
            PassThru               = $true
        }
        if ($Arguments -and $Arguments.Count -gt 0) { $sp['ArgumentList'] = $Arguments }

        # -WindowStyle Hidden stops a console window flashing on screen,
        # but it is an OPTIONAL nicety: some hosts reject the parameter
        # outright. Never let cosmetics decide whether the probe runs --
        # try it, and silently retry without it.
        $p = $null
        if (-not $script:NoWindowStyle) {
            $sp['WindowStyle'] = 'Hidden'
            try {
                $p = Start-Process @sp -ErrorAction Stop
            } catch {
                Add-Log 'Start-Process -WindowStyle unsupported here; retrying without it'
                $script:NoWindowStyle = $true
                $sp.Remove('WindowStyle')
            }
        }
        if (-not $p) { $p = Start-Process @sp -ErrorAction Stop }
        if (-not $p) { return $res }
        $res.Ran = $true

        # Poll HasExited rather than WaitForExit(): the latter has
        # handle-ownership quirks with -PassThru across PS versions.
        $deadline = (Get-Date).AddSeconds($TimeoutSec)
        while ((-not $p.HasExited) -and ((Get-Date) -lt $deadline)) {
            Start-Sleep -Milliseconds 150
        }
        if (-not $p.HasExited) {
            $res.TimedOut = $true
            try { $p.Kill() } catch { }
            Start-Sleep -Milliseconds 250
        } else {
            try { $res.ExitCode = $p.ExitCode } catch { }
        }

        Start-Sleep -Milliseconds 120     # let redirected handles flush
        if (Test-Path $outFile) { $res.StdOut = [string](Get-Content $outFile -Raw -ErrorAction SilentlyContinue) }
        if (Test-Path $errFile) { $res.StdErr = [string](Get-Content $errFile -Raw -ErrorAction SilentlyContinue) }
    } catch {
        Add-Log ("tool {0}: {1}" -f (Split-Path $FilePath -Leaf), $_.Exception.Message)
    } finally {
        Remove-Item $outFile, $errFile -Force -ErrorAction SilentlyContinue
    }
    return $res
}

# ===============================================================
# GPU COLLECTORS
#
# Each returns zero or more candidate records:
#   @{ Name; Vendor; TotalBytes; SharedBytes; Uma; Source; Rank; Capped }
# 'Capped' marks a source that saturates (Win32_VideoController's
# uint32 AdapterRAM) so the merge treats it as a floor, not a value.
# ===============================================================

function New-GpuCandidate {
    param(
        [string]$Name, [uint64]$TotalBytes, [string]$Source, [int]$Rank,
        [uint64]$SharedBytes = 0, $Uma = $null, [switch]$Capped
    )
    return [pscustomobject]@{
        Name        = ConvertTo-SafeAscii $Name
        RawName     = $Name
        Vendor      = Get-GpuVendor $Name
        TotalBytes  = $TotalBytes
        SharedBytes = $SharedBytes
        Uma         = $Uma
        Source      = $Source
        Rank        = $Rank
        Capped      = [bool]$Capped
    }
}

# --- LAYER 100: llama.cpp itself -------------------------------
#
# The highest-value layer for this project and the one v1 never
# had: it asks the exact backend that will run the model. Works
# for AMD, Intel and NVIDIA through one code path, needs no WMI,
# no registry and no driver utility. launch.bat reaches this
# probe only after :server_found, so llama-server.exe is present.
function Get-GpuFromLlama {
    param([string]$ServerExe)

    if ($NoLlama) { Add-Log 'llama.cpp: skipped (-NoLlama)'; return @() }

    $exe = $ServerExe
    if (-not $exe -or -not (Test-Path $exe)) {
        $guess = Join-Path $script:HereDir 'llama-cpp'
        if (Test-Path $guess) {
            $found = Get-ChildItem -Path $guess -Filter 'llama-server.exe' -Recurse -ErrorAction SilentlyContinue |
                     Select-Object -First 1
            if ($found) { $exe = $found.FullName }
        }
    }
    if (-not $exe -or -not (Test-Path $exe)) {
        Add-Log 'llama.cpp: skipped (llama-server.exe not found yet)'
        return @()
    }

    Write-Status 'Asking llama.cpp which devices it can see...'
    $r = Invoke-ToolCapture -FilePath $exe -Arguments @('--list-devices') -TimeoutSec $TimeoutSec
    if ($r.TimedOut) {
        Add-Log 'llama.cpp: TIMED OUT (killed) -- possible bad/hanging GPU driver'
        Add-ProbeWarning 'Querying the GPU through llama.cpp timed out. Your graphics driver may need updating; detection fell back to Windows.'
        return @()
    }
    if (-not $r.Ran) { Add-Log 'llama.cpp: could not start'; return @() }

    $devs = ConvertFrom-LlamaDeviceList -StdOut $r.StdOut -StdErr $r.StdErr
    if (-not $devs -or $devs.Count -eq 0) {
        Add-Log 'llama.cpp: ran but listed no GPU devices (CPU-only build or no Vulkan driver)'
        return @()
    }

    $out = @()
    foreach ($d in $devs) {
        $out += New-GpuCandidate -Name $d.Name -TotalBytes $d.TotalBytes `
                                 -Source 'llama.cpp' -Rank 100 -Uma $d.Uma
    }
    Add-Log ("llama.cpp: ok, {0} device(s)" -f $out.Count)
    return $out
}

# --- LAYER 90: nvidia-smi --------------------------------------
#
# v1 only checked PATH. Several driver packages install nvidia-smi
# somewhere else entirely, and a 32-bit PowerShell host has
# System32 redirected out from under it, so PATH lookup misses on
# machines that definitely have an NVIDIA card.
function Get-GpuFromNvidiaSmi {
    $paths = New-Object System.Collections.ArrayList
    $cmd = Get-Command 'nvidia-smi.exe' -ErrorAction SilentlyContinue
    if ($cmd) { [void]$paths.Add($cmd.Source) }
    # Join-Path THROWS on a null base, so build these by hand. Every
    # one of these locations ships nvidia-smi.exe on some driver
    # package; v1 only looked at PATH, which misses it entirely on a
    # 32-bit PowerShell host (System32 is redirected to SysWOW64).
    $roots = @()
    if ($env:SystemRoot)            { $roots += (($env:SystemRoot.TrimEnd('\')) + '\System32\nvidia-smi.exe') }
    if ($env:SystemRoot)            { $roots += (($env:SystemRoot.TrimEnd('\')) + '\Sysnative\nvidia-smi.exe') }
    if ($env:ProgramFiles)          { $roots += (($env:ProgramFiles.TrimEnd('\')) + '\NVIDIA Corporation\NVSMI\nvidia-smi.exe') }
    if (${env:ProgramFiles(x86)})   { $roots += ((${env:ProgramFiles(x86)}.TrimEnd('\')) + '\NVIDIA Corporation\NVSMI\nvidia-smi.exe') }
    foreach ($p in $roots) {
        if ($p -and (Test-Path $p) -and -not $paths.Contains($p)) { [void]$paths.Add($p) }
    }
    if ($paths.Count -eq 0) { Add-Log 'nvidia-smi: not present'; return @() }

    Write-Status 'Trying nvidia-smi...'
    foreach ($exe in $paths) {
        $r = Invoke-ToolCapture -FilePath $exe `
              -Arguments @('--query-gpu=name,memory.total', '--format=csv,noheader,nounits') `
              -TimeoutSec $TimeoutSec
        if ($r.TimedOut) { Add-Log 'nvidia-smi: TIMED OUT (killed)'; continue }
        if (-not $r.Ran) { continue }

        $rows = ConvertFrom-NvidiaSmiCsv -Text $r.StdOut
        if ($rows.Count -gt 0) {
            $out = @()
            foreach ($row in $rows) {
                $out += New-GpuCandidate -Name $row.Name -TotalBytes $row.TotalBytes `
                                         -Source 'nvidia-smi' -Rank 90 -Uma $false
            }
            Add-Log ("nvidia-smi: ok, {0} GPU(s)" -f $out.Count)
            return $out
        }
        Add-Log ("nvidia-smi: ran (exit {0}) but returned no parseable rows" -f $r.ExitCode)
    }
    return @()
}

# --- LAYER 70: registry qwMemorySize --------------------------
function Get-GpuFromRegistry {
    Write-Status 'Trying Windows registry...'
    $classKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}'
    if (-not (Test-Path $classKey)) { Add-Log 'registry: class key missing'; return @() }

    $out = @()
    $subkeys = @(Get-ChildItem $classKey -ErrorAction SilentlyContinue |
                 Where-Object { $_.PSChildName -match '^\d{4}$' })

    foreach ($sk in $subkeys) {
        # Per-key try/catch: one adapter with a hostile value must
        # not cost us the other adapters (v1 lost all of them).
        $cand = Invoke-Safe -Label ("registry[" + $sk.PSChildName + "]") -Body {
            $props = Get-ItemProperty $sk.PSPath -ErrorAction SilentlyContinue
            if (-not $props) { return $null }
            $desc = [string]$props.DriverDesc
            if (-not $desc) { return $null }
            if ($desc -match '(?i)Microsoft Basic|Remote Display|Hyper-V|RDP|Citrix|VMware SVGA|VirtualBox|Parsec|Mirror Driver|IddCx|Virtual Display') { return $null }

            $bytes = Get-RegistryAdapterMemory -Props $props
            if ($bytes -eq 0) { return $null }
            return New-GpuCandidate -Name $desc -TotalBytes $bytes -Source 'registry' -Rank 70
        }
        if ($cand) { $out += $cand }
    }

    if ($out.Count -eq 0) { Add-Log 'registry: no adapter reported a memory size' }
    else { Add-Log ("registry: ok, {0} adapter(s)" -f $out.Count) }
    return $out
}

# --- LAYER 40: Win32_VideoController --------------------------
#
# Missing entirely from v1, and the most universally available
# source of the adapter NAME.
#
# GOTCHA: AdapterRAM is a uint32, so it saturates at 4 GB and is
# frequently surfaced as a negative int32. It is recorded as
# 'Capped' and only ever used as a lower bound.
function Get-GpuFromCim {
    Write-Status 'Trying Windows video controller inventory...'

    $controllers = Invoke-Safe -Label 'cim:Win32_VideoController' -Default @() -Body {
        @(Get-CimInstance -ClassName Win32_VideoController -ErrorAction Stop)
    }
    if (-not $controllers -or $controllers.Count -eq 0) {
        $controllers = Invoke-Safe -Label 'wmi:Win32_VideoController' -Default @() -Body {
            @(Get-WmiObject -Class Win32_VideoController -ErrorAction Stop)
        }
    }
    if (-not $controllers -or $controllers.Count -eq 0) {
        Add-Log 'cim: Win32_VideoController unavailable (WMI may be broken)'
        return @()
    }

    $out = @()
    foreach ($c in $controllers) {
        $name = [string]$c.Name
        if (-not $name) { $name = [string]$c.Description }
        if (-not $name) { continue }
        if ($name -match '(?i)Microsoft Basic|Remote Display|RDP|Mirror Driver|IddCx|Virtual Display') { continue }

        $bytes = ConvertTo-UInt64Safe $c.AdapterRAM
        # 4294967295 / 4294967296 are the classic uint32 saturation
        # values -- treat them, and anything at-or-above 4 GB, as a
        # floor rather than a measurement.
        $capped = ($bytes -ge 4GB - 1MB)
        if ($bytes -eq 0) {
            # Still worth recording for the name/vendor and so a
            # machine with only an iGPU is not reported as GPU-less.
            $out += New-GpuCandidate -Name $name -TotalBytes 0 -Source 'cim' -Rank 40
            continue
        }
        $out += New-GpuCandidate -Name $name -TotalBytes $bytes -Source 'cim' -Rank 40 -Capped:$capped
    }
    Add-Log ("cim: ok, {0} controller(s)" -f $out.Count)
    return $out
}

# --- LAYER 30: dxdiag ------------------------------------------
function Get-GpuFromDxdiag {
    if ($NoDxdiag) { Add-Log 'dxdiag: skipped (-NoDxdiag)'; return @() }

    $dxexe = 'dxdiag.exe'
    if ($env:SystemRoot) {
        $abs = ($env:SystemRoot.TrimEnd('\')) + '\System32\dxdiag.exe'
        if (Test-Path $abs) { $dxexe = $abs }
    }

    Write-Status 'Trying dxdiag (a few seconds)...'
    $tmpRoot = $env:TEMP
    if (-not $tmpRoot -or -not (Test-Path $tmpRoot)) { $tmpRoot = $script:HereDir }
    $xmlPath = Join-Path $tmpRoot ("hwprobe-dxdiag-$PID.xml")
    Remove-Item $xmlPath -Force -ErrorAction SilentlyContinue

    $r = Invoke-ToolCapture -FilePath $dxexe -Arguments @('/whql:off', '/x', $xmlPath) -TimeoutSec $TimeoutSec
    if ($r.TimedOut) {
        Add-Log 'dxdiag: TIMED OUT (killed)'
        Remove-Item $xmlPath -Force -ErrorAction SilentlyContinue
        return @()
    }

    # dxdiag writes the XML asynchronously and can return before the
    # flush completes. Wait for the file to exist AND for its length
    # to stop changing -- parsing a half-written file just throws.
    $deadline = (Get-Date).AddSeconds(8)
    $lastLen = -1
    $stable = 0
    while ((Get-Date) -lt $deadline) {
        if (Test-Path $xmlPath) {
            $len = (Get-Item $xmlPath -ErrorAction SilentlyContinue).Length
            if ($len -gt 0 -and $len -eq $lastLen) { $stable++ } else { $stable = 0 }
            if ($stable -ge 2) { break }
            $lastLen = $len
        }
        Start-Sleep -Milliseconds 300
    }
    if (-not (Test-Path $xmlPath)) { Add-Log 'dxdiag: no XML produced'; return @() }

    $rows = Invoke-Safe -Label 'dxdiag:parse' -Default @() -Body {
        [xml]$dx = Get-Content $xmlPath -Raw -ErrorAction Stop
        ConvertFrom-DxdiagXml -Xml $dx
    }
    Remove-Item $xmlPath -Force -ErrorAction SilentlyContinue

    if (-not $rows -or $rows.Count -eq 0) { Add-Log 'dxdiag: parsed no usable adapters'; return @() }

    $out = @()
    foreach ($row in $rows) {
        $out += New-GpuCandidate -Name $row.Name -TotalBytes $row.TotalBytes `
                                 -SharedBytes $row.SharedBytes -Source 'dxdiag' -Rank 30
    }
    Add-Log ("dxdiag: ok, {0} adapter(s)" -f $out.Count)
    return $out
}

# ===============================================================
# EVIDENCE MERGE
#
# v1 was first-hit-wins, so one broken layer decided everything.
# Here every candidate is:
#   1. sanity-clamped   (silently dropping the 1.6-million-GB case)
#   2. grouped by adapter identity
#   3. resolved per adapter by source rank, with capped sources
#      only ever raising a floor
#   4. checked for cross-source disagreement, which is LOGGED
#
# Then we choose the primary adapter: the highest-memory DISCRETE
# one, because a mixed laptop (iGPU + dGPU) often reports a bigger
# number for the iGPU's shared heap than for the real card.
# ===============================================================
function Get-AdapterKey([string]$name) {
    if (-not $name) { return '?' }
    $k = $name.ToLowerInvariant()
    $k = $k -replace '\(r\)|\(tm\)|\(c\)', ''
    $k = $k -replace '\b(graphics|adapter|series|gpu|laptop)\b', ''
    $k = $k -replace '\(radv[^)]*\)', ''
    $k = $k -replace '[^a-z0-9]', ''
    if (-not $k) { return '?' }
    return $k
}

function Merge-GpuEvidence {
    param([array]$Candidates, [uint64]$RamBytes)

    $credible = @()
    foreach ($c in $Candidates) {
        if ($null -eq $c) { continue }
        if ($c.TotalBytes -eq 0) { $credible += $c; continue }   # name-only record
        if (-not (Test-CredibleVram $c.TotalBytes)) {
            Add-Log ("DISCARDED implausible value: {0} reported {1} bytes for '{2}'" -f `
                     $c.Source, $c.TotalBytes, $c.Name)
            Add-ProbeWarning ("Ignored an implausible VRAM reading from " + $c.Source + ".")
            continue
        }
        $credible += $c
    }
    if ($credible.Count -eq 0) { return $null }

    $groups = @{}
    foreach ($c in $credible) {
        $key = Get-AdapterKey $c.Name
        if (-not $groups.ContainsKey($key)) { $groups[$key] = @() }
        $groups[$key] += $c
    }

    $adapters = @()
    foreach ($key in $groups.Keys) {
        $members = @($groups[$key] | Sort-Object -Property Rank -Descending)
        $best = $members[0]

        # Authoritative value = highest-ranked source that is not
        # capped and actually reported something.
        $measured = @($members | Where-Object { -not $_.Capped -and $_.TotalBytes -gt 0 })
        $cappedOnly = ($measured.Count -eq 0 -and
                       @($members | Where-Object { $_.Capped }).Count -gt 0)
        $total = [uint64]0
        $method = 'none'
        $usedSources = @()
        if ($measured.Count -gt 0) {
            $total  = [uint64]$measured[0].TotalBytes
            $method = $measured[0].Source
        }
        # Capped sources can only raise a floor.
        foreach ($m in $members) {
            if ($m.Capped -and $m.TotalBytes -gt $total) {
                $total = [uint64]$m.TotalBytes
                if ($method -eq 'none') { $method = $m.Source }
            }
        }
        foreach ($m in $members) { if ($m.TotalBytes -gt 0) { $usedSources += $m.Source } }
        $usedSources = @($usedSources | Select-Object -Unique)

        # We identified the adapter but nothing could measure its
        # memory (typical for an iGPU whose AdapterRAM is 0). Say so
        # explicitly rather than reporting it as "no GPU found".
        if ($method -eq 'none') { $method = 'name-only' }

        # Disagreement check across measured sources.
        if ($measured.Count -ge 2) {
            $hi = ($measured | Measure-Object -Property TotalBytes -Maximum).Maximum
            $lo = ($measured | Measure-Object -Property TotalBytes -Minimum).Minimum
            if ($lo -gt 0 -and (($hi - $lo) / [double]$hi) -gt 0.25) {
                Add-Log ("sources disagree on '{0}': {1} .. {2} bytes -- trusting {3}" -f `
                         $best.Name, $lo, $hi, $method)
            }
        }

        # uma flag: prefer an explicit value from any source.
        $uma = $null
        foreach ($m in $members) { if ($null -ne $m.Uma) { $uma = $m.Uma; break } }

        $shared = [uint64]0
        foreach ($m in $members) { if ($m.SharedBytes -gt $shared) { $shared = $m.SharedBytes } }

        $isInt = Test-LooksIntegrated -Name $best.Name -TotalBytes $total -RamBytes $RamBytes -Uma $uma

        # An integrated adapter's "total" is a shared heap, not VRAM.
        if ($isInt -and $shared -eq 0) { $shared = $total }

        $conf = 'low'
        if ($method -eq 'llama.cpp' -or $method -eq 'nvidia-smi') { $conf = 'high' }
        elseif ($method -eq 'registry') { $conf = 'medium' }
        if ($usedSources.Count -ge 2 -and $conf -eq 'medium') { $conf = 'high' }

        $adapters += [pscustomobject]@{
            Name         = $best.Name
            Vendor       = $best.Vendor
            TotalBytes   = $total
            SharedBytes  = $shared
            IsIntegrated = $isInt
            CappedOnly   = [bool]$cappedOnly
            Method       = $method
            Sources      = $usedSources
            Confidence   = $conf
        }
    }

    if ($adapters.Count -eq 0) { return $null }

    # Primary = best discrete adapter; only fall back to integrated
    # if there is no discrete one at all.
    $discrete = @($adapters | Where-Object { -not $_.IsIntegrated -and $_.TotalBytes -gt 0 } |
                  Sort-Object -Property TotalBytes -Descending)
    if ($discrete.Count -gt 0) {
        return @{ Primary = $discrete[0]; All = $adapters }
    }
    $any = @($adapters | Sort-Object -Property TotalBytes -Descending)
    return @{ Primary = $any[0]; All = $adapters }
}

# ===============================================================
# SYSTEM RAM
#
# Five sources, in order. v1 had one, so a broken WMI repository
# (very common on long-lived consumer installs) silently produced
# ram_gb = 0.
#
# Win32_PhysicalMemory is FIRST because summing the DIMM capacities
# gives the true installed total. Win32_ComputerSystem's
# TotalPhysicalMemory excludes hardware-reserved pages and reads
# ~15.9 GB on a 16 GB machine -- which is exactly the kind of value
# v1's floor() turned into 15.
# ===============================================================
function Get-SystemRam {
    $attempts = @(
        @{ Label = 'Win32_PhysicalMemory'; Body = {
                $sticks = @(Get-CimInstance -ClassName Win32_PhysicalMemory -ErrorAction Stop)
                if ($sticks.Count -eq 0) { return [uint64]0 }
                $sum = [uint64]0
                foreach ($s in $sticks) { $sum += (ConvertTo-UInt64Safe $s.Capacity) }
                return $sum } },
        @{ Label = 'Win32_ComputerSystem'; Body = {
                ConvertTo-UInt64Safe (Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop).TotalPhysicalMemory } },
        @{ Label = 'Win32_OperatingSystem'; Body = {
                [uint64](ConvertTo-UInt64Safe (Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop).TotalVisibleMemorySize) * 1KB } },
        @{ Label = 'wmi:Win32_ComputerSystem'; Body = {
                ConvertTo-UInt64Safe (Get-WmiObject -Class Win32_ComputerSystem -ErrorAction Stop).TotalPhysicalMemory } },
        @{ Label = 'wmi:Win32_PhysicalMemory'; Body = {
                $sticks = @(Get-WmiObject -Class Win32_PhysicalMemory -ErrorAction Stop)
                $sum = [uint64]0
                foreach ($s in $sticks) { $sum += (ConvertTo-UInt64Safe $s.Capacity) }
                return $sum } }
    )

    foreach ($a in $attempts) {
        $bytes = Invoke-Safe -Label ("ram:" + $a.Label) -Default ([uint64]0) -Body $a.Body
        $bytes = ConvertTo-UInt64Safe $bytes
        # Reject nonsense: below 512 MB or above 4 TB is not a real total.
        if ($bytes -ge 512MB -and $bytes -le 4TB) {
            Add-Log ("ram: {0} -> {1} bytes" -f $a.Label, $bytes)
            return @{ bytes = $bytes; source = $a.Label }
        }
    }
    Add-Log 'ram: ALL sources failed'
    return @{ bytes = [uint64]0; source = 'unknown' }
}

# ===============================================================
# FREE DISK on the drive holding the models folder.
#
# System.IO.DriveInfo is tried first: it is plain .NET, needs no
# WMI, and handles mapped network drives. v1 went straight to
# Win32_LogicalDisk with a hand-built DeviceID filter, which
# produced the garbage filter "DeviceID='\\NAS\share:'" for a UNC
# models path and then reported 0 GB free -- triggering a bogus
# "Low free disk space" warning.
#
# 'known' distinguishes "genuinely almost full" from "could not
# measure", so we never warn about a number we do not have.
# ===============================================================
function Get-FreeDiskInfo {
    param([string]$modelsDir)

    $result = @{ drive = '?'; free_bytes = [uint64]0; free_gb = 0; known = $false }

    $probeDir = $modelsDir
    if (-not $probeDir) { $probeDir = $script:HereDir }
    if (-not (Test-Path $probeDir)) {
        $parent = Split-Path $probeDir -Parent
        if ($parent -and (Test-Path $parent)) { $probeDir = $parent } else { $probeDir = $script:HereDir }
    }

    $resolved = Invoke-Safe -Label 'disk:resolve' -Default $probeDir -Body {
        (Resolve-Path $probeDir -ErrorAction Stop).ProviderPath
    }

    if ($resolved -like '\\*') {
        # UNC share: no drive letter to query. Report unknown rather
        # than inventing a zero.
        $result.drive = 'UNC'
        Add-Log "disk: models path is a UNC share ($resolved) -- free space not measured"
        return $result
    }

    $root = Invoke-Safe -Label 'disk:root' -Default '' -Body {
        [System.IO.Path]::GetPathRoot($resolved)
    }
    if (-not $root) { Add-Log 'disk: could not determine path root'; return $result }

    # Normalise "C:\" -> "C:". Anything that is not a drive letter is
    # reported verbatim rather than having a colon bolted onto it.
    $letter = $root.TrimEnd('\')
    if ($letter -match '^([A-Za-z]):?$') { $letter = $Matches[1].ToUpperInvariant() + ':' }
    $result.drive = $letter

    # 1. .NET DriveInfo (no WMI dependency)
    $free = Invoke-Safe -Label 'disk:DriveInfo' -Default ([uint64]0) -Body {
        $di = New-Object System.IO.DriveInfo($root)
        if (-not $di.IsReady) { return [uint64]0 }
        return ConvertTo-UInt64Safe $di.AvailableFreeSpace
    }

    # 2. CIM fallback
    if ($free -eq 0) {
        $free = Invoke-Safe -Label 'disk:Win32_LogicalDisk' -Default ([uint64]0) -Body {
            $d = Get-CimInstance -ClassName Win32_LogicalDisk `
                                 -Filter ("DeviceID='" + $result.drive + "'") -ErrorAction Stop
            return ConvertTo-UInt64Safe $d.FreeSpace
        }
    }
    # 3. WMI fallback
    if ($free -eq 0) {
        $free = Invoke-Safe -Label 'disk:wmi' -Default ([uint64]0) -Body {
            $d = Get-WmiObject -Class Win32_LogicalDisk `
                               -Filter ("DeviceID='" + $result.drive + "'") -ErrorAction Stop
            return ConvertTo-UInt64Safe $d.FreeSpace
        }
    }

    if ($free -gt 0) {
        $result.free_bytes = $free
        $result.free_gb    = ConvertTo-FloorGB $free      # floor: never over-promise
        $result.known      = $true
        Add-Log ("disk: {0} has {1} GB free" -f $result.drive, $result.free_gb)
    } else {
        Add-Log ("disk: could not measure free space on {0}" -f $result.drive)
    }
    return $result
}

# ===============================================================
# CPU -- CIM, then WMI, then registry + environment.
#
# The registry/env path needs no WMI at all, so a machine with a
# broken repository still gets a real CPU name.
# ===============================================================
function Get-CpuInfo {
    $info = @{ name = 'unknown'; cores = 0; logical = 0 }

    $cpu = Invoke-Safe -Label 'cpu:cim' -Body {
        Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop | Select-Object -First 1
    }
    if (-not $cpu) {
        $cpu = Invoke-Safe -Label 'cpu:wmi' -Body {
            Get-WmiObject -Class Win32_Processor -ErrorAction Stop | Select-Object -First 1
        }
    }
    if ($cpu) {
        $info.name    = ConvertTo-SafeAscii ([string]$cpu.Name)
        $info.cores   = [int](ConvertTo-UInt64Safe $cpu.NumberOfCores)
        $info.logical = [int](ConvertTo-UInt64Safe $cpu.NumberOfLogicalProcessors)
    }

    if ($info.name -eq 'unknown' -or -not $info.name) {
        $regName = Invoke-Safe -Label 'cpu:registry' -Body {
            (Get-ItemProperty 'HKLM:\HARDWARE\DESCRIPTION\System\CentralProcessor\0' -ErrorAction Stop).ProcessorNameString
        }
        if ($regName) { $info.name = ConvertTo-SafeAscii ([string]$regName) }
        elseif ($env:PROCESSOR_IDENTIFIER) { $info.name = ConvertTo-SafeAscii $env:PROCESSOR_IDENTIFIER }
    }
    if ($info.logical -le 0 -and $env:NUMBER_OF_PROCESSORS) {
        $n = 0
        if ([int]::TryParse($env:NUMBER_OF_PROCESSORS, [ref]$n)) { $info.logical = $n }
    }
    if ($info.cores -le 0 -and $info.logical -gt 0) {
        # No core count anywhere: assume SMT and halve, floor at 1.
        $info.cores = [math]::Max(1, [int][math]::Floor($info.logical / 2))
    }
    if (-not $info.name) { $info.name = 'unknown' }
    return $info
}

# ===============================================================
# VM DETECTION
#
# Deliberately does NOT use Win32_ComputerSystem.HypervisorPresent:
# that is $true on essentially every Windows 11 machine because of
# VBS/HVCI, so it would flag most real hardware as a VM.
# ===============================================================
function Test-IsVirtualized {
    return Invoke-Safe -Label 'vm' -Default $false -Body {
        $cs   = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction SilentlyContinue
        $bios = Get-CimInstance -ClassName Win32_BIOS -ErrorAction SilentlyContinue
        $signals = @(
            [string]$cs.Manufacturer, [string]$cs.Model,
            [string]$bios.Manufacturer, [string]$bios.SerialNumber
        ) -join ' '
        if (-not $signals.Trim()) { return $false }
        return [bool]($signals -match '(?i)VMware|VirtualBox|innotek|QEMU|Bochs|\bXen\b|KVM|Virtual Machine|Hyper-V|Parallels|Google Compute Engine|Amazon EC2')
    }
}

# ===============================================================
# TIER + BUDGET
#
# recommended_tier keeps v1's exact thresholds and meaning so
# launch.bat's existing markers behave identically. What changed is
# the INPUT: vram_gb is now the nominal capacity, so a 16 GB card
# finally reports 16 instead of 15.
#
#   large    >= 20 GB
#   medium   >= 12 GB
#   small    >=  6 GB
#   cpu_only <   6 GB  (or no usable GPU offload at all)
#
# usable_budget_gb is the new, better number: how much memory a
# model may actually occupy on this machine, whichever path it
# takes. For a discrete card that is its VRAM. For an iGPU it is
# the shared heap, capped so the OS keeps room. With no GPU it is
# a conservative slice of system RAM.
# ===============================================================
function Get-RecommendedTier([int]$vramGB) {
    if ($vramGB -ge 20) { return 'large' }
    if ($vramGB -ge 12) { return 'medium' }
    if ($vramGB -ge 6)  { return 'small' }
    return 'cpu_only'
}

function Get-UsableBudget {
    param([int]$VramGB, [bool]$IsIntegrated, [int]$SharedGB, [int]$RamGB)

    if (-not $IsIntegrated -and $VramGB -ge 4) {
        return @{ gb = $VramGB; source = 'gpu' }
    }

    # Everything below shares system RAM with Windows. Leave 4 GB for
    # the OS and never claim more than 60% of total.
    $ramBudget = 0
    if ($RamGB -gt 0) {
        $ramBudget = [math]::Min($RamGB - 4, [int][math]::Floor($RamGB * 0.6))
        if ($ramBudget -lt 0) { $ramBudget = 0 }
    }

    if ($IsIntegrated) {
        $cap = $SharedGB
        if ($cap -le 0) { $cap = $ramBudget }
        return @{ gb = [math]::Max(0, [math]::Min($cap, $ramBudget)); source = 'shared' }
    }
    return @{ gb = $ramBudget; source = 'ram' }
}

# ===============================================================
# OUTPUT
#
# Atomic-ish write with directory fallback. v1 wrote straight to
# $OutputPath and exited 1 if that failed, which is the whole
# feature gone on any install under Program Files, a read-only
# share, or a OneDrive folder holding a sync lock.
#
# Also written without a BOM: Set-Content -Encoding UTF8 on
# Windows PowerShell prepends one, which trips up strict JSON
# readers even though ConvertFrom-Json tolerates it.
# ===============================================================
function Write-JsonFile {
    param([string]$Json, [string]$PreferredPath)

    $candidates = New-Object System.Collections.ArrayList
    [void]$candidates.Add($PreferredPath)
    if ($env:LOCALAPPDATA) {
        [void]$candidates.Add((Join-Path $env:LOCALAPPDATA 'gemma4\hardware.json'))
    }
    if ($env:TEMP) {
        [void]$candidates.Add((Join-Path $env:TEMP 'gemma4-hardware.json'))
    }

    foreach ($path in $candidates) {
        $ok = Invoke-Safe -Label ("write:" + $path) -Default $false -Body {
            $dir = Split-Path $path -Parent
            if ($dir -and -not (Test-Path $dir)) {
                New-Item -ItemType Directory -Path $dir -Force -ErrorAction Stop | Out-Null
            }
            $tmp = "$path.tmp"
            $enc = New-Object System.Text.UTF8Encoding($false)   # no BOM
            [System.IO.File]::WriteAllText($tmp, $Json, $enc)
            Move-Item -LiteralPath $tmp -Destination $path -Force -ErrorAction Stop
            return $true
        }
        if ($ok) { return $path }

        # Last-ditch: some locked-down hosts block [System.IO.File].
        $ok2 = Invoke-Safe -Label ("write-cmdlet:" + $path) -Default $false -Body {
            Set-Content -LiteralPath $path -Value $Json -Encoding ASCII -Force -ErrorAction Stop
            return $true
        }
        if ($ok2) { return $path }
    }
    return $null
}

# KEY=VALUE for launch.bat's for/f loop.
#
# Values are stripped of ! % ^ & " and non-ASCII: launch.bat runs
# under `setlocal enabledelayedexpansion`, where a literal '!' in a
# value is silently eaten and can break the surrounding parse.
function ConvertTo-EnvSafe([string]$s) {
    if (-not $s) { return '' }
    $t = ConvertTo-SafeAscii $s
    $t = $t -replace '[!%^&<>|"=]', ''
    return $t.Trim()
}

function Write-EnvFile {
    param([string]$Path, [hashtable]$Values)
    return Invoke-Safe -Label ("writeenv:" + $Path) -Default $false -Body {
        $lines = New-Object System.Collections.ArrayList
        foreach ($k in ($Values.Keys | Sort-Object)) {
            [void]$lines.Add(("{0}={1}" -f $k, (ConvertTo-EnvSafe ([string]$Values[$k]))))
        }
        Set-Content -LiteralPath $Path -Value $lines -Encoding ASCII -Force -ErrorAction Stop
        return $true
    }
}

# ===============================================================
# SELF TEST
#
# The reason v1 shipped three broken layers is that they only ever
# ran on one machine. Every parser and the merge logic are pure
# functions over text, so they can be verified anywhere -- on a
# machine with no GPU, in CI, before you ship:
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File hardware-probe.ps1 -SelfTest
#
# Exit code is the number of failures.
# ===============================================================
function Invoke-SelfTest {
    $script:TestFail = 0
    $script:TestPass = 0

    function Assert-Eq($label, $expected, $actual) {
        if ("$expected" -eq "$actual") {
            $script:TestPass++
            Write-Host ("  PASS  {0}" -f $label) -ForegroundColor Green
        } else {
            $script:TestFail++
            Write-Host ("  FAIL  {0}`n          expected [{1}] got [{2}]" -f $label, $expected, $actual) -ForegroundColor Red
        }
    }

    Write-Host ''
    Write-Host '  == 1. nominal capacity rounding (the v1 floor bug) ==' -ForegroundColor Cyan
    # A 16 GB card exposes 16368 MiB. v1 floored that to 15, so
    # launch.bat's `vram_gb >= 16` could never be true.
    Assert-Eq '24 GB card (24564 MiB)' 24 (ConvertTo-NominalGB ([uint64]24564 * 1MB))
    Assert-Eq '16 GB card (16368 MiB)' 16 (ConvertTo-NominalGB ([uint64]16368 * 1MB))
    Assert-Eq '16 GB card (16380 MiB)' 16 (ConvertTo-NominalGB ([uint64]16380 * 1MB))
    Assert-Eq '12 GB card (12282 MiB)' 12 (ConvertTo-NominalGB ([uint64]12282 * 1MB))
    Assert-Eq '8 GB card  (8188 MiB)'   8 (ConvertTo-NominalGB ([uint64]8188  * 1MB))
    Assert-Eq '6 GB card  (6144 MiB)'   6 (ConvertTo-NominalGB ([uint64]6144  * 1MB))
    Assert-Eq 'Arc A770   (16256 MiB)' 16 (ConvertTo-NominalGB ([uint64]16256 * 1MB))
    Assert-Eq '11 GB 1080Ti (11264)'   11 (ConvertTo-NominalGB ([uint64]11264 * 1MB))
    Assert-Eq '48 GB A6000 (49140)'    48 (ConvertTo-NominalGB ([uint64]49140 * 1MB))
    Assert-Eq '512 MB iGPU stays 0'     0 (ConvertTo-NominalGB ([uint64]512   * 1MB))
    Assert-Eq '2200 MiB iGPU -> 2'      2 (ConvertTo-NominalGB ([uint64]2200  * 1MB))
    # VRAM rounding stays TIGHT: a genuinely odd size is not inflated.
    Assert-Eq 'VRAM 15.2 GB stays 15'  15 (ConvertTo-NominalGB ([uint64]15577 * 1MB))
    Assert-Eq 'free disk floors'      423 (ConvertTo-FloorGB   ([uint64]454999999999))
    # RAM rounding is LOOSER -- snaps to standard installed totals,
    # because Windows subtracts hardware-reserved pages.
    Assert-Eq 'RAM 15.90 GiB -> 16'    16 (ConvertTo-NominalRamGB ([uint64]17079754752))
    Assert-Eq 'RAM 15.20 GiB -> 16'    16 (ConvertTo-NominalRamGB ([uint64]16320 * 1MB))
    Assert-Eq 'RAM 31.75 GiB -> 32'    32 (ConvertTo-NominalRamGB ([uint64]34091302912))
    Assert-Eq 'RAM 7.87 GiB -> 8'       8 (ConvertTo-NominalRamGB ([uint64]8451 * 1MB))
    Assert-Eq 'RAM 11.9 GiB -> 12'     12 (ConvertTo-NominalRamGB ([uint64]12185 * 1MB))
    Assert-Eq 'RAM 64 GiB exact'       64 (ConvertTo-NominalRamGB ([uint64]64GB))
    Assert-Eq 'RAM 5 GiB (no snap)'     5 (ConvertTo-NominalRamGB ([uint64]5GB))

    Write-Host ''
    Write-Host '  == 2. numeric coercion (the cast that killed v1) ==' -ForegroundColor Cyan
    # NOTE the parentheses: `ConvertTo-UInt64Safe -2147483648` would
    # bind the literal as a PARAMETER NAME, not a positional value.
    Assert-Eq 'int32.MinValue -> 2 GB'   2147483648 (ConvertTo-UInt64Safe (-2147483648))
    Assert-Eq '3 GB card as neg int32'   3221225472 (ConvertTo-UInt64Safe (-1073741824))
    Assert-Eq 'uint32 saturation kept'   4294967295 (ConvertTo-UInt64Safe (-1))
    Assert-Eq '24 GB REG_QWORD'         25769803776 (ConvertTo-UInt64Safe 25769803776)
    Assert-Eq 'REG_BINARY 4-byte LE'     1073741824 (ConvertTo-UInt64Safe ([byte[]]@(0,0,0,64)))
    Assert-Eq 'REG_BINARY 8-byte LE'     8589934592 (ConvertTo-UInt64Safe ([byte[]]@(0,0,0,0,2,0,0,0)))
    Assert-Eq 'decimal string'           8589934592 (ConvertTo-UInt64Safe '8589934592')
    Assert-Eq 'null -> 0'                         0 (ConvertTo-UInt64Safe $null)
    Assert-Eq 'garbage string -> 0'               0 (ConvertTo-UInt64Safe 'N/A')

    Write-Host ''
    Write-Host '  == 3. llama.cpp --list-devices ==' -ForegroundColor Cyan
    $llamaOut = @'
Available devices:
  Vulkan0: AMD Radeon RX 7900 XT (20464 MiB, 20464 MiB free)
'@
    $d = ConvertFrom-LlamaDeviceList -StdOut $llamaOut -StdErr ''
    Assert-Eq 'single device count'  1 $d.Count
    Assert-Eq 'single device name'   'AMD Radeon RX 7900 XT' $d[0].Name
    Assert-Eq 'single device MiB'    20464 (ConvertTo-Mib $d[0].TotalBytes)

    # Device names contain their own parentheses. A greedy regex
    # grabs "R) Graphics (ARL" or fails outright.
    $llamaParens = @'
Available devices:
  Vulkan0: Intel(R) Graphics (ARL) (11577 MiB, 8251 MiB free)
  Vulkan1: AMD Radeon 780M Graphics (RADV PHOENIX) (29696 MiB, 28598 MiB free)
'@
    $d2 = ConvertFrom-LlamaDeviceList -StdOut $llamaParens -StdErr ''
    Assert-Eq 'nested parens count'  2 $d2.Count
    Assert-Eq 'nested parens name 1' 'Intel(R) Graphics (ARL)' $d2[0].Name
    Assert-Eq 'nested parens MiB 1'  11577 (ConvertTo-Mib $d2[0].TotalBytes)
    Assert-Eq 'nested parens name 2' 'AMD Radeon 780M Graphics (RADV PHOENIX)' $d2[1].Name

    # Mixed CUDA + Vulkan, plus the uma flag from stderr.
    $mixOut = @'
Available devices:
  CUDA0: NVIDIA GeForce RTX 5060 (7708 MiB, 7573 MiB free)
  Vulkan0: Intel(R) Graphics (ARL) (11577 MiB, 8251 MiB free)
  Vulkan1: NVIDIA GeForce RTX 5060 (8151 MiB, 7573 MiB free)
'@
    $mixErr = @'
ggml_vulkan: Found 2 Vulkan devices:
ggml_vulkan: 0 = Intel(R) Graphics (ARL) (Intel driver) | uma: 1 | fp16: 1 | warp size: 32
ggml_vulkan: 1 = NVIDIA GeForce RTX 5060 (NVIDIA) | uma: 0 | fp16: 1 | warp size: 32
'@
    $d3 = ConvertFrom-LlamaDeviceList -StdOut $mixOut -StdErr $mixErr
    Assert-Eq 'mixed device count'   3 $d3.Count
    Assert-Eq 'uma harvested (iGPU)' 'True'  ($d3 | Where-Object { $_.Device -eq 'Vulkan0' }).Uma
    Assert-Eq 'uma harvested (dGPU)' 'False' ($d3 | Where-Object { $_.Device -eq 'Vulkan1' }).Uma
    $cpuOnly = ConvertFrom-LlamaDeviceList -StdOut "Available devices:`n  CPU0: fallback (0 MiB, 0 MiB free)" -StdErr ''
    Assert-Eq 'CPU device ignored'   0 $cpuOnly.Count

    Write-Host ''
    Write-Host '  == 4. nvidia-smi CSV ==' -ForegroundColor Cyan
    $n = ConvertFrom-NvidiaSmiCsv -Text "NVIDIA GeForce RTX 4090, 24564`nNVIDIA GeForce RTX 3060, 12288"
    Assert-Eq 'two GPUs'        2 $n.Count
    Assert-Eq 'first name'      'NVIDIA GeForce RTX 4090' $n[0].Name
    Assert-Eq 'first MiB'       24564 (ConvertTo-Mib $n[0].TotalBytes)
    $na = ConvertFrom-NvidiaSmiCsv -Text "NVIDIA GRID vGPU, [N/A]"
    Assert-Eq '[N/A] skipped'   0 $na.Count
    $comma = ConvertFrom-NvidiaSmiCsv -Text "Tesla T4, Rev 2, 15360"
    Assert-Eq 'comma in name'   'Tesla T4, Rev 2' $comma[0].Name

    Write-Host ''
    Write-Host '  == 5. dxdiag (the 1.6-million-GB regression) ==' -ForegroundColor Cyan
    [xml]$dxXml = @'
<?xml version="1.0"?>
<DxDiag>
  <DisplayDevices>
    <DisplayDevice>
      <CardName>AMD Radeon RX 7800 XT</CardName>
      <DedicatedMemory>16368 MB</DedicatedMemory>
      <SharedMemory>16297 MB</SharedMemory>
      <DisplayMemory>32665 MB</DisplayMemory>
    </DisplayDevice>
    <DisplayDevice>
      <CardName>Microsoft Basic Display Adapter</CardName>
      <DedicatedMemory>0 MB</DedicatedMemory>
      <DisplayMemory>2048 MB</DisplayMemory>
    </DisplayDevice>
  </DisplayDevices>
</DxDiag>
'@
    $dx = ConvertFrom-DxdiagXml -Xml $dxXml
    Assert-Eq 'basic adapter filtered' 1 $dx.Count
    Assert-Eq 'DEDICATED not concatenated' 16368 (ConvertTo-Mib $dx[0].TotalBytes)
    Assert-Eq 'nominal GB is 16, not 1598469' 16 (ConvertTo-NominalGB $dx[0].TotalBytes)
    Assert-Eq 'shared kept separate' 16297 (ConvertTo-Mib $dx[0].SharedBytes)
    Assert-Eq 'unit MB'   16368 (ConvertTo-Mib (ConvertFrom-DxdiagMemoryString '16368 MB'))
    Assert-Eq 'unit GB'    8192 (ConvertTo-Mib (ConvertFrom-DxdiagMemoryString '8 GB'))
    Assert-Eq 'unit MiB'   1024 (ConvertTo-Mib (ConvertFrom-DxdiagMemoryString '1024 MiB'))
    Assert-Eq 'empty -> 0'    0 (ConvertFrom-DxdiagMemoryString '')

    Write-Host ''
    Write-Host '  == 6. integrated vs discrete ==' -ForegroundColor Cyan
    $ram32 = [uint64]32GB
    Assert-Eq 'RTX 4090 discrete'  'False' (Test-LooksIntegrated -Name 'NVIDIA GeForce RTX 4090' -TotalBytes 24GB -RamBytes $ram32 -Uma $null)
    Assert-Eq 'Arc A770 discrete'  'False' (Test-LooksIntegrated -Name 'Intel(R) Arc(TM) A770 Graphics' -TotalBytes 16GB -RamBytes $ram32 -Uma $null)
    Assert-Eq 'RX 7800 XT discrete' 'False' (Test-LooksIntegrated -Name 'AMD Radeon RX 7800 XT' -TotalBytes 16GB -RamBytes $ram32 -Uma $null)
    Assert-Eq 'Radeon 780M iGPU'    'True' (Test-LooksIntegrated -Name 'AMD Radeon 780M Graphics' -TotalBytes 29GB -RamBytes $ram32 -Uma $null)
    Assert-Eq 'UHD 620 iGPU'        'True' (Test-LooksIntegrated -Name 'Intel(R) UHD Graphics 620' -TotalBytes 2GB -RamBytes $ram32 -Uma $null)
    Assert-Eq 'Arc Graphics iGPU'   'True' (Test-LooksIntegrated -Name 'Intel(R) Arc(TM) Graphics' -TotalBytes 8GB -RamBytes $ram32 -Uma $null)
    Assert-Eq 'Arc 140V iGPU'       'True' (Test-LooksIntegrated -Name 'Intel(R) Arc(TM) 140V GPU' -TotalBytes 8GB -RamBytes $ram32 -Uma $null)
    Assert-Eq 'uma flag overrides'  'True' (Test-LooksIntegrated -Name 'Some Unknown GPU' -TotalBytes 8GB -RamBytes $ram32 -Uma $true)
    Assert-Eq 'memory-share signal' 'True' (Test-LooksIntegrated -Name 'Mystery Adapter' -TotalBytes 30GB -RamBytes $ram32 -Uma $null)

    Write-Host ''
    Write-Host '  == 7. evidence merge ==' -ForegroundColor Cyan
    # A poisoned source must not win, and must not veto the good one.
    $poison = @(
        (New-GpuCandidate -Name 'AMD Radeon RX 7800 XT' -TotalBytes ([uint64]16368 * 1MB) -Source 'registry' -Rank 70),
        (New-GpuCandidate -Name 'AMD Radeon RX 7800 XT' -TotalBytes ([uint64]1636832665 * 1MB) -Source 'dxdiag' -Rank 30)
    )
    $m1 = Merge-GpuEvidence -Candidates $poison -RamBytes 32GB
    Assert-Eq 'implausible discarded' 16 (ConvertTo-NominalGB $m1.Primary.TotalBytes)
    Assert-Eq 'kept the good source'  'registry' $m1.Primary.Method

    # uint32-capped CIM value must not override a real measurement.
    $capped = @(
        (New-GpuCandidate -Name 'NVIDIA GeForce RTX 4090' -TotalBytes ([uint64]24564 * 1MB) -Source 'nvidia-smi' -Rank 90),
        (New-GpuCandidate -Name 'NVIDIA GeForce RTX 4090' -TotalBytes ([uint64]4GB) -Source 'cim' -Rank 40 -Capped)
    )
    $m2 = Merge-GpuEvidence -Candidates $capped -RamBytes 64GB
    Assert-Eq 'capped source ignored' 24 (ConvertTo-NominalGB $m2.Primary.TotalBytes)
    Assert-Eq 'method is nvidia-smi'  'nvidia-smi' $m2.Primary.Method

    # Hybrid laptop: the iGPU quotes a BIGGER number than the dGPU.
    # Naive max-VRAM picks the iGPU; we must pick the real card.
    $hybrid = @(
        (New-GpuCandidate -Name 'AMD Radeon 780M Graphics' -TotalBytes ([uint64]29696 * 1MB) -Source 'llama.cpp' -Rank 100 -Uma $true),
        (New-GpuCandidate -Name 'NVIDIA GeForce RTX 3090'  -TotalBytes ([uint64]24822 * 1MB) -Source 'llama.cpp' -Rank 100 -Uma $false)
    )
    $m3 = Merge-GpuEvidence -Candidates $hybrid -RamBytes 32GB
    Assert-Eq 'discrete beats iGPU'  'NVIDIA GeForce RTX 3090' $m3.Primary.Name
    Assert-Eq 'discrete VRAM'         24 (ConvertTo-NominalGB $m3.Primary.TotalBytes)
    Assert-Eq 'both adapters kept'     2 $m3.All.Count

    # iGPU only.
    $igpuOnly = @(
        (New-GpuCandidate -Name 'AMD Radeon 780M Graphics' -TotalBytes ([uint64]29696 * 1MB) -Source 'llama.cpp' -Rank 100 -Uma $true)
    )
    $m4 = Merge-GpuEvidence -Candidates $igpuOnly -RamBytes 32GB
    Assert-Eq 'iGPU flagged integrated' 'True' $m4.Primary.IsIntegrated
    Assert-Eq 'iGPU memory called shared' 29 (ConvertTo-NominalGB $m4.Primary.SharedBytes)

    # Name known, memory unmeasurable.
    $nameOnly = @( (New-GpuCandidate -Name 'Intel(R) UHD Graphics 630' -TotalBytes 0 -Source 'cim' -Rank 40) )
    $m5 = Merge-GpuEvidence -Candidates $nameOnly -RamBytes 8GB
    Assert-Eq 'name-only method' 'name-only' $m5.Primary.Method
    Assert-Eq 'name-only name'   'Intel UHD Graphics 630' $m5.Primary.Name

    Write-Host ''
    Write-Host '  == 8. tier + budget ==' -ForegroundColor Cyan
    Assert-Eq 'tier 24 GB' 'large'    (Get-RecommendedTier 24)
    Assert-Eq 'tier 20 GB' 'large'    (Get-RecommendedTier 20)
    Assert-Eq 'tier 16 GB' 'medium'   (Get-RecommendedTier 16)
    Assert-Eq 'tier 12 GB' 'medium'   (Get-RecommendedTier 12)
    Assert-Eq 'tier 8 GB'  'small'    (Get-RecommendedTier 8)
    Assert-Eq 'tier 4 GB'  'cpu_only' (Get-RecommendedTier 4)
    $b1 = Get-UsableBudget -VramGB 16 -IsIntegrated $false -SharedGB 0  -RamGB 32
    Assert-Eq 'budget discrete'   16 $b1.gb
    Assert-Eq 'budget src gpu'    'gpu' $b1.source
    $b2 = Get-UsableBudget -VramGB 29 -IsIntegrated $true  -SharedGB 29 -RamGB 32
    Assert-Eq 'budget iGPU capped' 19 $b2.gb
    Assert-Eq 'budget src shared' 'shared' $b2.source
    $b3 = Get-UsableBudget -VramGB 0  -IsIntegrated $false -SharedGB 0  -RamGB 8
    Assert-Eq 'budget RAM only'    4 $b3.gb
    Assert-Eq 'budget src ram'    'ram' $b3.source
    $b4 = Get-UsableBudget -VramGB 0  -IsIntegrated $false -SharedGB 0  -RamGB 4
    Assert-Eq 'budget tiny RAM'    0 $b4.gb

    Write-Host ''
    Write-Host '  == 9. output sanitising ==' -ForegroundColor Cyan
    Assert-Eq 'strip (R)/(TM)' 'Intel Arc A770 Graphics' (ConvertTo-SafeAscii 'Intel(R) Arc(TM) A770 Graphics')
    Assert-Eq 'strip non-ASCII' 'NVIDIA GeForce RTX 4090' (ConvertTo-SafeAscii "NVIDIA GeForce RTX 4090`u{00AE}")
    Assert-Eq 'env strips bang' 'Radeon RX 7800 XT' (ConvertTo-EnvSafe 'Radeon! RX 7800 XT')
    Assert-Eq 'env strips pct'  'GPU 100' (ConvertTo-EnvSafe 'GPU 100%')

    Write-Host ''
    if ($script:TestFail -eq 0) {
        Write-Host ("  ALL {0} CHECKS PASSED" -f $script:TestPass) -ForegroundColor Green
    } else {
        Write-Host ("  {0} PASSED, {1} FAILED" -f $script:TestPass, $script:TestFail) -ForegroundColor Red
    }
    Write-Host ''
    return $script:TestFail
}

if ($SelfTest) { exit (Invoke-SelfTest) }

# ===============================================================
# MAIN
#
# Wrapped end to end: no matter what explodes, we still write a
# usable hardware.json. "No GPU found" is a legitimate answer and
# exits 0; only being unable to write the file anywhere is failure.
# ===============================================================
$gpuRecord = $null
$allAdapters = @()
$ram = @{ bytes = [uint64]0; source = 'unknown' }
$disk = @{ drive = '?'; free_bytes = [uint64]0; free_gb = 0; known = $false }
$cpu = @{ name = 'unknown'; cores = 0; logical = 0 }
$isVm = $false

try {
    Write-Status 'Detecting hardware...'

    # RAM first: the integrated-GPU heuristics compare adapter memory
    # against system RAM.
    $ram = Get-SystemRam
    $ramGB = ConvertTo-NominalRamGB $ram.bytes

    # --- GPU: run the cheap, reliable layers and pool the evidence.
    $candidates = @()
    $candidates += @(Invoke-Safe -Label 'layer:llama'    -Default @() -Body { Get-GpuFromLlama -ServerExe $LlamaServer })
    $candidates += @(Invoke-Safe -Label 'layer:nvidiasmi' -Default @() -Body { Get-GpuFromNvidiaSmi })
    $candidates += @(Invoke-Safe -Label 'layer:registry' -Default @() -Body { Get-GpuFromRegistry })
    $candidates += @(Invoke-Safe -Label 'layer:cim'      -Default @() -Body { Get-GpuFromCim })

    # dxdiag is the slow one (~10 s). Only pay for it if nothing above
    # produced a credible memory figure.
    $haveMemory = @($candidates | Where-Object { $_ -and $_.TotalBytes -gt 0 -and -not $_.Capped }).Count -gt 0
    if (-not $haveMemory) {
        $candidates += @(Invoke-Safe -Label 'layer:dxdiag' -Default @() -Body { Get-GpuFromDxdiag })
    } else {
        Add-Log 'dxdiag: skipped (already have a credible reading)'
    }

    $merged = Merge-GpuEvidence -Candidates $candidates -RamBytes $ram.bytes
    if ($merged) {
        $gpuRecord   = $merged.Primary
        $allAdapters = $merged.All
    }

    $disk = Get-FreeDiskInfo $ModelsDir
    $cpu  = Get-CpuInfo
    $isVm = Test-IsVirtualized
} catch {
    Write-Warn ("Hardware detection hit an unexpected problem: {0}" -f $_.Exception.Message)
    Add-Log ("MAIN: {0}" -f $_.Exception.Message)
    Add-ProbeWarning 'Hardware detection was incomplete. The full catalog is shown without a recommendation.'
}

# --- Normalise into the output shape ---------------------------
if ($gpuRecord) {
    $gpu = @{
        name             = $gpuRecord.Name
        vendor           = $gpuRecord.Vendor
        vram_bytes       = [uint64]$gpuRecord.TotalBytes
        vram_gb          = ConvertTo-NominalGB $gpuRecord.TotalBytes
        vram_mib         = ConvertTo-Mib $gpuRecord.TotalBytes
        detection_method = $gpuRecord.Method
        is_integrated    = [bool]$gpuRecord.IsIntegrated
        shared_gb        = ConvertTo-NominalGB $gpuRecord.SharedBytes
        sources          = [string[]]@($gpuRecord.Sources)
        confidence       = $gpuRecord.Confidence
        capped_only      = [bool]$gpuRecord.CappedOnly
    }

    # vram_gb means DEDICATED video memory, and an integrated GPU has
    # none -- the big number it reports is a shared system-RAM heap,
    # carried in shared_gb instead. Zeroing it here keeps every
    # downstream `vram_gb >= N` test honest and stops launch.bat
    # announcing "29 GB VRAM" on a laptop that has no graphics card.
    # The raw per-adapter figures are still in gpus[].
    if ($gpu.is_integrated) {
        $gpu.vram_gb    = 0
        $gpu.vram_bytes = [uint64]0
        $gpu.vram_mib   = 0
    }
} else {
    $gpu = @{
        name             = 'No dedicated GPU detected'
        vendor           = 'unknown'
        vram_bytes       = [uint64]0
        vram_gb          = 0
        vram_mib         = 0
        detection_method = 'none'
        is_integrated    = $false
        shared_gb        = 0
        sources          = [string[]]@()
        confidence       = 'low'
        capped_only      = $false
    }
}

$ramGB = ConvertTo-NominalRamGB $ram.bytes

# vram_gb is already 0 for integrated adapters, so the tier falls
# through to cpu_only for them without any special-casing here.
$tier   = Get-RecommendedTier ([int]$gpu.vram_gb)
$budget = Get-UsableBudget -VramGB ([int]$gpu.vram_gb) `
                           -IsIntegrated ([bool]$gpu.is_integrated) `
                           -SharedGB ([int]$gpu.shared_gb) `
                           -RamGB ([int]$ramGB)
$cpuRamTier = Get-RecommendedTier ([int]$budget.gb)

# --- Report to the console -------------------------------------
if ($gpu.detection_method -eq 'none') {
    Write-Warn 'No dedicated GPU found -- CPU/RAM-only mode.'
} elseif ($gpu.is_integrated) {
    Write-Ok ("GPU: {0} (integrated, ~{1} GB shared, via {2})" -f $gpu.name, $gpu.shared_gb, $gpu.detection_method)
} elseif ($gpu.vram_gb -gt 0) {
    Write-Ok ("GPU: {0} ({1} GB VRAM, via {2}, confidence {3})" -f `
              $gpu.name, $gpu.vram_gb, $gpu.detection_method, $gpu.confidence)
} else {
    Write-Warn ("GPU: {0} (found, but VRAM size could not be measured)" -f $gpu.name)
}
if ($ramGB -gt 0) { Write-Ok ("RAM: {0} GB" -f $ramGB) } else { Write-Warn 'Could not detect system RAM.' }
if ($disk.known)  { Write-Ok ("Free disk on {0} {1} GB" -f $disk.drive, $disk.free_gb) }
else              { Write-Warn ("Could not measure free disk space on {0}." -f $disk.drive) }
if ($cpu.name -ne 'unknown') { Write-Ok ("CPU: {0} ({1} cores)" -f $cpu.name, $cpu.cores) }

# --- Warnings --------------------------------------------------
if ($tier -eq 'cpu_only') {
    if ($gpu.is_integrated) {
        [void]$script:Warnings.Add(("Integrated graphics only ({0}). Small models will run, sharing system RAM; expect roughly 5-15 tok/s." -f $gpu.name))
    } else {
        [void]$script:Warnings.Add('No dedicated GPU detected. Only small models will be recommended; inference will be slow (5-10 tok/s on CPU).')
    }
} elseif ($tier -eq 'small') {
    [void]$script:Warnings.Add('Modest VRAM. Stick with 8B-class models; larger ones will offload to RAM and run slowly.')
}

if ($disk.known -and $disk.free_gb -lt 10) {
    [void]$script:Warnings.Add("Low free disk space ($($disk.free_gb) GB on $($disk.drive)). Some model downloads may not fit.")
} elseif (-not $disk.known) {
    [void]$script:Warnings.Add("Could not measure free space on the models drive ($($disk.drive)); download sizes are not being checked.")
}

if ($ramGB -gt 0 -and $ramGB -lt 8) {
    [void]$script:Warnings.Add("Only $ramGB GB of RAM. Keep to the smallest models and a short context.")
}
if ($isVm) {
    [void]$script:Warnings.Add('Virtualized environment detected. GPU passthrough may be unstable with llama.cpp Vulkan.')
}
if ($gpu.detection_method -eq 'dxdiag') {
    [void]$script:Warnings.Add('VRAM detected via dxdiag fallback. Number may be approximate; verify against your GPU spec sheet if menu picks look wrong.')
}
if ($gpu.detection_method -eq 'name-only') {
    [void]$script:Warnings.Add("Found $($gpu.name) but could not read its memory size, so recommendations fall back to system RAM. Updating your graphics driver usually fixes this.")
}
if ($gpu.capped_only) {
    [void]$script:Warnings.Add("Windows only reports VRAM up to 4 GB for this adapter, so $($gpu.name) may have MORE memory than shown. If you know its real size you can safely pick a larger model.")
}
if ($gpu.confidence -eq 'low' -and $gpu.vram_gb -gt 0) {
    [void]$script:Warnings.Add('GPU memory size came from a low-confidence source. If the recommended model does not fit, pick one tier smaller.')
}

Write-Ok ("Recommended tier: {0} (usable budget ~{1} GB from {2})" -f $tier, $budget.gb, $budget.source)
foreach ($w in $script:Warnings) { Write-Warn $w }

# --- Build + write hardware.json -------------------------------
$elapsedMs = [int]((Get-Date) - $script:StartedAt).TotalMilliseconds

$payload = [ordered]@{
    schema_version   = 2
    probed_at        = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    probe_ms         = $elapsedMs
    gpu              = [ordered]@{
        name             = [string]$gpu.name
        vendor           = [string]$gpu.vendor
        vram_gb          = [int]$gpu.vram_gb
        vram_bytes       = [uint64]$gpu.vram_bytes
        vram_mib         = [int]$gpu.vram_mib
        detection_method = [string]$gpu.detection_method
        is_integrated    = [bool]$gpu.is_integrated
        shared_gb        = [int]$gpu.shared_gb
        sources          = [string[]]@($gpu.sources)
        confidence       = [string]$gpu.confidence
        capped_only      = [bool]$gpu.capped_only
    }
    gpus             = @(
        foreach ($a in $allAdapters) {
            [ordered]@{
                name          = [string]$a.Name
                vendor        = [string]$a.Vendor
                vram_gb       = ConvertTo-NominalGB $a.TotalBytes
                vram_mib      = ConvertTo-Mib $a.TotalBytes
                is_integrated = [bool]$a.IsIntegrated
                method        = [string]$a.Method
            }
        }
    )
    ram_gb           = [int]$ramGB
    ram_bytes        = [uint64]$ram.bytes
    ram_source       = [string]$ram.source
    disk             = [ordered]@{
        models_drive = [string]$disk.drive
        free_gb      = [int]$disk.free_gb
        free_bytes   = [uint64]$disk.free_bytes
        known        = [bool]$disk.known
    }
    cpu              = [ordered]@{
        name    = [string]$cpu.name
        cores   = [int]$cpu.cores
        logical = [int]$cpu.logical
    }
    is_virtualized   = [bool]$isVm
    recommended_tier = [string]$tier
    usable_budget_gb = [int]$budget.gb
    budget_source    = [string]$budget.source
    cpu_ram_tier     = [string]$cpuRamTier
    warnings         = [string[]]@($script:Warnings)
    warning_count    = [int]$script:Warnings.Count
    probe_log        = [string[]]@($script:ProbeLog)
}

$json = Invoke-Safe -Label 'json:serialize' -Default '' -Body { $payload | ConvertTo-Json -Depth 8 }
if (-not $json) {
    # Serialisation itself failed: emit a minimal hand-built document
    # so downstream consumers still get valid JSON.
    $json = @"
{
  "schema_version": 2,
  "probed_at": "$((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))",
  "gpu": { "name": "unknown", "vendor": "unknown", "vram_gb": 0, "vram_bytes": 0,
           "vram_mib": 0, "detection_method": "none", "is_integrated": false,
           "shared_gb": 0, "sources": [], "confidence": "low" },
  "gpus": [], "ram_gb": $([int]$ramGB), "ram_bytes": $([uint64]$ram.bytes), "ram_source": "unknown",
  "disk": { "models_drive": "?", "free_gb": 0, "free_bytes": 0, "known": false },
  "cpu": { "name": "unknown", "cores": 0, "logical": 0 },
  "is_virtualized": false, "recommended_tier": "cpu_only",
  "usable_budget_gb": 0, "budget_source": "ram", "cpu_ram_tier": "cpu_only",
  "warnings": ["Hardware probe could not serialise its results."],
  "warning_count": 1, "probe_log": []
}
"@
}

$written = Write-JsonFile -Json $json -PreferredPath $OutputPath
if (-not $written) {
    Write-Err 'Could not write hardware.json to the script folder, LOCALAPPDATA, or TEMP.'
    Write-Err 'The model menu will still work -- it just will not show a recommendation.'
    exit 1
}
Write-Ok ("Wrote {0}" -f $written)

# Optional KEY=VALUE handoff. Catalog knowledge (which menu option
# maps to which model) deliberately stays in launch.bat; this only
# exports the measured facts.
if ($EmitEnv) {
    $envValues = @{
        HW_OK        = 1
        HW_TIER      = $tier
        HW_VRAM      = [int]$gpu.vram_gb
        HW_VRAM_MIB  = [int]$gpu.vram_mib
        HW_RAM       = [int]$ramGB
        HW_DISK      = [int]$disk.free_gb
        HW_DISK_OK   = [int][bool]$disk.known
        HW_BUDGET    = [int]$budget.gb
        HW_IGPU      = [int][bool]$gpu.is_integrated
        HW_GPUNAME   = [string]$gpu.name
        HW_VENDOR    = [string]$gpu.vendor
        HW_METHOD    = [string]$gpu.detection_method
        HW_CONF      = [string]$gpu.confidence
        HW_JSON      = [string]$written
    }
    if (Write-EnvFile -Path $EmitEnv -Values $envValues) {
        Add-Log ("emitted env file: {0}" -f $EmitEnv)
    } else {
        Write-Warn ("Could not write {0}; launch.bat will parse the JSON instead." -f $EmitEnv)
    }
}

exit 0
