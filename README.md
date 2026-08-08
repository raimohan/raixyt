<p align="center">
  <img src="https://img.shields.io/badge/RaiX-Studio-blueviolet?style=for-the-badge&logo=telegram&logoColor=white" alt="RaiX Studio" />
</p>

<h1 align="center">RaiX — Your AI-Powered Telegram Studio</h1>

<p align="center">
  <strong>Download · Clip · Summarize · Study · Chat — all from Telegram.</strong>
</p>

<p align="center">
  <a href="https://github.com/raimohan/raixyt/stargazers"><img src="https://img.shields.io/github/stars/raimohan/raixyt?style=flat-square&color=f5c542" alt="Stars" /></a>
  <a href="https://github.com/raimohan/raixyt/network/members"><img src="https://img.shields.io/github/forks/raimohan/raixyt?style=flat-square&color=4fc3f7" alt="Forks" /></a>
  <a href="https://github.com/raimohan/raixyt/issues"><img src="https://img.shields.io/github/issues/raimohan/raixyt?style=flat-square&color=ef5350" alt="Issues" /></a>
  <a href="https://github.com/raimohan/raixyt/blob/main/LICENSE"><img src="https://img.shields.io/github/license/raimohan/raixyt?style=flat-square&color=66bb6a" alt="License" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node" />
  <img src="https://img.shields.io/badge/platform-Linux%20%7C%20Raspberry%20Pi-orange?style=flat-square&logo=linux&logoColor=white" alt="Platform" />
</p>

<p align="center">
  <a href="#-features">Features</a> •
  <a href="#-quick-start">Quick Start</a> •
  <a href="#%EF%B8%8F-configuration">Configuration</a> •
  <a href="#-architecture">Architecture</a> •
  <a href="#-commands">Commands</a> •
  <a href="#-troubleshooting">Troubleshooting</a> •
  <a href="#-contributing">Contributing</a>
</p>

---

## 🚀 What is RaiX?

**RaiX** is a self-hosted, button-driven Telegram bot that turns any video link into actionable content — downloads, clips, AI summaries, interactive quizzes, flashcards, and more. It is designed to run 24/7 on a **Raspberry Pi** or any Linux VPS with zero maintenance.

No commands to memorize. Paste a link → pick an action → done.

> **Two services, one folder.** The Express API backend (`backend.js`) handles yt-dlp, ffmpeg, and AI. The Telegram bot (`bot/`) presents it all through inline buttons. Both run under PM2 and share a single `.env`.

---

## ✨ Features

<table>
<tr>
<td width="50%">

### 🎬 Video & Music
- **Search YouTube** directly from Telegram
- **Download** in any quality (360p → 1080p)
- **Audio-only** extraction (MP3/M4A)
- **Playlist** browsing & batch downloads
- **Multi-platform** — YouTube, Instagram, Twitter/X, TikTok, Facebook, Vimeo, Pinterest, Snapchat

</td>
<td width="50%">

### ✂️ Clip Studio
- **Trim** any video to a 60-second clip
- **Reframe** to 9:16 (Shorts/Reels) or 1:1 (Feed)
- **AI Viral Finder** — automatically locates the most engaging 30 seconds
- Accepts flexible time formats: `90`, `1:30`, `0:01:30`

</td>
</tr>
<tr>
<td>

### 🧠 AI Studio
- **Summarize** — brief, detailed, key points, or timestamped chapters
- **Generate titles** — viral, curiosity, how-to, or listicle tones
- **Generate tags** — 15 SEO-optimized tags from any title
- **Write descriptions** — with timestamps, hashtags, CTAs, custom keywords
- Powered by **Groq** (free) or **OpenRouter** with multi-key failover

</td>
<td>

### 📚 Study Tools
- **Full transcript** — timestamped spoken text, downloadable
- **Class notes** — AI-structured revision notes
- **Interactive quiz** — 5 exam-style MCQs played inside Telegram
- **Flashcards** — tap to flip, swipe through the deck
- **Study planner** — paced daily schedule for any course

</td>
</tr>
<tr>
<td>

### 💬 Video Chat
- **Ask questions** about any video's content
- AI reads the transcript and answers in context
- Maintains chat history within the session

</td>
<td>

### 🛡️ Access Control & Admin
- **Private by default** — only the owner can use it
- **Request/Approve** flow for new users
- **Role system** — Owner, Admin, User
- **Owner Panel** — manage users, cookies, restart services, view stats
- **Cookie upload** — update yt-dlp cookies straight from your phone

</td>
</tr>
</table>

---

## 📦 Quick Start

### Prerequisites

| Requirement | Minimum | Notes |
|:---|:---|:---|
| **OS** | Debian 11+ / Ubuntu 20.04+ / Raspberry Pi OS | Any Linux with `apt` |
| **Node.js** | v18+ | Installed automatically by `setup.sh` |
| **RAM** | 1 GB | 2 GB+ recommended for concurrent clips |

### One-Command Install

```bash
git clone https://github.com/raimohan/raixyt.git
cd raixyt
chmod +x setup.sh
./setup.sh
```

The setup script automatically installs:

| Component | Purpose |
|:---|:---|
| **Node.js 20** | Runtime for backend + bot |
| **yt-dlp** | Video extraction (private virtualenv) |
| **ffmpeg** | Audio/video muxing & clip re-encoding |
| **Deno** | YouTube n-challenge solver |
| **PM2** | Process manager — keeps everything alive 24/7 |

### Configure

After setup, edit `.env` with your tokens:

```env
# Required
BOT_TOKEN=your-token-from-botfather
OWNER_ID=your-telegram-numeric-id

# AI (free tier is enough)
GROQ_API_KEY_1=your-groq-api-key
```

Then start:

```bash
./setup.sh --start
```

> **💡 Tip:** Send `/id` to your bot (or to [@userinfobot](https://t.me/userinfobot)) to find your numeric Telegram ID.

### Setup Modes

```bash
./setup.sh                # Full install + start
./setup.sh --no-start     # Install only, configure later
./setup.sh --start        # Skip install, just (re)start services
./setup.sh --update       # Update yt-dlp + npm deps + restart
./setup.sh --skip-apt     # Skip apt packages (re-runs)
```

---

## ⚙️ Configuration

All configuration lives in a single `.env` file. Copy from the template:

```bash
cp .env.example .env
```

<details>
<summary><b>📋 Full Environment Variable Reference</b></summary>

### Telegram Bot

| Variable | Required | Default | Description |
|:---|:---:|:---|:---|
| `BOT_TOKEN` | ✅ | — | Token from [@BotFather](https://t.me/BotFather) |
| `OWNER_ID` | ✅ | — | Your numeric Telegram ID |
| `ADMIN_IDS` | | — | Comma-separated admin IDs |
| `OPEN_ACCESS` | | `false` | Set `true` to allow anyone |
| `BOT_NAME` | | `RaiX Studio` | Shown in the welcome screen |

### Backend API

| Variable | Required | Default | Description |
|:---|:---:|:---|:---|
| `PORT` | | `3000` | API server port |
| `API_BASE` | | `http://127.0.0.1:3000` | Bot → backend URL |
| `ADMIN_TOKEN` | | — | Token for `/api/admin/*` routes |

### AI Provider

| Variable | Default | Description |
|:---|:---|:---|
| `GROQ_API_KEY_1` … `_10` | — | Up to 10 Groq keys (auto-rotate) |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | Primary model |
| `GROQ_MODEL_FALLBACKS` | `llama-3.3-70b-versatile,llama-3.1-8b-instant` | Fallback chain |
| `AI_PROVIDER` | auto-detect | Force `groq` or `openrouter` |
| `OPENROUTER_API_KEY_1` … `_5` | — | Up to 5 OpenRouter keys |

### Performance Tuning

| Variable | Default | Description |
|:---|:---|:---|
| `MAX_UPLOAD_MB` | `49` | Telegram's 50 MB bot upload limit |
| `MAX_CONCURRENT_JOBS` | `2` | Simultaneous heavy jobs |
| `THROTTLE_MAX` | `4` | Rate limit per window |
| `THROTTLE_WINDOW_MS` | `1000` | Rate limit window |
| `API_TIMEOUT_MS` | `180000` | API call timeout |
| `DOWNLOAD_IDLE_TIMEOUT_MS` | `240000` | Stalled transfer timeout |

</details>

---

## 🏗 Architecture

```
raixyt/
│
├── backend.js                 # Express API server (yt-dlp + AI + clips)
├── ecosystem.config.js        # PM2 process definitions
├── setup.sh                   # One-shot installer
├── package.json
├── .env.example               # Configuration template
│
└── bot/                       # Telegram bot (Telegraf)
    ├── index.js               # Entry point, middleware, graceful shutdown
    ├── config.js              # Environment parsing & validation
    │
    ├── api/
    │   └── client.js          # Typed HTTP wrapper over backend.js
    │
    ├── core/
    │   ├── router.js          # Callback/text/document dispatch + error boundary
    │   ├── flow.js            # Shared "send me a link / text" prompts
    │   ├── cache.js           # Token store for oversized callback payloads
    │   ├── session.js         # Per-user state & chat history
    │   └── queue.js           # Concurrency limiter for heavy jobs
    │
    ├── middleware/
    │   ├── auth.js            # Access gate (owner → admin → user)
    │   └── throttle.js        # Per-user rate limiter
    │
    ├── services/
    │   ├── users.js           # User registry & persistence
    │   ├── prefs.js           # Per-user preferences
    │   ├── stats.js           # Usage counters
    │   └── downloads.js       # Streaming download pipeline
    │
    ├── ui/
    │   ├── render.js          # Message renderer & progress bars
    │   ├── keyboards.js       # Inline keyboard builder
    │   └── text.js            # Shared copy & formatting
    │
    └── features/              # Self-registering feature modules
        ├── home.js            # Main menu & welcome screen
        ├── video.js           # 🎬 Video search & download
        ├── music.js           # 🎵 Music search & download
        ├── downloader.js      # ⬇️ Universal link downloader
        ├── clip.js            # ✂️ Clip Studio (trim + reframe)
        ├── subtitles.js       # 📝 Subtitle extraction
        ├── ai.js              # 🧠 AI Studio (summarize, tags, titles, descriptions)
        ├── study.js           # 📚 Study tools (quiz, flashcards, notes, plan)
        ├── chat.js            # 💬 Video Chat (conversational Q&A)
        ├── analytics.js       # 📊 Channel & video insights
        ├── course.js          # 🎓 Course discovery
        ├── settings.js        # ⚙️ User preferences
        └── admin.js           # 🛠 Owner Panel (users, cookies, services)
```

### How It Works

```
┌──────────────┐      HTTP/JSON      ┌──────────────────┐
│              │ ◄──────────────────► │                  │
│  Telegram    │                     │   backend.js     │
│  Bot (bot/)  │                     │   (Express API)  │
│              │                     │                  │
│  • Telegraf  │                     │  • yt-dlp        │
│  • Buttons   │                     │  • ffmpeg        │
│  • Sessions  │                     │  • Groq/OpenRouter│
│  • Progress  │                     │  • Cron jobs     │
│              │                     │                  │
└──────┬───────┘                     └────────┬─────────┘
       │                                      │
       │  Telegram Bot API                    │  Spawns
       ▼                                      ▼
  ┌──────────┐                         ┌─────────────┐
  │ Telegram │                         │ yt-dlp      │
  │ Servers  │                         │ ffmpeg      │
  └──────────┘                         │ deno/node   │
                                       └─────────────┘
```

> **Adding a feature** = one file in `bot/features/`, register routes with `router.onMany({...})`, add a button to the home menu. Nothing else changes.

---

## 🔧 Commands

### Telegram Commands

| Command | Description |
|:---|:---|
| `/start` | Open the main menu |
| `/menu` | Back to the main menu |
| `/id` | Show your Telegram ID |
| `/cancel` | Cancel the current action |

### PM2 Management

```bash
pm2 logs raix-bot          # Follow bot logs
pm2 logs raix-api          # Follow API logs
pm2 restart raix-bot       # Restart the bot
pm2 restart raix-api       # Restart the API
pm2 monit                  # Live CPU/RAM dashboard
pm2 status                 # Process overview
```

> **💡 Pro tip:** The Owner Panel can restart either service directly from your phone — no SSH needed.

---

## 🍪 Cookie Management

The backend uses **Netscape-format** cookie files for authenticated downloads.

| File | Platforms |
|:---|:---|
| `youtube.txt` | YouTube, Twitter/X, TikTok, Facebook, Vimeo, Pinterest, Snapchat |
| `instagram.txt` | Instagram |

### How to Update Cookies

1. Install a **"Get cookies.txt LOCALLY"** browser extension
2. Log in to the platform and export cookies
3. Upload via Telegram: **Owner Panel → 🍪 Cookies → Upload**

The file is validated, written with `0600` permissions, and picked up immediately — no restart needed.

> **⚠️ Warning:** An **empty** cookie file is worse than none — yt-dlp aborts on a rejected jar instead of falling back to anonymous access. Delete empty cookie files.

---

## 🔌 Supported Platforms

| Platform | Download | Cookies Needed |
|:---:|:---:|:---:|
| YouTube | ✅ | Recommended |
| Instagram | ✅ | Required |
| Twitter / X | ✅ | Recommended |
| TikTok | ✅ | Optional |
| Facebook | ✅ | Optional |
| Vimeo | ✅ | Optional |
| Pinterest | ✅ | Optional |
| Snapchat | ✅ | Optional |

> Powered by [yt-dlp](https://github.com/yt-dlp/yt-dlp) — any site yt-dlp supports will work.

---

## 🐛 Troubleshooting

<details>
<summary><b>Bot starts then exits immediately</b></summary>

`BOT_TOKEN` or `OWNER_ID` is missing or invalid.

```bash
pm2 logs raix-bot --lines 20
```

Check `.env` for empty values. Get a fresh token from [@BotFather](https://t.me/BotFather).
</details>

<details>
<summary><b>"The backend is not reachable"</b></summary>

The API server isn't running.

```bash
pm2 start raix-api
curl http://localhost:3000/health
```
</details>

<details>
<summary><b>Every YouTube download fails</b></summary>

Usually means no JavaScript runtime for the YouTube `n` challenge solver.

```bash
./deno --version        # Should print deno version
./setup.sh --update     # Re-install if missing
```

Check logs for: `"n challenge solving failed"` — this confirms the runtime is missing.
</details>

<details>
<summary><b>"Sign in to confirm you're not a bot"</b></summary>

Cookies are stale. Re-export from your browser and upload via **Owner Panel → Cookies**.
</details>

<details>
<summary><b>Downloads are slow</b></summary>

Expected on a Raspberry Pi for 1080p — yt-dlp downloads video + audio separately, then ffmpeg muxes them. **720p is ~3× faster.**
</details>

<details>
<summary><b>Out-of-memory restarts</b></summary>

Lower the concurrency in `.env`:

```env
MAX_CONCURRENT_JOBS=1
```
</details>

---

## 🤝 Contributing

Contributions are welcome! Here's how:

1. **Fork** the repository
2. **Create** a feature branch (`git checkout -b feature/amazing-feature`)
3. **Commit** your changes (`git commit -m 'Add amazing feature'`)
4. **Push** to the branch (`git push origin feature/amazing-feature`)
5. **Open** a Pull Request

### Development

```bash
# Check all files for syntax errors
npm run check

# Start the backend only
npm start

# Start the bot only
npm run bot
```

---

## 📄 License

This project is open source. See the [LICENSE](LICENSE) file for details.

---

## 👤 Author

<table>
<tr>
<td align="center">
<a href="https://github.com/raimohan">
<img src="https://github.com/raimohan.png" width="100px;" alt="raimohan" style="border-radius:50%;" /><br />
<sub><b>@raimohan</b></sub>
</a>
</td>
</tr>
</table>

---

<p align="center">
  <b>If you found this useful, consider giving it a ⭐</b>
</p>

<p align="center">
  <a href="https://github.com/raimohan/raixyt">
    <img src="https://img.shields.io/badge/GitHub-raixyt-181717?style=for-the-badge&logo=github" alt="GitHub" />
  </a>
</p>
