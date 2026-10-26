param(
    [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$Executable
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NativeAccessibilityWindow {
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr GetWindowDpiAwarenessContext(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern int GetAwarenessFromDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
$owned = Get-Process -Id $ProcessId
if ([IO.Path]::GetFullPath($owned.Path) -ne [IO.Path]::GetFullPath($Executable)) { throw 'Executable identity mismatch' }
$owned.Refresh()
$handle = $owned.MainWindowHandle
if ($handle -eq [IntPtr]::Zero) { throw 'Own process has no main window' }
[uint32]$ownerId = 0
[void][NativeAccessibilityWindow]::GetWindowThreadProcessId($handle, [ref]$ownerId)
if ($ownerId -ne $ProcessId) { throw 'Window ownership mismatch' }
$root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
if ($root.Current.ProcessId -ne $ProcessId) { throw 'UIA root ownership mismatch' }
$nodes = [Collections.Generic.List[object]]::new()
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$timer = [Diagnostics.Stopwatch]::StartNew()
function Read-OwnedTree($element, [int]$depth) {
    if ($nodes.Count -ge 500 -or $depth -gt 24 -or $timer.Elapsed.TotalSeconds -gt 15) { throw 'UIA traversal limit exceeded' }
    $current = $element.Current
    $nodes.Add([ordered]@{
        depth = $depth; name = $current.Name; controlType = $current.ControlType.ProgrammaticName
        processId = $current.ProcessId; isKeyboardFocusable = $current.IsKeyboardFocusable
        hasKeyboardFocus = $current.HasKeyboardFocus; isEnabled = $current.IsEnabled
        helpText = $current.HelpText; automationId = $current.AutomationId
    })
    $child = $walker.GetFirstChild($element)
    while ($null -ne $child) {
        Read-OwnedTree $child ($depth + 1)
        $child = $walker.GetNextSibling($child)
    }
}
# WebView renderer children can have different PIDs; the owned HWND is the boundary.
Read-OwnedTree $root 0
$dpi = [NativeAccessibilityWindow]::GetDpiForWindow($handle)
if ($dpi -eq 0) { throw 'GetDpiForWindow failed' }
[ordered]@{
    processId = $ProcessId; handle = $handle.ToInt64().ToString(); executable = $owned.Path
    dpi = $dpi; systemScalePercent = $dpi / 96 * 100
    dpiAwareness = [NativeAccessibilityWindow]::GetAwarenessFromDpiAwarenessContext([NativeAccessibilityWindow]::GetWindowDpiAwarenessContext($handle))
    ownWindowForeground = [NativeAccessibilityWindow]::GetForegroundWindow() -eq $handle
    nodes = $nodes.ToArray()
} | ConvertTo-Json -Depth 6 -Compress
