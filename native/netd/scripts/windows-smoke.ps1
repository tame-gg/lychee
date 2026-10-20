# Smoke test of lychee-netd's system-wide mode on Windows (run elevated). The runner has one NIC, so
# this checks the TUN, capture routes, relaying and off; not balancing. The helper is driven over
# its named-pipe control channel with the Go smoke client.
#
# usage: scripts\windows-smoke.ps1 path\to\lychee-netd.exe
param([string]$Bin = '..\..\build\netd\win-x64\lychee-netd.exe')
$ErrorActionPreference = 'Continue'
$Bin = (Resolve-Path $Bin).Path
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:fails = 0
function Pass($m) { Write-Host "PASS  $m" }
function Fail($m) { Write-Host "FAIL  $m"; $script:fails++ }
function Http { try { (Invoke-WebRequest https://example.com -UseBasicParsing -TimeoutSec 10).StatusCode } catch { 0 } }

$sid = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
$pipe = "\\.\pipe\lychee-netd-$sid"
Write-Host "== starting lychee-netd serve on $pipe"
$helper = Start-Process $Bin -ArgumentList 'serve', '--control', $pipe -PassThru -WindowStyle Hidden
Start-Sleep 2

$frames = Join-Path $env:TEMP 'nl-frames.log'
"subscribe`non" | Out-File -Encoding ascii (Join-Path $env:TEMP 'nl-in.txt')
$client = Start-Process go -ArgumentList "run `"$here\smokeclient.go`" `"$pipe`"" -RedirectStandardInput (Join-Path $env:TEMP 'nl-in.txt') -RedirectStandardOutput $frames -PassThru -WindowStyle Hidden -NoNewWindow
Start-Sleep 6

if ((Get-Content $frames -Raw) -match '"state":"on"') { Pass 'merging turned on over the pipe' } else { Fail 'helper did not report state on' }
if (route print -4 | Select-String ' 128.0.0.0 ') { Pass 'capture routes present' } else { Fail 'capture routes missing' }
if ((Http) -eq 200) { Pass 'HTTPS works through lychee-netd' } else { Fail 'HTTPS failed' }

Write-Host '== crash safety: TerminateProcess leaves the machine online'
Stop-Process $helper -Force
Start-Sleep 2
if (-not (route print -4 | Select-String ' 128.0.0.0 ')) { Pass 'capture routes gone after kill' } else { Fail 'capture routes survived kill' }
if ((Http) -eq 200) { Pass 'internet works after kill' } else { Fail 'internet after kill' }
if ($client -and -not $client.HasExited) { Stop-Process $client -Force }

Write-Host ''
if ($script:fails -eq 0) { Write-Host 'ALL CHECKS PASSED' } else { Write-Host "$($script:fails) CHECK(S) FAILED" }
exit $script:fails
