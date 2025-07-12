import { createRequire } from 'module';
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import fsSync from 'fs';
import path from 'path';
import handlebars from 'handlebars';
import { logger, MODULES } from './logger.js';

const require = createRequire(import.meta.url);

// Import ioctl for printer status
let ioctl;
try {
    ioctl = require('ioctl');
} catch (error) {
    logger.warn(MODULES.PRINTER, 'ioctl module not available, using fallback');
    ioctl = null;
}

const LPGETSTATUS = 0x060b;

// Printer status constants
const PRINTER_STATUS = {
    READY: 0x18,
    PAPER_OUT: 0x30,
    CALIBRATING: 0x50,
    LOADING: 0xb0,
    ERROR: 0x08
};

class Printer extends EventEmitter {
    constructor(config) {
        super();
        this.config = config;
        this.device = config.device;
        this.media = config.media;
        this.printDelay = config.printDelay || 2000;
        this.lastStatus = null;
        this.templateCache = new Map();
        this.deviceAvailable = false;
        this.initializationFailed = false;
        this.isPrinting = false;
    }

    async initialize() {
        logger.info(MODULES.PRINTER, `Initializing on ${this.device}`);

        try {
            // Check device access
            await this.checkDeviceAccess();
            this.deviceAvailable = true;

            // Get initial status
            const status = await this.getStatus();
            this.lastStatus = status;

            logger.success(MODULES.PRINTER, `Initialized: ${this.statusToString(status)}`);
            this.initializationFailed = false;

            return true;
        } catch (error) {
            logger.warn(MODULES.PRINTER, `Offline: ${error.message}`);

            this.deviceAvailable = false;
            this.initializationFailed = true;
            this.lastStatus = PRINTER_STATUS.ERROR;

            // Don't emit error - this is a recoverable condition
            this.emit('statusChanged', 'device not available');

            return false;
        }
    }

    async checkDeviceAccess() {
        try {
            await fs.access(this.device, fs.constants.W_OK);
            // Device is accessible
        } catch (error) {
            throw new Error(`Cannot access printer device ${this.device}: ${error.message}`);
        }
    }

    async getStatus() {
        // If device is not available, return offline status
        if (!this.deviceAvailable) {
            return PRINTER_STATUS.ERROR;
        }

        // Skip status check if currently printing to avoid EBUSY conflicts
        if (this.isPrinting) {
            // Return cached status during printing
            return this.lastStatus || PRINTER_STATUS.READY;
        }

        if (!ioctl) {
            // Mock status for development
            return PRINTER_STATUS.READY;
        }

        try {
            const fd = fsSync.openSync(this.device, 'r+');
            const buffer = Buffer.alloc(1);

            ioctl(fd, LPGETSTATUS, buffer);
            const [status] = buffer;

            fsSync.closeSync(fd);

            // Emit status change event if different
            if (status !== this.lastStatus) {
                const statusString = this.statusToString(status);
                this.emit('statusChanged', statusString);
                this.lastStatus = status;
            }

            return status;
        } catch (error) {
            logger.debug(MODULES.PRINTER, `Status check failed: ${error.message}`);

            // Device might have been disconnected
            this.deviceAvailable = false;
            this.emit('statusChanged', 'device disconnected');

            return PRINTER_STATUS.ERROR;
        }
    }

    statusToString(status) {
        if (!this.deviceAvailable) {
            return 'device not available';
        }

        switch (status) {
        case PRINTER_STATUS.READY:
            return 'ready';
        case PRINTER_STATUS.PAPER_OUT:
            return 'paper out';
        case PRINTER_STATUS.CALIBRATING:
            return 'calibrating';
        case PRINTER_STATUS.LOADING:
            return 'loading';
        case PRINTER_STATUS.ERROR:
            return 'error';
        default:
            return `unknown (0x${status.toString(16)})`;
        }
    }

    isReady() {
        return this.deviceAvailable && this.lastStatus === PRINTER_STATUS.READY;
    }

    async loadTemplate(templateName) {
        // Check cache first
        if (this.templateCache.has(templateName)) {
            return this.templateCache.get(templateName);
        }

        try {
            const templatePath = path.join(process.cwd(), 'templates', this.media, `${templateName}.epl`);
            const templateSource = await fs.readFile(templatePath, 'utf8');

            // Compile template
            const compiled = handlebars.compile(templateSource);

            // Cache it
            this.templateCache.set(templateName, compiled);

            return compiled;
        } catch (error) {
            throw new Error(`Failed to load template ${templateName}: ${error.message}`);
        }
    }

    async print(job) {
        const { template, data, copies = 1 } = job;

        try {
            // Check if device is available
            if (!this.deviceAvailable) {
                throw new Error('Printer device not available');
            }

            // Check printer status
            const status = await this.getStatus();
            if (status !== PRINTER_STATUS.READY) {
                throw new Error(`Printer not ready: ${this.statusToString(status)}`);
            }

            // Load and render template
            const compiledTemplate = await this.loadTemplate(template);
            const eplData = compiledTemplate(data);

            // Validate EPL data
            if (!eplData || eplData.length === 0) {
                throw new Error('Template rendered to empty data');
            }

            logger.info(MODULES.PRINTER, `Printing ${template} x${copies}`);
            logger.debug(MODULES.PRINTER, `EPL data length: ${eplData.length} bytes`);

            // Set printing flag to prevent status conflicts
            this.isPrinting = true;

            try {
                // Send to printer
                await this.sendToPrinter(eplData, copies);

                logger.success(MODULES.PRINTER, `Print completed: ${template} x${copies}`);

                return {
                    success: true,
                    template,
                    copies,
                    dataLength: eplData.length
                };
            } finally {
                // Always clear printing flag
                this.isPrinting = false;
            }

        } catch (error) {
            // Ensure flag is cleared on any error
            this.isPrinting = false;
            logger.error(MODULES.PRINTER, `Print failed: ${error.message}`);
            throw error;
        }
    }

    async sendToPrinter(eplData, copies) {
        try {
            // For multiple copies, send the EPL data multiple times
            for (let copy = 1; copy <= copies; copy++) {
                logger.debug(MODULES.PRINTER, `Sending copy ${copy}/${copies}`);

                await fs.writeFile(this.device, eplData);

                logger.debug(MODULES.PRINTER, `Copy ${copy}/${copies} sent, waiting ${this.printDelay}ms`);
                await new Promise(resolve => setTimeout(resolve, this.printDelay));
            }

        } catch (error) {
            throw new Error(`Failed to send to printer: ${error.message}`);
        }
    }

    async testConnection() {
        try {
            const status = await this.getStatus();
            return {
                connected: this.deviceAvailable,
                status: this.statusToString(status),
                ready: status === PRINTER_STATUS.READY
            };
        } catch (error) {
            return {
                connected: false,
                error: error.message
            };
        }
    }

    async retryConnection() {
        logger.info(MODULES.PRINTER, 'Attempting to reconnect');

        try {
            await this.checkDeviceAccess();

            if (!this.deviceAvailable) {
                this.deviceAvailable = true;
                this.initializationFailed = false;

                // Get fresh status
                const status = await this.getStatus();
                this.lastStatus = status;

                logger.success(MODULES.PRINTER, `Reconnected: ${this.statusToString(status)}`);
                this.emit('statusChanged', 'reconnected');

                return true;
            }
        } catch (error) {
            logger.debug(MODULES.PRINTER, `Reconnection failed: ${error.message}`);
            return false;
        }

        return false;
    }

    clearTemplateCache() {
        this.templateCache.clear();
        logger.info(MODULES.PRINTER, 'Template cache cleared');
    }
}

export function createPrinter(config) {
    return new Printer(config);
}
