// pm2 process definitions.
//
//   pm2 start ecosystem.config.js     start both services
//   pm2 logs raix-bot                 follow the bot
//   pm2 save && pm2 startup           survive a reboot
//
// Memory ceilings are sized for a Raspberry Pi 4: yt-dlp does the heavy work in
// its own short-lived processes, so both node services should stay small. A
// service that creeps past its ceiling gets recycled instead of swapping the
// whole board to a crawl.

const path = require('path');

const ROOT = __dirname;

const shared = {
    cwd: ROOT,
    autorestart: true,
    watch: false,
    time: true,
    kill_timeout: 10000,
    listen_timeout: 10000,
    restart_delay: 4000,
    exp_backoff_restart_delay: 200,
    max_restarts: 20,
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss'
};

module.exports = {
    apps: [
        {
            ...shared,
            name: 'raix-api',
            script: 'backend.js',
            instances: 1,
            exec_mode: 'fork',
            max_memory_restart: '600M',
            node_args: '--max-old-space-size=512',
            error_file: path.join(ROOT, 'logs', 'api-error.log'),
            out_file: path.join(ROOT, 'logs', 'api-out.log'),
            env: {
                NODE_ENV: 'production'
            }
        },
        {
            ...shared,
            name: 'raix-bot',
            script: 'bot/index.js',
            instances: 1,
            exec_mode: 'fork',
            max_memory_restart: '400M',
            node_args: '--max-old-space-size=384',
            error_file: path.join(ROOT, 'logs', 'bot-error.log'),
            out_file: path.join(ROOT, 'logs', 'bot-out.log'),
            env: {
                NODE_ENV: 'production'
            }
        }
    ]
};
