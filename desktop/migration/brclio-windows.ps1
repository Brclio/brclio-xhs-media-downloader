$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
function Find-Brclio {
  $found = @()
  foreach ($scope in @('CurrentUser','LocalMachine')) {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]$scope,[Microsoft.Win32.RegistryView]::Registry64)
    try {
      $key = $base.OpenSubKey('Software\c8f079c5-a346-5aee-a72f-5280717e7b26')
      if ($null -eq $key) { continue }
      try { $folder = $key.GetValue('InstallLocation') } finally { $key.Dispose() }
      if ([string]::IsNullOrWhiteSpace($folder) -or ![IO.Path]::IsPathRooted($folder)) { throw 'Invalid Brclio install location.' }
      $exe = Get-Item -LiteralPath (Join-Path $folder 'Brclio.exe')
      if ($exe.VersionInfo.ProductName -cne 'Brclio' -or ($exe.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unexpected Brclio identity.' }
      if ($exe.VersionInfo.ProductVersion -notmatch '^(\d+\.\d+\.\d+)(?:\.0)?$') { throw 'Invalid installed Brclio version.' }
      $found += @{ Path=$exe.FullName; Version=$Matches[1]; Scope=$scope }
    } finally { $base.Dispose() }
  }
  if ($found.Count -gt 1) { throw 'Multiple installations of Brclio found.' }
  if ($found.Count -eq 1) { return $found[0] }
}
function Open-Brclio($app) {
  if ($null -eq $app) { throw 'Brclio is not installed.' }
  Start-Process -FilePath $app.Path
}
$old = Find-Brclio
switch ($env:BRCLIO_LITE_ACTION) {
  'version' { if ($null -ne $old) { Write-Output $old.Version }; return }
  'open' { Open-Brclio $old; return }
  'install' {}
  default { throw 'Unknown install operation.' }
}
$target = $env:BRCLIO_LITE_VERSION
if ($old -and [version]$old.Version -ge [version]$target) { Open-Brclio $old; return }
$arguments = '/S /currentuser'
$instances = @(Get-Process -Name Brclio -ErrorAction SilentlyContinue)
foreach ($process in $instances) {
  if (!$old -or !$process.Path -or $process.Path -ine $old.Path) { throw 'Please close the other running copy of Brclio before installation.' }
}
if ($old) {
  foreach ($process in $instances) {
    if ($process.MainWindowHandle -ne 0) { [void]$process.CloseMainWindow() }
  }
  foreach ($process in $instances) {
    if (!$process.WaitForExit(30000)) { throw 'Please close Brclio before updating.' }
  }
  $mode = if ($old.Scope -eq 'LocalMachine') { '/allusers' } else { '/currentuser' }
  $arguments = '/S --updated --keep-shortcuts ' + $mode + ' /D=' + [IO.Path]::GetDirectoryName($old.Path)
}
$start = New-Object Diagnostics.ProcessStartInfo
$start.FileName = $env:BRCLIO_LITE_FILE
$start.Arguments = $arguments
$start.UseShellExecute = $false
$child = [Diagnostics.Process]::Start($start)
$child.WaitForExit()
if ($child.ExitCode -ne 0) { throw "Brclio installer exited with code $($child.ExitCode)." }
$new = Find-Brclio
if (!$new -or $new.Version -cne $target -or ($old -and $new.Path -ine $old.Path)) { throw 'Brclio installer did not produce the expected application.' }
Open-Brclio $new
