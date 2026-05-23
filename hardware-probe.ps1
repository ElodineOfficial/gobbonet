# ===============================================================
# hardware-probe.ps1
#
# Detects GPU / CPU / RAM / free-disk and writes hardware.json
# next to itself. Consumed by launch.bat's menu generator to
# filter the model catalog to entries that will actually fit.
#
# DETECTION ORDER (first-hit wins for GPU):
#   1. nvidia-smi           — cleanest, fastest, NVIDIA only
#   2. Registry qwMemorySize — covers AMD, Intel Arc, NVIDIA
#                              fallback if nvidia-smi is missing
#   3. dxdiag /x XML        — slow (~10s) but reliable last resort
#   4. CPU-only mode        — no dGPU found, recommend small only
#
# OUTPUT SCHEMA (hardware.json):
#   {
#     "schema_version": 1,
#     "probed_at": "<iso8601>",
#     "gpu": {
#       "name":             "NVIDIA GeForce RTX 4090",
#       "vendor":           "nvidia" | "amd" | "intel" | "unknown",
#       "vram_gb":          24,
#       "vram_bytes":       25769803776,
#       "detection_method": "nvidia-smi" | "registry" | "dxdiag" | "none"
#     },
#     "ram_gb":   64,
#     "ram_bytes": 68719476736,
#     "disk": {
#       "models_drive": "C:",
#       "free_gb":      423,
#       "free_bytes":   454116933632
#     },
#     "cpu": {
#       "name":  "AMD Ryzen 9 7950X",
#       "cores": 16
#     },
#     "is_virtualized":   false,
#     "recommended_tier": "small" | "medium" | "large" | "cpu_only",
#     "warnings": ["..."]
#   }
#
# EXIT CODES:
#   0 = probe succeeded (even "no GPU found" is a success — we
#       wrote a useful hardware.json with cpu_only tier)
#   1 = catastrophic failure (couldn't write the output file)
#
# USAGE:
#   powershell -NoProfile -ExecutionPolicy Bypass -File hardware-probe.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File hardware-probe.ps1 -Quiet
# ===============================================================

[CmdletBinding()]
param(
    [string]$OutputPath = (Join-Path $PSScriptRoot 'hardware.json'),
    [string]$ModelsDir  = (Join-Path $PSScriptRoot 'models'),
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------
# STATUS OUTPUT — matches launch.bat / setup-lan.bat style
# ---------------------------------------------------------------
function Write-Status($msg) { if (-not $Quiet) { Write-Host "  [..] $msg" } }
function Write-Ok($msg)     { if (-not $Quiet) { Write-Host "  [OK] $msg" -ForegroundColor Green } }
function Write-Warn($msg)   { if (-not $Quiet) { Write-Host "  [!!] $msg" -ForegroundColor Yellow } }
function Write-Err($msg)    { Write-Host "  [ERROR] $msg" -ForegroundColor Red }

# ---------------------------------------------------------------
# UNIT CONVERSION
#
# We use GiB everywhere internally (1024^3) but LABEL it as "GB"
# in output, because that matches what users see in Task Manager,
# the GPU box, and the models.json catalog's min_vram_gb field.
# Apples-to-apples with the catalog is what matters.
# ---------------------------------------------------------------
function To-GiB([uint64]$bytes) {
    if ($bytes -eq 0) { return 0 }
    return [math]::Floor($bytes / 1GB)
}

# ---------------------------------------------------------------
# GPU PROBE 1: nvidia-smi
#
# Fastest and most accurate for NVIDIA cards. Output:
#   "NVIDIA GeForce RTX 4090, 24564"
# memory.total is in MiB. We parse and convert to bytes.
#
# Returns hashtable on success, $null on miss/failure. Multiple
# GPUs: returns the one with most VRAM (typical case: laptop with
# integrated NVIDIA + discrete NVIDIA, or workstation with multiple
# discrete cards).
# ---------------------------------------------------------------
function Probe-GpuNvidiaSmi {
    $cmd = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if (-not $cmd) { return $null }

    Write-Status "Trying nvidia-smi..."
    try {
        $output = & nvidia-smi --query-gpu=name,memory.total `
                               --format=csv,noheader,nounits 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $output) { return $null }

        $candidates = @()
        foreach ($line in @($output)) {
            $parts = $line.Split(',').Trim()
            if ($parts.Count -lt 2) { continue }
            $mib = 0
            if (-not [int]::TryParse($parts[1], [ref]$mib)) { continue }
            $candidates += [pscustomobject]@{
                Name       = $parts[0]
                VramBytes  = [uint64]$mib * 1MB
            }
        }
        if ($candidates.Count -eq 0) { return $null }

        $best = $candidates | Sort-Object VramBytes -Descending | Select-Object -First 1
        return @{
            name             = $best.Name
            vendor           = 'nvidia'
            vram_bytes       = [uint64]$best.VramBytes
            vram_gb          = To-GiB $best.VramBytes
            detection_method = 'nvidia-smi'
        }
    } catch {
        Write-Status "nvidia-smi failed: $($_.Exception.Message)"
        return $null
    }
}

# ---------------------------------------------------------------
# GPU PROBE 2: Registry (qwMemorySize)
#
# The Windows display-adapter class GUID is fixed:
#   {4d36e968-e325-11ce-bfc1-08002be10318}
# Under it, each installed adapter gets a 4-digit subkey (0000,
# 0001, ...). The two memory values we care about:
#   HardwareInformation.qwMemorySize  — REG_QWORD, 64-bit, modern
#   HardwareInformation.MemorySize    — REG_BINARY, 4-byte DWORD,
#                                       caps at 4 GB on >=8 GB cards
#
# Prefer qwMemorySize when present. The legacy MemorySize is only
# useful as a last resort and is unreliable above 4 GB anyway.
#
# We filter out:
#   - "Microsoft Basic Display Adapter" (placeholder driver)
#   - any adapter with null DriverDesc (stale entry from old GPU)
#   - any with zero VRAM (Hyper-V synthetic adapters, etc.)
#
# Among survivors, return the highest-VRAM entry. That's almost
# always the dGPU on a laptop with Optimus, or the primary card
# on a workstation.
# ---------------------------------------------------------------
function Probe-GpuRegistry {
    Write-Status "Trying Windows registry..."
    $classKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}'
    if (-not (Test-Path $classKey)) { return $null }

    try {
        $subkeys = Get-ChildItem $classKey -ErrorAction SilentlyContinue |
                   Where-Object { $_.PSChildName -match '^\d{4}$' }

        $candidates = @()
        foreach ($sk in $subkeys) {
            $props = Get-ItemProperty $sk.PSPath -ErrorAction SilentlyContinue
            if (-not $props) { continue }
            $desc = $props.DriverDesc
            if (-not $desc) { continue }
            if ($desc -match 'Microsoft Basic Display') { continue }
            if ($desc -match 'Microsoft Remote Display') { continue }
            if ($desc -match 'Hyper-V') { continue }

            # Prefer qwMemorySize (REG_QWORD, 64-bit)
            $bytes = [uint64]0
            if ($props.PSObject.Properties.Name -contains 'HardwareInformation.qwMemorySize') {
                $bytes = [uint64]$props.'HardwareInformation.qwMemorySize'
            }

            # Fall back to legacy MemorySize (REG_BINARY, 4-byte LE DWORD)
            # Only use if qwMemorySize is missing — this field is
            # truncated at 4 GB for any card larger than that.
            if ($bytes -eq 0 -and
                $props.PSObject.Properties.Name -contains 'HardwareInformation.MemorySize') {
                $raw = $props.'HardwareInformation.MemorySize'
                if ($raw -is [byte[]] -and $raw.Length -ge 4) {
                    $bytes = [uint64][BitConverter]::ToUInt32($raw, 0)
                } elseif ($raw -is [int] -or $raw -is [long]) {
                    $bytes = [uint64]$raw
                }
            }

            if ($bytes -eq 0) { continue }

            # Guess vendor from driver description
            $vendor = 'unknown'
            if     ($desc -match 'NVIDIA|GeForce|Quadro|RTX|GTX') { $vendor = 'nvidia' }
            elseif ($desc -match 'AMD|Radeon|RX ')                { $vendor = 'amd' }
            elseif ($desc -match 'Intel|Arc|UHD Graphics|Iris')   { $vendor = 'intel' }

            $candidates += [pscustomobject]@{
                Name      = $desc
                Vendor    = $vendor
                VramBytes = $bytes
            }
        }

        if ($candidates.Count -eq 0) { return $null }
        $best = $candidates | Sort-Object VramBytes -Descending | Select-Object -First 1

        return @{
            name             = $best.Name
            vendor           = $best.Vendor
            vram_bytes       = [uint64]$best.VramBytes
            vram_gb          = To-GiB $best.VramBytes
            detection_method = 'registry'
        }
    } catch {
        Write-Status "Registry probe failed: $($_.Exception.Message)"
        return $null
    }
}

# ---------------------------------------------------------------
# GPU PROBE 3: dxdiag /x
#
# Slow (~10 sec) — only invoke if the faster probes failed.
# dxdiag writes XML asynchronously, so we have to poll for the
# output file. We cap the wait at 20 seconds; some systems with
# many display devices take longer.
#
# DisplayMemory in the XML looks like "24405 MB" or "8053 MB".
# Strip non-digits to get the number.
# ---------------------------------------------------------------
function Probe-GpuDxdiag {
    Write-Status "Trying dxdiag (this takes a few seconds)..."
    $xmlPath = Join-Path $env:TEMP "hardware-probe-dxdiag.xml"
    if (Test-Path $xmlPath) { Remove-Item $xmlPath -Force -ErrorAction SilentlyContinue }

    try {
        Start-Process -FilePath 'dxdiag' `
                      -ArgumentList '/x', $xmlPath `
                      -WindowStyle Hidden `
                      -Wait `
                      -ErrorAction Stop | Out-Null

        # Even with -Wait, dxdiag sometimes returns before flush completes.
        $deadline = (Get-Date).AddSeconds(5)
        while ((-not (Test-Path $xmlPath)) -and (Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 250
        }
        if (-not (Test-Path $xmlPath)) { return $null }

        [xml]$dx = Get-Content $xmlPath
        $displays = @($dx.DxDiag.DisplayDevices.DisplayDevice)
        if ($displays.Count -eq 0) { return $null }

        $candidates = @()
        foreach ($d in $displays) {
            $name = $d.CardName
            if (-not $name) { continue }
            if ($name -match 'Microsoft Basic') { continue }
            $memStr = "$($d.DedicatedMemory)$($d.DisplayMemory)"
            $digits = ($memStr -replace '[^\d]', '')
            if (-not $digits) { continue }
            $mib = 0
            if (-not [int]::TryParse($digits, [ref]$mib)) { continue }
            if ($mib -eq 0) { continue }

            $vendor = 'unknown'
            if     ($name -match 'NVIDIA|GeForce|Quadro|RTX|GTX') { $vendor = 'nvidia' }
            elseif ($name -match 'AMD|Radeon')                    { $vendor = 'amd' }
            elseif ($name -match 'Intel|Arc')                     { $vendor = 'intel' }

            $candidates += [pscustomobject]@{
                Name      = $name
                Vendor    = $vendor
                VramBytes = [uint64]$mib * 1MB
            }
        }

        Remove-Item $xmlPath -Force -ErrorAction SilentlyContinue
        if ($candidates.Count -eq 0) { return $null }
        $best = $candidates | Sort-Object VramBytes -Descending | Select-Object -First 1

        return @{
            name             = $best.Name
            vendor           = $best.Vendor
            vram_bytes       = [uint64]$best.VramBytes
            vram_gb          = To-GiB $best.VramBytes
            detection_method = 'dxdiag'
        }
    } catch {
        Write-Status "dxdiag probe failed: $($_.Exception.Message)"
        return $null
    }
}

# ---------------------------------------------------------------
# SYSTEM RAM
# ---------------------------------------------------------------
function Get-SystemRam {
    try {
        $cs = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop
        return [uint64]$cs.TotalPhysicalMemory
    } catch {
        return [uint64]0
    }
}

# ---------------------------------------------------------------
# FREE DISK on the drive holding the models folder.
#
# We use the models folder location, not %~dp0, in case the user
# has symlinked or junction'd models\ onto a different drive
# (common for users with a small SSD + big data HDD).
# ---------------------------------------------------------------
function Get-FreeDiskInfo($modelsDir) {
    try {
        # Resolve the parent if models\ doesn't exist yet (first launch)
        $probeDir = $modelsDir
        if (-not (Test-Path $probeDir)) {
            $probeDir = Split-Path $modelsDir -Parent
        }
        $resolved = (Resolve-Path $probeDir -ErrorAction Stop).Path
        $driveLetter = ([System.IO.Path]::GetPathRoot($resolved)).TrimEnd('\').TrimEnd(':') + ':'

        $disk = Get-CimInstance -ClassName Win32_LogicalDisk `
                                -Filter "DeviceID='$driveLetter'" `
                                -ErrorAction Stop
        return @{
            drive      = $driveLetter
            free_bytes = [uint64]$disk.FreeSpace
            free_gb    = To-GiB ([uint64]$disk.FreeSpace)
        }
    } catch {
        return @{ drive = '?'; free_bytes = [uint64]0; free_gb = 0 }
    }
}

# ---------------------------------------------------------------
# CPU
# ---------------------------------------------------------------
function Get-CpuInfo {
    try {
        $cpu = Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop |
               Select-Object -First 1
        return @{
            name  = ($cpu.Name -replace '\s+', ' ').Trim()
            cores = [int]$cpu.NumberOfCores
        }
    } catch {
        return @{ name = 'unknown'; cores = 0 }
    }
}

# ---------------------------------------------------------------
# VM DETECTION
#
# llama.cpp Vulkan can have rough edges under VM GPU passthrough,
# and on hypervisor-backed display adapters there's no real VRAM
# at all. Flagging this lets the menu warn the user.
# ---------------------------------------------------------------
function Test-IsVirtualized {
    try {
        $cs = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop
        $bios = Get-CimInstance -ClassName Win32_BIOS -ErrorAction Stop
        $signals = @($cs.Manufacturer, $cs.Model, $bios.Manufacturer) -join ' '
        return ($signals -match 'VMware|VirtualBox|QEMU|Xen|Hyper-V|Virtual Machine|KVM')
    } catch {
        return $false
    }
}

# ---------------------------------------------------------------
# TIER RECOMMENDATION
#
# Maps detected VRAM to one of the catalog's tier slugs:
#   large    >= 20 GB   — runs any model in the catalog
#   medium   >= 12 GB   — 24B dense / 30B MoE in Q4
#   small    >=  6 GB   — 8B class
#   cpu_only <  6 GB    — Phi-4-mini territory, mostly RAM-based
#
# Thresholds are slightly below the catalog's tier targets (8/16/24)
# because:
#   - catalog min_vram_gb already builds in ~2 GB KV-cache headroom
#   - rounding cards to GiB underreports slightly (24576 MiB → 24,
#     but a 16 GB card can be 15-something after the OS reserves
#     a fraction)
# We round down on the probe side, round down on the threshold
# side, and let the menu generator do the final fits-or-doesn't
# check using the exact min_vram_gb from models.json.
# ---------------------------------------------------------------
function Get-RecommendedTier([int]$vramGB) {
    if ($vramGB -ge 20) { return 'large' }
    if ($vramGB -ge 12) { return 'medium' }
    if ($vramGB -ge 6)  { return 'small' }
    return 'cpu_only'
}

# ===============================================================
# MAIN
# ===============================================================
Write-Status "Detecting hardware..."

# --- GPU --------------------------------------------------------
$gpu = Probe-GpuNvidiaSmi
if (-not $gpu) { $gpu = Probe-GpuRegistry }
if (-not $gpu) { $gpu = Probe-GpuDxdiag }
if (-not $gpu) {
    $gpu = @{
        name             = 'No dedicated GPU detected'
        vendor           = 'unknown'
        vram_bytes       = [uint64]0
        vram_gb          = 0
        detection_method = 'none'
    }
}

if ($gpu.detection_method -eq 'none') {
    Write-Warn "No dedicated GPU found — CPU/RAM-only mode."
} else {
    Write-Ok ("GPU: {0} ({1} GB VRAM, via {2})" -f `
              $gpu.name, $gpu.vram_gb, $gpu.detection_method)
}

# --- RAM --------------------------------------------------------
$ramBytes = Get-SystemRam
$ramGB    = To-GiB $ramBytes
if ($ramGB -gt 0) {
    Write-Ok ("RAM: {0} GB" -f $ramGB)
} else {
    Write-Warn "Could not detect system RAM."
}

# --- Disk -------------------------------------------------------
$disk = Get-FreeDiskInfo $ModelsDir
if ($disk.free_gb -gt 0) {
    Write-Ok ("Free disk on {0} {1} GB" -f $disk.drive, $disk.free_gb)
} else {
    Write-Warn "Could not detect free disk space."
}

# --- CPU --------------------------------------------------------
$cpu = Get-CpuInfo
if ($cpu.name -ne 'unknown') {
    Write-Ok ("CPU: {0} ({1} cores)" -f $cpu.name, $cpu.cores)
}

# --- VM ---------------------------------------------------------
$isVm = Test-IsVirtualized

# --- TIER + WARNINGS --------------------------------------------
$tier = Get-RecommendedTier ([int]$gpu.vram_gb)
$warnings = New-Object System.Collections.ArrayList

if ($tier -eq 'cpu_only') {
    [void]$warnings.Add('No dedicated GPU detected. Only small models will be recommended; inference will be slow (5-10 tok/s on CPU).')
} elseif ($tier -eq 'small') {
    [void]$warnings.Add('Modest VRAM. Stick with 8B-class models; larger ones will offload to RAM and run slowly.')
}

if ($disk.free_gb -lt 10) {
    [void]$warnings.Add("Low free disk space ($($disk.free_gb) GB on $($disk.drive)). Some model downloads may not fit.")
}

if ($isVm) {
    [void]$warnings.Add('Virtualized environment detected. GPU passthrough may be unstable with llama.cpp Vulkan.')
}

if ($gpu.detection_method -eq 'dxdiag') {
    [void]$warnings.Add('VRAM detected via dxdiag fallback. Number may be approximate; verify against your GPU spec sheet if menu picks look wrong.')
}

Write-Ok ("Recommended tier: {0}" -f $tier)
foreach ($w in $warnings) { Write-Warn $w }

# --- WRITE hardware.json ---------------------------------------
$payload = [ordered]@{
    schema_version   = 1
    probed_at        = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    gpu              = [ordered]@{
        name             = $gpu.name
        vendor           = $gpu.vendor
        vram_gb          = [int]$gpu.vram_gb
        vram_bytes       = [uint64]$gpu.vram_bytes
        detection_method = $gpu.detection_method
    }
    ram_gb           = [int]$ramGB
    ram_bytes        = [uint64]$ramBytes
    disk             = [ordered]@{
        models_drive = $disk.drive
        free_gb      = [int]$disk.free_gb
        free_bytes   = [uint64]$disk.free_bytes
    }
    cpu              = [ordered]@{
        name  = $cpu.name
        cores = [int]$cpu.cores
    }
    is_virtualized   = [bool]$isVm
    recommended_tier = $tier
    warnings         = @($warnings)
}

try {
    $json = $payload | ConvertTo-Json -Depth 8
    Set-Content -Path $OutputPath -Value $json -Encoding UTF8 -Force
    Write-Ok ("Wrote {0}" -f $OutputPath)
    exit 0
} catch {
    Write-Err ("Failed to write hardware.json: {0}" -f $_.Exception.Message)
    exit 1
}
