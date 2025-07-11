import { createRequire } from 'module';
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import fsSync from 'fs';
import path from 'path';
import handlebars from 'handlebars';

const require = createRequire(import.meta.url);

// Import ioctl for printer status
let ioctl;
try {
    ioctl = require('ioctl');
} catch (error) {
    console.log('ioctl module not available, using fallback implementation');
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
        this.lastStatus = null;
        this.templateCache = new Map();
        this.deviceAvailable = false;
        this.initializationFailed = false;
    }

    async initialize() {
        console.log(`Initializing printer on ${this.device}`);
        
        try {
            // Check device access
            await this.checkDeviceAccess();
            this.deviceAvailable = true;
            
            // Get initial status
            const status = await this.getStatus();
            this.lastStatus = status;
            
            console.log(`Printer initialized: ${this.statusToString(status)}`);
            this.initializationFailed = false;
            
            return true;
        } catch (error) {
            console.log(`Printer offline: ${error.message}`);
            
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

        if (!ioctl) {
            // Mock status for development
            return PRINTER_STATUS.READY;
        }

        try {
            const fd = fsSync.openSync(this.device, 'r+');
            const buffer = Buffer.alloc(1);
            
            ioctl(fd, LPGETSTATUS, buffer);
            const status = buffer[0];
            
            fsSync.closeSync(fd);
            
            // Emit status change event if different
            if (status !== this.lastStatus) {
                const statusString = this.statusToString(status);
                this.emit('statusChanged', statusString);
                this.lastStatus = status;
            }
            
            return status;
        } catch (error) {
            console.error('Error getting printer status:', error);
            
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

            console.log(`Printing ${copies} copies of ${template}`);
            console.log(`EPL data length: ${eplData.length} bytes`);

            // Send to printer
            await this.sendToPrinter(eplData, copies);

            return {
                success: true,
                template,
                copies,
                dataLength: eplData.length
            };

        } catch (error) {
            console.error('Print job failed:', error);
            throw error;
        }
    }

    async sendToPrinter(eplData, copies) {
        try {
            // For multiple copies, send the EPL data multiple times
            for (let copy = 1; copy <= copies; copy++) {
                console.log(`Sending copy ${copy}/${copies}...`);
                
                await fs.writeFile(this.device, eplData);
                
                console.log(`✓ Copy ${copy}/${copies} sent successfully`);
                
                // Small delay between copies
                if (copy < copies) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
            }
            
            console.log(`✓ All ${copies} copies sent successfully`);
            
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
        console.log('Attempting to reconnect to printer device...');
        
        try {
            await this.checkDeviceAccess();
            
            if (!this.deviceAvailable) {
                this.deviceAvailable = true;
                this.initializationFailed = false;
                
                // Get fresh status
                const status = await this.getStatus();
                this.lastStatus = status;
                
                console.log(`✓ Printer reconnected - Status: ${this.statusToString(status)}`);
                this.emit('statusChanged', 'reconnected');
                
                return true;
            }
        } catch (error) {
            console.debug('Printer device still not available:', error.message);
            return false;
        }
        
        return false;
    }

    clearTemplateCache() {
        this.templateCache.clear();
        console.log('Template cache cleared');
    }
}

export function createPrinter(config) {
    return new Printer(config);
}