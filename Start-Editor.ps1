$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$editorNode = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if ($editorNode) {
    $editorMajor = [int]((& $editorNode --version) -replace '^v(\d+).*', '$1')
    if ($editorMajor -ne 20 -and $editorMajor -lt 22) { $editorNode = $null }
}
if (-not $editorNode) {
    $editorBundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path -LiteralPath $editorBundledNode) { $editorNode = $editorBundledNode }
}
if (-not $editorNode) { throw 'Install Node.js 24 LTS, then reopen this launcher.' }

$env:PATH = (Split-Path $editorNode) + ';' + $env:PATH
# Use the Windows trusted CA store, including any local network certificates.
$env:NODE_USE_SYSTEM_CA = '1'
$editorNpm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not (Test-Path -LiteralPath 'node_modules\vite\bin\vite.js')) {
    if (-not $editorNpm) { throw 'npm is missing. Install Node.js 24 LTS with npm.' }
    & $editorNpm ci
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
}
Write-Host 'Open http://127.0.0.1:5173/ in your browser. Press Ctrl+C here to stop the editor.'
& $editorNode 'node_modules/vite/bin/vite.js' --host 127.0.0.1 --port 5173 --strictPort
