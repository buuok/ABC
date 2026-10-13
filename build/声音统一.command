#!/bin/bash
# 双击运行：启动“声音统一”并自动打开浏览器界面。关闭此窗口即退出。
cd "$(dirname "$0")" || exit 1
xattr -dr com.apple.quarantine . 2>/dev/null
chmod +x ./runtime/node ./bin/ffmpeg 2>/dev/null
exec ./runtime/node app.cjs
