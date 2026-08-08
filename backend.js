const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const cors = require('cors');
const crypto = require('crypto');

const ENV_PATH = process.env.ENV_FILE || path.join(__dirname, '.env');
const envResult = require('dotenv').config({ path: ENV_PATH, override: true });

if (envResult.error) {
    console.warn(`⚠️  No .env loaded from ${ENV_PATH} (${envResult.error.code || 'unreadable'})`);
    console.warn('    Values already exported in the environment still apply.');
} else {
    console.log(`📄 Loaded ${Object.keys(envResult.parsed || {}).length} settings from ${ENV_PATH}`);
}

const app = express();
app.use(cors({ exposedHeaders: ['Content-Disposition'] }));
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;

const AI_PROVIDERS = {
    groq: {
        label: 'Groq',
        endpoint: 'https://api.groq.com/openai/v1/chat/completions',
        keyPrefix: 'GROQ_API_KEY',
        maxKeys: 10,
        modelEnv: 'GROQ_MODEL',
        defaultModel: 'llama-3.3-70b-versatile',
        fallbacksEnv: 'GROQ_MODEL_FALLBACKS',
        defaultFallbacks: 'llama-3.3-70b-versatile,llama-3.1-8b-instant',
        headers: () => ({})
    },
    openrouter: {
        label: 'OpenRouter',
        endpoint: 'https://openrouter.ai/api/v1/chat/completions',
        keyPrefix: 'OPENROUTER_API_KEY',
        maxKeys: 5,
        modelEnv: 'OPENROUTER_MODEL',
        defaultModel: 'openrouter/auto',
        fallbacksEnv: 'OPENROUTER_MODEL_FALLBACKS',
        defaultFallbacks: 'openrouter/auto',
        headers: (opts) => ({
            'HTTP-Referer': opts.referer || process.env.APP_REFERER || 'https://raix.app',
            'X-Title': opts.title || 'RaiX App'
        })
    }
};

function readKeys(provider) {
    const keys = [];
    for (let i = 1; i <= provider.maxKeys; i++) {
        const key = process.env[`${provider.keyPrefix}_${i}`]
            || (i === 1 ? process.env[provider.keyPrefix] : null);
        if (key && key.trim()) keys.push(key.trim());
    }
    return keys;
}

function pickProvider() {
    const forced = (process.env.AI_PROVIDER || '').trim().toLowerCase();
    if (forced && AI_PROVIDERS[forced]) return forced;
    if (readKeys(AI_PROVIDERS.groq).length > 0) return 'groq';
    if (readKeys(AI_PROVIDERS.openrouter).length > 0) return 'openrouter';
    return 'groq';
}

const PROVIDER_NAME = pickProvider();
const PROVIDER = AI_PROVIDERS[PROVIDER_NAME];

const AI_MODEL = (process.env[PROVIDER.modelEnv] || PROVIDER.defaultModel).trim();
const MODEL_FALLBACKS = (process.env[PROVIDER.fallbacksEnv] || PROVIDER.defaultFallbacks)
    .split(',').map(m => m.trim()).filter(Boolean);

let activeModel = AI_MODEL;

function nextModelAfter(dead) {
    for (const m of MODEL_FALLBACKS) {
        if (m !== dead) return m;
    }
    return null;
}

class AIKeyManager {
    constructor(provider) {
        this.provider = provider;
        this.keys = readKeys(provider);
        this.currentKeyIndex = 0;
        this.keyStatus = new Map();

        this.keys.forEach((_, i) => {
            this.keyStatus.set(i, { lastError: null, failCount: 0, isBlacklisted: false });
        });

        if (this.keys.length === 0) {
            console.warn(`⚠️ No ${provider.label} API keys found! AI features will be disabled.`);
            console.warn(`💡 Set ${provider.keyPrefix}_1 … ${provider.keyPrefix}_${provider.maxKeys} in ${ENV_PATH}`);
        } else {
            console.log(`✅ Loaded ${this.keys.length} ${provider.label} API key(s) · model: ${AI_MODEL}`);
        }
    }

    getCurrentKey() {
        if (this.keys.length === 0) return null;

        for (let i = 0; i < this.keys.length; i++) {
            const index = (this.currentKeyIndex + i) % this.keys.length;
            if (!this.keyStatus.get(index).isBlacklisted) {
                this.currentKeyIndex = index;
                return this.keys[index];
            }
        }

        console.warn('⚠️ All API keys blacklisted. Resetting blacklist...');
        this.keyStatus.forEach((status) => {
            status.isBlacklisted = false;
            status.failCount = 0;
        });

        return this.keys[0];
    }

    markCurrentKeyAsFailed(error) {
        if (this.keys.length === 0) return;

        const status = this.keyStatus.get(this.currentKeyIndex);
        status.lastError = new Date();
        status.failCount++;

        const keyPreview = this.keys[this.currentKeyIndex].substring(0, 10) + '...';
        console.error(`❌ API Key ${this.currentKeyIndex + 1} failed (${keyPreview}): ${error}`);
        console.error(`   Fail count: ${status.failCount}`);

        if (status.failCount >= 3) {
            status.isBlacklisted = true;
            console.error(`🚫 API Key ${this.currentKeyIndex + 1} blacklisted after ${status.failCount} failures`);
        }

        this.switchToNextKey();
    }

    switchToNextKey() {
        if (this.keys.length <= 1) return;

        const oldIndex = this.currentKeyIndex;

        for (let i = 1; i <= this.keys.length; i++) {
            const nextIndex = (this.currentKeyIndex + i) % this.keys.length;
            if (!this.keyStatus.get(nextIndex).isBlacklisted) {
                this.currentKeyIndex = nextIndex;
                console.log(`🔄 Switched from API Key ${oldIndex + 1} to API Key ${nextIndex + 1}`);
                return;
            }
        }

        console.warn('⚠️ No available API keys to switch to!');
    }

    markCurrentKeyAsSuccess() {
        if (this.keys.length === 0) return;

        const status = this.keyStatus.get(this.currentKeyIndex);
        if (status.failCount > 0) {
            console.log(`✅ API Key ${this.currentKeyIndex + 1} recovered`);
            status.failCount = 0;
            status.isBlacklisted = false;
        }
    }

    hasAvailableKey() {
        return this.keys.length > 0;
    }

    getStatusSummary() {
        if (this.keys.length === 0) return 'No API keys configured';

        const summary = [];
        this.keyStatus.forEach((status, index) => {
            const keyPreview = this.keys[index].substring(0, 10) + '...';
            const state = status.isBlacklisted ? '🚫 BLACKLISTED'
                : status.failCount > 0 ? `⚠️ ${status.failCount} fails` : '✅ OK';
            summary.push(`Key ${index + 1} (${keyPreview}): ${state}`);
        });

        return summary.join('\n');
    }
}

const apiKeyManager = new AIKeyManager(PROVIDER);
const AI_READY = apiKeyManager.hasAvailableKey();

async function callAI(body, options = {}) {
    if (!apiKeyManager.hasAvailableKey()) {
        throw new Error(`No ${PROVIDER.label} API keys configured`);
    }

    const maxRetries = Math.max(apiKeyManager.keys.length, 1);
    let lastError = null;

    const payload = { ...body, model: options.model || activeModel };

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const apiKey = apiKeyManager.getCurrentKey();
        if (!apiKey) throw new Error(`No ${PROVIDER.label} API keys available`);

        try {
            const response = await fetch(PROVIDER.endpoint, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    ...PROVIDER.headers(options),
                    ...options.headers
                },
                body: JSON.stringify(payload)
            });

            if (response.status === 429) {
                const errorData = await response.json().catch(() => ({}));
                const errorMsg = errorData.error?.message || 'Rate limited';
                console.warn(`⏳ Key ${apiKeyManager.currentKeyIndex + 1} rate limited: ${errorMsg}`);
                lastError = new Error(errorMsg);
                apiKeyManager.switchToNextKey();
                continue;
            }

            if (response.status === 401 || response.status === 403) {
                const errorData = await response.json().catch(() => ({}));
                const errorMsg = errorData.error?.message || `HTTP ${response.status}`;
                console.error(`🔑 API key authentication failed: ${errorMsg}`);
                apiKeyManager.markCurrentKeyAsFailed(errorMsg);
                lastError = new Error(errorMsg);
                continue;
            }

            if (response.status >= 500) {
                const errorMsg = `${PROVIDER.label} server error (HTTP ${response.status})`;
                console.warn(`⚠️ ${errorMsg}`);
                lastError = new Error(errorMsg);
                apiKeyManager.switchToNextKey();
                continue;
            }

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                const errorMsg = errorData.error?.message || `HTTP ${response.status}`;

                if (/decommission|not (?:found|exist)|does not exist|invalid.*model|model.*invalid/i.test(errorMsg)) {
                    const replacement = nextModelAfter(payload.model);
                    if (replacement && !options.model) {
                        console.error(`🧠 Model "${payload.model}" unavailable (${errorMsg}). Falling back to "${replacement}" — update ${PROVIDER.modelEnv} in .env.`);
                        activeModel = replacement;
                        payload.model = replacement;
                        lastError = new Error(errorMsg);
                        continue;
                    }
                }
                throw new Error(errorMsg);
            }

            apiKeyManager.markCurrentKeyAsSuccess();
            return await response.json();

        } catch (error) {
            if (error instanceof TypeError || /fetch|network|ECONN|socket/i.test(error.message)) {
                console.error(`🌐 AI call attempt ${attempt + 1} network error: ${error.message}`);
                lastError = error;
                apiKeyManager.switchToNextKey();
                continue;
            }
            throw error;
        }
    }

    throw lastError || new Error('All API keys failed');
}

function stripThinking(text) {
    if (!text) return '';
    let out = String(text);
    out = out.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
    const lastOpen = out.lastIndexOf('<think');
    if (lastOpen !== -1 && !/<\/think/i.test(out.slice(lastOpen))) {
        out = out.slice(0, lastOpen);
    }
    return out.trim();
}

function contentOf(data) {
    return stripThinking(data?.choices?.[0]?.message?.content || '');
}

async function callForJson(systemPrompt, userPrompt, maxTokens, title) {
    const data = await callAI(
        {
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            max_tokens: maxTokens,
            temperature: 0.4
        },
        { title: title || 'Study Tools' }
    );

    const raw = contentOf(data);
    const firstBracket = raw.indexOf('[');
    const firstBrace = raw.indexOf('{');
    const start = firstBracket !== -1 && (firstBracket < firstBrace || firstBrace === -1)
        ? firstBracket : firstBrace;
    if (start === -1) throw new Error('Model did not return JSON');
    const end = raw.lastIndexOf(raw[start] === '[' ? ']' : '}');
    if (end === -1) throw new Error('Model did not return JSON');
    return JSON.parse(raw.slice(start, end + 1));
}

const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(__dirname, 'downloads');

const COOKIES_DIR = process.env.COOKIES_DIR || __dirname;

const APK_FILE = process.env.APK_FILE || path.join(__dirname, 'app-release.apk');
const APP_VERSION_FILE = process.env.APP_VERSION_FILE || path.join(__dirname, 'app_version.json');

const APP_PACKAGE = process.env.APP_PACKAGE || 'com.bennu.app';
const APP_NAME = process.env.APP_NAME || 'Bennu';

const PLATFORM_COOKIES = {
    youtube: path.join(COOKIES_DIR, 'youtube.txt'),
    instagram: path.join(COOKIES_DIR, 'instagram.txt'),
    twitter: path.join(COOKIES_DIR, 'youtube.txt'),
    x: path.join(COOKIES_DIR, 'youtube.txt'),
    pinterest: path.join(COOKIES_DIR, 'youtube.txt'),
    snapchat: path.join(COOKIES_DIR, 'youtube.txt'),
    tiktok: path.join(COOKIES_DIR, 'youtube.txt'),
    facebook: path.join(COOKIES_DIR, 'youtube.txt'),
    vimeo: path.join(COOKIES_DIR, 'youtube.txt')
};

const PLATFORM_PATTERNS = {
    youtube: ['youtube.com', 'youtu.be'],
    instagram: ['instagram.com'],
    twitter: ['twitter.com', 'x.com'],
    x: ['x.com'],
    snapchat: ['snapchat.com'],
    pinterest: ['pinterest.com'],
    tiktok: ['tiktok.com'],
    facebook: ['facebook.com', 'fb.watch'],
    vimeo: ['vimeo.com']
};

function findBinary(name, envVar, extraPaths = []) {

    const home = process.env.HOME || process.env.USERPROFILE;

    const candidates = [
        process.env[envVar],

        path.join(__dirname, name),
        path.join(__dirname, `${name}.exe`),
        path.join(__dirname, 'bin', name),
        path.join(__dirname, 'bin', `${name}.exe`),
        ...extraPaths,

        home ? path.join(home, '.local', 'bin', name) : null,
        `/usr/local/bin/${name}`,
        `/usr/bin/${name}`,
        `/snap/bin/${name}`
    ].filter(Boolean);

    for (const binPath of candidates) {
        try {
            if (fs.existsSync(binPath)) {
                console.log(`✅ Found ${name} at: ${binPath}`);
                return binPath;
            }
        } catch (e) {  }
    }

    console.log(`ℹ️  ${name} not found on disk — falling back to PATH lookup. `
        + `If spawn fails, set ${envVar} in .env to the full path.`);
    return name;
}

const YT_DLP_BINARY = findBinary('yt-dlp', 'YT_DLP_PATH', [
    '/home/raimohan/.local/bin/yt-dlp'
]);

const FFMPEG_BINARY = findBinary('ffmpeg', 'FFMPEG_PATH');

const JS_RUNTIME = (() => {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const candidates = [
        process.env.DENO_PATH,
        path.join(__dirname, 'deno'),
        path.join(__dirname, 'bin', 'deno'),
        home ? path.join(home, '.deno', 'bin', 'deno') : null,
        '/usr/local/bin/deno',
        '/usr/bin/deno'
    ].filter(Boolean);

    for (const p of candidates) {
        try {
            if (fs.existsSync(p)) return p;
        } catch (e) {  }
    }
    return null;
})();

let JS_RUNTIME_ARGS = [];

function desiredRuntimeArgs() {
    const args = [];
    if (JS_RUNTIME) args.push('--js-runtimes', `deno:${JS_RUNTIME}`);
    args.push('--js-runtimes', `node:${process.execPath}`);
    return args;
}

if (JS_RUNTIME) {
    console.log(`✅ Found JS runtime (deno) at: ${JS_RUNTIME}`);
} else {
    console.warn('⚠️  deno not found — node will be the only JS runtime.');
    console.warn('    deno is the one yt-dlp recommends; some challenges fail without it.');
    console.warn('    Install without sudo:  curl -fsSL https://deno.land/install.sh | sh');
}

function probeJsRuntime() {
    return new Promise((resolve) => {
        const wanted = desiredRuntimeArgs();
        const probe = spawn(YT_DLP_BINARY, [...wanted, '--version'], { env: CHILD_ENV });

        let err = '';
        const timer = setTimeout(() => probe.kill('SIGKILL'), 10000);

        probe.stderr.on('data', (d) => err += d.toString());

        probe.on('error', (e) => {
            clearTimeout(timer);
            console.error(`❌ Cannot run yt-dlp ("${YT_DLP_BINARY}"): ${e.message}`);
            console.error('   Every extraction route will fail until this is fixed.');
            console.error('   Install:  python3 -m pip install --user -U "yt-dlp[default,curl-cffi]" yt-dlp-ejs');
            console.error('   Or set YT_DLP_PATH in .env to the full path of the binary.');
            resolve();
        });

        probe.on('close', (code) => {
            clearTimeout(timer);

            if (code === 0) {
                JS_RUNTIME_ARGS = wanted;
                console.log(`✅ JS runtimes enabled for yt-dlp: ${JS_RUNTIME ? 'deno (primary) + ' : ''}node — ${process.execPath}`);
            } else {
                console.warn('⚠️  No JavaScript runtime available to yt-dlp — YouTube extraction WILL fail.');
                console.warn('    Symptom: "n challenge solving failed" and only storyboard (sb0-sb3) formats.');
                if (/unrecognized|no such option/i.test(err)) {
                    console.warn('    This yt-dlp is too old for --js-runtimes. Update it:');
                    console.warn('      python3 -m pip install --user -U "yt-dlp[default,curl-cffi]" yt-dlp-ejs');
                } else {
                    console.warn(`    yt-dlp rejected the runtime: ${err.trim().split('\n').pop() || `exit ${code}`}`);
                    console.warn('    Make sure yt-dlp-ejs is installed, or install deno:');
                    console.warn('      curl -fsSL https://deno.land/install.sh | sh');
                }
                console.warn('    See https://github.com/yt-dlp/yt-dlp/wiki/EJS');
            }
            resolve();
        });
    });
}

const CHILD_ENV = (() => {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const extra = [
        __dirname,
        path.join(__dirname, 'bin'),
        home ? path.join(home, '.deno', 'bin') : null,
        home ? path.join(home, '.local', 'bin') : null,
        '/usr/local/bin',
        '/usr/bin'
    ].filter(Boolean);

    const current = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    const merged = [...new Set([...extra, ...current])].join(path.delimiter);

    return { ...process.env, PATH: merged };
})();

function spawnYtDlp(args) {
    return spawn(YT_DLP_BINARY, [...JS_RUNTIME_ARGS, ...args], { env: CHILD_ENV });
}

function spawnFfmpeg(args) {
    return spawn(FFMPEG_BINARY, args, { env: CHILD_ENV });
}

if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || '').trim();
if (!ADMIN_TOKEN) {
    console.warn('⚠️  ADMIN_TOKEN is not set — /api/admin/* will answer 503.');
    console.warn('💡 Generate one with:  openssl rand -hex 24');
} else {
    const fp = crypto.createHash('sha256').update(ADMIN_TOKEN).digest('hex').slice(0, 8);
    console.log(`🔑 ADMIN_TOKEN loaded (len=${ADMIN_TOKEN.length} fp=${fp})`);
}

function detectPlatform(url) {
    const urlLower = String(url || '').toLowerCase();

    for (const [platform, patterns] of Object.entries(PLATFORM_PATTERNS)) {
        if (patterns.some(pattern => urlLower.includes(pattern))) {
            return platform;
        }
    }

    return 'generic';
}

function getCookieFile(url) {
    const platform = detectPlatform(url);

    const candidates = [
        PLATFORM_COOKIES[platform],
        PLATFORM_COOKIES.youtube,
        path.join(__dirname, `${platform}.txt`),
        path.join(__dirname, 'youtube.txt'),
        path.join(__dirname, 'cookies', `${platform}.txt`),
        path.join(__dirname, 'cookies', 'youtube.txt')
    ].filter(Boolean);

    for (const file of new Set(candidates)) {
        try {
            if (fs.existsSync(file) && fs.statSync(file).size > 0) {
                console.log(`🍪 Using cookies from: ${file} for platform: ${platform}`);
                return file;
            }
        } catch (e) {  }
    }

    console.log(`⚠️ No cookies found for ${platform}, proceeding without cookies`);
    return null;
}

function getCommonArgs(url) {
    const platform = detectPlatform(url);

    const args = [
        '--no-check-certificates',
        '--no-warnings',
        '--no-playlist',

        '--impersonate', 'chrome'
    ];

    if (platform === 'twitter' || platform === 'x') {
        args.push('--referer', 'https://twitter.com/');
    } else {
        args.push('--referer', 'https://www.youtube.com/');
    }

    const cookieFile = getCookieFile(url);
    if (cookieFile) {
        args.push('--cookies', cookieFile);
    }

    if (platform === 'youtube') {
        args.push('--embed-metadata', '--embed-chapters');
    }

    return args;
}

const YT_STRATEGIES = [
    { name: 'cookies+chrome', cookies: true, impersonate: true, clients: null },
    { name: 'cookies+clients', cookies: true, impersonate: true, clients: 'default,mweb,android' },
    { name: 'anon+chrome', cookies: false, impersonate: true, clients: null },
    { name: 'bare', cookies: false, impersonate: false, clients: null }
];

let ytPreferredStrategy = 0;

function strategyOrder() {
    return [
        YT_STRATEGIES[ytPreferredStrategy],
        ...YT_STRATEGIES.filter((_, i) => i !== ytPreferredStrategy)
    ];
}

function strategyArgs(strategy, url, extra) {
    const args = ['--no-check-certificates', '--no-warnings', '--no-playlist'];
    if (YT_DLP_IGNORE_CONFIG) args.unshift('--ignore-config');
    if (strategy.impersonate) args.push('--impersonate', 'chrome');
    if (strategy.clients) {
        args.push('--extractor-args', `youtube:player_client=${strategy.clients}`);
    }
    if (strategy.cookies) {
        const cookieFile = getCookieFile(url);
        if (cookieFile) args.push('--cookies', cookieFile);

        else return null;
    }
    return [...args, ...extra];
}

const YT_RUNG_TIMEOUT_MS = 25000;
const YT_LADDER_BUDGET_MS = 60000;

function runYtDlp(args, timeoutMs = YT_RUNG_TIMEOUT_MS) {
    return new Promise((resolve) => {
        const child = spawnYtDlp(args);
        let out = '';
        let err = '';
        const timer = setTimeout(() => {
            err += '\nyt-dlp timed out';
            child.kill('SIGKILL');
        }, timeoutMs);

        child.stdout.on('data', (d) => out += d.toString());
        child.stderr.on('data', (d) => err += d.toString());
        child.on('error', (e) => {
            clearTimeout(timer);
            resolve({ ok: false, stdout: '', stderr: String(e) });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ ok: code === 0 && out.trim().length > 0, stdout: out, stderr: err });
        });
    });
}

function ytDlpReason(stderr) {
    if (!stderr) return null;
    const line = stderr
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .reverse()
        .find(l => l.startsWith('ERROR:'));
    return (line || stderr.trim().split('\n').pop() || '')
        .replace(/^ERROR:\s*/, '')
        .slice(0, 300) || null;
}

function findYtDlpConfigs() {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    return [
        '/etc/yt-dlp.conf',
        '/etc/yt-dlp/config',
        home ? path.join(home, '.config', 'yt-dlp', 'config') : null,
        home ? path.join(home, '.config', 'yt-dlp.conf') : null,
        path.join(__dirname, 'yt-dlp.conf')
    ].filter(Boolean).filter(p => {
        try { return fs.existsSync(p); } catch (e) { return false; }
    });
}

const YT_DLP_CONFIGS = findYtDlpConfigs();
if (YT_DLP_CONFIGS.length > 0) {
    console.warn('⚠️  yt-dlp config file(s) found — these apply to EVERY call:');
    YT_DLP_CONFIGS.forEach(p => console.warn(`     ${p}`));
    console.warn('     A "-f" line in any of them overrides what this server asks for.');
    console.warn('     Set YT_DLP_IGNORE_CONFIG=1 in .env to bypass them.');
}

const YT_DLP_IGNORE_CONFIG = /^(1|true|yes)$/i.test(process.env.YT_DLP_IGNORE_CONFIG || '');
if (YT_DLP_IGNORE_CONFIG) console.log('🚫 Ignoring yt-dlp config files (YT_DLP_IGNORE_CONFIG=1)');

async function logAvailableFormats(url, label) {
    const args = ['--no-warnings', '--impersonate', 'chrome', '--list-formats', url];
    const cookieFile = getCookieFile(url);
    if (cookieFile) args.push('--cookies', cookieFile);

    const { stdout, stderr } = await runYtDlp(args, 20000);
    const table = (stdout || stderr || '').trim();

    if (!table) {
        console.error(`🔬 ${label}: --list-formats returned nothing at all — the video exposes no formats (upcoming premiere, live placeholder, or members-only).`);
        return;
    }

    console.error(`🔬 ${label}: formats YouTube actually offers:`);
    table.split('\n').slice(0, 40).forEach(l => console.error(`     ${l}`));
}

function isFormatFailure(reason) {
    return /requested format is not available|no video formats found|no formats found/i
        .test(reason || '');
}

function isAuthFailure(reason) {
    return /sign in|not a bot|cookies|login|age|private|members-only|unavailable/i
        .test(reason || '');
}

async function extractWithFallback(url, extra, label) {
    let lastErr = 'extraction failed';

    let firstErr = null;
    const deadline = Date.now() + YT_LADDER_BUDGET_MS;

    for (const strategy of strategyOrder()) {
        const args = strategyArgs(strategy, url, extra);
        if (!args) continue;

        const left = deadline - Date.now();
        if (left < 5000) {
            console.error(`⏱ ${label}: out of time after "${strategy.name}"`);
            break;
        }

        const { ok, stdout, stderr } = await runYtDlp(args, Math.min(YT_RUNG_TIMEOUT_MS, left));
        if (ok) {
            const index = YT_STRATEGIES.indexOf(strategy);
            if (index !== ytPreferredStrategy) {
                console.log(`🔀 ${label}: switching to "${strategy.name}"`);
                ytPreferredStrategy = index;
            }
            return { ok: true, stdout, strategy: strategy.name };
        }

        lastErr = ytDlpReason(stderr) || lastErr;
        if (firstErr === null) firstErr = lastErr;
        console.error(`↻ ${label}: "${strategy.name}" failed — ${lastErr}`);

        if (strategy.cookies && isFormatFailure(lastErr)) {
            console.error(`⛔ ${label}: format selector matched nothing with valid cookies — not retrying anonymously.`);
            await logAvailableFormats(url, label);
            return { ok: false, reason: lastErr };
        }
    }

    const reason = (firstErr && isAuthFailure(lastErr) && !isAuthFailure(firstErr))
        ? firstErr
        : lastErr;

    return { ok: false, reason };
}

function fetchInfoJson(url) {
    return new Promise((resolve, reject) => {
        const args = [
            '--skip-download',
            '--no-warnings',
            '--ignore-no-formats-error',
            '--impersonate', 'chrome',
            '-J',
            url
        ];
        const cookieFile = getCookieFile(url);
        if (cookieFile) args.push('--cookies', cookieFile);

        const child = spawnYtDlp(args);
        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (d) => stdout += d.toString());
        child.stderr.on('data', (d) => stderr += d.toString());

        child.on('close', (code) => {
            if (code !== 0) return reject(new Error(ytDlpReason(stderr) || 'Failed to fetch video info'));
            try {
                resolve(JSON.parse(stdout));
            } catch (e) {
                reject(new Error('Failed to parse video info'));
            }
        });

        child.on('error', (err) => reject(err));
    });
}

async function fetchTitle(url, fallback = 'video', timeout = 5000) {
    try {
        const args = ['--get-title', '--no-warnings', '--impersonate', 'chrome', url];
        const cookieFile = getCookieFile(url);
        if (cookieFile) args.push('--cookies', cookieFile);

        const child = spawnYtDlp(args);
        let titleData = '';

        await new Promise((resolve) => {
            child.stdout.on('data', d => titleData += d.toString());
            child.on('close', () => resolve());
            child.on('error', () => resolve());
            setTimeout(resolve, timeout);
        });

        return titleData.trim() || fallback;
    } catch (e) {
        console.error('Title fetch error:', e.message);
        return fallback;
    }
}

function formatDuration(seconds) {
    if (!seconds) return '--:--';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatViews(count) {
    if (!count) return '0';
    if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M';
    if (count >= 1000) return (count / 1000).toFixed(1) + 'K';
    return count.toString();
}

function formatDate(dateStr) {
    if (!dateStr || dateStr.length !== 8) return 'Unknown';
    return `${dateStr.substring(6, 8)}/${dateStr.substring(4, 6)}/${dateStr.substring(0, 4)}`;
}

function getAvailableQualities(formats) {
    const qualities = new Set();
    formats.forEach(f => {
        if (f.height) {
            if (f.height >= 1080) qualities.add('1080p');
            if (f.height >= 720) qualities.add('720p');
            if (f.height >= 480) qualities.add('480p');
            if (f.height >= 360) qualities.add('360p');
        }
    });
    return Array.from(qualities);
}

function safeName(name, fallback = 'file') {
    return String(name || '')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/[\r\n]/g, '')
        .trim() || fallback;
}

function parseVTT(content) {
    const lines = [];
    const blocks = content.split(/\n\n+/);

    for (const block of blocks) {
        const blockLines = block.trim().split('\n');
        if (blockLines.length < 2) continue;

        const timestampLine = blockLines.find(l => l.includes('-->'));
        if (!timestampLine) continue;

        const timeMatch = timestampLine.match(/(\d{2}:\d{2}:\d{2})/);
        const time = timeMatch ? timeMatch[1] : '';

        const textIndex = blockLines.indexOf(timestampLine) + 1;
        const text = blockLines.slice(textIndex).join(' ').replace(/<[^>]+>/g, '').trim();

        if (text) lines.push({ time, text });
    }

    return lines;
}

function vttTimeToSeconds(time) {
    const m = String(time || '').match(/(\d{2}):(\d{2}):(\d{2})/);
    if (!m) return null;
    return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]);
}

async function fetchSubtitleLines(url, langs, prefix) {
    const timestamp = Date.now();
    const subFile = path.join(DOWNLOAD_DIR, `${prefix}_${timestamp}`);

    const args = [
        '--write-sub',
        '--write-auto-sub',
        '--sub-lang', langs,
        '--sub-format', 'vtt',
        '--skip-download',
        '--no-warnings',
        '--impersonate', 'chrome',
        '-o', subFile,
        url
    ];

    const cookieFile = getCookieFile(url);
    if (cookieFile) args.push('--cookies', cookieFile);

    await new Promise((resolve) => {
        const child = spawnYtDlp(args);
        child.on('close', () => resolve());
        child.on('error', () => resolve());
    });

    const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith(`${prefix}_${timestamp}`));
    if (files.length === 0) return [];

    const subFilePath = path.join(DOWNLOAD_DIR, files[0]);
    const content = fs.readFileSync(subFilePath, 'utf8');
    try { fs.unlinkSync(subFilePath); } catch (e) { }

    return parseVTT(content);
}

const TRANSCRIPT_CACHE_DIR = process.env.TRANSCRIPT_CACHE_DIR || path.join(__dirname, 'transcript-cache');
if (!fs.existsSync(TRANSCRIPT_CACHE_DIR)) fs.mkdirSync(TRANSCRIPT_CACHE_DIR, { recursive: true });

const AI_CACHE_DIR = process.env.AI_CACHE_DIR || path.join(__dirname, 'ai-cache');
if (!fs.existsSync(AI_CACHE_DIR)) fs.mkdirSync(AI_CACHE_DIR, { recursive: true });

function videoCacheKey(url) {
    const m = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/) || url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
    if (m) return m[1];

    let h = 0;
    for (let i = 0; i < url.length; i++) h = ((h << 5) - h + url.charCodeAt(i)) | 0;
    return 'u' + Math.abs(h).toString(36);
}

async function getTranscriptCached(url) {
    const cachePath = path.join(TRANSCRIPT_CACHE_DIR, `${videoCacheKey(url)}.json`);

    if (fs.existsSync(cachePath)) {
        try {
            return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        } catch (e) {  }
    }

    const lines = await fetchSubtitleLines(url, 'en,en-US,en-GB,en-orig,hi,hi-IN', 'tr');

    if (lines.length > 0) {
        try { fs.writeFileSync(cachePath, JSON.stringify(lines)); } catch (e) { }
    }
    return lines;
}

function aiCachePath(url, kind) {
    return path.join(AI_CACHE_DIR, `${videoCacheKey(url)}__${kind}.json`);
}

function aiCacheGet(url, kind) {
    try {
        const p = aiCachePath(url, kind);
        if (!fs.existsSync(p)) return null;
        const entry = JSON.parse(fs.readFileSync(p, 'utf8'));
        return entry && entry.data !== undefined ? entry.data : null;
    } catch (e) {
        return null;
    }
}

function aiCachePut(url, kind, data) {
    try {
        fs.writeFileSync(aiCachePath(url, kind), JSON.stringify({
            createdAt: new Date().toISOString(),
            model: activeModel,
            data
        }));
    } catch (e) {
        console.error('AI cache write failed:', e.message);
    }
}

const ENDPOINTS = {
    music: [
        'POST /api/music/search       { query }',
        'POST /api/music/playlist     { url }',
        'GET  /api/music/download     ?id=&title=&artist=',
        'GET  /api/music/stream       ?id='
    ],
    video: [
        'POST /api/video/search       { query }',
        'POST /api/video/info         { url }',
        'POST /api/video/playlist     { url }',
        'GET  /api/video/stream       ?id=&quality=&json=1&hls=1',
        'GET  /api/video/stream       ?id=&all=1   (every quality 144p→max, one call)'
    ],
    downloader: [
        'POST /api/analyze            { url }',
        'GET  /api/download           ?url=&resolution=&type=&title=',
        'GET  /api/clip               ?url=&start=&end=&quality=&ratio=',
        'GET  /api/clip/status/:jobId',
        'GET  /api/clip/download/:jobId'
    ],
    subtitles: [
        'POST /api/subtitles          { url }',
        'POST /api/subtitles/preview  { url, lang }',
        'GET  /api/subtitles/download ?url=&lang=&format='
    ],
    ai: [
        'POST /api/summarize          { url, type, refresh }',
        'POST /api/viral              { url, excludedRanges }',
        'POST /api/tags/generate      { title, existingTags }',
        'POST /api/titles/generate    { topic, style }',
        'POST /api/description/generate { title, keywords, type, options, modifier }',
        'GET  /api/chat/info          ?url=',
        'POST /api/chat               { videoId, videoData, messages }'
    ],
    study: [
        'POST /api/transcript         { url }',
        'POST /api/quiz               { url, refresh }',
        'POST /api/flashcards         { url, refresh }',
        'POST /api/ai-notes           { url, refresh }',
        'POST /api/plan               { goal, videoCount, totalDurationSec }',
        'POST /api/course/resolve     { input }',
        'POST /api/course/search      { query }'
    ],
    metadata: [
        'POST /api/thumbnail          { url }',
        'POST /api/metadata           { url }',
        'POST /api/channel/analyze    { input }'
    ],
    app: [
        'GET  /api/app/version',
        'GET  /download/app',
        'GET  /app_version.json',
        'GET  /c/:code',
        'GET  /api/admin/status         (x-admin-token)',
        'POST /api/admin/upload-ticket  (x-admin-token)',
        'PUT  /api/admin/apk            (x-admin-token or ?ticket=)',
        'POST /api/admin/version        (x-admin-token)'
    ],
    system: [
        'GET  /health'
    ]
};

app.get(['/', '/index.html'], (req, res) => {
    res.json({
        status: 'online',
        service: 'RAIX API',
        mode: 'api-only',
        note: 'This host serves the API only. No HTML app is served from here.',
        endpoints: ENDPOINTS
    });
});

app.get(['/admin', '/admin.html'], (req, res) => {
    res.status(410).json({
        error: 'Removed',
        hint: 'Publishing moved to the admin console. This page handled the admin token in the browser, which is why it is gone.'
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: Math.round(process.uptime()),
        aiProvider: PROVIDER_NAME,
        aiModel: activeModel,
        aiKeys: apiKeyManager.keys.length,
        aiReady: AI_READY,
        ytdlp: YT_DLP_BINARY,
        ffmpeg: FFMPEG_BINARY,
        cookies: Object.entries(PLATFORM_COOKIES)
            .filter(([, file]) => fs.existsSync(file))
            .map(([platform]) => platform),
        timestamp: new Date().toISOString()
    });
});

app.get('/app_version.json', (req, res) => {
    if (!fs.existsSync(APP_VERSION_FILE)) {
        return res.json({ version: '1.0.0', notes: 'No version file uploaded yet' });
    }
    try {
        res.type('application/json').send(fs.readFileSync(APP_VERSION_FILE, 'utf8'));
    } catch (e) {
        res.status(500).json({ error: 'Failed to read app_version.json' });
    }
});

app.post('/api/music/search', (req, res) => {
    const { query } = req.body;
    if (!query || query.length < 2) {
        return res.status(400).json({ error: 'Please enter a song name to search' });
    }

    console.log(`🎵 Searching music: ${query}`);

    const args = [
        '--no-check-certificates',
        '--no-warnings',
        '--flat-playlist',
        '--impersonate', 'chrome',
        '-J',
        `ytsearch10:${query} audio`
    ];

    const child = spawnYtDlp(args);
    let jsonBuffer = '';

    child.stdout.on('data', (d) => jsonBuffer += d.toString());
    child.stderr.on('data', (d) => console.error(`[Music Search Log] ${d}`));

    child.on('close', (code) => {
        if (code !== 0) {
            console.error(`Music search exited with code ${code}`);
            return res.status(500).json({ error: 'Search failed. Please try again.' });
        }

        try {
            const data = JSON.parse(jsonBuffer);
            let results = [];

            if (data.entries && Array.isArray(data.entries)) {
                results = data.entries
                    .filter(entry => entry && entry.title)
                    .slice(0, 10)
                    .map(entry => ({
                        id: entry.id || entry.url,
                        title: entry.title || 'Unknown Title',
                        artist: entry.channel || entry.uploader || 'Unknown Artist',
                        duration: formatDuration(entry.duration),
                        thumbnail: entry.thumbnail || `https://img.youtube.com/vi/${entry.id}/mqdefault.jpg`,
                        url: entry.url || `https://www.youtube.com/watch?v=${entry.id}`
                    }));
            }

            console.log(`🎶 Found ${results.length} songs for "${query}"`);
            res.json({ status: 'success', query, results });

        } catch (e) {
            console.error('Music search JSON Parse Error:', e);
            res.status(500).json({ error: 'Failed to parse search results' });
        }
    });

    child.on('error', (err) => {
        console.error('❌ Music search spawn error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to start search' });
    });
});

app.post('/api/music/playlist', (req, res) => {
    const { url } = req.body;
    if (!url || !url.includes('playlist')) {
        return res.status(400).json({ error: 'Please enter a valid YouTube playlist URL' });
    }

    console.log(`🎵 Extracting playlist: ${url}`);

    const args = [
        '--no-check-certificates',
        '--no-warnings',
        '--flat-playlist',
        '--impersonate', 'chrome',
        '-J',
        url
    ];

    const cookieFile = getCookieFile(url);
    if (cookieFile) args.push('--cookies', cookieFile);

    const child = spawnYtDlp(args);
    let jsonBuffer = '';

    child.stdout.on('data', (d) => jsonBuffer += d.toString());
    child.stderr.on('data', (d) => console.error(`[Playlist Log] ${d}`));

    child.on('close', (code) => {
        if (code !== 0) {
            console.error(`Playlist extraction exited with code ${code}`);
            return res.status(500).json({ error: 'Failed to extract playlist. Please check the URL.' });
        }

        try {
            const data = JSON.parse(jsonBuffer);
            let results = [];

            if (data.entries && Array.isArray(data.entries)) {
                results = data.entries
                    .filter(entry => entry && entry.title && entry.id)
                    .map(entry => ({
                        id: entry.id,
                        title: entry.title || 'Unknown Title',
                        artist: entry.channel || entry.uploader || 'Unknown Artist',
                        duration: formatDuration(entry.duration),
                        thumbnail: entry.thumbnail || `https://img.youtube.com/vi/${entry.id}/mqdefault.jpg`,
                        url: entry.url || `https://www.youtube.com/watch?v=${entry.id}`
                    }));
            }

            console.log(`🎶 Found ${results.length} songs in playlist`);
            res.json({ status: 'success', title: data.title || 'Playlist', count: results.length, results });

        } catch (e) {
            console.error('Playlist JSON Parse Error:', e);
            res.status(500).json({ error: 'Failed to parse playlist data' });
        }
    });

    child.on('error', (err) => {
        console.error('❌ Playlist spawn error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to start extraction' });
    });
});

app.get('/api/music/download', async (req, res) => {
    const { id, title, artist } = req.query;
    if (!id) return res.status(400).send('Missing song ID');

    console.log(`🎵 Downloading music: ${title} by ${artist}`);

    const url = id.startsWith('http') ? id : `https://www.youtube.com/watch?v=${id}`;

    const timestamp = Date.now();
    const filename = `music_${timestamp}.mp3`;
    const filePath = path.join(DOWNLOAD_DIR, filename);

    const args = [
        '--no-check-certificates',
        '--no-warnings',
        '--impersonate', 'chrome',
        '-x',
        '--audio-format', 'mp3',
        '--audio-quality', '0',
        '--embed-thumbnail',
        '--embed-metadata',
        '-o', filePath,
        url
    ];

    const cookieFile = getCookieFile(url);
    if (cookieFile) args.push('--cookies', cookieFile);

    console.log(`📁 Saving music to: ${filePath}`);

    const child = spawnYtDlp(args);

    child.stdout.on('data', d => console.log(`[Music DL] ${d}`));
    child.stderr.on('data', d => console.error(`[Music DL ERR] ${d}`));

    child.on('close', (code) => {
        if (code === 0 && fs.existsSync(filePath)) {
            const userFilename = `${safeName(title, 'song')} - ${safeName(artist, 'artist')}.mp3`;
            console.log(`✅ Music download successful: ${userFilename}`);

            res.download(filePath, userFilename, (err) => {
                if (!err) {
                    setTimeout(() => {
                        if (fs.existsSync(filePath)) {
                            fs.unlinkSync(filePath);
                            console.log(`🗑️ Cleaned up: ${filename}`);
                        }
                    }, 5 * 60 * 1000);
                } else {
                    console.error(`❌ Music download serve error: ${err.message}`);
                }
            });
        } else {
            console.error(`❌ Music download failed with code: ${code}`);
            res.status(500).send('Download failed. Please try again.');
        }
    });

    child.on('error', (err) => {
        console.error('❌ Music Spawn Error:', err);
        res.status(500).send('Failed to start download process.');
    });
});

app.get('/api/music/stream', async (req, res) => {
    const { id } = req.query;
    if (!id) return res.status(400).send('Missing song ID');

    console.log(`🎵 Streaming music: ${id}`);

    const url = id.startsWith('http') ? id : `https://www.youtube.com/watch?v=${id}`;

    const result = await extractWithFallback(
        url,
        ['-f', 'bestaudio[ext=m4a]/bestaudio/140', '--get-url', url],
        `audio ${id}`
    );

    const directUrl = result.ok ? result.stdout.trim().split('\n')[0] : '';
    if (!directUrl) {
        const reason = result.reason || 'no audio URL returned';
        console.error(`❌ Failed to get audio stream for ${id}: ${reason}`);
        return res.status(502).json({ error: 'Failed to get audio stream.', reason });
    }

    console.log(`✅ Got direct audio URL for ${id} [${result.strategy}]`);
    res.redirect(directUrl);
});

app.post('/api/video/search', (req, res) => {
    const { query } = req.body;
    if (!query || query.length < 2) {
        return res.status(400).json({ error: 'Please enter a search term' });
    }

    console.log(`🎬 Searching videos: ${query}`);

    const args = [
        '--no-check-certificates',
        '--no-warnings',
        '--flat-playlist',
        '--impersonate', 'chrome',
        '-J',
        `ytsearch15:${query}`
    ];

    const child = spawnYtDlp(args);
    let jsonBuffer = '';

    child.stdout.on('data', (d) => jsonBuffer += d.toString());
    child.stderr.on('data', (d) => console.error(`[Video Search Log] ${d}`));

    child.on('close', (code) => {
        if (code !== 0) {
            console.error(`Video search exited with code ${code}`);
            return res.status(500).json({ error: 'Search failed. Please try again.' });
        }

        try {
            const data = JSON.parse(jsonBuffer);
            let results = [];

            if (data.entries && Array.isArray(data.entries)) {
                results = data.entries
                    .filter(entry => entry && entry.title)
                    .slice(0, 15)
                    .map(entry => ({
                        id: entry.id || entry.url,
                        title: entry.title || 'Unknown Title',
                        channel: entry.channel || entry.uploader || 'Unknown Channel',
                        duration: formatDuration(entry.duration),
                        views: entry.view_count ? formatViews(entry.view_count) : 'N/A',
                        uploadDate: entry.upload_date ? formatDate(entry.upload_date) : 'Unknown',
                        thumbnail: entry.thumbnail || `https://img.youtube.com/vi/${entry.id}/mqdefault.jpg`,
                        url: entry.url || `https://www.youtube.com/watch?v=${entry.id}`
                    }));
            }

            console.log(`🎥 Found ${results.length} videos for "${query}"`);
            res.json({ status: 'success', query, results });

        } catch (e) {
            console.error('Video search JSON Parse Error:', e);
            res.status(500).json({ error: 'Failed to parse search results' });
        }
    });

    child.on('error', (err) => {
        console.error('❌ Video search spawn error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to start search' });
    });
});

app.post('/api/video/info', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Please provide a video URL' });

    console.log(`🎬 Getting video info: ${url}`);

    const result = await extractWithFallback(url, ['-J', url], `info ${url}`);

    if (!result.ok) {
        const reason = result.reason || 'extraction failed';
        console.error(`Video info extraction failed: ${reason}`);
        return res.status(502).json({ error: 'Failed to get video info. Please check the URL.', reason });
    }

    try {
        const data = JSON.parse(result.stdout);

        const videoInfo = {
            id: data.id,
            title: data.title || 'Unknown Title',
            channel: data.channel || data.uploader || 'Unknown Channel',
            duration: formatDuration(data.duration),
            views: data.view_count ? formatViews(data.view_count) : 'N/A',
            uploadDate: data.upload_date ? formatDate(data.upload_date) : 'Unknown',
            thumbnail: data.thumbnail || `https://img.youtube.com/vi/${data.id}/mqdefault.jpg`,
            description: data.description || '',
            qualities: getAvailableQualities(data.formats || [])
        };

        console.log(`✅ Got video info: ${videoInfo.title} [${result.strategy}]`);
        res.json({ status: 'success', video: videoInfo });

    } catch (e) {
        console.error('Video info JSON Parse Error:', e);
        res.status(500).json({ error: 'Failed to parse video data' });
    }
});

app.post('/api/video/playlist', (req, res) => {
    const { url } = req.body;
    if (!url || !url.includes('playlist')) {
        return res.status(400).json({ error: 'Please enter a valid YouTube playlist URL' });
    }

    console.log(`🎬 Extracting playlist: ${url}`);

    const args = [
        '--no-check-certificates',
        '--no-warnings',
        '--flat-playlist',
        '--impersonate', 'chrome',
        '-J',
        url
    ];

    const cookieFile = getCookieFile(url);
    if (cookieFile) args.push('--cookies', cookieFile);

    const child = spawnYtDlp(args);
    let jsonBuffer = '';

    child.stdout.on('data', (d) => jsonBuffer += d.toString());
    child.stderr.on('data', (d) => console.error(`[Playlist Log] ${d}`));

    child.on('close', (code) => {
        if (code !== 0) {
            console.error(`Playlist extraction exited with code ${code}`);
            return res.status(500).json({ error: 'Failed to extract playlist. Please check the URL.' });
        }

        try {
            const data = JSON.parse(jsonBuffer);
            let results = [];

            if (data.entries && Array.isArray(data.entries)) {
                results = data.entries
                    .filter(entry => entry && entry.title && entry.id)
                    .map(entry => ({
                        id: entry.id,
                        title: entry.title || 'Unknown Title',
                        channel: entry.channel || entry.uploader || 'Unknown Channel',
                        duration: formatDuration(entry.duration),
                        thumbnail: entry.thumbnail || `https://img.youtube.com/vi/${entry.id}/mqdefault.jpg`,
                        url: entry.url || `https://www.youtube.com/watch?v=${entry.id}`
                    }));
            }

            console.log(`🎥 Found ${results.length} videos in playlist`);
            res.json({ status: 'success', title: data.title || 'Playlist', count: results.length, results });

        } catch (e) {
            console.error('Playlist JSON Parse Error:', e);
            res.status(500).json({ error: 'Failed to parse playlist data' });
        }
    });

    child.on('error', (err) => {
        console.error('❌ Playlist spawn error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to start extraction' });
    });
});

const streamCache = new Map();

function streamCacheGet(key) {
    const hit = streamCache.get(key);
    if (!hit) return null;
    if (Date.now() >= hit.expiresAt) {
        streamCache.delete(key);
        return null;
    }
    return hit;
}

function streamCachePut(key, entry) {

    const anyUrl = entry.url
        || entry.muxed?.url
        || entry.audio?.url
        || entry.video?.[0]?.url
        || '';
    const m = /[?&]expire=(\d{9,})/.exec(anyUrl);
    const expiresAt = m
        ? Number(m[1]) * 1000 - 5 * 60 * 1000
        : Date.now() + 30 * 60 * 1000;

    if (expiresAt > Date.now()) {
        streamCache.set(key, { ...entry, expiresAt });
    }

    if (streamCache.size > 800) {
        for (const k of streamCache.keys()) {
            streamCache.delete(k);
            if (streamCache.size <= 600) break;
        }
    }
}

async function resolveAllStreams(id, label) {
    const url = id.startsWith('http') ? id : `https://www.youtube.com/watch?v=${id}`;

    const result = await extractWithFallback(url, ['-J', url], label);
    if (!result.ok) return { ok: false, reason: result.reason || 'extraction failed' };

    let data;
    try {
        data = JSON.parse(result.stdout);
    } catch (e) {
        return { ok: false, reason: 'could not parse format data' };
    }

    const formats = (data.formats || []).filter(f => f.url && f.ext !== 'mhtml');
    const size = (f) => f.filesize || f.filesize_approx || 0;

    const plain = (f) => !f.protocol || f.protocol === 'https' || f.protocol === 'http';

    const audioFormats = formats
        .filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none') && plain(f))
        .sort((a, b) => {
            const aac = (f) => (f.ext === 'm4a' || String(f.acodec).startsWith('mp4a')) ? 1 : 0;
            return (aac(b) - aac(a)) || ((b.abr || 0) - (a.abr || 0));
        });

    const byHeight = new Map();
    formats
        .filter(f => f.vcodec && f.vcodec !== 'none' && f.height && plain(f))
        .forEach(f => {
            const current = byHeight.get(f.height);
            const score = (x) => (String(x.vcodec).startsWith('avc1') ? 1e9 : 0) + (x.tbr || 0);
            if (!current || score(f) > score(current)) byHeight.set(f.height, f);
        });

    const video = Array.from(byHeight.values())
        .sort((a, b) => b.height - a.height)
        .map(f => ({
            quality: `${f.height}p${f.fps && f.fps > 30 ? Math.round(f.fps) : ''}`,
            itag: f.format_id,
            height: f.height,
            width: f.width || null,
            fps: f.fps ? Math.round(f.fps) : null,
            ext: f.ext,
            vcodec: f.vcodec,
            filesize: size(f),

            hasAudio: Boolean(f.acodec && f.acodec !== 'none'),
            url: f.url
        }));

    if (video.length === 0) {
        return { ok: false, reason: 'no playable video formats' };
    }

    const muxedFormat = formats
        .filter(f => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none' && plain(f))
        .sort((a, b) => (b.height || 0) - (a.height || 0))[0];

    const bestAudio = audioFormats[0];

    return {
        ok: true,
        entry: {
            id: data.id || id,
            title: data.title || '',
            duration: data.duration || 0,
            thumbnail: data.thumbnail || '',

            muxed: muxedFormat ? {
                url: muxedFormat.url,
                itag: muxedFormat.format_id,
                height: muxedFormat.height || 0,
                filesize: size(muxedFormat)
            } : null,

            audio: bestAudio ? {
                url: bestAudio.url,
                itag: bestAudio.format_id,
                acodec: bestAudio.acodec,
                abr: bestAudio.abr || null,
                ext: bestAudio.ext,
                filesize: size(bestAudio)
            } : null,
            video,

            kind: 'adaptive-list'
        }
    };
}

async function resolveAdaptive(url, maxHeight, label) {
    const result = await extractWithFallback(
        url,
        [
            '-f',
            `bestvideo[height<=${maxHeight}][ext=mp4]+bestaudio[ext=m4a]`
            + `/bestvideo[height<=${maxHeight}]+bestaudio`,
            '--print',
            [
                '%(requested_formats.0.format_id)s',
                '%(requested_formats.0.height)s',
                '%(requested_formats.0.filesize,requested_formats.0.filesize_approx)s',
                '%(requested_formats.0.url)s',
                '%(requested_formats.1.format_id)s',
                '%(requested_formats.1.acodec)s',
                '%(requested_formats.1.filesize,requested_formats.1.filesize_approx)s',
                '%(requested_formats.1.url)s'
            ].join('\t'),
            url
        ],
        `adaptive ${label}`
    );

    if (!result.ok) return null;

    const line = result.stdout.trim().split('\n').filter(Boolean)[0] || '';
    const [vItag, vHeight, vSize, vUrl, aItag, aCodec, aSize, aUrl] = line.split('\t');

    const bad = (s) => !s || s === 'NA';
    if (bad(vUrl) || bad(aUrl) || !vUrl.startsWith('http') || !aUrl.startsWith('http')) {
        return null;
    }

    const num = (s) => (/^\d+$/.test(s || '') ? Number(s) : 0);

    return {
        video: { url: vUrl, itag: vItag, height: num(vHeight), filesize: num(vSize) },
        audio: { url: aUrl, itag: aItag, acodec: bad(aCodec) ? null : aCodec, filesize: num(aSize) }
    };
}

app.get('/api/video/stream', async (req, res) => {
    const { id, quality, json, hls, all } = req.query;
    if (!id) return res.status(400).send('Missing video ID');

    const allowHls = hls === '1';
    const wantAll = all === '1';
    const cacheKey = `${id}|${wantAll ? 'all' : (quality || 'auto')}${allowHls ? '|hls' : ''}`;

    const cached = streamCacheGet(cacheKey);
    if (cached) {
        console.log(`⚡ Cached stream for ${id} (${wantAll ? `${cached.video?.length || 0} qualities` : `itag ${cached.itag}`})`);
        return (json === '1' || wantAll)
            ? res.json({ ...cached, cached: true })
            : res.redirect(cached.url);
    }

    if (wantAll) {
        const listing = await resolveAllStreams(id, `all ${id}`);
        if (!listing.ok) {
            return res.status(502).json({ error: 'Failed to get video streams.', reason: listing.reason });
        }
        streamCachePut(cacheKey, listing.entry);
        console.log(`✅ ${id}: ${listing.entry.video.length} video qualities `
            + `(${listing.entry.video.map(v => v.quality).join(', ')})`);
        return res.json(listing.entry);
    }

    console.log(`🎬 Streaming video: ${id} (quality: ${quality || 'best'}${allowHls ? ', hls ok' : ', progressive only'})`);

    const url = id.startsWith('http') ? id : `https://www.youtube.com/watch?v=${id}`;

    const heightFor = { '1080p': 1080, '720p': 720, '480p': 480, '360p': 360 };
    const maxHeight = heightFor[quality];

    const format = [
        allowHls && maxHeight ? `best[height<=${maxHeight}][vcodec!=none][acodec!=none]` : null,
        maxHeight ? `best[height<=${maxHeight}][vcodec!=none][acodec!=none][protocol^=http]` : null,
        allowHls ? `best[vcodec!=none][acodec!=none]` : null,
        `best[vcodec!=none][acodec!=none][protocol^=http]`,
        `best[vcodec!=none][acodec!=none]`,
        maxHeight ? `best[height<=${maxHeight}]` : null,
        `18`,
        `best`
    ].filter(Boolean).join('/');

    const result = await extractWithFallback(
        url,
        [
            '-f', format,

            '--print',
            '%(format_id)s\t%(acodec)s\t%(height)s\t%(filesize)s\t%(filesize_approx)s\t%(protocol)s\t%(url)s',
            url
        ],
        `stream ${id}`
    );

    const line = result.ok ? (result.stdout.trim().split('\n').filter(Boolean)[0] || '') : '';
    const [formatId, acodec, height, sizeExact, sizeApprox, protocol, directUrl] = line.split('\t');

    if (!result.ok || !directUrl) {
        const reason = result.reason || 'no stream URL returned';
        console.error(`❌ Failed to get stream URL for ${id}: ${reason}`);
        return res.status(502).json({ error: 'Failed to get video stream.', reason });
    }

    if (!acodec || acodec === 'none') {
        console.error(`❌ Format ${formatId} has no audio — refusing.`);
        return res.status(502).json({
            error: 'No playable stream for this video.',
            reason: 'the only formats available have no audio track'
        });
    }

    const isManifest = protocol && protocol !== 'https' && protocol !== 'http';
    if (isManifest && !allowHls) {
        console.error(`❌ Format ${formatId} is ${protocol}, not progressive.`);
        return res.status(502).json({
            error: 'No progressive stream for this video.',
            reason: `only streaming manifests (${protocol}) are available`
        });
    }

    const exact = /^\d+$/.test(sizeExact || '');
    const bytes = exact
        ? Number(sizeExact)
        : (/^\d+$/.test(sizeApprox || '') ? Number(sizeApprox) : 0);

    const entry = {
        url: directUrl,
        itag: formatId,
        height: Number(height) || 0,
        filesize: bytes,
        exact,

        kind: isManifest ? 'hls' : 'progressive',
        protocol: protocol || 'https'
    };

    if (json === '1' && maxHeight && entry.height && entry.height < maxHeight) {
        const adaptive = await resolveAdaptive(url, maxHeight, id);
        if (adaptive) {
            entry.adaptive = adaptive;
            console.log(`➕ ${id}: muxed capped at ${entry.height}p — added adaptive `
                + `${adaptive.video.height}p (itag ${adaptive.video.itag} + ${adaptive.audio.itag})`);
        } else {
            console.log(`ℹ️  ${id}: no muxed track above ${entry.height}p and no adaptive pair either.`);
        }
    }

    streamCachePut(cacheKey, entry);

    console.log(`✅ Streaming ${id} via itag ${formatId} (${height}p, ${acodec}, ${entry.kind}${bytes ? `, ${(bytes / 1048576).toFixed(1)} MB` : ''}) [${result.strategy}]`);

    if (json === '1') return res.json(entry);
    res.redirect(directUrl);
});

app.post('/api/analyze', (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'No URL provided' });

    console.log(`🔍 Analyzing: ${url}`);
    const platform = detectPlatform(url);
    console.log(`📱 Platform detected: ${platform}`);

    const args = [...getCommonArgs(url), '-J', url];
    const child = spawnYtDlp(args);
    let jsonBuffer = '';

    child.stdout.on('data', (d) => jsonBuffer += d.toString());
    child.stderr.on('data', (d) => console.error(`[Analyze Log] ${d}`));

    child.on('close', (code) => {
        if (code !== 0) {
            console.error(`Analysis process exited with code ${code}`);
            return res.status(500).json({ error: 'Analysis failed (Check server logs)' });
        }

        try {
            const data = JSON.parse(jsonBuffer);

            const MAX_SIZE = 100 * 1024 * 1024;

            const videoFormats = (data.formats || [])
                .filter(f =>
                    f.vcodec !== 'none' &&
                    f.ext !== 'mhtml' &&
                    f.height &&
                    (!f.filesize || f.filesize <= MAX_SIZE)
                )
                .map(f => ({
                    format_id: f.format_id,
                    height: f.height,
                    width: f.width,
                    fps: f.fps || null,
                    ext: f.ext,
                    filesize: f.filesize,
                    tbr: f.tbr || 0,
                    vcodec: f.vcodec,
                    url: f.url
                }));

            const resolutionMap = new Map();
            videoFormats.forEach(f => {
                const existing = resolutionMap.get(f.height);
                if (!existing || f.tbr > existing.tbr) resolutionMap.set(f.height, f);
            });

            let uniqueFormats = Array.from(resolutionMap.values())
                .sort((a, b) => b.height - a.height)
                .map(f => {
                    let resLabel = `${f.height}p`;
                    if (f.fps && f.height >= 720) resLabel += ` ${Math.round(f.fps)}fps`;

                    return {
                        format_id: f.format_id,
                        resolution: resLabel,
                        height: f.height,
                        extension: f.ext,
                        size: f.filesize ? (f.filesize / 1024 / 1024).toFixed(1) + ' MB' : '~',
                        fps: f.fps ? Math.round(f.fps) : null,
                        url: f.url
                    };
                });

            uniqueFormats = uniqueFormats.filter(f => {
                if (f.size === '~') return true;
                return parseFloat(f.size) <= 100;
            });

            console.log(`📊 Found ${uniqueFormats.length} unique quality options`);

            res.json({
                status: 'success',
                title: data.title,
                thumbnail: data.thumbnail,
                duration: data.duration_string || (data.duration ? new Date(data.duration * 1000).toISOString().substr(11, 8) : 'N/A'),
                source: data.extractor_key || data.extractor || platform.toUpperCase(),
                formats: uniqueFormats,
                platform
            });

        } catch (e) {
            console.error('JSON Parse Error:', e);
            res.status(500).json({ error: 'Failed to parse JSON' });
        }
    });

    child.on('error', (err) => {
        console.error('❌ Analyze spawn error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to start analysis' });
    });
});

app.get('/api/download', async (req, res) => {
    const { url, resolution, type, title } = req.query;
    if (!url) return res.status(400).send('Missing URL');

    const platform = detectPlatform(url);
    console.log(`🚀 Downloading from ${platform}: ${url} [Type: ${type}, Res: ${resolution}]`);

    let videoTitle;
    if (title && title.trim()) {
        videoTitle = title.trim();
        console.log(`📄 Title (from query param): ${videoTitle}`);
    } else {
        videoTitle = await fetchTitle(url, 'video');
        console.log(`📄 Title: ${videoTitle}`);
    }

    const timestamp = Date.now();
    const ext = type === 'audio' ? 'mp3' : 'mp4';
    const filename = `${platform}_${timestamp}.${ext}`;
    const filePath = path.join(DOWNLOAD_DIR, filename);

    const args = getCommonArgs(url);
    args.push('-o', filePath);

    if (type === 'audio') {
        args.push(
            '-x',
            '--audio-format', 'mp3',
            '--audio-quality', '0',
            '--embed-thumbnail',
            '--embed-metadata'
        );
    } else if (resolution && resolution !== 'best' && resolution !== 'Best Auto') {

        const heightMatch = resolution.match(/^(\d+)p/);
        const height = heightMatch ? heightMatch[1] : resolution.replace(/\D/g, '');

        args.push(
            '-f',
            `bestvideo[height<=${height}][vcodec^=avc1]+bestaudio[acodec^=mp4a]/bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${height}]+bestaudio/best`,
            '--merge-output-format', 'mp4'
        );
    } else {
        args.push(
            '-f',
            'bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
            '--merge-output-format', 'mp4'
        );
    }

    args.push(url);

    console.log(`📁 Saving to: ${filePath}`);

    const child = spawnYtDlp(args);

    child.stdout.on('data', d => console.log(`[DL] ${d}`));
    child.stderr.on('data', d => console.error(`[DL ERR] ${d}`));

    child.on('close', (code) => {
        if (code !== 0) {
            console.error(`❌ Download failed with code: ${code}`);
            return res.status(500).send(`Download failed. Code: ${code}`);
        }

        if (!fs.existsSync(filePath)) {
            console.error('❌ FATAL: File not found after download:', filePath);
            return res.status(500).send('File not found after download.');
        }

        const userFilename = `${safeName(videoTitle, `video_${timestamp}`)}.${ext}`;
        console.log(`✅ Download successful. Serving as: ${userFilename}`);

        res.download(filePath, userFilename, (err) => {
            if (!err) {
                setTimeout(() => {
                    if (fs.existsSync(filePath)) {
                        fs.unlinkSync(filePath);
                        console.log(`🗑️ Cleaned up: ${filename}`);
                    }
                }, 5 * 60 * 1000);
            } else {
                console.error(`❌ Download serve error: ${err.message}`);
            }
        });
    });

    child.on('error', (err) => {
        console.error('❌ Spawn Error:', err);
        res.status(500).send('Failed to start download process.');
    });
});

const clipJobs = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [jobId, job] of clipJobs) {
        if (now - job.createdAt > 30 * 60 * 1000) {
            if (job.filePath && fs.existsSync(job.filePath)) {
                try { fs.unlinkSync(job.filePath); } catch (e) { }
            }
            clipJobs.delete(jobId);
        }
    }
}, 10 * 60 * 1000);

app.get('/api/clip', async (req, res) => {
    const { url, start, end, quality, ratio } = req.query;

    if (!url) return res.status(400).send('Missing URL');
    if (start === undefined || end === undefined) {
        return res.status(400).send('Missing start or end time');
    }

    const startTime = parseInt(start);
    const endTime = parseInt(end);
    const duration = endTime - startTime;

    if (Number.isNaN(startTime) || Number.isNaN(endTime)) {
        return res.status(400).send('Invalid time range');
    }
    if (duration <= 0) return res.status(400).send('Invalid time range');
    if (duration > 60) return res.status(400).send('Maximum clip duration is 60 seconds');

    const validQualities = ['360', '480', '720', '1080'];
    const selectedQuality = validQualities.includes(quality || '720') ? (quality || '720') : '720';

    const validRatios = ['original', '9:16', '1:1'];
    const selectedRatio = validRatios.includes(ratio || 'original') ? (ratio || 'original') : 'original';
    const needsConversion = selectedRatio !== 'original';

    console.log(`✂️ Clipping: ${url} [${startTime}s-${endTime}s] @ ${selectedQuality}p${needsConversion ? ` → ${selectedRatio}` : ''}`);

    const timestamp = Date.now();
    let safeTitle = `clip_${timestamp}`;

    if (!needsConversion) {
        const videoTitle = await fetchTitle(url, 'clip', 3000);
        safeTitle = videoTitle.slice(0, 50).replace(/[^a-zA-Z0-9 ]/g, '').trim() || 'clip';
    }

    const filename = `clip_${timestamp}.mp4`;
    const filePath = path.join(DOWNLOAD_DIR, filename);
    const sectionArg = `*${startTime}-${endTime}`;
    const formatStr = `bestvideo[ext=mp4][height<=${selectedQuality}]+bestaudio[ext=m4a]/best[ext=mp4][height<=${selectedQuality}]/best`;

    const args = [
        ...getCommonArgs(url),
        '--download-sections', sectionArg,
        '-f', formatStr,
        '--merge-output-format', 'mp4',
        '-o', filePath,
        url
    ];

    if (!needsConversion) {
        const downloadChild = spawnYtDlp(args);
        let stderrLog = '';
        downloadChild.stderr.on('data', d => stderrLog += d.toString());

        downloadChild.on('close', (code) => {
            if (code !== 0) {
                console.error(`❌ Clip download failed: ${ytDlpReason(stderrLog) || code}`);
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                return res.status(500).send('Clip download failed.');
            }

            let actualPath = filePath;
            if (!fs.existsSync(filePath)) {
                const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith(`clip_${timestamp}`));
                if (files.length > 0) actualPath = path.join(DOWNLOAD_DIR, files[0]);
                else return res.status(500).send('Clip not found.');
            }

            const userFilename = `${safeTitle} [${startTime}s-${endTime}s].mp4`;
            res.download(actualPath, userFilename, (err) => {
                if (!err) {
                    setTimeout(() => {
                        try { if (fs.existsSync(actualPath)) fs.unlinkSync(actualPath); } catch (e) { }
                    }, 5 * 60 * 1000);
                }
            });
        });

        downloadChild.on('error', () => res.status(500).send('Failed to start clip.'));
        return;
    }

    const jobId = `job_${timestamp}_${Math.random().toString(36).substr(2, 6)}`;
    const ratioSuffix = selectedRatio === '9:16' ? 'shorts' : 'square';

    clipJobs.set(jobId, {
        status: 'processing',
        filePath: null,
        filename: `${safeTitle} [${startTime}s-${endTime}s] ${ratioSuffix}.mp4`,
        error: null,
        createdAt: Date.now()
    });

    res.json({
        status: 'processing',
        jobId,
        message: `Processing clip with ratio conversion. Poll /api/clip/status/${jobId}`
    });

    console.log(`[Job ${jobId}] Starting download at ${selectedQuality}p`);

    const downloadChild = spawnYtDlp(args);
    let downloadStderr = '';

    downloadChild.stdout.on('data', (data) => {
        console.log(`[Job ${jobId}] ${data.toString().trim()}`);
    });

    downloadChild.stderr.on('data', (data) => {
        downloadStderr += data.toString();
        const output = data.toString().trim();
        if (output.includes('[download]') || output.includes('%')) {
            console.log(`[Job ${jobId}] Download: ${output}`);
        } else if (/error/i.test(output)) {
            console.error(`[Job ${jobId}] Download ERROR: ${output}`);
        }
    });

    downloadChild.on('close', (code) => {
        console.log(`[Job ${jobId}] Download process exited with code: ${code}`);

        if (code !== 0) {
            console.error(`[Job ${jobId}] Download stderr:\n${downloadStderr}`);
            clipJobs.set(jobId, { ...clipJobs.get(jobId), status: 'failed', error: 'Download failed' });
            return;
        }

        let actualFilePath = filePath;
        if (!fs.existsSync(filePath)) {
            const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith(`clip_${timestamp}`));
            if (files.length > 0) {
                actualFilePath = path.join(DOWNLOAD_DIR, files[0]);
            } else {
                clipJobs.set(jobId, { ...clipJobs.get(jobId), status: 'failed', error: 'File not found' });
                return;
            }
        }

        const convertedPath = path.join(DOWNLOAD_DIR, `clip_${timestamp}_${ratioSuffix}.mp4`);

        let filterStr;
        if (selectedRatio === '9:16') {

            const targetHeight = parseInt(selectedQuality);
            const targetWidth = Math.round(targetHeight * 9 / 16);
            filterStr = `scale=-2:${targetHeight},crop=${targetWidth}:${targetHeight}`;
        } else {
            const targetSize = parseInt(selectedQuality);
            filterStr = `crop='min(iw,ih)':'min(iw,ih)',scale=${targetSize}:${targetSize}`;
        }

        const ffmpegArgs = [
            '-y', '-i', actualFilePath,
            '-vf', filterStr,
            '-c:v', 'libx264',
            '-preset', 'superfast',
            '-crf', '28',
            '-c:a', 'aac',
            '-b:a', '96k',
            '-movflags', '+faststart',
            '-threads', '0',
            convertedPath
        ];

        console.log(`[Job ${jobId}] FFmpeg converting to ${selectedRatio}...`);

        const ffmpegChild = spawnFfmpeg(ffmpegArgs);
        let ffmpegStderr = '';

        ffmpegChild.stderr.on('data', (data) => {
            ffmpegStderr += data.toString();
            const output = data.toString().trim();
            if (output.includes('time=') || output.includes('frame=')) {
                console.log(`[Job ${jobId}] FFmpeg progress: ${output}`);
            } else if (/error|failed/i.test(output)) {
                console.error(`[Job ${jobId}] FFmpeg ERROR: ${output}`);
            }
        });

        ffmpegChild.on('close', (ffmpegCode) => {
            console.log(`[Job ${jobId}] FFmpeg exited with code: ${ffmpegCode}`);

            if (ffmpegCode !== 0) {
                console.error(`[Job ${jobId}] FFmpeg stderr:\n${ffmpegStderr}`);
            }

            try { if (fs.existsSync(actualFilePath)) fs.unlinkSync(actualFilePath); } catch (e) { }

            if (ffmpegCode !== 0 || !fs.existsSync(convertedPath)) {
                clipJobs.set(jobId, {
                    ...clipJobs.get(jobId),
                    status: 'failed',
                    error: `Conversion failed (exit code ${ffmpegCode})`
                });
                return;
            }

            const fileSize = fs.statSync(convertedPath).size;
            console.log(`[Job ${jobId}] ✅ Conversion complete (${(fileSize / 1024).toFixed(2)} KB)`);

            clipJobs.set(jobId, { ...clipJobs.get(jobId), status: 'ready', filePath: convertedPath });
        });

        ffmpegChild.on('error', (err) => {
            console.error(`[Job ${jobId}] ❌ FFmpeg spawn error:`, err);
            clipJobs.set(jobId, {
                ...clipJobs.get(jobId),
                status: 'failed',
                error: `FFmpeg error: ${err.message}`
            });
        });
    });

    downloadChild.on('error', () => {
        clipJobs.set(jobId, { ...clipJobs.get(jobId), status: 'failed', error: 'Process error' });
    });
});

app.get('/api/clip/status/:jobId', (req, res) => {
    const job = clipJobs.get(req.params.jobId);
    if (!job) {
        return res.status(404).json({ status: 'not_found', error: 'Job not found or expired' });
    }
    res.json({ status: job.status, error: job.error, filename: job.filename });
});

app.get('/api/clip/download/:jobId', (req, res) => {
    const { jobId } = req.params;
    const job = clipJobs.get(jobId);

    if (!job) return res.status(404).send('Job not found or expired');
    if (job.status !== 'ready') return res.status(400).send('Clip not ready yet');
    if (!job.filePath || !fs.existsSync(job.filePath)) return res.status(404).send('File not found');

    res.download(job.filePath, job.filename, (err) => {
        if (!err) {
            setTimeout(() => {
                try {
                    if (fs.existsSync(job.filePath)) fs.unlinkSync(job.filePath);
                    clipJobs.delete(jobId);
                } catch (e) { }
            }, 60 * 1000);
        }
    });
});

app.post('/api/subtitles', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Missing URL' });

    console.log(`📝 Fetching subtitles for: ${url}`);

    const args = [
        '--list-subs',
        '--skip-download',
        '--no-warnings',
        '--impersonate', 'chrome',
        '-J',
        url
    ];

    const cookieFile = getCookieFile(url);
    if (cookieFile) args.push('--cookies', cookieFile);

    const child = spawnYtDlp(args);
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => stdout += d.toString());
    child.stderr.on('data', (d) => stderr += d.toString());

    child.on('close', (code) => {
        if (code !== 0) {
            console.error('Subtitle list error:', stderr);
            return res.status(500).json({ error: 'Failed to fetch subtitle info' });
        }

        try {

            const jsonStart = stdout.indexOf('{');
            const data = JSON.parse(jsonStart !== -1 ? stdout.slice(jsonStart) : stdout);

            const subtitles = [];

            if (data.subtitles) {
                Object.keys(data.subtitles).forEach(lang => {
                    const sub = data.subtitles[lang];
                    if (sub && sub.length > 0) {
                        subtitles.push({ code: lang, name: sub[0].name || lang.toUpperCase(), auto: false });
                    }
                });
            }

            if (data.automatic_captions) {
                Object.keys(data.automatic_captions).forEach(lang => {
                    if (subtitles.find(s => s.code === lang)) return;
                    const sub = data.automatic_captions[lang];
                    if (sub && sub.length > 0) {
                        subtitles.push({
                            code: lang,
                            name: (sub[0].name || lang.toUpperCase()) + ' (Auto)',
                            auto: true
                        });
                    }
                });
            }

            subtitles.sort((a, b) => {
                if (a.code.startsWith('en') && !b.code.startsWith('en')) return -1;
                if (!a.code.startsWith('en') && b.code.startsWith('en')) return 1;
                return a.code.localeCompare(b.code);
            });

            console.log(`✅ Found ${subtitles.length} subtitle tracks`);

            res.json({
                title: data.title || 'Unknown',
                thumbnail: data.thumbnail || '',
                uploader: data.uploader || data.channel || 'Unknown',
                duration: data.duration_string || '',
                subtitles
            });

        } catch (parseErr) {
            console.error('JSON parse error:', parseErr);
            res.status(500).json({ error: 'Failed to parse subtitle info' });
        }
    });

    child.on('error', (err) => {
        console.error('Spawn error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to fetch subtitles' });
    });
});

app.post('/api/subtitles/preview', async (req, res) => {
    const { url, lang } = req.body;
    if (!url || !lang) return res.status(400).json({ error: 'Missing URL or language' });

    console.log(`📖 Fetching transcript preview: ${lang}`);

    try {
        const lines = await fetchSubtitleLines(url, lang, 'sub');
        if (lines.length === 0) {
            return res.status(404).json({ error: 'No subtitle file generated' });
        }
        res.json({ transcript: lines.slice(0, 100) });
    } catch (err) {
        console.error('Preview error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/subtitles/download', async (req, res) => {
    const { url, lang, format } = req.query;
    if (!url || !lang) return res.status(400).send('Missing URL or language');

    const subFormat = ['srt', 'vtt', 'txt'].includes(format) ? format : 'srt';
    console.log(`📥 Downloading subtitle: ${lang} as ${subFormat}`);

    const timestamp = Date.now();
    const subFile = path.join(DOWNLOAD_DIR, `sub_${timestamp}`);

    const downloadFormat = subFormat === 'txt' ? 'vtt' : subFormat;

    const args = [
        '--write-sub',
        '--write-auto-sub',
        '--sub-lang', lang,
        '--sub-format', downloadFormat,
        '--skip-download',
        '--no-warnings',
        '--impersonate', 'chrome',
        '-o', subFile,
        url
    ];

    const cookieFile = getCookieFile(url);
    if (cookieFile) args.push('--cookies', cookieFile);

    const videoTitle = await fetchTitle(url, 'subtitle');
    const safeTitle = videoTitle.slice(0, 50).replace(/[^a-zA-Z0-9 ]/g, '').trim() || 'subtitle';

    const child = spawnYtDlp(args);
    let stderr = '';

    child.stderr.on('data', (d) => stderr += d.toString());

    child.on('close', () => {
        const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith(`sub_${timestamp}`));

        if (files.length === 0) {
            console.error('No subtitle file found:', stderr);
            return res.status(404).send('No subtitle available for this language');
        }

        const subFilePath = path.join(DOWNLOAD_DIR, files[0]);

        try {
            if (subFormat === 'txt') {
                const lines = parseVTT(fs.readFileSync(subFilePath, 'utf8'));
                const txtPath = path.join(DOWNLOAD_DIR, `sub_${timestamp}.txt`);
                fs.writeFileSync(txtPath, lines.map(l => l.text).join('\n'));
                fs.unlinkSync(subFilePath);

                res.download(txtPath, `${safeTitle} [${lang}].txt`, () => {
                    setTimeout(() => {
                        if (fs.existsSync(txtPath)) fs.unlinkSync(txtPath);
                    }, 60000);
                });
            } else {
                res.download(subFilePath, `${safeTitle} [${lang}].${subFormat}`, () => {
                    setTimeout(() => {
                        if (fs.existsSync(subFilePath)) fs.unlinkSync(subFilePath);
                    }, 60000);
                });
            }

            console.log(`✅ Subtitle downloaded: ${safeTitle} [${lang}].${subFormat}`);

        } catch (readErr) {
            console.error('Read error:', readErr);
            res.status(500).send('Failed to read subtitle file');
        }
    });

    child.on('error', (err) => {
        console.error('Spawn error:', err);
        if (!res.headersSent) res.status(500).send('Failed to download subtitle');
    });
});

app.post('/api/summarize', async (req, res) => {
    const { url, type, refresh } = req.body;
    if (!url) return res.status(400).json({ error: 'Missing URL' });

    if (!AI_READY) {
        return res.status(500).json({ error: `AI service not configured. Please set ${PROVIDER.keyPrefix}_1 in your .env file` });
    }

    const summaryType = ['brief', 'detailed', 'keypoints', 'chapters'].includes(type) ? type : 'brief';

    if (!refresh) {
        const hit = aiCacheGet(url, `summary_${summaryType}`);
        if (hit) {
            console.log(`💾 Cached summary (${summaryType}) for ${url}`);
            return res.json({ ...hit, cached: true });
        }
    }

    console.log(`🧠 AI Summarizing video: ${url} (${summaryType})`);

    try {
        const videoInfo = await fetchInfoJson(url);
        const transcriptLines = await getTranscriptCached(url);

        if (transcriptLines.length === 0) {
            return res.status(400).json({ error: 'No subtitles available for this video' });
        }

        const transcriptText = transcriptLines.map(l => l.text).join(' ').slice(0, 15000);

        const systemPrompt = 'You are an expert video summarizer. Provide clear, well-structured summaries.';
        let userPrompt = '';

        switch (summaryType) {
            case 'brief':
                userPrompt = `Summarize this video transcript in 3-5 paragraphs. Focus on the main message and key takeaways.

Video Title: ${videoInfo.title || 'Unknown'}
Video Channel: ${videoInfo.uploader || videoInfo.channel || 'Unknown'}

Transcript:
${transcriptText}`;
                break;

            case 'detailed':
                userPrompt = `Provide a detailed summary of this video with the following sections:
1. **Overview** - What is this video about?
2. **Main Points** - List all important points discussed
3. **Key Insights** - Any valuable insights or lessons
4. **Conclusion** - Final thoughts and takeaways

Video Title: ${videoInfo.title || 'Unknown'}
Video Channel: ${videoInfo.uploader || videoInfo.channel || 'Unknown'}

Transcript:
${transcriptText}`;
                break;

            case 'keypoints':
                userPrompt = `Extract the key points from this video as a bulleted list. Each point should be concise but informative. Include at least 5-10 key points.

Video Title: ${videoInfo.title || 'Unknown'}
Video Channel: ${videoInfo.uploader || videoInfo.channel || 'Unknown'}

Transcript:
${transcriptText}`;
                break;

            case 'chapters':

                userPrompt = `Create a chapter-by-chapter breakdown of this video with TIMESTAMPS. Identify the different sections/topics and where they start.

STRICT format — one chapter per line, starting with the timestamp:
0:00 Introduction
2:35 [Topic Name]
10:12 [Topic Name]

The first line MUST start at 0:00. Use the transcript's pacing to estimate realistic start times. After the list you may add one short summary line per chapter.

Video Title: ${videoInfo.title || 'Unknown'}
Video Channel: ${videoInfo.uploader || videoInfo.channel || 'Unknown'}

Transcript with timing:
${transcriptLines.slice(0, 400).map(l => `[${l.time}] ${l.text}`).join('\n').slice(0, 15000)}`;
                break;
        }

        console.log(`🤖 Calling ${PROVIDER.label} (${activeModel})...`);

        const aiData = await callAI(
            {
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                max_tokens: 2000,
                temperature: 0.7
            },
            { title: 'RaiSum Video Summarizer' }
        );

        const summary = contentOf(aiData) || 'Could not generate summary';
        console.log(`✅ Summary generated (${summary.length} chars)`);

        const payload = {
            title: videoInfo.title || 'Unknown',
            thumbnail: videoInfo.thumbnail || '',
            uploader: videoInfo.uploader || videoInfo.channel || 'Unknown',
            duration: videoInfo.duration_string || '',
            summary,
            type: summaryType
        };

        aiCachePut(url, `summary_${summaryType}`, payload);
        res.json(payload);

    } catch (err) {
        console.error('Summarize error:', err);
        res.status(500).json({ error: err.message || 'Failed to summarize video' });
    }
});

app.post('/api/viral', async (req, res) => {
    const { url, excludedRanges } = req.body;
    if (!url) return res.status(400).json({ error: 'Missing URL' });

    if (!AI_READY) {
        return res.status(500).json({ error: `AI service not configured. Please set ${PROVIDER.keyPrefix}_1 in your .env file` });
    }

    console.log(`🔥 Finding viral clip for: ${url}`);
    if (excludedRanges && excludedRanges.length > 0) {
        console.log(`📌 Excluding ${excludedRanges.length} previously selected range(s)`);
    }

    try {
        const videoInfo = await fetchInfoJson(url);
        const videoDuration = videoInfo.duration || 0;

        if (videoDuration < 30) {
            return res.status(400).json({ error: 'Video must be at least 30 seconds long' });
        }

        const transcriptLines = await getTranscriptCached(url);

        if (transcriptLines.length === 0) {
            console.log('⚠️ No subtitles found — using a random 30s segment.');

            let minStart = 0;
            let maxStart = Math.max(0, videoDuration - 30);

            if (videoDuration > 120) {
                minStart = Math.floor(videoDuration * 0.1);
                maxStart = Math.floor(videoDuration * 0.9) - 30;
            }
            if (maxStart < minStart) maxStart = minStart;

            let attempts = 0;
            let finalStart = minStart;
            let isValid = false;

            while (attempts < 50 && !isValid) {
                const randStart = Math.floor(Math.random() * (maxStart - minStart + 1)) + minStart;
                const randEnd = randStart + 30;

                const collision = (excludedRanges || []).some(r => randStart < r.end && randEnd > r.start);

                if (!collision) {
                    finalStart = randStart;
                    isValid = true;
                }
                attempts++;
            }

            if (!isValid) {
                finalStart = Math.floor(Math.random() * (maxStart - minStart + 1)) + minStart;
            }

            return res.json({
                title: videoInfo.title || 'Unknown',
                thumbnail: videoInfo.thumbnail || '',
                uploader: videoInfo.uploader || videoInfo.channel || 'Unknown',
                duration: videoDuration,
                startTime: finalStart,
                endTime: finalStart + 30,
                reasoning: 'No subtitles available. Selected a random highlight segment.',
                clipTranscript: 'No transcript available for this video.'
            });
        }

        const transcriptWithTimestamps = transcriptLines
            .map(l => {
                const seconds = vttTimeToSeconds(l.time);
                if (seconds === null) return `[${l.time}] ${l.text}`;

                const isExcluded = (excludedRanges || []).some(range =>
                    seconds >= (range.start - 5) && seconds <= (range.end + 5)
                );

                return isExcluded
                    ? `[${l.time}] [ALREADY SELECTED - DO NOT USE]`
                    : `[${l.time}] ${l.text}`;
            })
            .join('\n')
            .slice(0, 20000);

        console.log('🤖 AI analyzing for viral moment...');

        let excludedText = '';
        if (excludedRanges && excludedRanges.length > 0) {
            excludedText = '\n\nCRITICAL INSTRUCTION: The following time ranges have ALREADY been selected. You MUST NOT select any time range that overlaps with these:\n';
            excludedRanges.forEach((range, idx) => {
                excludedText += `- Range ${idx + 1}: ${range.start}s to ${range.end}s (ALREADY USED)\n`;
            });
            excludedText += '\nFind a COMPLETELY DIFFERENT valid hook from the remaining transcript.\n';
        }

        const systemPrompt = `You are a viral content expert. Analyze video transcripts and identify the single best 30-second segment that would go viral on TikTok, Instagram Reels, or YouTube Shorts.

Look for:
- Shocking statements or surprising facts
- Emotional hooks that grab attention in first 3 seconds
- Controversial or thought-provoking moments
- Funny or relatable quotes
- "Aha!" moments or key insights
- Cliffhangers or mystery hooks

IMPORTANT: Respond ONLY in this exact JSON format:
{
  "startTime": <seconds_as_number>,
  "endTime": <seconds_as_number>,
  "reasoning": "<1-2 sentence explanation of why this moment is viral-worthy>"
}`;

        const userPrompt = `Video Title: ${videoInfo.title || 'Unknown'}
Video Duration: ${videoDuration} seconds

Find the best 30-second clip from this transcript. The clip must be exactly 30 seconds.${excludedText}

Transcript with timestamps:
${transcriptWithTimestamps}

Return ONLY the JSON response with startTime (in seconds), endTime (in seconds, which should be startTime + 30), and reasoning.`;

        const aiData = await callAI(
            {
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                max_tokens: 500,
                temperature: 0.7
            },
            { title: 'RaiViral Clip Finder' }
        );

        const aiText = contentOf(aiData);

        let startTime = 0;
        let endTime = 30;
        let reasoning = 'This segment has high viral potential based on content analysis.';

        try {
            const jsonMatch = aiText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                startTime = Math.max(0, Number(parsed.startTime) || 0);
                endTime = Math.min(videoDuration, Number(parsed.endTime) || startTime + 30);
                reasoning = parsed.reasoning || reasoning;

                if (endTime - startTime !== 30) {
                    endTime = Math.min(videoDuration, startTime + 30);
                }
                if (endTime > videoDuration) {
                    startTime = Math.max(0, videoDuration - 30);
                    endTime = videoDuration;
                }
            }
        } catch (parseErr) {
            console.error('AI response parse error:', parseErr);
        }

        const clipTranscript = transcriptLines
            .filter(l => {
                const seconds = vttTimeToSeconds(l.time);
                return seconds !== null && seconds >= startTime && seconds <= endTime;
            })
            .map(l => l.text)
            .join(' ');

        console.log(`✅ Viral clip found: ${startTime}s - ${endTime}s`);

        res.json({
            title: videoInfo.title || 'Unknown',
            thumbnail: videoInfo.thumbnail || '',
            uploader: videoInfo.uploader || videoInfo.channel || 'Unknown',
            duration: videoDuration,
            startTime,
            endTime,
            reasoning,
            clipTranscript: clipTranscript || 'Transcript not available for this segment.'
        });

    } catch (err) {
        console.error('Viral clip error:', err);
        res.status(500).json({ error: err.message || 'Failed to find viral clip' });
    }
});

app.post('/api/tags/generate', async (req, res) => {
    const { title, existingTags } = req.body;
    if (!title) return res.status(400).json({ error: 'Missing title' });
    if (!AI_READY) return res.status(500).json({ error: 'AI service not configured' });

    console.log(`🏷️ Generating AI tags for: ${title}`);

    try {
        const prompt = `Generate 15 relevant YouTube tags for a video titled: "${title}"
${existingTags?.length ? `\nExisting tags for reference: ${existingTags.slice(0, 10).join(', ')}` : ''}

Requirements:
- Return ONLY a JSON array of strings
- Tags should be relevant, searchable keywords
- Mix of broad and specific tags
- Include trending variations
- No hashtags, just plain text tags

Example output format: ["tag1", "tag2", "tag3"]`;

        const aiData = await callAI(
            {
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 500,
                temperature: 0.8
            },
            { title: 'RaiTags Generator' }
        );

        const aiText = contentOf(aiData) || '[]';

        let tags = [];
        try {
            const match = aiText.match(/\[[\s\S]*\]/);
            if (match) tags = JSON.parse(match[0]);
        } catch (e) {
            tags = aiText.split(',').map(t => t.trim().replace(/["\[\]]/g, '')).filter(Boolean);
        }

        res.json({ tags: tags.slice(0, 15) });

    } catch (err) {
        console.error('AI tags error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/titles/generate', async (req, res) => {
    const { topic, style } = req.body;
    if (!topic) return res.status(400).json({ error: 'Missing topic' });
    if (!AI_READY) return res.status(500).json({ error: 'AI service not configured' });

    console.log(`📝 Generating titles for: ${topic} (style: ${style})`);

    const stylePrompts = {
        viral: 'Focus on shocking, emotional hooks that create FOMO and urgency',
        curiosity: 'Create curiosity gaps that make viewers NEED to click to find out more',
        howto: 'Clear, actionable titles that promise specific skills or knowledge',
        listicle: 'Use numbers, brackets, and list formats (Top 10, 5 Ways, etc.)'
    };

    try {
        const prompt = `Generate exactly 10 unique YouTube video titles for: "${topic}"

Style: ${stylePrompts[style] || stylePrompts.viral}

Requirements:
- Under 60 characters each
- Use power words and emotional triggers
- Include numbers or brackets where appropriate
- SEO-optimized with natural keywords
- No clickbait that doesn't deliver

Return ONLY a JSON array of 10 strings. Example: ["Title 1", "Title 2", ...]`;

        const aiData = await callAI(
            {
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 800,
                temperature: 0.9
            },
            { title: 'RaiTitle Generator' }
        );

        const aiText = contentOf(aiData) || '[]';

        let titles = [];
        try {
            const match = aiText.match(/\[[\s\S]*\]/);
            if (match) titles = JSON.parse(match[0]);
        } catch (e) {
            titles = aiText.split('\n')
                .filter(l => l.trim())
                .map(l => l.replace(/^\d+\.\s*/, '').replace(/^["']|["']$/g, '').trim())
                .filter(Boolean);
        }

        res.json({ titles: titles.slice(0, 10) });

    } catch (err) {
        console.error('AI titles error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/description/generate', async (req, res) => {
    const { title, keywords, type, options, modifier } = req.body;
    if (!title) return res.status(400).json({ error: 'Missing title' });
    if (!AI_READY) return res.status(500).json({ error: 'AI service not configured' });

    console.log(`📄 Generating description for: ${title}`);

    const typePrompts = {
        standard: 'Balanced description with hook, main content, and CTA (200-400 words)',
        detailed: 'Comprehensive description with detailed sections (400-600 words)',
        minimal: 'Concise, impactful description (100-200 words)'
    };

    const modifierPrompts = {
        shorter: 'Make the description shorter and more concise',
        longer: 'Expand the description with more details and sections',
        formal: 'Use professional, formal language',
        casual: 'Use friendly, casual, conversational tone'
    };

    let optionsText = '';
    if (options?.timestamps) optionsText += '\n- Include sample timestamps section (e.g., 0:00 Intro, 1:30 Main Topic)';
    if (options?.hashtags) optionsText += '\n- End with 3-5 relevant hashtags';
    if (options?.links) optionsText += '\n- Include placeholder social media links section';
    if (options?.cta) optionsText += '\n- Include call-to-action (subscribe, like, comment)';

    try {
        const prompt = `Generate a YouTube video description for: "${title}"
${keywords ? `\nKeywords to include naturally: ${keywords}` : ''}

Style: ${typePrompts[type] || typePrompts.standard}
${modifier ? `\nModifier: ${modifierPrompts[modifier]}` : ''}
${optionsText}

Requirements:
- SEO-optimized with natural keyword usage
- Engaging hook in first 2 lines (visible before "Show more")
- Well-structured with clear sections
- Include relevant emojis for visual appeal

Return ONLY the description text, no explanations.`;

        const aiData = await callAI(
            {
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 1500,
                temperature: 0.8
            },
            { title: 'RaiDesc Generator' }
        );

        res.json({ description: contentOf(aiData).trim() });

    } catch (err) {
        console.error('AI description error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/chat/info', (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'No URL provided' });

    console.log(`🤖 [Chat] Getting video info: ${url}`);

    const args = [
        '--no-check-certificates',
        '--no-warnings',
        '--skip-download',
        '--print-json',
        '--impersonate', 'chrome',
        url
    ];

    const cookieFile = getCookieFile(url);
    if (cookieFile) args.unshift('--cookies', cookieFile);

    const child = spawnYtDlp(args);
    let jsonBuffer = '';
    let errorBuffer = '';

    child.stdout.on('data', (d) => jsonBuffer += d.toString());
    child.stderr.on('data', (d) => errorBuffer += d.toString());

    child.on('close', (code) => {
        if (code !== 0) {
            console.error(`[Chat] Info fetch failed with code ${code}: ${errorBuffer}`);
            return res.status(500).json({ error: 'Failed to get video info' });
        }

        try {
            const data = JSON.parse(jsonBuffer);

            res.json({
                status: 'success',
                title: data.title || 'Unknown Title',
                uploader: data.uploader || data.channel || 'Unknown Channel',
                channel: data.channel || data.uploader || 'Unknown Channel',
                duration: data.duration || 0,
                thumbnail: data.thumbnail || null,
                description: data.description || '',
                view_count: data.view_count || 0,
                like_count: data.like_count || 0,
                upload_date: data.upload_date || null,
                categories: data.categories || [],
                tags: data.tags || []
            });

        } catch (e) {
            console.error('[Chat] JSON Parse Error:', e);
            res.status(500).json({ error: 'Failed to parse video info' });
        }
    });

    child.on('error', (err) => {
        console.error('[Chat] Spawn Error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to start info process' });
    });
});

app.post('/api/chat', async (req, res) => {
    const { videoId, videoData, messages } = req.body;

    if (!videoId || !messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: 'Invalid request. videoId and messages are required.' });
    }

    if (!AI_READY) {
        console.error('[Chat] AI key not configured');
        return res.status(500).json({ error: `AI service not configured. Please set ${PROVIDER.keyPrefix}_1.` });
    }

    console.log(`🤖 [Chat] Processing chat for video: ${videoData?.title || videoId}`);

    try {
        const systemPrompt = `You are RaiChat, a friendly and helpful AI assistant that specializes in analyzing and discussing YouTube videos.

CURRENT VIDEO CONTEXT:
- Title: ${videoData?.title || 'Unknown'}
- Channel: ${videoData?.channel || 'Unknown'}
- Duration: ${videoData?.duration || 'Unknown'}
- Description: ${(videoData?.description || '').substring(0, 1000)}
${videoData?.courseTitle ? `
THIS LESSON IS PART OF A COURSE THE STUDENT IS TAKING:
- Course: ${videoData.courseTitle}
- Day-wise outline:
${(videoData.courseOutline || '').substring(0, 3000)}

The student may ask about the whole course ("this topic kis din aayega?",
"kya main aage jump kar sakta hoon?") — answer using the outline above.
Reply in the same language the student writes in; default to English.
` : ''}
YOUR CAPABILITIES:
- Summarize videos based on title, description, and available metadata
- Answer questions about the video's topic, creator, and content
- Provide key takeaways and main points
- Suggest timestamps for different sections (based on description if available)
- Explain complex concepts mentioned in the video
- Translate or simplify content
- Generate scripts, hooks, or content ideas based on the video

GUIDELINES:
- Be concise but thorough
- Use markdown formatting for better readability (bullet points, bold, headers)
- If you don't have enough information, be honest and say so
- Focus on being helpful and actionable
- Keep responses engaging and conversational`;

        const apiMessages = [
            { role: 'system', content: systemPrompt },
            ...messages.filter(m => m.role !== 'system').map(m => ({
                role: m.role === 'assistant' ? 'assistant' : 'user',
                content: m.content
            }))
        ];

        const data = await callAI(
            {
                messages: apiMessages,
                max_tokens: 1500,
                temperature: 0.7
            },
            { title: 'RaiChat Video Assistant' }
        );

        if (!data.choices || !data.choices[0] || !data.choices[0].message) {
            throw new Error('Invalid response from AI service');
        }

        const aiResponse = contentOf(data);
        console.log(`✅ [Chat] Response generated (${aiResponse.length} chars)`);

        res.json({ status: 'success', response: aiResponse });

    } catch (error) {
        console.error('[Chat] Chat Error:', error);
        res.status(500).json({
            error: 'Failed to generate response. Please try again.',
            details: error.message
        });
    }
});

app.post('/api/transcript', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Missing URL' });

    console.log(`📖 Full transcript: ${url}`);

    try {
        const lines = await getTranscriptCached(url);
        if (lines.length === 0) {
            return res.status(404).json({ error: 'No subtitles available for this video' });
        }
        res.json({ transcript: lines });
    } catch (err) {
        console.error('Transcript error:', err);
        res.status(500).json({ error: 'Failed to fetch transcript' });
    }
});

app.post('/api/quiz', async (req, res) => {
    const { url, refresh } = req.body;
    if (!url) return res.status(400).json({ error: 'Missing URL' });
    if (!AI_READY) return res.status(500).json({ error: 'AI service not configured' });

    if (!refresh) {
        const hit = aiCacheGet(url, 'quiz');
        if (hit) return res.json({ questions: hit, cached: true });
    }

    console.log(`❓ Quiz for: ${url}`);

    try {
        const lines = await getTranscriptCached(url);
        if (lines.length === 0) {
            return res.status(400).json({ error: 'No subtitles available — quiz needs the transcript' });
        }

        const transcriptText = lines.map(l => l.text).join(' ').slice(0, 14000);

        const questions = await callForJson(
            'You are an exam paper setter. You write questions about the SUBJECT, '
            + 'using a lesson transcript only as the source of what was taught. '
            + 'Reply with ONLY a JSON array, no prose.',
            `Write exactly 5 multiple-choice questions on the TOPIC taught in the transcript below.

Write them as they would appear on a real exam paper for this subject.
A student who understood the lesson should be able to answer them without
having the transcript in front of them.

HARD RULES — a question breaking any of these is useless:
- NEVER ask about the video, the recording, the teacher, or the wording.
  Banned: "which word did the speaker use", "what did the teacher say",
  "according to the video", "which of these was mentioned".
- Do NOT ask what something is "called" in the transcript. Ask what it
  MEANS, what it CAUSES, how it is CALCULATED, or when it APPLIES.
- Prefer: apply a formula to numbers, predict an outcome, compare two
  concepts, spot the error in a statement, choose the correct definition.
- All four options must be believable to someone who half-learned the
  topic. No filler options, no joke options, no "none of the above".
- Only cover material actually taught in the transcript.

Write in the same language as the transcript (a Hindi lesson gets Hindi
questions), but keep technical terms in their standard form.

JSON schema: [{"question": "...", "options": ["A","B","C","D"], "answer": 0, "explanation": "one line on why the right answer is right"}]
"answer" is the 0-based index of the correct option.

Transcript:
${transcriptText}`,
            1800,
            'Study Quiz'
        );

        if (!Array.isArray(questions) || questions.length === 0) throw new Error('Empty quiz');

        aiCachePut(url, 'quiz', questions);
        res.json({ questions });

    } catch (err) {
        console.error('Quiz error:', err);
        res.status(500).json({ error: err.message || 'Failed to build quiz' });
    }
});

app.post('/api/flashcards', async (req, res) => {
    const { url, refresh } = req.body;
    if (!url) return res.status(400).json({ error: 'Missing URL' });
    if (!AI_READY) return res.status(500).json({ error: 'AI service not configured' });

    if (!refresh) {
        const hit = aiCacheGet(url, 'flashcards');
        if (hit) return res.json({ cards: hit, cached: true });
    }

    console.log(`🃏 Flashcards for: ${url}`);

    try {
        const lines = await getTranscriptCached(url);
        if (lines.length === 0) {
            return res.status(400).json({ error: 'No subtitles available — flashcards need the transcript' });
        }

        const transcriptText = lines.map(l => l.text).join(' ').slice(0, 14000);

        const cards = await callForJson(
            'You create spaced-repetition flashcards from lesson transcripts. Reply with ONLY a JSON array, no prose.',
            `From this lesson transcript, create 8-12 flashcards covering the key formulas, definitions and concepts. Front = a short question/term, back = the concise answer. Same language as the transcript.

JSON schema: [{"front": "...", "back": "..."}]

Transcript:
${transcriptText}`,
            1600,
            'Study Flashcards'
        );

        if (!Array.isArray(cards) || cards.length === 0) throw new Error('Empty cards');

        aiCachePut(url, 'flashcards', cards);
        res.json({ cards });

    } catch (err) {
        console.error('Flashcards error:', err);
        res.status(500).json({ error: err.message || 'Failed to build flashcards' });
    }
});

app.post('/api/ai-notes', async (req, res) => {
    const { url, refresh } = req.body;
    if (!url) return res.status(400).json({ error: 'Missing URL' });
    if (!AI_READY) return res.status(500).json({ error: 'AI service not configured' });

    if (!refresh) {
        const hit = aiCacheGet(url, 'ai_notes');
        if (hit) return res.json({ notes: hit, cached: true });
    }

    console.log(`📝 AI notes for: ${url}`);

    try {
        const lines = await getTranscriptCached(url);
        if (lines.length === 0) {
            return res.status(400).json({ error: 'No subtitles available — notes need the transcript' });
        }

        const timed = lines.slice(0, 500).map(l => `[${l.time}] ${l.text}`).join('\n').slice(0, 15000);

        const data = await callAI(
            {
                messages: [
                    {
                        role: 'system',
                        content: 'You write clean, structured class notes from lesson transcripts. Markdown. Keep the transcript\'s language.'
                    },
                    {
                        role: 'user',
                        content: `Turn this lesson into revision-ready class notes. Rules:
- Section headings WITH the starting timestamp, e.g. "## [12:30] Newton's Second Law"
- Bullet points under each section: formulas, definitions, examples
- End with a short "Key formulas / points to remember" section

Transcript with timing:
${timed}`
                    }
                ],
                max_tokens: 2200,
                temperature: 0.5
            },
            { title: 'AI Class Notes' }
        );

        const notes = contentOf(data);
        if (!notes) throw new Error('Empty notes');

        aiCachePut(url, 'ai_notes', notes);
        res.json({ notes });

    } catch (err) {
        console.error('AI notes error:', err);
        res.status(500).json({ error: err.message || 'Failed to build notes' });
    }
});

app.post('/api/plan', async (req, res) => {
    const { goal, videoCount, totalDurationSec } = req.body;
    if (!goal || !videoCount) return res.status(400).json({ error: 'Missing goal or videoCount' });
    if (!AI_READY) return res.status(500).json({ error: 'AI service not configured' });

    console.log(`🗓️ Plan: "${goal}" for ${videoCount} videos`);

    try {
        const hours = ((totalDurationSec || 0) / 3600).toFixed(1);

        const plan = await callForJson(
            'You are a study planner. Reply with ONLY a JSON object, no prose.',
            `A student wants: "${goal}".
The course has ${videoCount} lessons, ${hours} hours total.

Pick a realistic daily pace and study days. JSON schema:
{"videosPerDay": <int 1-6>, "restDays": ["sunday"] or [], "message": "2-3 sentence friendly plan summary, written in English"}

The pace must finish the course within the asked time frame if one is mentioned; otherwise suggest a sustainable pace.`,
            500,
            'Course Planner'
        );

        res.json(plan);

    } catch (err) {
        console.error('Plan error:', err);
        res.status(500).json({ error: err.message || 'Failed to build plan' });
    }
});

app.post('/api/course/resolve', async (req, res) => {
    const { input } = req.body;
    if (!input || !input.trim()) return res.status(400).json({ error: 'Missing input' });

    let target = input.trim();
    let sourceType = 'playlist';

    if (target.startsWith('@')) {
        target = `https://www.youtube.com/${target}/videos`;
        sourceType = 'channel';
    } else if (/youtube\.com\/(@|c\/|channel\/|user\/)/.test(target)) {

        if (!/\/videos\/?$/.test(target)) {
            target = target.replace(/\/+$/, '') + '/videos';
        }
        sourceType = 'channel';
    } else if (!/list=/.test(target) && !/youtube\.com|youtu\.be/.test(target)) {
        target = `https://www.youtube.com/@${target.replace(/^@/, '')}/videos`;
        sourceType = 'channel';
    }

    console.log(`📚 Resolving course (${sourceType}): ${target}`);

    const args = [
        '--no-check-certificates',
        '--no-warnings',
        '--flat-playlist',
        '--impersonate', 'chrome',
        '-J',
        target
    ];

    const cookieFile = getCookieFile(target);
    if (cookieFile) args.push('--cookies', cookieFile);

    const child = spawnYtDlp(args);
    let jsonBuffer = '';
    let errBuffer = '';

    child.stdout.on('data', (d) => jsonBuffer += d.toString());
    child.stderr.on('data', (d) => errBuffer += d.toString());

    child.on('close', (code) => {
        if (code !== 0) {
            console.error(`Course resolve failed (${code}): ${errBuffer.slice(0, 400)}`);
            return res.status(404).json({
                error: 'Could not read that playlist or channel. Check the link is public.'
            });
        }

        try {
            const data = JSON.parse(jsonBuffer);
            const entries = (data.entries || []).filter(e => e && e.id && e.title);

            const videos = entries
                .filter(e => !/^\[(private|deleted) video\]$/i.test(e.title))
                .map((e, i) => ({
                    id: e.id,
                    title: e.title,
                    thumbUrl: e.thumbnail || `https://img.youtube.com/vi/${e.id}/mqdefault.jpg`,
                    durationSec: Math.round(e.duration || 0),
                    description: e.description || '',
                    position: i
                }));

            if (videos.length === 0) {
                return res.status(404).json({ error: 'No public videos found in this source.' });
            }

            res.json({
                playlistId: data.id || videoCacheKey(target),
                title: data.title || data.channel || 'Course',
                author: data.uploader || data.channel || '',
                thumbUrl: videos[0].thumbUrl,
                sourceType,
                canonicalUrl: data.webpage_url || target,
                videoCount: videos.length,
                totalDurationSec: videos.reduce((sum, v) => sum + v.durationSec, 0),
                videos
            });

        } catch (e) {
            console.error('Course resolve parse error:', e);
            res.status(500).json({ error: 'Failed to read course data' });
        }
    });

    child.on('error', (err) => {
        console.error('Course resolve spawn error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to start resolver' });
    });
});

app.post('/api/course/search', (req, res) => {
    const { query } = req.body;
    if (!query || query.trim().length < 2) {
        return res.status(400).json({ error: 'Type at least 2 characters' });
    }

    const q = query.trim();
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgIQAw%253D%253D`;
    console.log(`🔎 Course search: ${q}`);

    const args = [
        '--no-check-certificates',
        '--no-warnings',
        '--flat-playlist',
        '--playlist-end', '20',
        '--impersonate', 'chrome',
        '-J',
        searchUrl
    ];

    const cookieFile = getCookieFile('https://www.youtube.com/');
    if (cookieFile) args.push('--cookies', cookieFile);

    const child = spawnYtDlp(args);
    let jsonBuffer = '';
    let errBuffer = '';

    child.stdout.on('data', (d) => jsonBuffer += d.toString());
    child.stderr.on('data', (d) => errBuffer += d.toString());

    child.on('close', (code) => {
        if (code !== 0) {
            console.error(`Course search failed (${code}): ${errBuffer.slice(0, 300)}`);
            return res.status(500).json({ error: 'Search failed. Try again.' });
        }

        try {
            const data = JSON.parse(jsonBuffer);
            const entries = (data.entries || []).filter(e => e && e.title);

            const results = entries
                .filter(e => e._type === 'playlist' || e.ie_key === 'YoutubeTab' || /list=/.test(e.url || ''))
                .slice(0, 20)
                .map(e => {
                    const listMatch = (e.url || '').match(/list=([A-Za-z0-9_-]+)/);
                    const playlistId = listMatch ? listMatch[1] : e.id;

                    return {
                        playlistId,
                        title: e.title,
                        author: e.channel || e.uploader || '',
                        thumbUrl: e.thumbnails?.[e.thumbnails.length - 1]?.url || e.thumbnail || '',
                        videoCount: e.playlist_count || e.video_count || 0,
                        url: e.url && e.url.startsWith('http')
                            ? e.url
                            : `https://www.youtube.com/playlist?list=${playlistId}`
                    };
                })
                .filter(r => r.playlistId);

            console.log(`🔎 Found ${results.length} playlists for "${q}"`);
            res.json({ results });

        } catch (e) {
            console.error('Course search parse error:', e);
            res.status(500).json({ error: 'Failed to read search results' });
        }
    });

    child.on('error', (err) => {
        console.error('Course search spawn error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to start search' });
    });
});

app.post('/api/thumbnail', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Missing URL' });

    try {
        const info = await fetchInfoJson(url);
        res.json({
            title: info.title || 'Unknown',
            uploader: info.uploader || info.channel || '',
            thumbnail: info.thumbnail || '',
            thumbnails: info.thumbnails || []
        });
    } catch (err) {
        console.error('Thumbnail error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/metadata', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Missing URL' });

    console.log(`📊 Fetching metadata for: ${url}`);

    try {
        const info = await fetchInfoJson(url);
        res.json({
            title: info.title || 'Unknown',
            uploader: info.uploader || info.channel || '',
            upload_date: info.upload_date || '',
            description: info.description || '',
            duration: info.duration || 0,
            duration_string: info.duration_string || '0:00',
            view_count: info.view_count || 0,
            like_count: info.like_count || 0,
            comment_count: info.comment_count || 0,
            tags: info.tags || [],
            categories: info.categories || [],
            thumbnail: info.thumbnail || ''
        });
    } catch (err) {
        console.error('Metadata error:', err);
        res.status(500).json({ error: err.message });
    }
});

function extractChannelId(input) {
    if (input.startsWith('@')) return { type: 'handle', value: input };

    const patterns = [
        /youtube\.com\/@([a-zA-Z0-9_-]+)/,
        /youtube\.com\/channel\/(UC[a-zA-Z0-9_-]+)/,
        /youtube\.com\/c\/([a-zA-Z0-9_-]+)/,
        /youtube\.com\/user\/([a-zA-Z0-9_-]+)/,
        /youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/,
        /youtu\.be\/([a-zA-Z0-9_-]{11})/
    ];

    for (const pattern of patterns) {
        const match = input.match(pattern);
        if (match) {
            const src = pattern.toString();
            if (src.includes('watch') || src.includes('youtu.be')) {
                return { type: 'video', value: match[1] };
            }
            if (src.includes('channel')) {
                return { type: 'channel_id', value: match[1] };
            }
            return { type: 'handle', value: '@' + match[1] };
        }
    }

    return { type: 'handle', value: input.startsWith('@') ? input : '@' + input };
}

app.post('/api/channel/analyze', async (req, res) => {
    const { input } = req.body;
    if (!input) return res.status(400).json({ error: 'No channel input provided' });

    console.log(`📊 [Analyze] Analyzing: ${input}`);

    const channelInfo = extractChannelId(input);
    let targetUrl;
    let videosUrl;

    switch (channelInfo.type) {
        case 'video':
            targetUrl = `https://www.youtube.com/watch?v=${channelInfo.value}`;
            break;
        case 'channel_id':
            targetUrl = `https://www.youtube.com/channel/${channelInfo.value}`;
            videosUrl = `${targetUrl}/videos`;
            break;
        default: {
            const handle = channelInfo.value.replace(/^@/, '');
            targetUrl = `https://www.youtube.com/@${handle}`;
            videosUrl = `${targetUrl}/videos`;
        }
    }

    console.log(`📊 [Analyze] Target URL: ${targetUrl}`);

    try {
        const cookieFile = getCookieFile(targetUrl);

        const infoArgs = [
            '--no-check-certificates',
            '--no-warnings',
            '--skip-download',
            '--impersonate', 'chrome',
            '-j',
            '--playlist-items', '1',
            targetUrl
        ];
        if (cookieFile) infoArgs.unshift('--cookies', cookieFile);

        console.log('📊 [Analyze] Fetching channel info...');

        const channelMeta = await new Promise((resolve, reject) => {
            const child = spawnYtDlp(infoArgs);
            let stdout = '';
            let stderr = '';

            child.stdout.on('data', d => stdout += d.toString());
            child.stderr.on('data', d => stderr += d.toString());

            child.on('close', code => {
                if (code !== 0) {
                    console.error(`[Analyze] Info fetch failed: ${stderr}`);
                    return reject(new Error('Failed to fetch channel info'));
                }
                try {
                    resolve(JSON.parse(stdout));
                } catch (e) {
                    reject(new Error('Failed to parse channel info'));
                }
            });

            child.on('error', err => reject(err));
        });

        const channelName = channelMeta.channel || channelMeta.uploader || 'Unknown Channel';
        const channelId = channelMeta.channel_id || channelMeta.uploader_id || '';
        const channelHandle = channelMeta.uploader_id || channelId;
        const channelUrl = channelMeta.channel_url || channelMeta.uploader_url || targetUrl;
        const subscriberCount = channelMeta.channel_follower_count || 0;
        const channelDescription = channelMeta.channel_description || channelMeta.description || '';

        let avatarUrl = null;
        if (channelMeta.thumbnails && channelMeta.thumbnails.length > 0) {
            const possibleAvatars = channelMeta.thumbnails.filter(t =>
                t.height && t.width && Math.abs(t.height - t.width) < 50 && t.height < 300
            );
            if (possibleAvatars.length > 0) {
                avatarUrl = possibleAvatars[possibleAvatars.length - 1].url;
            }
        }

        if (!avatarUrl) {
            avatarUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(channelName)}&size=200&background=10B981&color=fff&bold=true`;
        }

        console.log(`📊 [Analyze] Channel: ${channelName}, Subs: ${subscriberCount}`);

        const actualVideosUrl = videosUrl || channelUrl + '/videos';
        const videosArgs = [
            '--no-check-certificates',
            '--no-warnings',
            '--skip-download',
            '--impersonate', 'chrome',
            '-j',
            '--playlist-items', '1:10',
            actualVideosUrl
        ];
        if (cookieFile) videosArgs.unshift('--cookies', cookieFile);

        console.log(`📊 [Analyze] Fetching videos from: ${actualVideosUrl}`);

        const videosData = await new Promise((resolve) => {
            const child = spawnYtDlp(videosArgs);
            let stdout = '';
            let stderr = '';

            child.stdout.on('data', d => stdout += d.toString());
            child.stderr.on('data', d => stderr += d.toString());

            child.on('close', code => {
                if (code !== 0) console.log(`[Analyze] Videos fetch warning: ${stderr}`);
                resolve(stdout);
            });

            child.on('error', err => {
                console.error('[Analyze] Videos fetch error:', err);
                resolve('');
            });
        });

        const videos = [];
        let totalViews = 0;
        let videoCount = 0;
        let oldestDate = null;

        if (videosData.trim()) {
            for (const line of videosData.trim().split('\n').filter(l => l.trim())) {
                try {
                    const video = JSON.parse(line);
                    const views = video.view_count || 0;
                    totalViews += views;
                    videoCount++;

                    if (video.upload_date) {
                        const uploadDate = new Date(video.upload_date.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'));
                        if (!oldestDate || uploadDate < oldestDate) oldestDate = uploadDate;
                    }

                    videos.push({
                        id: video.id,
                        title: video.title || 'Untitled',
                        url: video.webpage_url || `https://www.youtube.com/watch?v=${video.id}`,
                        thumbnail: video.thumbnail || `https://img.youtube.com/vi/${video.id}/maxresdefault.jpg`,
                        duration: formatDuration(video.duration),
                        views,
                        uploadDate: video.upload_date
                            ? new Date(video.upload_date.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')).toISOString()
                            : null
                    });
                } catch (e) {  }
            }
        }

        let channelAge = null;
        if (oldestDate) {
            const now = new Date();
            const years = Math.floor((now - oldestDate) / (365.25 * 24 * 60 * 60 * 1000));
            const months = Math.floor(((now - oldestDate) % (365.25 * 24 * 60 * 60 * 1000)) / (30.44 * 24 * 60 * 60 * 1000));
            if (years > 0) channelAge = `${years}+ years`;
            else if (months > 0) channelAge = `${months}+ months`;
            else channelAge = 'Less than a month';
        }

        console.log(`✅ [Analyze] Found ${videos.length} videos for ${channelName}`);

        res.json({
            status: 'success',
            name: channelName,
            handle: channelHandle ? (channelHandle.startsWith('@') ? channelHandle : '@' + channelHandle) : '',
            description: channelDescription.substring(0, 500),
            url: channelUrl,
            avatar: avatarUrl,
            subscribers: subscriberCount,
            videoCount: channelMeta.playlist_count || videoCount || 0,
            totalViews,
            channelAge,
            country: channelMeta.location || null,
            videos
        });

    } catch (err) {
        console.error('[Analyze] Error:', err.message);

        if (channelInfo.type === 'handle') {
            return fetchChannelViaSearch(channelInfo.value, res);
        }

        res.status(500).json({ error: 'Failed to analyze channel. Please check the URL and try again.' });
    }
});

function fetchChannelViaSearch(handle, res) {
    console.log(`📊 [Analyze] Fallback search for: ${handle}`);

    const args = [
        '--no-check-certificates',
        '--no-warnings',
        '--flat-playlist',
        '--impersonate', 'chrome',
        '-J',
        `ytsearch1:${handle.replace('@', '')} channel`
    ];

    const child = spawnYtDlp(args);
    let jsonBuffer = '';

    child.stdout.on('data', (d) => jsonBuffer += d.toString());
    child.stderr.on('data', (d) => console.error(`[Analyze Search] ${d}`));

    child.on('close', (code) => {
        if (code !== 0) {
            return res.status(500).json({ error: 'Channel not found. Please check the username and try again.' });
        }

        try {
            const data = JSON.parse(jsonBuffer);
            if (!data.entries || data.entries.length === 0) {
                return res.status(404).json({ error: 'Channel not found' });
            }

            const entry = data.entries[0];
            res.json({
                status: 'success',
                name: entry.channel || entry.uploader || 'Unknown',
                handle,
                description: '',
                url: entry.channel_url || entry.uploader_url || '',
                avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(entry.channel || 'CH')}&size=200&background=10B981&color=fff`,
                subscribers: entry.channel_follower_count || 0,
                videoCount: 0,
                totalViews: 0,
                videos: [{
                    id: entry.id,
                    title: entry.title,
                    thumbnail: entry.thumbnail || `https://img.youtube.com/vi/${entry.id}/maxresdefault.jpg`,
                    views: entry.view_count || 0,
                    duration: formatDuration(entry.duration)
                }]
            });

        } catch (e) {
            console.error('[Analyze Search] Parse Error:', e);
            res.status(500).json({ error: 'Failed to search for channel' });
        }
    });

    child.on('error', (err) => {
        console.error('[Analyze Search] Spawn Error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to search for channel' });
    });
}

function publicBase(req) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.get('host');
    return `${proto}://${host}`;
}

app.get('/api/app/version', (req, res) => {
    if (!fs.existsSync(APP_VERSION_FILE)) {
        return res.status(404).json({ error: 'No version manifest' });
    }
    try {
        const data = JSON.parse(fs.readFileSync(APP_VERSION_FILE, 'utf8'));
        if (!data.apkUrl) data.apkUrl = `${publicBase(req)}/download/app`;
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: 'Bad version manifest' });
    }
});

app.get('/download/app', (req, res) => {
    if (!fs.existsSync(APK_FILE)) {
        return res.status(404).json({
            error: 'No APK published yet',
            hint: `Publish one from the admin console, or copy it to ${APK_FILE}.`
        });
    }

    res.type('application/vnd.android.package-archive');
    res.download(APK_FILE, `${APP_NAME.toLowerCase().replace(/[^a-z0-9]/g, '')}.apk`);
});

const MAX_APK_BYTES = 300 * 1024 * 1024;

const ADMIN_FAILS = new Map();
const ADMIN_MAX_FAILS = 8;
const ADMIN_BLOCK_MS = 15 * 60 * 1000;

function adminClientIp(req) {
    return (
        req.headers['cf-connecting-ip'] ||
        String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
        req.ip ||
        'unknown'
    );
}

function adminIsBlocked(req) {
    const rec = ADMIN_FAILS.get(adminClientIp(req));
    return Boolean(rec && rec.blockedUntil > Date.now());
}

function adminNoteFailure(req) {
    const ip = adminClientIp(req);
    const rec = ADMIN_FAILS.get(ip) || { count: 0, blockedUntil: 0 };
    rec.count++;

    if (rec.count >= ADMIN_MAX_FAILS) {
        rec.blockedUntil = Date.now() + ADMIN_BLOCK_MS;
        rec.count = 0;
        console.warn(`⛔ Admin auth blocked for ${ip} (${ADMIN_BLOCK_MS / 60000} min)`);
    }

    ADMIN_FAILS.set(ip, rec);
    if (ADMIN_FAILS.size > 5000) ADMIN_FAILS.clear();
}

function adminNoteSuccess(req) {
    ADMIN_FAILS.delete(adminClientIp(req));
}

function logTokenMismatch(given) {
    const fp = (s) => s ? crypto.createHash('sha256').update(s).digest('hex').slice(0, 8) : '(empty)';
    console.warn(`🔒 Admin token rejected. Sent: len=${given.length} fp=${fp(given)} · Expected: len=${ADMIN_TOKEN.length} fp=${fp(ADMIN_TOKEN)}`);
}

function adminAuthorised(req) {
    if (!ADMIN_TOKEN) return false;

    const given = String(req.get('x-admin-token') || '').trim();
    const a = Buffer.from(given);
    const b = Buffer.from(ADMIN_TOKEN);

    if (a.length !== b.length) {
        logTokenMismatch(given);
        return false;
    }
    if (crypto.timingSafeEqual(a, b)) return true;

    logTokenMismatch(given);
    return false;
}

function requireAdmin(req, res) {
    if (!ADMIN_TOKEN) {
        res.status(503).json({
            error: 'Publishing is disabled',
            hint: 'Set ADMIN_TOKEN in .env and restart the server.'
        });
        return false;
    }

    if (adminIsBlocked(req)) {
        res.status(429).json({ error: 'Too many failed attempts. Try again in a few minutes.' });
        return false;
    }

    if (!adminAuthorised(req)) {
        adminNoteFailure(req);
        res.status(401).json({ error: 'Wrong admin token' });
        return false;
    }

    adminNoteSuccess(req);
    return true;
}

const uploadTickets = new Map();
const TICKET_TTL_MS = 10 * 60 * 1000;

function sweepTickets() {
    const now = Date.now();
    for (const [t, v] of uploadTickets) {
        if (v.expiresAt <= now) uploadTickets.delete(t);
    }
}

function redeemTicket(ticket) {
    sweepTickets();
    if (!ticket) return null;

    const entry = uploadTickets.get(ticket);
    if (!entry) return null;

    uploadTickets.delete(ticket);
    if (entry.expiresAt <= Date.now()) return null;
    return entry;
}

function readManifest() {
    try {
        if (fs.existsSync(APP_VERSION_FILE)) {
            return JSON.parse(fs.readFileSync(APP_VERSION_FILE, 'utf8'));
        }
    } catch (e) { }
    return { version: '0.0.0', notes: '' };
}

app.get('/api/admin/status', (req, res) => {
    if (!requireAdmin(req, res)) return;

    let apk = null;
    if (fs.existsSync(APK_FILE)) {
        const st = fs.statSync(APK_FILE);
        apk = {
            sizeMb: +(st.size / 1024 / 1024).toFixed(1),
            uploadedAt: st.mtime.toISOString()
        };
    }

    res.json({ manifest: readManifest(), apk, apkPath: APK_FILE });
});

app.post('/api/admin/upload-ticket', (req, res) => {
    if (!requireAdmin(req, res)) return;

    const version = String(req.body?.version || '').trim();
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
        return res.status(400).json({ error: 'Version must look like 1.2.0' });
    }
    const notes = String(req.body?.notes || '').slice(0, 500);

    sweepTickets();
    const ticket = crypto.randomBytes(32).toString('hex');
    uploadTickets.set(ticket, { version, notes, expiresAt: Date.now() + TICKET_TTL_MS });

    res.json({
        ticket,
        uploadUrl: `/api/admin/apk?ticket=${ticket}`,
        expiresInSec: TICKET_TTL_MS / 1000
    });
});

app.put('/api/admin/apk',
    express.raw({ type: '*/*', limit: MAX_APK_BYTES }),
    (req, res) => {
        const redeemed = redeemTicket(String(req.query.ticket || ''));
        if (!redeemed && !requireAdmin(req, res)) return;

        const buf = req.body;
        if (!Buffer.isBuffer(buf) || buf.length < 1024 * 1024) {
            return res.status(400).json({ error: 'That file is too small to be an APK.' });
        }

        if (!(buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04)) {
            return res.status(400).json({ error: 'That is not an APK file.' });
        }

        const version = redeemed ? redeemed.version : String(req.query.version || '').trim();
        if (!/^\d+\.\d+\.\d+$/.test(version)) {
            return res.status(400).json({ error: 'Version must look like 1.2.0' });
        }
        const notes = redeemed ? redeemed.notes : String(req.query.notes || '').slice(0, 500);

        const tmp = `${APK_FILE}.uploading`;
        try {
            fs.mkdirSync(path.dirname(APK_FILE), { recursive: true });
            fs.writeFileSync(tmp, buf);
            fs.renameSync(tmp, APK_FILE);
        } catch (e) {
            try { fs.unlinkSync(tmp); } catch (_) { }
            console.error('APK write failed:', e);
            return res.status(500).json({ error: `Could not write ${APK_FILE}: ${e.message}` });
        }

        try {
            fs.mkdirSync(path.dirname(APP_VERSION_FILE), { recursive: true });
            fs.writeFileSync(APP_VERSION_FILE, JSON.stringify({ version, notes }, null, 2));
        } catch (e) {
            return res.status(500).json({
                error: `APK saved, but the manifest could not be written: ${e.message}`
            });
        }

        console.log(`🚀 Published v${version} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
        res.json({ status: 'published', version, sizeMb: +(buf.length / 1024 / 1024).toFixed(1) });
    });

app.post('/api/admin/version', (req, res) => {
    if (!requireAdmin(req, res)) return;

    const version = String(req.body?.version || '').trim();
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
        return res.status(400).json({ error: 'Version must look like 1.2.0' });
    }
    const notes = String(req.body?.notes || '').slice(0, 500);

    try {
        fs.mkdirSync(path.dirname(APP_VERSION_FILE), { recursive: true });
        fs.writeFileSync(APP_VERSION_FILE, JSON.stringify({ version, notes }, null, 2));
        res.json({ status: 'ok', version, notes });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/c/:code', (req, res) => {
    const raw = String(req.params.code || '');
    if (!/^[A-Za-z0-9]{4,10}$/.test(raw)) {
        return res.status(400).send('Invalid course code');
    }

    const code = raw.toUpperCase();
    const base = publicBase(req);

    const hintQs = ['t', 'a', 'n', 'd', 'i']
        .filter((k) => req.query[k])
        .map((k) => `&${k}=${encodeURIComponent(String(req.query[k]).slice(0, 200))}`)
        .join('');

    const intentUrl =
        `intent://${req.get('host')}/c/${code}#Intent;scheme=https;`
        + `package=${APP_PACKAGE};S.browser_fallback_url=`
        + `${encodeURIComponent(`${base}/c/${code}?noapp=1${hintQs}`)};end`;

    const noApp = req.query.noapp === '1';

    const esc = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const title = esc(req.query.t || '') || 'A study course';
    const author = esc(req.query.a || '');
    const lessons = /^\d{1,4}$/.test(String(req.query.n || '')) ? req.query.n : null;
    const perDay = /^\d{1,2}$/.test(String(req.query.d || '')) ? req.query.d : null;
    const thumb = /^https:\/\/[\w.-]*(ytimg|ggpht|googleusercontent)\.com\//
        .test(String(req.query.i || '')) ? esc(req.query.i) : '';

    res.type('html').send(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#0E120E">
<title>${title} · ${esc(APP_NAME)}</title>
<style>
  :root { color-scheme: dark }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent }
  body { margin:0; min-height:100vh; background:#0B0F0B; color:#eaf2ea;
         font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;
         display:flex; justify-content:center; padding:0 18px 40px }
  .wrap { width:100%; max-width:400px }
  header { display:flex; align-items:center; gap:9px; padding:22px 2px 26px }
  .dot { width:26px; height:26px; border-radius:9px; background:#22C55E;
         display:grid; place-items:center; color:#04140a; font-weight:800;
         font-size:15px }
  .brand { font-weight:700; font-size:16px; letter-spacing:-.2px }
  .card { background:#131A13; border:1px solid #222c22; border-radius:20px;
          overflow:hidden; margin-bottom:14px }
  .thumb { width:100%; aspect-ratio:16/9; object-fit:cover; display:block;
           background:#1b241b }
  .body { padding:16px 16px 18px }
  h1 { font-size:19px; line-height:1.3; margin:0 0 6px; letter-spacing:-.2px }
  .by { color:#8ea08e; font-size:13.5px; margin:0 0 14px }
  .facts { display:flex; gap:8px; flex-wrap:wrap; margin:0 0 4px }
  .fact { background:#0d130d; border:1px solid #232f23; border-radius:10px;
          padding:7px 11px; font-size:12.5px; color:#b9cbb9 }
  .fact b { color:#eaf2ea; font-weight:700 }
  .note { color:#8ea08e; font-size:13px; margin:14px 0 0 }
  a.btn, button.btn {
    display:block; width:100%; padding:15px; border:0; border-radius:14px;
    font:inherit; font-weight:700; font-size:15px; text-align:center;
    text-decoration:none; cursor:pointer; margin-bottom:10px }
  .primary { background:#22C55E; color:#04140a }
  .ghost { background:transparent; border:1px solid #2a352a; color:#cfe0cf }
  .codebox { text-align:center; margin:18px 0 6px }
  .codebox span { display:block; font-size:11.5px; letter-spacing:1.4px;
                  color:#7c8c7c; text-transform:uppercase; margin-bottom:7px }
  .code { display:inline-block; letter-spacing:7px; font-size:23px;
          font-weight:800; padding:11px 12px 11px 19px; border-radius:12px;
          background:#131A13; border:1px solid #232f23 }
  .foot { color:#65755f; font-size:12px; text-align:center; margin-top:22px }
</style></head>
<body><div class="wrap">
  <header><div class="dot">${esc(APP_NAME.charAt(0).toUpperCase())}</div><div class="brand">${esc(APP_NAME)}</div></header>

  <div class="card">
    ${thumb ? `<img class="thumb" src="${thumb}" alt="">` : ''}
    <div class="body">
      <h1>${title}</h1>
      ${author ? `<p class="by">${author}</p>` : ''}
      <div class="facts">
        ${lessons ? `<div class="fact"><b>${lessons}</b> lessons</div>` : ''}
        ${perDay ? `<div class="fact"><b>${perDay}</b> a day</div>` : ''}
        <div class="fact">Day 1 starts today</div>
      </div>
      <p class="note">${esc(APP_NAME)} turns this into a day-wise course — lessons
        unlock on schedule, so you actually finish it.</p>
    </div>
  </div>

  ${noApp ? `
  <a class="btn primary" href="${base}/download/app" download>Download ${esc(APP_NAME)}</a>
  <a class="btn ghost" id="open" href="${intentUrl}">I already have the app</a>
  <p class="foot">The download is an Android APK — your browser will ask you
     to confirm before saving it.</p>
  ` : `
  <a class="btn primary" id="open" href="${intentUrl}">Open in ${esc(APP_NAME)}</a>
  <a class="btn ghost" href="${base}/c/${code}?noapp=1${hintQs}">I don't have the app</a>
  `}

  <div class="codebox">
    <span>or add it by code</span>
    <div class="code">${code}</div>
  </div>

  <p class="foot">Open ${esc(APP_NAME)} &rarr; Add course &rarr; paste this link.</p>
</div>
<script>
  // Only auto-launch on the normal path. On ?noapp=1 the visitor already told
  // us the app is not installed, so re-firing the intent just bounces them.
  ${noApp ? '' : `setTimeout(function () {
    window.location.href = ${JSON.stringify(intentUrl)};
  }, 400);`}
</script>
</body></html>`);
});

app.use((req, res) => {
    res.status(404).json({
        error: 'Not found',
        method: req.method,
        path: req.path,
        hint: 'GET / for the list of available endpoints'
    });
});

app.use((err, req, res, next) => {
    console.error('❌ API ERROR:', err);
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

process.on('uncaughtException', (err) => {
    console.error('CRITICAL ERROR (Uncaught Exception):', err);
});

process.on('unhandledRejection', (reason) => {
    console.error('CRITICAL ERROR (Unhandled Rejection):', reason);
});

function cleanupOldFiles() {
    try {
        if (!fs.existsSync(DOWNLOAD_DIR)) return;

        const now = Date.now();
        const maxAge = 5 * 60 * 1000;
        let deletedCount = 0;

        fs.readdirSync(DOWNLOAD_DIR).forEach(file => {
            const filePath = path.join(DOWNLOAD_DIR, file);
            const stats = fs.statSync(filePath);

            if (stats.isDirectory()) return;

            if (now - stats.mtimeMs > maxAge) {
                fs.unlinkSync(filePath);
                deletedCount++;
                console.log(`🗑️ Auto-cleanup: Deleted ${file} (${Math.round((now - stats.mtimeMs) / 60000)} min old)`);
            }
        });

        if (deletedCount > 0) {
            console.log(`✅ Cleanup complete: ${deletedCount} old file(s) removed`);
        }
    } catch (error) {
        console.error('❌ Cleanup error:', error.message);
    }
}

cron.schedule('*/10 * * * *', () => {
    console.log('🕐 Running scheduled cleanup...');
    cleanupOldFiles();
});

console.log('🧹 Running initial cleanup...');
cleanupOldFiles();

probeJsRuntime().then(startServer);

function startServer() {
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌍 Universal API (API-only mode) running on Port ${PORT}`);
    console.log(`📱 Supported Platforms: ${Object.keys(PLATFORM_PATTERNS).join(', ')}`);
    console.log('🍪 Cookie files detected:');

    const seen = new Set();
    Object.entries(PLATFORM_COOKIES).forEach(([platform, file]) => {
        if (fs.existsSync(file)) {
            console.log(`   ✅ ${platform}: ${path.basename(file)}`);
            seen.add(file);
        }
    });
    if (seen.size === 0) {
        console.log(`   ⚠️  none — put youtube.txt next to backend.js (${__dirname})`);
    }

    console.log(`🤖 AI: ${PROVIDER.label} · ${apiKeyManager.keys.length} key(s) · ${activeModel}`);
    console.log(`🎉 API ready! Base URL: http://localhost:${PORT}`);
    console.log(`📖 Endpoint list: GET http://localhost:${PORT}/`);
    console.log(`❤️  Health check:  GET http://localhost:${PORT}/health`);
});

server.on('error', (err) => {
    if (err.code === 'EACCES') {
        console.error(`❌ PERMISSION DENIED: Port ${PORT} is privileged (below 1024).`);
        console.error('👉 Use a normal port instead — no root needed:  PORT=3000 node backend.js');
        console.error('   Put a reverse proxy in front if you need :80 or :443.');
    } else if (err.code === 'EADDRINUSE') {
        console.error(`❌ PORT IN USE: Port ${PORT} is already being used.`);
    } else {
        console.error('❌ SERVER ERROR:', err);
    }
});
}
