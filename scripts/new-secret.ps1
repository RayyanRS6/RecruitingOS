# Recruiting OS: a fresh random secret on the clipboard, never shown, for the values the application makes up rather
# than receives from a provider: SESSION_SECRET, ANALYTICS_SALT, POSTMARK_WEBHOOK_SECRET and POSTMARK_INBOUND_SECRET.
# Run by the founder in her own PowerShell window from the repository root, once per value (the Windows replacement for
# "openssl rand ... | pbcopy", which this computer does not have):
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\new-secret.ps1 -Name SESSION_SECRET
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\new-secret.ps1 -Name ANALYTICS_SALT -Length 64
#
# Letters and digits only (64 by default), from the operating system's cryptographic generator. The value goes to the
# clipboard kept out of clipboard history (Win+V) and cloud clipboard sync (scripts/lib/clipboard.ps1), stays there until
# the founder types done (or ten minutes pass, or Ctrl-C ends the script), and is then cleared. It is never printed,
# logged or written to disk, and what is typed at the prompt shows as *, so the secret pasted there by mistake (Ctrl+V,
# or a right-click in the window) is not shown either. -Name only labels the messages.
param(
  [ValidateRange(32, 256)][int]$Length = 64,
  [ValidatePattern('^[A-Z][A-Z0-9_]*$')][string]$Name
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\clipboard.ps1')

function Read-Done {
  # One line typed after the prompt (keys pressed earlier are dropped), or $null once the deadline passes. Each key shows
  # as *: a paste into this window would otherwise put the secret on screen.
  param([Parameter(Mandatory = $true)][DateTime]$Deadline)
  try {
    while ([Console]::KeyAvailable) { $null = [Console]::ReadKey($true) }
  } catch {
    return [string](Read-Host) # no console to watch (input redirected): wait without the deadline
  }
  $line = New-Object System.Text.StringBuilder
  while ([DateTime]::UtcNow -lt $Deadline) {
    if (-not [Console]::KeyAvailable) { Start-Sleep -Milliseconds 100; continue }
    $key = [Console]::ReadKey($true)
    if ($key.Key -eq [ConsoleKey]::Enter) { Write-Host ''; return $line.ToString() }
    if ($key.Key -eq [ConsoleKey]::Backspace) {
      if ($line.Length -gt 0) { $line.Length -= 1; Write-Host "`b `b" -NoNewline }
      continue
    }
    if (-not [char]::IsControl($key.KeyChar)) { $null = $line.Append($key.KeyChar); Write-Host '*' -NoNewline }
  }
  return $null
}

try { Assert-SecretClipboard } catch { Write-Host $_.Exception.Message; exit 1 }
$label = if ($Name) { $Name } else { 'The new secret' }
$secret = New-LettersAndDigits -Length $Length
$confirmed = $false
try {
  try { Set-SecretClipboard -Value $secret } catch { Write-Host $_.Exception.Message; exit 1 }
  $secret = $null
  Write-Host "$label is on the clipboard: $Length letters and digits, not shown, kept out of clipboard history (Win+V) and off your other devices."
  Write-Host 'Paste it into its 1Password field first, then everywhere the runbook says it goes: the same value everywhere.'
  $deadline = [DateTime]::UtcNow.AddMinutes(10)
  while (-not $confirmed) {
    Write-Host 'Type done and press Return once it is pasted everywhere (it shows as ****; the clipboard is cleared then, or in 10 minutes): ' -NoNewline
    $answer = Read-Done -Deadline $deadline
    if ($null -eq $answer) { break }
    if ($answer.Trim().ToLowerInvariant() -eq 'done') { $confirmed = $true }
    elseif ($answer.Trim().Length -gt 8) { Write-Host 'That was not done. If it was the secret, it was not shown, and it is still on the clipboard: paste it into 1Password, not here, then type done and press Return.' }
    else { Write-Host 'Not yet: it is still on the clipboard. Paste it where it goes, then type done and press Return.' }
  }
} finally {
  # Also on Ctrl-C: the value never outlives this script on the clipboard.
  Clear-SecretClipboard
}
if (-not $confirmed) {
  Write-Host ''
  Write-Host 'No confirmation in 10 minutes: the clipboard was cleared. Copy the value from 1Password if it is stored there, or run this again for a fresh one.'
  exit 1
}
Write-Host 'Clipboard cleared. Nothing was printed. Press Win+V to check that the secret is not listed there.'
