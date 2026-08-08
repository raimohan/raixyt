#!/usr/bin/env bash
#
# RaiX — one-shot installer for Raspberry Pi OS / Debian / Ubuntu.
#
#   ./setup.sh              install everything, then start under pm2
#   ./setup.sh --no-start   install only
#   ./setup.sh --update     refresh yt-dlp + npm deps, restart services
#   ./setup.sh --start      skip installing, just (re)start under pm2
#   ./setup.sh --skip-apt   don't touch apt (useful on re-runs)
#
# Everything lands in this folder. Nothing is installed system-wide except
# node, ffmpeg and pm2.

set -Eeuo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

VENV="$DIR/.venv"
NODE_MAJOR_MIN=18

DO_APT=1
DO_INSTALL=1
DO_START=1
UPDATE_ONLY=0

for arg in "$@"; do
    case "$arg" in
        --no-start) DO_START=0 ;;
        --skip-apt) DO_APT=0 ;;
        --start)    DO_INSTALL=0 ;;
        --update)   UPDATE_ONLY=1 ;;
        -h|--help)  sed -n '2,15p' "$0"; exit 0 ;;
        *) echo "Unknown option: $arg" >&2; exit 1 ;;
    esac
done

# ---------- output helpers ----------
if [ -t 1 ]; then
    B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; C=$'\033[36m'; N=$'\033[0m'
else
    B=''; G=''; Y=''; R=''; C=''; N=''
fi

STEP=0
step() { STEP=$((STEP + 1)); printf '\n%s[%d/%d]%s %s%s%s\n' "$C" "$STEP" "$TOTAL_STEPS" "$N" "$B" "$1" "$N"; }
ok()   { printf '   %s✓%s %s\n' "$G" "$N" "$1"; }
warn() { printf '   %s!%s %s\n' "$Y" "$N" "$1"; }
die()  { printf '\n%s✗ %s%s\n\n' "$R" "$1" "$N" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
    have sudo && SUDO="sudo"
fi

TOTAL_STEPS=12
[ "$UPDATE_ONLY" -eq 1 ] && TOTAL_STEPS=4
[ "$DO_INSTALL" -eq 0 ] && TOTAL_STEPS=2

printf '\n%s╭──────────────────────────────────────────────╮%s\n' "$B" "$N"
printf '%s│   RaiX  ·  backend + Telegram bot installer   │%s\n' "$B" "$N"
printf '%s╰──────────────────────────────────────────────╯%s\n' "$B" "$N"
printf '   folder : %s\n' "$DIR"
printf '   arch   : %s (%s)\n' "$(uname -m)" "$(uname -s)"

# ============================================================
#  UPDATE-ONLY PATH
# ============================================================
if [ "$UPDATE_ONLY" -eq 1 ]; then
    step "Updating yt-dlp"
    if [ -x "$VENV/bin/pip" ]; then
        "$VENV/bin/pip" install -q -U "yt-dlp[default,curl-cffi]" yt-dlp-ejs \
            || "$VENV/bin/pip" install -q -U yt-dlp
        ok "$("$VENV/bin/yt-dlp" --version 2>/dev/null || echo unknown)"
    else
        warn "no virtualenv yet — run ./setup.sh first"
    fi

    step "Updating node packages"
    npm install --omit=dev --no-audit --no-fund
    ok "node_modules refreshed"

    step "Checking syntax"
    node --check backend.js
    while IFS= read -r f; do node --check "$f"; done < <(find bot -name '*.js' -type f)
    ok "all files parse"

    step "Restarting services"
    if have pm2; then
        pm2 restart ecosystem.config.js --update-env >/dev/null 2>&1 || pm2 start ecosystem.config.js
        pm2 save >/dev/null 2>&1 || true
        ok "pm2 reloaded"
    else
        warn "pm2 is not installed"
    fi

    printf '\n%s✓ Update complete%s\n\n' "$G" "$N"
    exit 0
fi

# ============================================================
#  INSTALL
# ============================================================
if [ "$DO_INSTALL" -eq 1 ]; then

    # ---------- 1. system packages ----------
    step "System packages"
    if [ "$DO_APT" -eq 1 ] && have apt-get; then
        $SUDO apt-get update -qq
        $SUDO apt-get install -y -qq \
            ca-certificates curl unzip \
            python3 python3-venv python3-pip \
            ffmpeg
        ok "curl, unzip, python3-venv, ffmpeg"
    else
        warn "skipping apt — make sure python3-venv, ffmpeg and unzip exist"
    fi

    # ---------- 2. node ----------
    step "Node.js ${NODE_MAJOR_MIN}+"
    NODE_OK=0
    if have node; then
        CURRENT="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
        if [ "$CURRENT" -ge "$NODE_MAJOR_MIN" ] 2>/dev/null; then
            NODE_OK=1
            ok "node $(node -v) already installed"
        else
            warn "node $(node -v) is too old"
        fi
    fi

    if [ "$NODE_OK" -eq 0 ]; then
        have curl || die "curl is required to install node"
        printf '   installing node 20 from NodeSource…\n'
        curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash - >/dev/null
        $SUDO apt-get install -y -qq nodejs
        have node || die "node install failed — install it manually and re-run"
        ok "node $(node -v)"
    fi

    # ---------- 3. yt-dlp ----------
    step "yt-dlp (in a private virtualenv)"
    # Debian 12 marks the system python as externally-managed, so a venv is the
    # only clean way to pip-install. It also keeps yt-dlp updatable without sudo.
    if [ ! -x "$VENV/bin/python" ]; then
        python3 -m venv "$VENV" || die "could not create a virtualenv (install python3-venv)"
    fi

    "$VENV/bin/pip" install -q -U pip wheel >/dev/null 2>&1 || true

    if "$VENV/bin/pip" install -q -U "yt-dlp[default,curl-cffi]" yt-dlp-ejs; then
        ok "yt-dlp with curl-cffi (browser impersonation) + EJS"
    elif "$VENV/bin/pip" install -q -U "yt-dlp[default]" yt-dlp-ejs; then
        warn "curl-cffi unavailable — installed yt-dlp without impersonation"
    else
        "$VENV/bin/pip" install -q -U yt-dlp || die "yt-dlp install failed"
        warn "installed bare yt-dlp"
    fi

    # backend.js looks in its own folder first, so a symlink here wins over PATH.
    ln -sfn "$VENV/bin/yt-dlp" "$DIR/yt-dlp"
    ok "yt-dlp $("$DIR/yt-dlp" --version 2>/dev/null || echo '?') linked at ./yt-dlp"

    # ---------- 4. deno ----------
    step "Deno (YouTube 'n challenge' solver)"
    # Without a JS runtime YouTube hands back storyboards only and every format
    # selector fails. Deno is the runtime yt-dlp prefers; node is the fallback.
    if [ -x "$DIR/deno" ]; then
        ok "already present: $("$DIR/deno" --version 2>/dev/null | head -1)"
    else
        case "$(uname -m)" in
            aarch64|arm64) DENO_TARGET="aarch64-unknown-linux-gnu" ;;
            x86_64|amd64)  DENO_TARGET="x86_64-unknown-linux-gnu" ;;
            *)             DENO_TARGET="" ;;
        esac

        if [ -z "$DENO_TARGET" ]; then
            warn "no deno build for $(uname -m) — yt-dlp will fall back to node"
        else
            DENO_URL="https://github.com/denoland/deno/releases/latest/download/deno-${DENO_TARGET}.zip"
            if curl -fsSL --retry 3 -o "$DIR/deno.zip" "$DENO_URL"; then
                unzip -oq "$DIR/deno.zip" -d "$DIR"
                rm -f "$DIR/deno.zip"
                chmod +x "$DIR/deno"
                ok "$("$DIR/deno" --version 2>/dev/null | head -1)"
            else
                rm -f "$DIR/deno.zip"
                warn "deno download failed — yt-dlp will fall back to node"
            fi
        fi
    fi

    # ---------- 5. node packages ----------
    step "Node packages"
    npm install --omit=dev --no-audit --no-fund
    ok "express, telegraf, dotenv, cors, node-cron"

    # ---------- 6. pm2 ----------
    step "pm2 (keeps everything running 24/7)"
    if have pm2; then
        ok "pm2 $(pm2 -v 2>/dev/null) already installed"
    else
        if $SUDO npm install -g pm2 --no-audit --no-fund >/dev/null 2>&1; then
            ok "pm2 $(pm2 -v 2>/dev/null) installed"
        else
            warn "global pm2 install failed — try: sudo npm install -g pm2"
        fi
    fi

    # ---------- 7. folders ----------
    step "Folders"
    mkdir -p "$DIR/data" "$DIR/downloads" "$DIR/bot_tmp" "$DIR/logs"
    ok "data, downloads, bot_tmp, logs"

    # ---------- 8. .env ----------
    step "Configuration"
    if [ ! -f "$DIR/.env" ]; then
        cp "$DIR/.env.example" "$DIR/.env"
        chmod 600 "$DIR/.env"
        warn ".env created from the template — it still needs your tokens"
    else
        chmod 600 "$DIR/.env" 2>/dev/null || true
        ok ".env already exists (left untouched)"
    fi

    ENV_READY=1
    get_env() { grep -E "^$1=" "$DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'\''[:space:]'; }

    [ -z "$(get_env BOT_TOKEN)" ] && { warn "BOT_TOKEN is empty"; ENV_READY=0; }
    [ -z "$(get_env OWNER_ID)" ] && { warn "OWNER_ID is empty"; ENV_READY=0; }
    [ -z "$(get_env GROQ_API_KEY_1)" ] && warn "no AI key set — AI features will be disabled"
    [ "$ENV_READY" -eq 1 ] && ok "BOT_TOKEN and OWNER_ID are set"

    # ---------- 9. cookies ----------
    step "Cookies"
    if [ -s "$DIR/youtube.txt" ]; then
        COOKIE_LINES="$(grep -cve '^\s*#' -e '^\s*$' "$DIR/youtube.txt" 2>/dev/null || echo 0)"
        ok "youtube.txt present ($COOKIE_LINES cookies)"
    elif [ -f "$DIR/youtube.txt" ]; then
        warn "youtube.txt exists but is EMPTY — yt-dlp aborts on an empty jar, delete it or replace it"
    else
        warn "no youtube.txt yet — upload one from the bot: Owner Panel → Cookies"
    fi

    # ---------- 10. syntax check ----------
    step "Syntax check"
    node --check backend.js || die "backend.js has a syntax error"
    FILE_COUNT=0
    while IFS= read -r f; do
        node --check "$f" || die "$f has a syntax error"
        FILE_COUNT=$((FILE_COUNT + 1))
    done < <(find bot -name '*.js' -type f)
    node --check ecosystem.config.js
    ok "backend.js + $FILE_COUNT bot files parse cleanly"
fi

# ---------- 11. start ----------
if [ "$DO_INSTALL" -eq 0 ]; then TOTAL_STEPS=2; STEP=0; fi

step "Starting services"

if ! have pm2; then
    warn "pm2 missing — start manually with:  node backend.js  and  node bot/index.js"
elif [ "$DO_START" -eq 0 ]; then
    warn "skipped (--no-start). Start later with:  pm2 start ecosystem.config.js"
elif [ "${ENV_READY:-1}" -eq 0 ]; then
    warn "not starting: fill BOT_TOKEN and OWNER_ID in .env first, then run ./setup.sh --start"
else
    pm2 delete raix-api raix-bot >/dev/null 2>&1 || true
    pm2 start ecosystem.config.js
    pm2 save >/dev/null 2>&1 || true
    ok "raix-api and raix-bot are running"

    step "Boot persistence"
    if [ -n "$SUDO" ] || [ "$(id -u)" -eq 0 ]; then
        STARTUP_CMD="$(pm2 startup systemd -u "${SUDO_USER:-$USER}" --hp "$HOME" 2>/dev/null | grep -E '^\s*sudo ' | head -1 || true)"
        if [ -n "$STARTUP_CMD" ]; then
            if eval "$STARTUP_CMD" >/dev/null 2>&1; then
                pm2 save >/dev/null 2>&1 || true
                ok "services will come back automatically after a reboot"
            else
                warn "could not register the boot service — run this yourself:"
                printf '       %s\n' "$STARTUP_CMD"
            fi
        else
            ok "boot service already registered"
        fi
    else
        warn "no sudo — run 'pm2 startup' yourself to survive reboots"
    fi
fi

# ============================================================
#  SUMMARY
# ============================================================
printf '\n%s╭──────────────────────────────────────────────╮%s\n' "$B" "$N"
printf '%s│                 All done                      │%s\n' "$B" "$N"
printf '%s╰──────────────────────────────────────────────╯%s\n' "$B" "$N"

if [ "${ENV_READY:-1}" -eq 0 ]; then
    printf '\n%sBefore the bot can start:%s\n' "$Y" "$N"
    printf '  1. Open %s.env%s\n' "$B" "$N"
    printf '  2. Set %sBOT_TOKEN%s      (from @BotFather)\n' "$B" "$N"
    printf '  3. Set %sOWNER_ID%s       (send /id to your bot, or @userinfobot)\n' "$B" "$N"
    printf '  4. Set %sGROQ_API_KEY_1%s (free at https://console.groq.com/keys)\n' "$B" "$N"
    printf '  5. Run %s./setup.sh --start%s\n' "$B" "$N"
fi

printf '\n%sEveryday commands%s\n' "$B" "$N"
printf '  pm2 logs raix-bot        follow the bot\n'
printf '  pm2 logs raix-api        follow the backend\n'
printf '  pm2 restart raix-bot     restart the bot\n'
printf '  pm2 monit                live resource view\n'
printf '  ./setup.sh --update      update yt-dlp + deps, then restart\n'

printf '\n%sIn Telegram%s\n' "$B" "$N"
printf '  /start                   open the menu\n'
printf '  /id                      show your Telegram id\n'
printf '  Owner Panel → Cookies    upload youtube.txt straight from your phone\n\n'
