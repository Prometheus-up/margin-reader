# 打包免安装版本：输出到 D:\MarginApp\页边.exe（不要放到 Desktop\Clubhouse 树下，会被 ACL 拦）
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$root = Split-Path -Parent $PSScriptRoot
$out = 'D:\MarginApp'
$dist = Join-Path $root 'node_modules\electron\dist'

if (-not (Test-Path $dist)) { throw '找不到 electron，先跑 npm install' }

Write-Host '清理旧产物…'
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Path $out -Force | Out-Null

Write-Host '复制 Electron 运行时…'
robocopy $dist $out /E /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy 失败：$LASTEXITCODE" }

# Electron 自带欢迎页，必须删掉，否则会加载 default_app
Remove-Item (Join-Path $out 'resources\default_app.asar') -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $out 'resources\default-app.asar') -Force -ErrorAction SilentlyContinue

Write-Host '重命名主程序…'
Rename-Item (Join-Path $out 'electron.exe') '页边.exe'

Write-Host '复制应用代码…'
$appDir = Join-Path $out 'resources\app'
New-Item -ItemType Directory -Path $appDir -Force | Out-Null
robocopy (Join-Path $root 'out') (Join-Path $appDir 'out') /E /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy out 失败：$LASTEXITCODE" }

Write-Host '复制 OCR 脚本与模型…'
robocopy (Join-Path $root 'scripts') (Join-Path $appDir 'scripts') /E /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy scripts 失败：$LASTEXITCODE" }

# PP-OCRv4 模型（检测 4.5MB + 识别 10.3MB + 字典），缺了扫描件就没法识别
if (Test-Path (Join-Path $root 'models')) {
  robocopy (Join-Path $root 'models') (Join-Path $appDir 'models') /E /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy models 失败：$LASTEXITCODE" }
} else {
  Write-Warning '找不到 models 目录，扫描版 PDF 将无法识别'
}

Write-Host '复制 pdf.js 中文 CMap 与标准字体（缺了 PDF 会缺字）…'
foreach ($pair in @(@('cmaps', 'cmaps'), @('standard_fonts', 'standard_fonts'))) {
  $src = Join-Path $root ('node_modules\pdfjs-dist\' + $pair[0])
  if (Test-Path $src) {
    robocopy $src (Join-Path $appDir $pair[1]) /E /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy $($pair[0]) 失败：$LASTEXITCODE" }
  } else {
    Write-Warning "找不到 $src"
  }
}
$pkg = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$appPkg = [ordered]@{
  name        = 'margin'
  productName = '页边'
  version     = if ($pkg.version) { $pkg.version } else { '0.1.0' }
  description = '页边 Margin — 本地 AI 阅读平台'
  main        = 'out/main/index.js'
  type        = 'module'
}
$json = $appPkg | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText((Join-Path $appDir 'package.json'), $json, [Text.UTF8Encoding]::new($false))

Write-Host '解析运行时依赖…'
# 主进程 bundle 只外置了这几个包，需要连同它们的传递依赖一起复制
$queue = [Collections.Generic.Queue[string]]::new()
foreach ($n in @('fflate', 'linkedom', 'pdfjs-dist', 'sharp', 'onnxruntime-node')) { $queue.Enqueue($n) }
$wanted = [Collections.Generic.HashSet[string]]::new()
while ($queue.Count -gt 0) {
  $name = $queue.Dequeue()
  if (-not $wanted.Add($name)) { continue }
  $dir = Join-Path $root "node_modules\$name"
  if (-not (Test-Path $dir)) { Write-Warning "缺失依赖：$name"; continue }
  $meta = Get-Content (Join-Path $dir 'package.json') -Raw | ConvertFrom-Json
  foreach ($group in @($meta.dependencies, $meta.optionalDependencies)) {
    if (-not $group) { continue }
    foreach ($p in $group.PSObject.Properties) {
      # sharp 的平台包只装当前平台的，没装上的（linux/darwin）跳过
      if ($group -eq $meta.optionalDependencies -and -not (Test-Path (Join-Path $root "node_modules\$($p.Name)"))) { continue }
      $queue.Enqueue($p.Name)
    }
  }
  Write-Host "  + $name"
}
$destModules = Join-Path $appDir 'node_modules'
New-Item -ItemType Directory -Path $destModules -Force | Out-Null
foreach ($name in $wanted) {
  $to = Join-Path $destModules $name
  New-Item -ItemType Directory -Path (Split-Path $to -Parent) -Force | Out-Null
  robocopy (Join-Path $root "node_modules\$name") $to /E /NFL /NDL /NJH /NJS /NP | Out-Null
}

Write-Host '裁剪无关平台的二进制…'
$ortBin = Join-Path $destModules 'onnxruntime-node\bin'
if (Test-Path $ortBin) {
  foreach ($d in Get-ChildItem (Join-Path $ortBin 'napi-v6') -Directory) {
    if ($d.Name -ne 'win32') { Remove-Item $d.FullName -Recurse -Force }
  }
  $arm = Join-Path $ortBin 'napi-v6\win32\arm64'
  if (Test-Path $arm) { Remove-Item $arm -Recurse -Force }
}

$samples = Join-Path $root '样例'
if (Test-Path $samples) {
  robocopy $samples (Join-Path $out '样例') /E /NFL /NDL /NJH /NJS /NP | Out-Null
}

$readme = @'
页边 Margin

双击「页边.exe」启动。不需要安装，整个文件夹可以拷到 U 盘。

第一次启动后：
  1. 点左上「＋ 导入书籍」，选 EPUB / PDF / MOBI / AZW3 / DOCX / TXT / MD
  2. 在正文里拖选一段话，选一种讨论方式
  3. 右栏「设置」里填 AI 接口（OpenAI 兼容的 baseUrl + key + 模型名）

书和划线存在：%APPDATA%\margin\margin.db
启动日志在：%APPDATA%\margin\boot.log（打不开时把这个发我）
'@
[IO.File]::WriteAllText((Join-Path $out '使用说明.txt'), $readme, [Text.UTF8Encoding]::new($false))

$size = (Get-ChildItem $out -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host ''
Write-Host ("完成：{0}" -f $out)
Write-Host ("大小：{0:N1} MB" -f ($size / 1MB))
