# Shared by scripts/db-setup.ps1 and scripts/db-status.ps1, the Windows twin of scripts/lib/db-owner-url.sh.
# Dot-sourced, not run. Asks for the Session pooler connection string with its [YOUR-PASSWORD] placeholder (no secret)
# and, separately and never shown (Read-Host -AsSecureString), for the database password; completes the string with the
# password percent-encoded by packages/db/src/cli/fill-password.ts, which receives the password on standard input only:
# never as an argument, in history, on disk or on screen. The completed string goes back to the calling script, which
# hands it only to the steps it starts, in their own environment: it never enters this PowerShell session's
# environment. The steps run through node_modules\.bin\tsx.cmd in packages\db, as the package.json scripts do (pnpm.exe
# may be blocked on this computer).

$RosRepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$RosDbPackage = Join-Path $RosRepoRoot 'packages\db'
$RosTsx = Join-Path $RosRepoRoot 'node_modules\.bin\tsx.cmd'
$RosCmd = if ($env:ComSpec) { $env:ComSpec } else { Join-Path $env:SystemRoot 'System32\cmd.exe' }
# The staging project, as in packages/db/src/cli/environment.ts, which checks every string again.
$RosStagingRef = 'vjuaiyjmtrenbrmujvtc'

function Resolve-DbTarget {
  # The environment and project this run is for, or $null with the reason said.
  param([Parameter(Mandatory = $true)][string]$Environment, [Parameter(Mandatory = $true)][AllowEmptyString()][string]$ProjectRef)
  $ref = $ProjectRef.Trim().ToLowerInvariant()
  if ($ref -notmatch '^[a-z0-9]{10,40}$') {
    Write-Host 'Give -ProjectRef the project''s reference: the lowercase letters in https://<ref>.supabase.co (Supabase, Project Settings, General, Project ID).'
    return $null
  }
  if ($Environment -eq 'staging' -and $ref -ne $RosStagingRef) {
    Write-Host "Staging is the Supabase project $RosStagingRef, not $ref. Nothing was changed."
    return $null
  }
  if ($Environment -eq 'production' -and $ref -eq $RosStagingRef) {
    Write-Host "$ref is the staging project. Production is a different Supabase project: give its own reference. Nothing was changed."
    return $null
  }
  $vault = if ($Environment -eq 'production') { 'Recruiting OS Production' } else { 'Recruiting OS Staging' }
  return [pscustomobject]@{ Name = $Environment; Ref = $ref; Vault = $vault }
}

function Get-DbCommand {
  # How to run one of the scripts again for this target, for messages.
  param([Parameter(Mandatory = $true)]$Target, [Parameter(Mandatory = $true)][string]$File)
  return "powershell -NoProfile -ExecutionPolicy Bypass -File scripts\$File -Environment $($Target.Name) -ProjectRef $($Target.Ref)"
}

function Test-DbTools {
  # Node and the installed packages, before anything is asked.
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host 'Node.js is not on the PATH of this window. Install it (version 24), open a new PowerShell window, and run this again.'; return $false }
  if (-not (Test-Path -LiteralPath $RosTsx -PathType Leaf)) { Write-Host "The project's packages are not installed ($RosTsx is missing). Install them first, then run this again."; return $false }
  return $true
}

function New-DbToolStartInfo {
  # A step in packages\db, through tsx.cmd, with these variables added to its own environment only.
  param([Parameter(Mandatory = $true)][string]$Arguments, [Parameter(Mandatory = $true)][hashtable]$Environment)
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $RosCmd
  # cmd.exe runs the .cmd shim: /d skips any AutoRun command, /s keeps the quoting exactly as written here.
  $info.Arguments = '/d /s /c ""' + $RosTsx + '" ' + $Arguments + '"'
  $info.WorkingDirectory = $RosDbPackage
  $info.UseShellExecute = $false
  foreach ($name in @($Environment.Keys)) { $info.EnvironmentVariables[$name] = [string]$Environment[$name] }
  return $info
}

function Invoke-DbTool {
  # Runs a step in this window (its output and prompts are the person's) and returns its exit code.
  param([Parameter(Mandatory = $true)][string]$Arguments, [Parameter(Mandatory = $true)][hashtable]$Environment)
  $process = [System.Diagnostics.Process]::Start((New-DbToolStartInfo -Arguments $Arguments -Environment $Environment))
  try {
    $process.WaitForExit()
    return $process.ExitCode
  } finally {
    $process.Dispose()
  }
}

function New-DbToolEnvironment {
  # What every step needs: which database (checked again by each step), the owner string, and the certificate.
  param([Parameter(Mandatory = $true)]$Target, [Parameter(Mandatory = $true)][string]$Owner, [AllowEmptyString()][string]$CaFile = '')
  $tools = @{ ROS_DB_ENV = $Target.Name; ROS_DB_PROJECT_REF = $Target.Ref; MIGRATE_DATABASE_URL = $Owner }
  if ($CaFile) { $tools['DATABASE_SSL_CA_FILE'] = $CaFile }
  return $tools
}

function Complete-OwnerUrl {
  # fill-password.ts with the password on its standard input, as UTF-8 bytes copied out of the SecureString and wiped
  # after the write; returns the completed string, or $null when the step refused (its own message says why).
  param([Parameter(Mandatory = $true)]$Target, [Parameter(Mandatory = $true)][string]$Uri, [Parameter(Mandatory = $true)][Security.SecureString]$Password)
  $info = New-DbToolStartInfo -Arguments 'src\cli\fill-password.ts' -Environment @{ ROS_DB_ENV = $Target.Name; ROS_DB_PROJECT_REF = $Target.Ref; ROS_OWNER_URI = $Uri }
  $info.RedirectStandardInput = $true
  $info.RedirectStandardOutput = $true
  $info.StandardOutputEncoding = New-Object System.Text.UTF8Encoding $false
  $process = [System.Diagnostics.Process]::Start($info)
  $pointer = [IntPtr]::Zero
  $chars = $null
  $bytes = $null
  try {
    try {
      $pointer = [Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($Password)
      $chars = New-Object char[] $Password.Length
      [Runtime.InteropServices.Marshal]::Copy($pointer, $chars, 0, $chars.Length)
      $bytes = [Text.Encoding]::UTF8.GetBytes($chars)
      $process.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
      $process.StandardInput.BaseStream.Flush()
    } catch {
      # A step that ended before reading closed the pipe; it says why itself, and nothing is completed.
    } finally {
      if ($null -ne $chars) { [Array]::Clear($chars, 0, $chars.Length) }
      if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
      if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($pointer) }
      try { $process.StandardInput.Close() } catch { }
    }
    $completed = $process.StandardOutput.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0 -or -not $completed) { return $null }
    return $completed
  } finally {
    $process.Dispose()
  }
}

function Read-OwnerUrl {
  # The owner's connection string, completed; or $null with the reason said. Nothing typed is shown or kept.
  param([Parameter(Mandatory = $true)]$Target)
  $placeholder = '[YOUR-PASSWORD]'
  Write-Host "Step 1 of 2. In Supabase open the $($Target.Name) project ($($Target.Ref)), Connect, Session pooler, and copy the"
  Write-Host "connection string exactly as shown, with $placeholder still in it. Do not fill the password in. Paste it here (it holds no secret):"
  Write-Host '> ' -NoNewline
  $uri = [string](Read-Host)
  $uri = $uri.Trim()
  if ($uri -notmatch '^postgres(ql)?://') { Write-Host 'That does not look like a Postgres connection string (it must start with postgresql://).'; return $null }
  $count = [regex]::Matches($uri, [regex]::Escape($placeholder)).Count
  if ($count -ne 1) { Write-Host "The connection string must contain $placeholder exactly once (found $count). Copy it again from Supabase without filling in the password."; return $null }
  # The project is checked before the password is asked for; fill-password.ts and every later step check it again.
  $user = ''
  if ($uri -match '^postgres(?:ql)?://([^:@/?#]*)') { $user = $Matches[1] }
  if (-not $user.StartsWith('postgres.')) { Write-Host 'That is not the Session pooler string: its user must be postgres.<project-ref>. In Supabase: Connect, Session pooler.'; return $null }
  $found = $user.Substring('postgres.'.Length).ToLowerInvariant()
  if ($found -ne $Target.Ref) {
    $which = if ($found -eq $RosStagingRef) { "the staging project ($found)" } else { "the Supabase project $found" }
    Write-Host "That string is for $which, not the $($Target.Name) project $($Target.Ref). Copy it from the $($Target.Name) project. Nothing was changed."
    return $null
  }
  if ($uri -match '@[^/?#@]+:6543(?:[/?#]|$)') { Write-Host 'That is the Transaction pooler string (port 6543). The application needs the Session pooler (port 5432): in Supabase, Connect, Session pooler.'; return $null }
  Write-Host ''
  Write-Host "Step 2 of 2. Type the database password from the $($Target.Vault) vault and press Return."
  Write-Host 'Nothing you type is shown, saved to history, written to disk, or sent anywhere but the database:'
  Write-Host '> ' -NoNewline
  $password = Read-Host -AsSecureString
  try {
    if ($password.Length -eq 0) { Write-Host 'The password was empty.'; return $null }
    $owner = Complete-OwnerUrl -Target $Target -Uri $uri -Password $password
    if (-not $owner) { Write-Host 'The connection string could not be completed. Nothing was changed.'; return $null }
    return $owner
  } finally {
    $password.Dispose()
  }
}

function Read-CaFile {
  # Supabase signs its database and pooler certificates with its own authority, which this computer does not trust by
  # itself. Verification stays on (sslmode=verify-full); the authority's certificate is downloaded once from the
  # dashboard and its path given here. It holds no secret. A file named prod-ca-2021.crt in Downloads or on the Desktop
  # is offered. Returns Ok and Path ('' to continue without one).
  if ($env:DATABASE_SSL_CA_FILE -and (Test-Path -LiteralPath $env:DATABASE_SSL_CA_FILE -PathType Leaf)) {
    Write-Host 'TLS: using the certificate at DATABASE_SSL_CA_FILE.'
    return [pscustomobject]@{ Ok = $true; Path = $env:DATABASE_SSL_CA_FILE }
  }
  $default = ''
  foreach ($dir in @((Join-Path $env:USERPROFILE 'Downloads'), [Environment]::GetFolderPath('Desktop'))) {
    foreach ($name in @('prod-ca-2021.crt', 'prod-supabase.cer')) {
      $file = Join-Path $dir $name
      if (-not $default -and (Test-Path -LiteralPath $file -PathType Leaf)) { $default = $file }
    }
  }
  Write-Host ''
  Write-Host 'TLS. Supabase signs its database certificates with its own authority, which this computer does not'
  Write-Host 'trust by itself. Download it once: Supabase, Project Settings, Database, SSL Configuration, Download certificate'
  Write-Host '(a file named prod-ca-2021.crt). Then give its path here. The certificate is public; it is not a secret.'
  if ($default) { Write-Host "Path to the certificate [$default]: " -NoNewline } else { Write-Host 'Path to the certificate (press Return to continue without it): ' -NoNewline }
  $ca = ([string](Read-Host)).Trim().Trim('"')
  if (-not $ca) { $ca = $default }
  if (-not $ca) {
    Write-Host 'TLS: continuing without the certificate; a connection to Supabase will be refused with a certificate error until it is given.'
    return [pscustomobject]@{ Ok = $true; Path = '' }
  }
  if (-not (Test-Path -LiteralPath $ca -PathType Leaf)) { Write-Host "TLS: no file at $ca."; return [pscustomobject]@{ Ok = $false; Path = '' } }
  if (-not (Select-String -LiteralPath $ca -Pattern 'BEGIN CERTIFICATE' -SimpleMatch -Quiet)) { Write-Host "TLS: $ca is not a certificate file."; return [pscustomobject]@{ Ok = $false; Path = '' } }
  $full = (Resolve-Path -LiteralPath $ca).Path
  Write-Host "TLS: verifying against $full."
  return [pscustomobject]@{ Ok = $true; Path = $full }
}
