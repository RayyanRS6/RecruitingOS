# Secrets on the Windows clipboard, for scripts/db-setup.ps1, scripts/new-secret.ps1 and the database setup's delivery
# step (packages/db/src/cli/deliver.ts runs it for each connection string). Dot-sourced, not run. Needs Windows
# PowerShell 5.1 (powershell.exe), whose single-threaded apartment the clipboard requires; PowerShell 7 cannot load the
# Windows API used here.
#
# Windows keeps a copy of everything copied in clipboard history (Win+V) and, with cloud clipboard on, sends it to the
# person's other devices; copying something harmless afterwards removes neither. Set-SecretClipboard uses the Windows
# clipboard API that marks a value as excluded from both (Windows.ApplicationModel.DataTransfer.Clipboard,
# SetContentWithOptions with IsAllowedInHistory and IsRoamable off; Windows 10 version 1809 or later). Where that API
# cannot be loaded these functions refuse with a clear message: a secret is never copied the ordinary way instead.
# Nothing here prints, logs or writes a value.

$script:SecretClipboardReady = $false

function Assert-SecretClipboard {
  # Loads the Windows clipboard API once, or throws why it cannot be used. Changes nothing on the clipboard.
  if ($script:SecretClipboardReady) { return }
  if ($PSVersionTable.PSEdition -eq 'Core') { throw 'The secret clipboard needs Windows PowerShell 5.1 (powershell.exe), not PowerShell 7 (pwsh): start it with powershell -NoProfile -ExecutionPolicy Bypass -File ...' }
  if ([Threading.Thread]::CurrentThread.GetApartmentState() -ne [Threading.ApartmentState]::STA) { throw 'The secret clipboard needs Windows PowerShell started normally (single-threaded apartment); this one was started with -MTA.' }
  try {
    $null = [Windows.ApplicationModel.DataTransfer.Clipboard, Windows.ApplicationModel.DataTransfer, ContentType = WindowsRuntime]
    $null = [Windows.ApplicationModel.DataTransfer.DataPackage, Windows.ApplicationModel.DataTransfer, ContentType = WindowsRuntime]
    $null = [Windows.ApplicationModel.DataTransfer.ClipboardContentOptions, Windows.ApplicationModel.DataTransfer, ContentType = WindowsRuntime]
  } catch {
    throw 'This computer cannot load the Windows clipboard API that keeps a value out of clipboard history (Windows.ApplicationModel.DataTransfer), so no secret is put on its clipboard. It needs Windows 10 version 1809 or later and Windows PowerShell 5.1. Nothing was copied.'
  }
  if (-not [Windows.ApplicationModel.DataTransfer.Clipboard].GetMethod('SetContentWithOptions')) {
    throw 'This version of Windows cannot keep a copied value out of clipboard history (it needs Windows 10 version 1809 or later), so no secret is put on its clipboard. Nothing was copied.'
  }
  $script:SecretClipboardReady = $true
}

function Set-SecretClipboard {
  # Puts the value on the clipboard, excluded from clipboard history and cloud sync, and keeps it there after this
  # process ends. Throws, with nothing copied, when Windows refuses.
  param([Parameter(Mandatory = $true)][string]$Value)
  Assert-SecretClipboard
  $package = New-Object Windows.ApplicationModel.DataTransfer.DataPackage
  $package.SetText($Value)
  $options = New-Object Windows.ApplicationModel.DataTransfer.ClipboardContentOptions
  $options.IsAllowedInHistory = $false
  $options.IsRoamable = $false
  $placed = $false
  try {
    $placed = [Windows.ApplicationModel.DataTransfer.Clipboard]::SetContentWithOptions($package, $options)
  } catch {
    $placed = $false
  }
  if (-not $placed) { throw 'Windows refused to put the value on the clipboard (another program may be holding it open). Nothing was copied; try again.' }
  # Without Flush the value would vanish from the clipboard when this process ends.
  [Windows.ApplicationModel.DataTransfer.Clipboard]::Flush()
}

function Clear-SecretClipboard {
  # Empties the clipboard. A value set by Set-SecretClipboard never reached clipboard history, so nothing is left there.
  Assert-SecretClipboard
  [Windows.ApplicationModel.DataTransfer.Clipboard]::Clear()
}

function New-LettersAndDigits {
  # A random string of letters and digits from the operating system's cryptographic generator. Bytes from 248 up are
  # dropped (248 is 4 x 62), so every character is equally likely.
  param([Parameter(Mandatory = $true)][ValidateRange(16, 1024)][int]$Length)
  $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  $chars = New-Object char[] $Length
  $buffer = New-Object byte[] 64
  $random = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
  try {
    $filled = 0
    while ($filled -lt $Length) {
      $random.GetBytes($buffer)
      foreach ($b in $buffer) {
        if ($b -lt 248 -and $filled -lt $Length) {
          $chars[$filled] = $alphabet[$b % 62]
          $filled++
        }
      }
    }
    return (-join $chars)
  } finally {
    $random.Dispose()
    [Array]::Clear($buffer, 0, $buffer.Length)
    [Array]::Clear($chars, 0, $chars.Length)
  }
}
