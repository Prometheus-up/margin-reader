param(
  [Parameter(Mandatory = $true)][string]$Pdf,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [int]$From = 1,
  [int]$To = 0,
  [int]$MaxWidth = 2000
)

# Render PDF pages to PNG files. Only uses Windows.Data.Pdf (built into Windows),
# no OCR here: the recognition runs in Node with PP-OCR models.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

[Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null

$asTaskOp = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
$asTaskAct = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
  })[0]

function AwaitOp($op, [Type]$t) {
  $task = $asTaskOp.MakeGenericMethod($t).Invoke($null, @($op))
  $task.Wait()
  $task.Result
}
function AwaitAct($op) {
  $task = $asTaskAct.Invoke($null, @($op))
  $task.Wait()
}

$file = AwaitOp ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Pdf)) ([Windows.Storage.StorageFile])
$doc = AwaitOp ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
$total = [int]$doc.PageCount
$last = if ($To -le 0 -or $To -gt $total) { $total } else { $To }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

[Console]::Error.WriteLine("T $total")

for ($i = $From; $i -le $last; $i++) {
  $page = $doc.GetPage($i - 1)
  $scale = $MaxWidth / $page.Size.Width
  if ($scale -gt 4.0) { $scale = 4.0 }
  $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
  $opts = New-Object Windows.Data.Pdf.PdfPageRenderOptions
  $opts.DestinationWidth = [uint32][Math]::Round($page.Size.Width * $scale)
  $opts.DestinationHeight = [uint32][Math]::Round($page.Size.Height * $scale)
  AwaitAct ($page.RenderToStreamAsync($stream, $opts))

  $stream.Seek(0)
  $net = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream)
  $name = 'p' + $i.ToString('0000') + '.png'
  $fs = [IO.File]::Create((Join-Path $OutDir $name))
  $net.CopyTo($fs)
  $fs.Close()
  $net.Dispose()
  $stream.Dispose()
  $page.Dispose()
  [Console]::Error.WriteLine("P $i")
}

[Environment]::Exit(0)
