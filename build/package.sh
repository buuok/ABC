#!/bin/bash
# 打包成双击即用的独立程序（Windows exe + Mac 两个版本）。
# 需要先准备 X 目录（下载并解压）：
#   node-v22.22.0-{win-x64,darwin-arm64,darwin-x64}/   来自 https://nodejs.org/dist/v22.22.0/
#   ffmpeg-installer-{win32-x64,darwin-arm64,darwin-x64}/package/ffmpeg[.exe]   来自 npm @ffmpeg-installer/*
#   postject/package/   来自 npm postject（只用它的 dist/api.js）
# 运行打包的 node 必须也是 v22.22.0（SEA blob 要和目标 node 同版本）。
# 用法：X=/path/to/downloads OUT=/path/to/out bash build/package.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(dirname "$HERE")"
X="${X:?}"; OUT="${OUT:?}"; W="$OUT/work"; rm -rf "$W"; mkdir -p "$W"
node "$HERE/bundle.mjs" "$W/app.cjs"
cat > "$W/sea-config.json" <<JSON
{"main":"$W/app.cjs","output":"$W/sea-prep.blob","disableExperimentalSEAWarning":true,
 "useCodeCache":false,"useSnapshot":false,"assets":{"index.html":"$ROOT/public/index.html"}}
JSON
node --experimental-sea-config "$W/sea-config.json"

# Windows：去掉 node.exe 原签名（注入后签名必然失效），注入 blob
D="$W/win/VoiceUnify"; mkdir -p "$D/bin"
python3 -I "$HERE/pe-strip-signature.py" "$X/node-v22.22.0-win-x64/node.exe" "$D/VoiceUnify.exe"
POSTJECT="$X/postject/package/dist/api.js" node "$HERE/inject.cjs" "$D/VoiceUnify.exe" "$W/sea-prep.blob"
cp "$X/ffmpeg-installer-win32-x64/package/ffmpeg.exe" "$D/bin/"
cp "$HERE/使用说明-Windows.txt" "$D/使用说明.txt"
python3 -I "$HERE/mkzip.py" "$D" "$OUT/VoiceUnify-Windows.zip"

# Mac：不改动官方已签名的 node，用 .command 启动脚本
for a in arm64:AppleSilicon x64:Intel; do
  arch=${a%%:*}; name=${a##*:}; D="$W/mac-$arch/VoiceUnify"; mkdir -p "$D/runtime" "$D/bin" "$D/public"
  cp "$X/node-v22.22.0-darwin-$arch/bin/node" "$D/runtime/node"
  cp "$X/node-v22.22.0-darwin-$arch/LICENSE" "$D/runtime/NODE-LICENSE"
  cp "$X/ffmpeg-installer-darwin-$arch/package/ffmpeg" "$D/bin/ffmpeg"
  cp "$W/app.cjs" "$D/"; cp "$ROOT/public/index.html" "$D/public/"
  cp "$HERE/声音统一.command" "$D/"; cp "$HERE/使用说明-Mac.txt" "$D/使用说明.txt"
  chmod 755 "$D/声音统一.command" "$D/runtime/node" "$D/bin/ffmpeg"
  python3 -I "$HERE/mkzip.py" "$D" "$OUT/VoiceUnify-Mac-$name.zip"
done
