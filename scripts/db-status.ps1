# Recruiting OS: read-only report of the staging or production database, run by the founder in her own PowerShell
# window from the repository root. The Windows twin of scripts/staging-db-status.sh:
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\db-status.ps1 -Environment production -ProjectRef <ref>
#
# Changes nothing. Prints which migrations are applied, whether the next one was interrupted halfway, whether the
# application roles exist, can log in and carry their safety limits, and whether Supabase Vault is present and granted.
# Asks for the Session pooler string and the password the same way as scripts/db-setup.ps1 (the password never shown,
# handed on standard input only). The output holds no connection string, password or row data, so it can be pasted
# back in full. Exit codes as packages/db/src/cli/status.ts: 0 everything in place, 3 something still to do, 2 the
# database could not be reached; 1 when this script stopped before asking it.
param(
  [Parameter(Mandatory = $true)][ValidateSet('staging', 'production')][string]$Environment,
  [Parameter(Mandatory = $true)][string]$ProjectRef
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\db-owner-url.ps1')

$target = Resolve-DbTarget -Environment $Environment -ProjectRef $ProjectRef
if (-not $target) { exit 1 }
if (-not (Test-DbTools)) { exit 1 }
Write-Host "Recruiting OS: $($target.Name) database status (read-only), Supabase project $($target.Ref)."
Write-Host ''
$owner = Read-OwnerUrl -Target $target
if (-not $owner) { exit 1 }
$ca = Read-CaFile
if (-not $ca.Ok) { exit 1 }
Write-Host ''
$tools = New-DbToolEnvironment -Target $target -Owner $owner -CaFile $ca.Path
$owner = $null
try {
  exit (Invoke-DbTool -Arguments 'src\cli\status.ts' -Environment $tools)
} finally {
  $tools.Clear()
}
