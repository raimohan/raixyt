# RaiX Telegram Bot

A button-driven Telegram front end for the `backend.js` API. No commands to
memorise — every feature is reachable by tapping, and pasting any video link
brings up a quick-action card.

Built for a Raspberry Pi 4: two concurrent heavy jobs, streaming downloads that
never buffer a whole file in RAM, and a token cache so a 15-result search does
not blow past Telegram's 64-byte button limit.

---

## Install

```bash
cd /home/anonymous/Bot
./setup.sh
```

That installs ffmpeg, Node 20, yt-dlp (in a private virtualenv), Deno, the npm
packages and pm2, then starts both services and registers them to survive a
reboot.

Then fill in `.env`:

| Key | What it is |
|---|---|
| `BOT_TOKEN` | From [@BotFather](https://t.me/BotFather) |
| `OWNER_ID` | Your numeric Telegram id — send `/id` to your bot |
| `GROQ_API_KEY_1` | Free key from [console.groq.com/keys](https://console.groq.com/keys) |

```bash
./setup.sh --start
```

### Other setup modes

```bash
./setup.sh --update     # refresh yt-dlp + npm deps, restart services
./setup.sh --no-start   # install only
./setup.sh --start      # skip install, just (re)start
./setup.sh --skip-apt   # leave apt alone
```

---

## Access control

The bot is private. Only `OWNER_ID` can use it until you add people.

A stranger who opens the bot sees one button: **Request access**. That pings you
with Approve / Deny / Block. You can also add someone directly from
**Owner Panel → Add user** with their numeric id.

- `OWNER_ID` — full control, including roles and service restarts
- `ADMIN_IDS` — can manage users and cookies, cannot promote or restart
- `OPEN_ACCESS=true` — drops the gate entirely (not recommended)

State lives in `data/users.json`.

---

## Cookies

The backend reads `youtube.txt` and `instagram.txt` from its own folder.
`youtube.txt` is also what it uses for X/Twitter, TikTok, Facebook, Vimeo,
Pinterest and Snapchat.

**Upload from your phone:** Owner Panel → 🍪 Cookies → Upload youtube → send the
file as a document. It is validated as Netscape format, written with `0600`
permissions, and picked up on the next request — no restart.

Export with a *Get cookies.txt LOCALLY* browser extension while logged in.
JSON cookie exports are rejected; yt-dlp only reads Netscape format.

> An **empty** cookie file is worse than none — yt-dlp aborts the whole
> extraction on a rejected jar. The Cookies screen flags this.

---

## What the bot does

| Module | Backend routes |
|---|---|
| 🎬 Video | `/api/video/search`, `/info`, `/playlist` |
| 🎵 Music | `/api/music/search`, `/playlist`, `/download`, `/stream` |
| ⬇️ Downloader | `/api/analyze`, `/api/download` |
| ✂️ Clip Studio | `/api/clip`, `/clip/status/:id`, `/clip/download/:id` |
| 📝 Subtitles | `/api/subtitles`, `/preview`, `/download` |
| 🧠 AI Studio | `/api/summarize`, `/viral`, `/tags`, `/titles`, `/description` |
| 📚 Study | `/api/transcript`, `/quiz`, `/flashcards`, `/ai-notes`, `/plan` |
| 💬 Video Chat | `/api/chat/info`, `/api/chat` |
| 📊 Insights | `/api/metadata`, `/thumbnail`, `/channel/analyze` |
| 🎓 Courses | `/api/course/search`, `/course/resolve` |
| 🛠 Owner Panel | `/health` + local user, cookie and pm2 management |

Nice touches worth knowing about:

- **Quiz** is played inside Telegram — tap an answer, see the verdict and the
  explanation, then a score card at the end.
- **Flashcards** flip in place and reset when you move to the next card.
- **Clip Studio** accepts `90`, `1:30` or `0:01:30` for timestamps, and can hand
  the range over to the AI viral-moment finder.
- Files over **49 MB** cannot be uploaded by any Telegram bot. Instead of
  failing, the bot resolves a direct CDN link and sends that.

---

## Day to day

```bash
pm2 logs raix-bot        # follow the bot
pm2 logs raix-api        # follow the backend
pm2 restart raix-bot
pm2 monit                # live CPU/RAM
pm2 status
```

The Owner Panel can restart either service from your phone.

---

## Layout

```
bot/
├── index.js              entry point, middleware order, graceful shutdown
├── config.js             env parsing + validation
├── api/client.js         typed wrapper over backend.js, streaming downloads
├── core/
│   ├── router.js         callback/text/document dispatch, error boundary
│   ├── flow.js           shared "send me a link / send me text" prompts
│   ├── cache.js          token store — payloads too big for callback_data
│   ├── session.js        per-user waiting state and chat history
│   └── queue.js          concurrency limiter for heavy jobs
├── middleware/           auth gate, rate limiter
├── services/             users, prefs, stats, download pipeline
├── ui/                   keyboards, renderer, progress bars, copy
└── features/             one module per menu, each self-registering
```

Adding a feature means creating one file in `features/`, registering its routes
with `router.onMany({...})`, and adding a button. Nothing else needs to change.

---

## Troubleshooting

**Bot starts then exits** — `BOT_TOKEN` or `OWNER_ID` is missing. `pm2 logs
raix-bot` names the one that is wrong.

**"The backend is not reachable"** — `pm2 start raix-api`, then check
`curl localhost:3000/health`.

**Every YouTube download fails** — usually no JS runtime, so YouTube returns
only storyboards. Check `./deno --version`; re-run `./setup.sh` if it is
missing.

**"Sign in to confirm you're not a bot"** — cookies are stale. Re-export and
upload them through the Owner Panel.

**Downloads are slow** — expected on a Pi for 1080p merges; yt-dlp downloads
video and audio separately then muxes with ffmpeg. 720p is roughly 3× faster.

**Out-of-memory restarts** — lower `MAX_CONCURRENT_JOBS` to `1` in `.env`.
