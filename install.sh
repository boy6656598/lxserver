#!/bin/bash
# lxserver V3.0.1 一键安装脚本
# 适用于 Linux / macOS，普通用户无需配置即可自动完成安装、构建并启动

set -e

LX_VERSION="3.0.1"
LX_REPO="https://github.com/boy6656598/lxserver.git"

print_step() {
  echo ""
  echo "=============================================="
  echo "[lxserver $LX_VERSION] $1"
  echo "=============================================="
}

error_exit() {
  echo ""
  echo "[错误] $1"
  echo "安装未完成，请根据上面的提示处理后重试。"
  exit 1
}

detect_os() {
  case "$(uname -s)" in
    Linux*) echo "linux" ;;
    Darwin*) echo "darwin" ;;
    *) error_exit "当前系统暂不支持一键安装，请前往 https://github.com/boy6656598/lxserver/releases 下载对应系统的版本。" ;;
  esac
}

ensure_node() {
  if command -v node >/dev/null 2>&1; then
    NODE_VER=$(node -v | tr -d 'v' | cut -d'.' -f1)
    if [ "$NODE_VER" -ge 16 ] 2>/dev/null; then
      print_step "检测到 Node.js $(node -v)，满足要求"
      return 0
    fi
    print_step "检测到 Node.js 版本过低（$(node -v)），需要 Node.js 16 或更高版本"
  fi

  print_step "未检测到可用的 Node.js，开始自动安装 Node.js 22 LTS"

  if [ "$OS" = "linux" ]; then
    if command -v curl >/dev/null 2>&1; then
      DOWNLOADER="curl -fsSL"
    elif command -v wget >/dev/null 2>&1; then
      DOWNLOADER="wget -qO-"
    else
      error_exit "未找到 curl 或 wget，请先安装其中一个后重试。"
    fi

    export NVM_DIR="$HOME/.nvm"
    if [ ! -d "$NVM_DIR" ]; then
      $DOWNLOADER https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    fi
    . "$NVM_DIR/nvm.sh"
    nvm install 22
    nvm alias default 22
  elif [ "$OS" = "darwin" ]; then
    if command -v brew >/dev/null 2>&1; then
      brew install node@22
    else
      error_exit "macOS 需要先安装 Homebrew（https://brew.sh），安装完成后重新运行本脚本。"
    fi
  fi

  command -v node >/dev/null 2>&1 || error_exit "Node.js 安装失败，请手动安装 Node.js 16+ 后重试。"
  print_step "Node.js $(node -v) 安装完成"
}

ensure_git() {
  if command -v git >/dev/null 2>&1; then
    return 0
  fi
  print_step "未检测到 git，开始自动安装 git"
  if [ "$OS" = "linux" ]; then
    if command -v apt-get >/dev/null 2>&1; then
      DEBIAN_FRONTEND=noninteractive apt-get update -y >/dev/null 2>&1 || true
      DEBIAN_FRONTEND=noninteractive apt-get install -y git >/dev/null 2>&1 || error_exit "git 安装失败，请手动安装后重试。"
    elif command -v yum >/dev/null 2>&1; then
      yum install -y git >/dev/null 2>&1 || error_exit "git 安装失败，请手动安装后重试。"
    else
      error_exit "无法自动安装 git，请手动安装后重试。"
    fi
  elif [ "$OS" = "darwin" ]; then
    command -v brew >/dev/null 2>&1 && brew install git || error_exit "无法自动安装 git，请手动安装后重试。"
  fi
}

prepare_project() {
  if [ -f "$PWD/package.json" ] && grep -q '"name": "lx-music-sync-server"' "$PWD/package.json"; then
    print_step "已在项目目录中，跳过代码获取"
    PROJECT_DIR="$PWD"
    return 0
  fi

  PROJECT_DIR="$HOME/lxserver"
  if [ ! -d "$PROJECT_DIR/.git" ]; then
    print_step "开始下载 lxserver 项目代码"
    git clone "$LX_REPO" "$PROJECT_DIR" || error_exit "项目下载失败，请检查网络后重试。"
  else
    print_step "检测到已有项目代码，执行更新"
    git -C "$PROJECT_DIR" fetch --tags || true
    git -C "$PROJECT_DIR" checkout v$LX_VERSION 2>/dev/null || git -C "$PROJECT_DIR" pull || true
  fi
}

install_and_build() {
  cd "$PROJECT_DIR"
  print_step "安装依赖（首次可能需要几分钟）"
  npm ci || error_exit "依赖安装失败，请检查网络后重试。"
  print_step "编译项目"
  npm run build || error_exit "编译失败，请将上方错误信息反馈给开发者。"
}

start_server() {
  cd "$PROJECT_DIR"
  print_step "启动服务"
  nohup npm start > "$PROJECT_DIR/server.log" 2>&1 &
  SERVER_PID=$!
  echo "服务进程 PID: $SERVER_PID"
  sleep 8

  if kill -0 "$SERVER_PID" 2>/dev/null; then
    print_step "安装成功！服务已启动"
  else
    print_step "服务启动失败，请查看日志：$PROJECT_DIR/server.log"
    cat "$PROJECT_DIR/server.log" 2>/dev/null || true
    exit 1
  fi
}

print_summary() {
  echo ""
  echo "=============================================="
  echo "  lxserver V3.0.1 安装完成"
  echo "=============================================="
  echo "  同步管理后台: http://localhost:9527"
  echo "  Web 播放器:   http://localhost:9527/music"
  echo "  后台默认密码: 123456"
  echo ""
  echo "  项目目录:     $PROJECT_DIR"
  echo "  服务日志:     $PROJECT_DIR/server.log"
  echo ""
  echo "  停止服务:  kill $SERVER_PID"
  echo "  下次启动:  cd $PROJECT_DIR && npm start"
  echo "=============================================="
}

main() {
  OS=$(detect_os)
  print_step "欢迎使用 lxserver V3.0.1 一键安装"
  ensure_node
  ensure_git
  prepare_project
  install_and_build
  start_server
  print_summary
}

main
