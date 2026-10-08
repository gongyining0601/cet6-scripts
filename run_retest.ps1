# CET6 复测脚本运行器：带硬超时，超时即杀进程树（避免 Playwright 残留 Edge 卡住后续测试）
# 用法： powershell -NoProfile -ExecutionPolicy Bypass -File D:\CET6\scripts\run_retest.ps1 -Name import -TimeoutSec 300
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [int]$TimeoutSec = 300
)
$ErrorActionPreference = 'Continue'
$script = "D:\CET6\scripts\retest_$Name.js"
$log = "D:\CET6\docs\retest-$Name-console.txt"
$errf = "D:\CET6\docs\retest-$Name-console.err.txt"
if (-not (Test-Path $script)) { "MISSING: $script"; exit 2 }
if (Test-Path $log) { Remove-Item $log -Force }
if (Test-Path $errf) { Remove-Item $errf -Force }
$sw = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath 'node' -ArgumentList "retest_$Name.js" -WorkingDirectory 'D:\CET6\scripts' `
  -RedirectStandardOutput $log -RedirectStandardError $errf -PassThru -NoNewWindow
$exited = $p.WaitForExit($TimeoutSec * 1000)
if (-not $exited) {
  try { $p.Kill($true) } catch { }
  Add-Content -Path $log -Value "`n[TIMEOUT after $TimeoutSec s — 已杀掉进程树]" -Encoding UTF8
  "TIMEOUT: retest_$Name.js  用时 $([int]$sw.Elapsed.TotalSeconds)s  → 见 $log"
  exit 124
}
$code = $p.ExitCode
if ((Test-Path $errf) -and (Get-Item $errf).Length -gt 0) {
  Add-Content -Path $log -Value "`n===== stderr =====`n" -Encoding UTF8
  Get-Content $errf -Raw -Encoding UTF8 | Add-Content -Path $log -Encoding UTF8
}
"EXIT=$code  retest_$Name.js  用时 $([int]$sw.Elapsed.TotalSeconds)s  → $log"
exit $code
