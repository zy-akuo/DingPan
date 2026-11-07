#!/bin/bash
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
bash scripts/dev.sh --desktop
result=$?
if [ "$result" -ne 0 ]; then
  echo "启动/停止失败，请查看以上错误。按回车关闭。"
  read -r _
fi
exit "$result"
