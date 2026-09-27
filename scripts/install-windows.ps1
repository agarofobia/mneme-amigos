<#
.SYNOPSIS
  Installs Mneme on Windows into a workspace of its own: a folder where Claude Code finds Mneme's hooks,
  its MCP server, the workspace rules and any recommended skills. Outside that folder Claude Code stays
  exactly as it was. Every step says what it did; uninstall-windows.ps1 undoes it (notes are never modified).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
  # creates %USERPROFILE%\AI-Workspace with a notes folder, and sets everything up there

.EXAMPLE
  # your own notes (an Obsidian vault works), and a recommended kit someone shared with you
  powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 -Notes "C:\Users\me\vault" -Kit "C:\Users\me\Downloads\kit"

.NOTES
  This Mneme folder IS the installation: the hooks and the MCP server point here, so do not move it
  afterwards (if you do, run this script again from the new place).
#>
[CmdletBinding()]
param(
  # The workspace folder. Created if missing.
  [string]$Workspace = (Join-Path $HOME 'AI-Workspace'),
  # A folder of markdown notes you already have. Without it, the workspace gets a new "notas" folder.
  [string]$Notes,
  # Skip the Claude Code hooks (the MCP server and the rules are still set up).
  [switch]$NoHooks,
  # A recommended kit: a folder with claude\skills\<name>\SKILL.md and, optionally, RULES.md and PROMPT.md.
  [string]$Kit,
  # Which kit skills to add: ask for each one (default), all, or none.
  [ValidateSet('ask', 'all', 'none')][string]$KitSkills = 'ask',
  # Answer every question with its default (no prompts). Downloads are never accepted by default.
  [switch]$Yes,
  # Do not touch the user's PATH (for testing).
  [switch]$SkipUserEnv
)

$ErrorActionPreference = 'Stop'
$App = Split-Path -Parent $PSScriptRoot
$Bin = Join-Path $App 'bin\mneme.js'
$BinDir = Join-Path $App 'bin'
$Helpers = Join-Path $PSScriptRoot 'install-helpers.mjs'
$Assets = Join-Path $PSScriptRoot 'workspace'
$Marker = '<!-- mneme workspace rules'

function Say([string]$status, [string]$msg) {
  $color = @{ ok = 'Green'; skip = 'DarkGray'; warn = 'Yellow'; fail = 'Red'; info = 'Cyan' }[$status]
  Write-Host ("[{0,-4}] " -f $status) -ForegroundColor $color -NoNewline
  Write-Host $msg
}
function Ask([string]$question, [string]$default) {
  if ($Yes) { return $default }
  $answer = Read-Host "$question [$default]"
  if ([string]::IsNullOrWhiteSpace($answer)) { return $default }
  return $answer.Trim()
}
function Mneme {
  & node $Bin @args
  if ($LASTEXITCODE -ne 0) { throw "mneme $($args -join ' ') exited with $LASTEXITCODE" }
}
# Runs node and returns ALL its output (stdout and stderr). In Windows PowerShell 5.1, redirecting a native
# program's stderr under ErrorActionPreference=Stop turns its first stderr line into an exception.
function NodeOut {
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { return @(& node @args 2>&1 | ForEach-Object { "$_" }) } finally { $ErrorActionPreference = $old }
}

Write-Host ''
Write-Host 'Mneme - install on Windows' -ForegroundColor White
Write-Host "  from: $App"
Write-Host ''

# 1. Node 22 or later
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Say fail 'Node.js is not installed. Install it with:  winget install OpenJS.NodeJS.LTS  then open a new terminal and run this again.'
  exit 1
}
$major = [int](((& node -v) -replace '^v', '').Split('.')[0])
if ($major -lt 22) {
  Say fail "Node $major found; Mneme needs 22 or later. Update with:  winget upgrade OpenJS.NodeJS.LTS"
  exit 1
}
Say ok "Node $(& node -v)"

# 2. Dependencies
# npm.cmd, not npm: in PowerShell `npm` resolves to npm.ps1, whose argument handling breaks this command
# ("Unknown command: pm", seen on Windows PowerShell 5.1 with Node 22).
Push-Location $App
try {
  $npmOut = & npm.cmd ci --omit=dev --no-audit --no-fund --loglevel=error 2>&1
  if ($LASTEXITCODE -ne 0) { $npmOut | ForEach-Object { Write-Host "       $_" }; throw "npm ci exited with $LASTEXITCODE" }
} finally { Pop-Location }
Say ok 'dependencies installed'

# 3. The mneme command: bin\mneme.cmd on the user's PATH (and bin\mneme next to it, for Git Bash,
#    where Claude Code's Bash tool runs: it does not run a .cmd by its bare name)
$env:Path = "$BinDir;$env:Path"
if ($SkipUserEnv) {
  Say skip "your PATH was left as it was (-SkipUserEnv); this window can use mneme"
} else {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not $userPath) { $userPath = '' }
  if (($userPath -split ';') -notcontains $BinDir) {
    [Environment]::SetEnvironmentVariable('Path', (($userPath.TrimEnd(';') + ';' + $BinDir).TrimStart(';')), 'User')
  }
  Say ok 'mneme is on your PATH (in new terminals)'
}

# 4. The workspace, and its notes
$Workspace = $Workspace.Trim('"')
New-Item -ItemType Directory -Force -Path $Workspace | Out-Null
$Workspace = (Resolve-Path -LiteralPath $Workspace).Path
if ($Notes) {
  $Notes = $Notes.Trim('"')
  if (-not (Test-Path -LiteralPath $Notes -PathType Container)) { Say fail "not a folder: $Notes"; exit 1 }
  $NotesDir = (Resolve-Path -LiteralPath $Notes).Path
} else {
  $NotesDir = Join-Path $Workspace 'notas'
  New-Item -ItemType Directory -Force -Path $NotesDir | Out-Null
  if (-not (Get-ChildItem -LiteralPath $NotesDir -Filter *.md -File -ErrorAction SilentlyContinue)) {
    Copy-Item -LiteralPath (Join-Path $Assets 'Welcome.md') -Destination $NotesDir
  }
}
if (Test-Path -LiteralPath (Join-Path $NotesDir '.mneme')) {
  # Already governed (a second run, or notes that come from another machine): init keeps it as it is
  # and registers it for this profile's hooks; it exits with 1 on purpose, which is not a failure here.
  $null = NodeOut $Bin init $NotesDir --adopt
  Say ok "workspace $Workspace; notes already governed: $NotesDir"
} else {
  Mneme init $NotesDir --adopt | Out-Null
  Say ok "workspace $Workspace; notes: $NotesDir (nothing in them was modified)"
}

# 5. Embeddings: the hybrid reader if Ollama and nomic-embed-text are there
$tags = $null
try { $tags = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 3 } catch { $tags = $null }
if ($null -eq $tags) {
  Say skip 'Ollama is not running: search is lexical only (it works). To add the semantic reader later: install Ollama, run  ollama pull nomic-embed-text  and run this script again.'
} else {
  $hasModel = @($tags.models | Where-Object { $_.name -like 'nomic-embed-text*' }).Count -gt 0
  if (-not $hasModel) {
    $pull = Ask 'Ollama is running but nomic-embed-text is missing. Download it now (274 MB)? y/n' 'n'
    if ($pull -match '^[yYsS]') { & ollama pull nomic-embed-text; $hasModel = ($LASTEXITCODE -eq 0) }
  }
  if ($hasModel) {
    & node $Helpers embeddings $NotesDir | Out-Null
    Say ok 'semantic reader on: Ollama + nomic-embed-text (hybrid search)'
  } else {
    Say skip 'semantic reader off: search is lexical only'
  }
}

# 6. Claude Code hooks, in the WORKSPACE's settings: they only run when Claude Code works here
$WsSettings = Join-Path $Workspace '.claude\settings.json'
if ($NoHooks) {
  Say skip 'hooks not installed (-NoHooks). Later:  mneme hooks install --settings "<workspace>\.claude\settings.json"'
} else {
  Mneme hooks install --settings $WsSettings | Out-Null
  Say ok "Claude Code hooks installed in $WsSettings (only for this workspace; your own settings were not touched)"
}

# 7. The MCP server, for this workspace only: the search tool Claude uses here
& node $Helpers mcp $Workspace $Bin $NotesDir | Out-Null
if ($LASTEXITCODE -ne 0) { throw "could not write $Workspace\.mcp.json" }
Say ok "MCP server added to $Workspace\.mcp.json (Claude Code asks you to approve it the first time)"

# 8. The workspace rules, as this workspace's CLAUDE.md (asked; they only apply here)
$RulesTarget = Join-Path $Workspace 'CLAUDE.md'
$RulesSource = Join-Path $Assets 'CLAUDE.md'
if (Test-Path -LiteralPath $RulesTarget) {
  if ((Get-Content -LiteralPath $RulesTarget -Raw -Encoding UTF8).Contains($Marker)) {
    Say ok 'workspace rules already there (CLAUDE.md; your edits are kept)'
  } else {
    $side = Join-Path $Workspace 'CLAUDE.mneme.md'
    if (-not (Test-Path -LiteralPath $side)) { Copy-Item -LiteralPath $RulesSource -Destination $side }
    Say warn "this folder already has a CLAUDE.md, left as it is; Mneme's rules are in CLAUDE.mneme.md, to merge if you want them"
  }
} elseif ((Ask 'Add the workspace rules (a CLAUDE.md that only applies in this folder)? y/n' 'y') -match '^[yYsS]') {
  Copy-Item -LiteralPath $RulesSource -Destination $RulesTarget
  Say ok "workspace rules in $RulesTarget"
} else {
  Say skip "no workspace rules; they are in $RulesSource if you want them later"
}

# 8b. The questionnaire and the person's own rules file, only next to the workspace rules.
#     questionnaire.md is Mneme's and is refreshed on every install; rules.md is theirs and is created only once.
$HasRules = (Test-Path -LiteralPath $RulesTarget) -or (Test-Path -LiteralPath (Join-Path $Workspace 'CLAUDE.mneme.md'))
if ($HasRules) {
  Copy-Item -LiteralPath (Join-Path $Assets 'questionnaire.md') -Destination (Join-Path $Workspace 'questionnaire.md') -Force
  $OwnRules = Join-Path $Workspace 'rules.md'
  if (Test-Path -LiteralPath $OwnRules) {
    Say ok 'your rules file is already there (rules.md; left as it is)'
  } else {
    Copy-Item -LiteralPath (Join-Path $Assets 'rules.md') -Destination $OwnRules
    Say ok "your rules file: $OwnRules (empty; the questionnaire offers to fill it)"
  }
}

# 9. Check, and a first search with one of your own headings
$doctor = NodeOut $Bin doctor --root $NotesDir --settings $WsSettings
if ($LASTEXITCODE -eq 0) { Say ok 'mneme doctor: all checks pass' } else { Say warn 'mneme doctor has warnings:'; $doctor | ForEach-Object { Write-Host "       $_" } }
$title = & node $Helpers first-title $NotesDir
if ($LASTEXITCODE -eq 0 -and $title) {
  # Read ALL the output, then trim: `| Select-Object -First n` stops the process early and leaves
  # $LASTEXITCODE at -1 even when the search worked (Windows PowerShell 5.1).
  $found = NodeOut $Bin search "$title" --root $NotesDir
  if ($LASTEXITCODE -eq 0 -and $found.Count -gt 0) {
    Say ok "first search, for `"$title`":"
    $found | Select-Object -First 3 | ForEach-Object { Write-Host "       $_" }
  } else { Say warn "the first search for `"$title`" found nothing; run  mneme doctor" }
} else { Say skip 'no note with a heading to try a first search' }

# 10. A recommended kit (optional): skills one by one, rules through a prompt to Claude, all in the workspace
if ($Kit) {
  if (-not (Test-Path -LiteralPath $Kit -PathType Container)) { Say fail "kit folder not found: $Kit"; exit 1 }
  $skillsDir = Join-Path $Workspace '.claude\skills'
  New-Item -ItemType Directory -Force -Path $skillsDir | Out-Null
  $added = 0; $kept = 0
  $offered = @(& node $Helpers kit-skills $Kit | ForEach-Object { $_ | ConvertFrom-Json })
  foreach ($s in $offered) {
    $target = Join-Path $skillsDir $s.name
    if (Test-Path -LiteralPath $target) { $kept++; continue }
    $take = $KitSkills -eq 'all'
    if ($KitSkills -eq 'ask') {
      Write-Host ''
      Write-Host "  $($s.name)" -ForegroundColor White
      if ($s.description) { Write-Host "    $($s.description)" }
      $take = (Ask '    Add this skill? y/n' 'n') -match '^[yYsS]'
    }
    if ($take) { Copy-Item -LiteralPath $s.path -Destination $target -Recurse; $added++ }
  }
  Say ok "kit skills in $skillsDir : $added added, $kept already there (not touched), $($offered.Count) offered"
  # RULES.md, or the claude\CLAUDE.md of a kit made by an earlier exporter: either way it is a recommendation.
  $rules = Join-Path $Kit 'RULES.md'
  if (-not (Test-Path -LiteralPath $rules)) { $rules = Join-Path $Kit 'claude\CLAUDE.md' }
  if (Test-Path -LiteralPath $rules) {
    $dest = Join-Path $Workspace '.claude\recomendado'
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Copy-Item -LiteralPath $rules -Destination (Join-Path $dest 'RULES.md') -Force
    $prompt = Join-Path $Kit 'PROMPT.md'
    $promptDest = Join-Path $dest 'PROMPT.md'
    $utf8 = New-Object System.Text.UTF8Encoding $false
    if (Test-Path -LiteralPath $prompt) { Copy-Item -LiteralPath $prompt -Destination $promptDest -Force }
    else { [IO.File]::WriteAllText($promptDest, "Read the recommended rules file (its path is below). Compare it with this workspace's CLAUDE.md, propose which rules to add and where, show me the exact change, and write it only after I say yes. Never replace a rule of mine.`r`n", $utf8) }
    # The paths of THIS machine go in the prompt, so Claude does not have to guess them.
    [IO.File]::AppendAllText($promptDest, "`r`nRecommended rules: $dest\RULES.md`r`nThis workspace's CLAUDE.md: $RulesTarget`r`nKit folder: $((Resolve-Path -LiteralPath $Kit).Path)`r`n", $utf8)
    Say ok "recommended rules in $dest - they are NOT in any CLAUDE.md yet: open Claude Code in the workspace and paste the text of $promptDest"
  }
}

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Host "  Open Claude Code in the workspace:  cd `"$Workspace`"   then   claude"
Write-Host '  The first time, Claude Code asks to approve the "mneme" MCP server: approve it (it only reads).'
Write-Host "  Do not move $App (the hooks and the MCP server point here). To undo:  scripts\uninstall-windows.ps1"
Write-Host ''

# 10. Open Mneme: "Abrir Mneme.cmd" in the workspace opens the galaxy (mneme galaxia) on these notes.
#     The first step lives inside it: while rules.md says "questionnaire: not offered", the galaxy
#     shows a window with the message that starts the questionnaire. The same message goes to
#     EMPEZAR.txt / START.txt and to this console. With -Yes nothing opens.
$Launcher = Join-Path $Workspace 'Abrir Mneme.cmd'
# chcp 65001: the paths can have accents or an n with tilde (a user name), and the file is UTF-8
$cmdText = "@echo off`r`nchcp 65001 >nul`r`nnode `"$Bin`" galaxia --root `"$NotesDir`" --workspace `"$Workspace`"`r`n"
[IO.File]::WriteAllText($Launcher, $cmdText, (New-Object System.Text.UTF8Encoding $false))
Say ok "to open Mneme later: double-click $Launcher"
$OwnRulesFile = Join-Path $Workspace 'rules.md'
if ((Test-Path -LiteralPath $OwnRulesFile) -and ((Get-Content -LiteralPath $OwnRulesFile -Raw -Encoding UTF8) -match 'questionnaire: not offered')) {
  & (Join-Path $PSScriptRoot 'first-step.ps1') -Workspace $Workspace
}
if (-not $Yes) {
  Start-Process -FilePath $Launcher -WorkingDirectory $Workspace
  Say ok 'Mneme is opening in your browser (keep its window open while you use it)'
}
