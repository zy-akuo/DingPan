# 钉盘开发入口（macOS/Linux）。Windows 用户请继续使用 start-dev.bat / start-desktop.bat
.PHONY: dev setup desktop clean help

DEFAULT_GOAL := help

dev:      ## 一键开发：后端 --reload(后台) + 前端 HMR(前台) + 自动开浏览器
	bash scripts/dev.sh

setup:    ## 仅准备环境（uv/venv + 前后端依赖），不启动服务
	bash scripts/dev.sh --setup-only

desktop:  ## 按需增量构建前端并打开 pywebview 桌面窗口
	bash scripts/dev.sh --desktop

clean:    ## 删除 .venv 虚拟环境
	rm -rf .venv

help:
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  make %-8s %s\n", $$1, $$2}'
