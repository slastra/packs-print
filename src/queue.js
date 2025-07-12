import { EventEmitter } from 'events';
import { logger, MODULES } from './logger.js';

class PrintQueue extends EventEmitter {
    constructor() {
        super();
        this.queue = [];
        this.processing = false;
        this.currentJob = null;
        this.stats = {
            totalJobs: 0,
            completedJobs: 0,
            failedJobs: 0,
            startTime: new Date()
        };
    }

    async add(job) {
        // Validate job
        if (!job || !job.template) {
            throw new Error('Invalid job: missing template');
        }

        // Add unique ID and timestamp
        const enhancedJob = {
            ...job,
            id: this.generateJobId(),
            queuedAt: new Date().toISOString(),
            status: 'queued'
        };

        this.queue.push(enhancedJob);
        this.stats.totalJobs++;

        logger.info(MODULES.QUEUE, `Job queued: ${enhancedJob.template} x${enhancedJob.copies}`);
        logger.debug(MODULES.QUEUE, `Job ID: ${enhancedJob.id}, Queue length: ${this.queue.length}`);

        this.emit('jobQueued', enhancedJob);

        // Start processing if not already running
        if (!this.processing) {
            this.processQueue();
        }

        return enhancedJob.id;
    }

    async processQueue() {
        if (this.processing || this.queue.length === 0) {
            return;
        }

        this.processing = true;
        logger.info(MODULES.QUEUE, 'Processing started');

        while (this.queue.length > 0) {
            const job = this.queue.shift();
            await this.processJob(job);
        }

        this.processing = false;
        logger.info(MODULES.QUEUE, 'Processing completed');
        this.emit('queueEmpty');
    }

    async processJob(job) {
        this.currentJob = job;
        job.status = 'processing';
        job.startedAt = new Date().toISOString();

        logger.info(MODULES.QUEUE, `Processing: ${job.template} x${job.copies}`);
        logger.debug(MODULES.QUEUE, `Job ID: ${job.id}`);
        this.emit('jobStarted', job);

        try {
            // Emit print request and wait for completion
            this.emit('printRequest', job);

            // Wait for job to be completed or failed by the main app
            await new Promise((resolve) => {
                const onCompleted = (completedJob) => {
                    if (completedJob.id === job.id) {
                        this.removeListener('jobCompleted', onCompleted);
                        this.removeListener('jobFailed', onFailed);
                        resolve();
                    }
                };

                const onFailed = (failedJob) => {
                    if (failedJob.id === job.id) {
                        this.removeListener('jobCompleted', onCompleted);
                        this.removeListener('jobFailed', onFailed);
                        resolve();
                    }
                };

                this.on('jobCompleted', onCompleted);
                this.on('jobFailed', onFailed);
            });

        } catch (error) {
            await this.markJobFailed(job, error);
        }
    }

    async markJobCompleted(job, result = {}) {
        job.status = 'completed';
        job.completedAt = new Date().toISOString();
        job.result = result;

        this.stats.completedJobs++;
        this.currentJob = null;

        logger.success(MODULES.QUEUE, `Job completed: ${job.template} x${job.copies}`);
        logger.debug(MODULES.QUEUE, `Job ID: ${job.id}`);
        this.emit('jobCompleted', job);
    }

    async markJobFailed(job, error) {
        job.status = 'failed';
        job.failedAt = new Date().toISOString();
        job.error = {
            message: error.message,
            stack: error.stack
        };

        this.stats.failedJobs++;
        this.currentJob = null;

        logger.error(MODULES.QUEUE, `Job failed: ${job.template} - ${error.message}`);
        logger.debug(MODULES.QUEUE, `Job ID: ${job.id}`);
        this.emit('jobFailed', job, error);
    }

    // Method to be called by the main app after successful print
    async completeCurrentJob(result) {
        if (this.currentJob) {
            await this.markJobCompleted(this.currentJob, result);
        }
    }

    // Method to be called by the main app after failed print
    async failCurrentJob(error) {
        if (this.currentJob) {
            await this.markJobFailed(this.currentJob, error);
        }
    }

    generateJobId() {
        return `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    getQueueStatus() {
        return {
            length: this.queue.length,
            processing: this.processing,
            currentJob: this.currentJob ? {
                id: this.currentJob.id,
                template: this.currentJob.template,
                status: this.currentJob.status,
                startedAt: this.currentJob.startedAt
            } : null
        };
    }

    getStats() {
        const runtime = Date.now() - this.stats.startTime.getTime();
        return {
            ...this.stats,
            runtime: Math.floor(runtime / 1000), // seconds
            queueLength: this.queue.length,
            processing: this.processing,
            successRate: this.stats.totalJobs > 0 ?
                (this.stats.completedJobs / this.stats.totalJobs * 100).toFixed(1) : 0
        };
    }

    getQueuedJobs() {
        return this.queue.map(job => ({
            id: job.id,
            template: job.template,
            copies: job.copies,
            queuedAt: job.queuedAt,
            status: job.status
        }));
    }

    async clearQueue() {
        if (this.processing) {
            logger.warn(MODULES.QUEUE, 'Cannot clear queue while processing');
            return false;
        }

        const clearedCount = this.queue.length;
        this.queue = [];

        logger.info(MODULES.QUEUE, `Queue cleared: ${clearedCount} jobs removed`);
        this.emit('queueCleared', clearedCount);

        return true;
    }

    async drain() {
        if (this.queue.length === 0 && !this.processing) {
            return;
        }

        logger.info(MODULES.QUEUE, 'Draining queue');

        return new Promise((resolve) => {
            if (this.queue.length === 0 && !this.processing) {
                resolve();
                return;
            }

            this.once('queueEmpty', resolve);
        });
    }

    async pause() {
        if (this.processing) {
            logger.info(MODULES.QUEUE, 'Processing paused');
            this.processing = false;
            this.emit('queuePaused');
        }
    }

    async resume() {
        if (!this.processing && this.queue.length > 0) {
            logger.info(MODULES.QUEUE, 'Processing resumed');
            this.processQueue();
            this.emit('queueResumed');
        }
    }
}

export function createPrintQueue() {
    return new PrintQueue();
}
