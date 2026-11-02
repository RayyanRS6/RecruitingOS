# Recruiting OS: database setup on Windows, for staging or production, run by the founder in her own PowerShell window
# from the repository root. The Windows twin of scripts/staging-db-setup.sh (a Mac, staging only), step for step:
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\db-setup.ps1 -Environment production -ProjectRef <ref>
#       full setup (the default); also the way to rotate the two application passwords
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\db-setup.ps1 -Environment production -ProjectRef <ref> -Mode grants
#       role safety limits, Vault grants and checks only (after enabling Supabase Vault); passwords and connection
#       strings are left alone
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\db-status.ps1 -Environment production -ProjectRef <ref>
#       read-only report of where things stand
#
# -ProjectRef is the project's reference (Supabase, Project Settings, General, Project ID). The pasted string must
# belong to that project; staging is always vjuaiyjmtrenbrmujvtc, and production may never be the staging project.
#
# Safe to run again after an interruption: migrations already applied are skipped, a migration that an earlier run left
# half-applied is completed, the application role passwords are set afresh, the safety limits and Vault grants are
# re-applied, and every role is verified. Running it again replaces the application passwords, so a DATABASE_URL or
# WORKER_DATABASE_URL entered earlier into Vercel or Railway must be replaced with the new values.
#
# Asks for two things, separately: the Session pooler connection string exactly as Supabase shows it (with the
# [YOUR-PASSWORD] placeholder still in it; it holds no secret) and the database password (never shown). The password
# reaches packages/db/src/cli/fill-password.ts on standard input only: never on a command line, in this window's
# history or environment, on disk, or on screen. The two new connection strings are never shown either: each goes to
# the clipboard in turn for 1Password, kept out of clipboard history and cloud sync (scripts/lib/clipboard.ps1), and
# the clipboard is cleared afterwards. A computer whose clipboard cannot keep them out of history is refused before
# anything changes.
param(
  [Parameter(Mandatory = $true)][ValidateSet('staging', 'production')][string]$Environment,
  [Parameter(Mandatory = $true)][string]$ProjectRef,
  [ValidateSet('full', 'grants')][string]$Mode = 'full'
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\clipboard.ps1')
. (Join-Path $PSScriptRoot 'lib\db-owner-url.ps1')

$target = Resolve-DbTarget -Environment $Environment -ProjectRef $ProjectRef
if (-not $target) { exit 1 }
if (-not (Test-DbTools)) { exit 1 }
try { Assert-SecretClipboard } catch { Write-Host $_.Exception.Message; exit 1 }
$status = Get-DbCommand -Target $target -File 'db-status.ps1'

Write-Host "Recruiting OS: $($target.Name) database setup ($Mode mode), Supabase project $($target.Ref). Safe to run again; every full run sets fresh passwords."
if ($Mode -eq 'full') { Write-Host 'The new connection strings will go to the clipboard for 1Password, one at a time, never shown and kept out of clipboard history.' }
Write-Host ''
$owner = Read-OwnerUrl -Target $target
if (-not $owner) { exit 1 }
$ca = Read-CaFile
if (-not $ca.Ok) { exit 1 }
Write-Host ''
$tools = New-DbToolEnvironment -Target $target -Owner $owner -CaFile $ca.Path
$owner = $null
$delivering = $false
try {
  if ($Mode -eq 'grants') {
    Write-Host '1/1 role safety limits, Vault grants and checks (passwords and connection strings unchanged)'
    $tools['ROS_PROVISION_MODE'] = 'grants'
    exit (Invoke-DbTool -Arguments 'src\cli\provision.ts' -Environment $tools)
  }
  $tools['ROS_APP_PASSWORD'] = New-LettersAndDigits -Length 40
  $tools['ROS_WORKER_PASSWORD'] = New-LettersAndDigits -Length 40
  Write-Host '1/3 applying migrations (already-applied ones are skipped; an interrupted one is completed)'
  if ((Invoke-DbTool -Arguments 'src\cli\migrate.ts' -Environment $tools) -ne 0) {
    Write-Host ''
    Write-Host 'The migrations stopped (see the line above for the file, the statement and the code). Nothing from the failed'
    Write-Host "migration was kept. For a read-only report run: $status"
    Write-Host 'then run this script again.'
    exit 1
  }
  Write-Host '2/3 application roles, safety limits, Vault grants, verification, delivery'
  $tools['ROS_PROVISION_DELIVERY'] = 'clipboard'
  $delivering = $true
  if ((Invoke-DbTool -Arguments 'src\cli\provision.ts' -Environment $tools) -ne 0) {
    Write-Host ''
    Write-Host "Provisioning stopped (see the lines above). For a read-only report run: $status"
    Write-Host 'then run this script again; it is safe to repeat.'
    exit 1
  }
  Write-Host '3/3 done'
} finally {
  # provision.ts clears the clipboard itself, also when interrupted; this is the backstop for a harder ending.
  if ($delivering) { try { Clear-SecretClipboard } catch { } }
  $tools.Clear()
}
