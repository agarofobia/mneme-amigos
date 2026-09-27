<#
.SYNOPSIS
  The first step after installing: the message to paste in Claude Code to start the questionnaire,
  written to the workspace (START.txt / EMPEZAR.txt) and printed. The window that shows it lives
  inside Mneme (galaxia/, the first-step window), which the installer opens right after this.
.NOTES
  Called at the end of install-windows.ps1 while rules.md says "questionnaire: not offered". The texts
  live in workspace\first-run.json (UTF-8), shared with the galaxy: this file stays ASCII, because
  PowerShell 5.1 reads a script without BOM as ANSI.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\first-step.ps1 -Workspace "$HOME\AI-Workspace"
#>
param(
  [Parameter(Mandatory = $true)] [string]$Workspace,
  # Force a language (es, en). Default: the language of Windows, English if it is not one of them.
  [string]$Lang = ''
)
$ErrorActionPreference = 'Stop'

$all = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'workspace\first-run.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $Lang) { $Lang = (Get-Culture).TwoLetterISOLanguageName }
$t = if ($Lang -eq 'es') { $all.es } else { $all.en }

# The message in a file of the workspace, UTF-8 with BOM so Notepad shows it right.
$file = Join-Path $Workspace $t.file
$text = $t.explain + [Environment]::NewLine + [Environment]::NewLine + $t.prompt + [Environment]::NewLine
[IO.File]::WriteAllText($file, $text, (New-Object System.Text.UTF8Encoding $true))
Write-Host ''
Write-Host "  $($t.prompt)"
Write-Host "  ($($t.fileNote) $file)"
