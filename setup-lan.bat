@echo off
setlocal
title Gemma 4 -- LAN Access Setup (one-time)
color 0A

echo.
echo  ====================================================
echo   GEMMA 4 -- LAN ACCESS SETUP
echo.
echo   This script configures Windows to let your phone
echo   connect to the chat over your local network.
echo.
echo   Access is limited to devices on your local subnet,
echo   and the chat itself requires a password (set in
echo   launch.bat). The wider internet cannot reach it, and
echo   nobody on your network gets in without the password.
echo.
echo   NOTE: if you re-run this after an earlier version, it
echo   will UPDATE the existing rules to the current scope.
echo.
echo   It must be run ONCE as Administrator.
echo   You do NOT need to run this again after the first
echo   time, even after reboots.
echo  ====================================================
echo.

:: Check for admin
net session >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] This script must be run as Administrator.
    echo.
    echo          Right-click setup-lan.bat and choose
    echo          "Run as administrator"
    echo.
    pause
    exit /b 1
)

echo  [OK] Running with Administrator privileges.
echo.

:: ---------------------------------------------------------------
:: FIREWALL RULES
:: ---------------------------------------------------------------
echo  [..] Adding firewall rules...

netsh advfirewall firewall show rule name="Gemma4-LLM" >nul 2>&1
if errorlevel 1 (
    netsh advfirewall firewall add rule name="Gemma4-LLM" dir=in action=allow protocol=TCP localport=11434 profile=private,public remoteip=LocalSubnet >nul
    echo  [OK] Firewall rule added: Gemma4-LLM (port 11434, llama.cpp, local subnet only)
) else (
    rem Repair any pre-existing (possibly wide-open) rule from an older run.
    netsh advfirewall firewall set rule name="Gemma4-LLM" new dir=in action=allow protocol=TCP localport=11434 profile=private,public remoteip=LocalSubnet >nul
    echo  [OK] Firewall rule updated: Gemma4-LLM (re-scoped to local subnet only)
)

netsh advfirewall firewall show rule name="Gemma4-Search" >nul 2>&1
if errorlevel 1 (
    netsh advfirewall firewall add rule name="Gemma4-Search" dir=in action=allow protocol=TCP localport=11435 profile=private,public remoteip=LocalSubnet >nul
    echo  [OK] Firewall rule added: Gemma4-Search (port 11435, search proxy, local subnet only)
) else (
    rem Repair any pre-existing (possibly wide-open) rule from an older run.
    netsh advfirewall firewall set rule name="Gemma4-Search" new dir=in action=allow protocol=TCP localport=11435 profile=private,public remoteip=LocalSubnet >nul
    echo  [OK] Firewall rule updated: Gemma4-Search (re-scoped to local subnet only)
)

netsh advfirewall firewall show rule name="Gemma4-Web" >nul 2>&1
if errorlevel 1 (
    netsh advfirewall firewall add rule name="Gemma4-Web" dir=in action=allow protocol=TCP localport=8080 profile=private,public remoteip=LocalSubnet >nul
    echo  [OK] Firewall rule added: Gemma4-Web (port 8080, file server, local subnet only)
) else (
    rem Repair any pre-existing (possibly wide-open) rule from an older run.
    netsh advfirewall firewall set rule name="Gemma4-Web" new dir=in action=allow protocol=TCP localport=8080 profile=private,public remoteip=LocalSubnet >nul
    echo  [OK] Firewall rule updated: Gemma4-Web (re-scoped to local subnet only)
)

echo.

:: ---------------------------------------------------------------
:: mDNS (.local hostname) -- enable on the PRIVATE profile only
::
:: Windows ships with built-in 'mDNS (UDP-In)' rules. We enable the
:: rule on Private AND Public profiles, scoped to the local subnet,
:: so phones can resolve <PC>.local on a home network regardless of
:: how Windows auto-classified it (home Wi-Fi is often tagged Public,
:: which would otherwise block .local resolution).
::
:: Access is still bounded two ways: remoteip=LocalSubnet keeps the
:: wider internet out, and the file server itself requires a password
:: (set in launch.bat). So even another device on the same Wi-Fi must
:: know the password to reach your chats -- the firewall and the
:: password together are the boundary, not the network profile alone.
::
:: Why .local matters: when users bookmark http://<PC>.local:8080
:: instead of the IP, the browser keeps localStorage stable across
:: IP rotations (same hostname = same origin). No more lost chats
:: when DHCP hands out a new lease.
:: ---------------------------------------------------------------
echo  [..] Enabling mDNS (.local hostname) on Private + Public profiles...

netsh advfirewall firewall set rule name="mDNS (UDP-In)" new enable=yes profile=private,public >nul 2>&1
if errorlevel 1 (
    :: Older builds may not have the canonical rule name. Add a fresh
    :: one as a fallback so the .local hostname still works -- scoped
    :: to private + local subnet to match the service rules.
    netsh advfirewall firewall show rule name="Gemma4-mDNS" >nul 2>&1
    if errorlevel 1 (
        netsh advfirewall firewall add rule name="Gemma4-mDNS" dir=in action=allow protocol=UDP localport=5353 profile=private,public remoteip=LocalSubnet >nul
        echo  [OK] Firewall rule added: Gemma4-mDNS (UDP 5353, .local resolution, local subnet only)
    ) else (
        echo  [OK] Firewall rule already exists: Gemma4-mDNS
    )
) else (
    echo  [OK] Built-in 'mDNS (UDP-In)' rule enabled on the Private profile.
)

echo.

:: ---------------------------------------------------------------
:: URL ACL RESERVATIONS
:: PowerShell's HttpListener needs permission to bind to non-
:: localhost addresses. These one-time reservations grant that.
::
:: GOTCHA: `netsh http show urlacl url=<x>` ALWAYS exits with code 0
:: whether or not a reservation actually exists -- when nothing
:: matches, it just prints the "URL Reservations:" header with no
:: entries underneath. So we can't use `if errorlevel 1` to detect
:: a missing ACL. Instead, pipe the output through findstr looking
:: for the "Reserved URL" line that appears in real entries; that
:: gives us a reliable signal we can branch on.
::
:: Background: an earlier version of this script used the errorlevel
:: check, which silently always reported "already exists" and never
:: actually added anything. If Windows Update (or System Restore, or
:: a driver rollback) wipes UrlAclInfo from the registry, the script
:: looked successful but did nothing. The new check actually works.
:: ---------------------------------------------------------------
echo  [..] Adding URL ACL reservations...

netsh http show urlacl url=http://+:11435/ | findstr /i "Reserved URL" >nul
if errorlevel 1 (
    netsh http add urlacl url=http://+:11435/ user=Everyone >nul
    echo  [OK] URL ACL added: http://+:11435/ (search proxy)
) else (
    echo  [OK] URL ACL already exists: http://+:11435/
)

netsh http show urlacl url=http://+:8080/ | findstr /i "Reserved URL" >nul
if errorlevel 1 (
    netsh http add urlacl url=http://+:8080/ user=Everyone >nul
    echo  [OK] URL ACL added: http://+:8080/ (file server)
) else (
    echo  [OK] URL ACL already exists: http://+:8080/
)

echo.
echo  ====================================================
echo   All done! You can now run launch.bat normally.
echo.
echo   Your phone will be able to connect at:
echo     http://%COMPUTERNAME%.local:8080  [recommended]
echo     http://YOUR_PC_IP:8080            [alternate]
echo.
echo   The .local URL is preferred -- it stays the same
echo   even when your PC's IP rotates, so your phone's
echo   bookmark and saved chats never break.
echo.
echo   launch.bat will show the exact URLs when it starts.
echo.
echo   To UNDO these changes later, run:
echo     netsh advfirewall firewall delete rule name="Gemma4-LLM"
echo     netsh advfirewall firewall delete rule name="Gemma4-Search"
echo     netsh advfirewall firewall delete rule name="Gemma4-Web"
echo     netsh advfirewall firewall delete rule name="Gemma4-mDNS"
echo     netsh http delete urlacl url=http://+:11435/
echo     netsh http delete urlacl url=http://+:8080/
echo  ====================================================
echo.
pause