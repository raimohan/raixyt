'use strict';

const { config } = require('../config');

/**
 * A Pi 4 can serve two yt-dlp jobs at once and stays responsive; four makes the
 * whole box crawl. Heavy work goes through here, everything else runs free.
 */
class Queue {
    constructor(limit = 2) {
        this.limit = Math.max(1, limit);
        this.active = 0;
        this.pending = [];
    }

    get waiting() {
        return this.pending.length;
    }

    run(task) {
        return new Promise((resolve, reject) => {
            this.pending.push({ task, resolve, reject });
            this._drain();
        });
    }

    // Position in line (1-based) a new job would take, or 0 if it starts now.
    projectedWait() {
        return this.active < this.limit ? 0 : this.pending.length + 1;
    }

    _drain() {
        while (this.active < this.limit && this.pending.length) {
            const job = this.pending.shift();
            this.active++;

            Promise.resolve()
                .then(job.task)
                .then(job.resolve, job.reject)
                .finally(() => {
                    this.active--;
                    this._drain();
                });
        }
    }
}

module.exports = {
    Queue,
    heavy: new Queue(config.maxConcurrentJobs)
};
