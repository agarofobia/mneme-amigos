<#
.SYNOPSIS
  Undoes install-windows.ps1: removes Mneme's hooks from the workspace settings (byte for byte if nothing
  else changed), its server from the workspace .mcp.json (if it is still ours), and the mneme command from
  the PATH. The notes, the workspace rules (CLAUDE.md), your own rules (rules.md), the questionnaire
  (questionnaire.md) and any skills are NOT touched.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\uninstall-windows.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\uninstall-windows.ps1 -Workspace "D:\my-workspace"
#>
[CmdletBinding()]
param(
  # The workspace given at install (default: %USERPROFILE%\AI-Workspace).
  [string]$Workspace = (Join-Path $HOME 'AI-Workspace'),
  # Do not touch the user's PATH (for testing).
  [switch]$SkipUserEnv
)
$ErrorActionPreference = 'Stop'
$App = Split-Path -Parent $PSScriptRoot
$Bin = Join-Path $App 'bin\mneme.js'
$BinDir = Join-Path $App 'bin'
$Helpers = Join-Path $PSScriptRoot 'install-helpers.mjs'
$Workspace = $Workspace.Trim('"')

$WsSettings = Join-Path $Workspace '.claude\settings.json'
if (Test-Path -LiteralPath $WsSettings) {
  & node $Bin hooks uninstall --settings $WsSettings
  if ($LASTEXITCODE -ne 0) { Write-Host '[warn] hooks uninstall reported a problem (see above)' -ForegroundColor Yellow }
  else { Write-Host '[ok  ] Claude Code hooks removed from the workspace' -ForegroundColor Green }
} else { Write-Host "[skip] no workspace settings at $WsSettings" -ForegroundColor DarkGray }

if (Test-Path -LiteralPath (Join-Path $Workspace '.mcp.json')) {
  $res = & node $Helpers mcp-remove $Workspace $Bin
  Write-Host "[ok  ] MCP server: $res" -ForegroundColor Green
}

# "Abrir Mneme.cmd" opens this installation: without it, the shortcut would point at nothing
$Launcher = Join-Path $Workspace 'Abrir Mneme.cmd'
if ((Test-Path -LiteralPath $Launcher) -and ((Get-Content -LiteralPath $Launcher -Raw) -match 'galaxia')) {
  Remove-Item -LiteralPath $Launcher -Force
  Write-Host '[ok  ] "Abrir Mneme.cmd" removed from the workspace' -ForegroundColor Green
}

if (-not $SkipUserEnv) {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($userPath) {
    $kept = ($userPath -split ';') | Where-Object { $_ -and $_ -ne $BinDir }
    [Environment]::SetEnvironmentVariable('Path', ($kept -join ';'), 'User')
  }
  Write-Host '[ok  ] mneme removed from your PATH' -ForegroundColor Green
}

Write-Host ''
Write-Host "Your notes, the workspace rules and any skills were not touched. To remove everything, delete"
Write-Host "the workspace folder ($Workspace) and, if your notes live elsewhere, the .mneme folder inside them."
