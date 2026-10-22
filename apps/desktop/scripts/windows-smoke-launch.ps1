param([Parameter(Mandatory = $true)][string]$Config)
$ErrorActionPreference = 'Stop'
$configData = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
Add-Type -Path (Join-Path $PSScriptRoot 'windows-smoke-native.cs')
Add-Type -AssemblyName System.Drawing
[WindowsSmokeProcess]::SetProcessDPIAware() | Out-Null
$owned = $null
$expected = $null
$clock = [Diagnostics.Stopwatch]::StartNew()
$nativeObserved = $false
$desktopObserved = $false

function Save-NativePreparation {
    param($Window, $Expected, [string]$Destination)
    $rect = [WindowsSmokeProcess+Rect]::new()
    if (-not [WindowsSmokeProcess]::GetWindowRect($Window, [ref]$rect)) { return $false }
    $width = $rect.right - $rect.left
    $height = $rect.bottom - $rect.top
    if ($width -lt 320 -or $height -lt 150 -or [Math]::Abs($width / $height - $Expected.Width / $Expected.Height) -gt 0.05) { return $false }
    $capture = [Drawing.Bitmap]::new($width, $height)
    $graphics = [Drawing.Graphics]::FromImage($capture)
    try {
        # Screen pixels, not a successful process start or an offscreen render.
        $graphics.CopyFromScreen($rect.left, $rect.top, 0, 0, $capture.Size)
        $matched = 0
        $foregroundMatched = 0
        $foreground = 0
        $samples = 0
        $background = $Expected.GetPixel(20, 20)
        for ($y = 0; $y -lt $Expected.Height; $y += 4) {
            for ($x = 0; $x -lt $Expected.Width; $x += 4) {
                $want = $Expected.GetPixel($x, $y)
                $actual = $capture.GetPixel([Math]::Min($width - 1, [int]($x * $width / $Expected.Width)), [Math]::Min($height - 1, [int]($y * $height / $Expected.Height)))
                $matches = [Math]::Abs([int]$want.R - $actual.R) -le 24 -and [Math]::Abs([int]$want.G - $actual.G) -le 24 -and [Math]::Abs([int]$want.B - $actual.B) -le 24
                $samples++
                if ($matches) { $matched++ }
                if ([Math]::Abs([int]$want.R - $background.R) -gt 50) {
                    $foreground++
                    if ($matches) { $foregroundMatched++ }
                }
            }
        }
        # Both background and actual lettering/accent must be visible. A blank
        # dark rectangle cannot count as preparation feedback.
        $visible = $matched / $samples -ge 0.95 -and $foreground -gt 0 -and $foregroundMatched / $foreground -ge 0.85
        $capture.Save($Destination, [Drawing.Imaging.ImageFormat]::Png)
        return $visible
    } finally {
        $graphics.Dispose()
        $capture.Dispose()
    }
}

function Save-DisplayedApp {
    param($Window, $Owned, [bool]$Descendant, [string]$Destination)
    if (-not $Owned.IsDisplayedAppWindow($Window, $Descendant)) { return $false }
    $rect = [WindowsSmokeProcess+Rect]::new()
    if (-not [WindowsSmokeProcess]::GetWindowRect($Window, [ref]$rect)) { return $false }
    $capture = [Drawing.Bitmap]::new(($rect.right - $rect.left), ($rect.bottom - $rect.top))
    $graphics = [Drawing.Graphics]::FromImage($capture)
    try {
        $graphics.CopyFromScreen($rect.left, $rect.top, 0, 0, $capture.Size)
        # Recheck after capture so a window hidden/minimized during the copy
        # cannot produce successful evidence from an unrelated desktop.
        if (-not $Owned.IsDisplayedAppWindow($Window, $Descendant)) { return $false }
        $capture.Save($Destination, [Drawing.Imaging.ImageFormat]::Png)
        return $true
    } finally {
        $graphics.Dispose()
        $capture.Dispose()
    }
}

try {
    if (-not [Environment]::UserInteractive) {
        throw 'Windows shipped-artifact smoke requires an interactive, unlocked desktop; native UI evidence is unavailable.'
    }
    if ($configData.portable) {
        $expected = [Drawing.Bitmap]::new([string]$configData.splash)
    }
    $owned = [WindowsSmokeProcess]::new($configData.executable, $configData.arguments, $configData.cwd)
    @{ pid = $owned.Id; launchedMs = $clock.ElapsedMilliseconds } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $configData.evidence 'launched.json')
    while ($clock.Elapsed.TotalSeconds -lt 180) {
        if ($configData.portable -and -not $nativeObserved) {
            foreach ($window in $owned.VisibleWindows()) {
                if (Save-NativePreparation $window $expected (Join-Path $configData.evidence 'native-preparation.png')) {
                    $nativeObserved = $true
                    @{ observedMs = $clock.ElapsedMilliseconds; pid = $owned.Id } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $configData.evidence 'native-preparation.json')
                    break
                }
            }
        }
        # Requested only after the renderer reached actionable session prep.
        # ZIP owns the root Electron process; portable owns its descendant.
        if (-not $desktopObserved -and (Test-Path -LiteralPath $configData.captureDesktop)) {
            foreach ($window in $owned.DisplayedAppWindows([bool]$configData.portable)) {
                if (Save-DisplayedApp $window $owned ([bool]$configData.portable) (Join-Path $configData.evidence 'desktop-window.png')) {
                    $rect = [WindowsSmokeProcess+Rect]::new()
                    [WindowsSmokeProcess]::GetWindowRect($window, [ref]$rect) | Out-Null
                    @{
                        observedMs = $clock.ElapsedMilliseconds
                        pid = [WindowsSmokeProcess]::ProcessIdForWindow($window)
                        rootPid = $owned.Id
                        hwnd = $window.ToInt64()
                        bounds = $rect
                        image = 'desktop-window.png'
                    } | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $configData.evidence 'desktop-window.pending.json')
                    Move-Item -LiteralPath (Join-Path $configData.evidence 'desktop-window.pending.json') -Destination (Join-Path $configData.evidence 'desktop-window.json')
                    $desktopObserved = $true
                    break
                }
            }
        }
        if ($owned.ActiveCount -eq 0) {
            @{ exitCode = $owned.ExitCode; elapsedMs = $clock.ElapsedMilliseconds; nativeObserved = $nativeObserved } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $configData.evidence 'exited.json')
            if ($owned.ExitCode -ne 0) { throw "Shipped launcher exited with code $($owned.ExitCode)." }
            if ($configData.portable -and -not $nativeObserved) { throw 'Native preparation image was not observed on the interactive desktop.' }
            if (-not $desktopObserved) { throw 'No displayed, non-minimized Electron window in the owned job was observed after renderer readiness.' }
            exit 0
        }
        if (Test-Path -LiteralPath $configData.stop) { throw 'Smoke controller requested cleanup before the owned process tree exited.' }
        Start-Sleep -Milliseconds 20
    }
    throw 'Shipped application exceeded the 180-second observation deadline.'
} catch {
    $_ | Out-String | Set-Content -LiteralPath (Join-Path $configData.evidence 'native-error.txt')
    Write-Error -ErrorRecord $_ -ErrorAction Continue
    exit 1
} finally {
    if ($null -ne $owned) { $owned.Dispose() }
    if ($null -ne $expected) { $expected.Dispose() }
}
