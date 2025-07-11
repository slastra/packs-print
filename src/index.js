import { createRequire } from 'module';
import { EventEmitter } from 'events';
import os from 'os';
import process from 'process';

import { createPrinter } from './printer.js';
import { createMqttClient } from './mqtt.js';
import { createPrintQueue } from './queue.js';
import { createLedController } from './led.js';
import { createMonitor } from './monitor.js';

const require = createRequire(import.meta.url);
const config = {
    mqtt: {
        host: process.env.MQTT_HOST || 'servicez.cloud',
        port: parseInt(process.env.MQTT_PORT || '1883'),
        username: process.env.MQTT_USERNAME || 'rez',
        password: process.env.MQTT_PASSWORD || 'ukn8qnc2QYP@acz4pjd'
    },
    printer: {
        media: process.env.PRINTER_MEDIA || '2x1',
        device: process.env.PRINTER_DEVICE || '/dev/usb/lp0'
    },
    monitoring: {
        statusInterval: parseInt(process.env.STATUS_INTERVAL || '10000'),
        wifiInterface: process.env.WIFI_INTERFACE || 'wlan0'
    },
    led: {
        brightness: parseFloat(process.env.LED_BRIGHTNESS || '0.5')
    }
};

const HOSTNAME = os.hostname();

class PrinterApp extends EventEmitter {
    constructor() {
        super();
        this.config = config;
        this.hostname = HOSTNAME;
        this.components = {};
        this.isShuttingDown = false;
    }

    async initialize() {
        console.log(`Starting Rollo printer integration on ${this.hostname}`);

        try {
            // Initialize components
            this.components.led = createLedController(this.config.led);
            this.components.printer = createPrinter(this.config.printer);
            this.components.queue = createPrintQueue();
            this.components.monitor = createMonitor(this.config.monitoring);
            this.components.mqtt = createMqttClient(this.config.mqtt, this.hostname);

            // Set up event listeners
            this.setupEventListeners();

            // Initialize LED (startup indication)
            await this.components.led.initialize();
            await this.components.led.setColor(255, 255, 255, 100); // White pulse

            // Initialize printer (don't fail if device not available)
            const printerInitialized = await this.components.printer.initialize();
            if (!printerInitialized) {
                console.log('✓ Application will continue without printer device');
            }

            // Start monitoring
            this.components.monitor.start();

            // Connect MQTT
            await this.components.mqtt.connect();

            console.log('✓ All components initialized successfully');
            
        } catch (error) {
            console.error('Failed to initialize:', error);
            await this.components.led?.setColor(255, 0, 0, 100); // Red for error
            throw error;
        }
    }

    setupEventListeners() {
        // MQTT print job events
        this.components.mqtt.on('printJob', async (job) => {
            try {
                await this.components.queue.add(job);
            } catch (error) {
                console.error('Failed to queue print job:', error);
                this.emit('error', error);
            }
        });

        // Print queue events
        this.components.queue.on('jobStarted', (job) => {
            console.log(`Starting print job: ${job.template} (${job.copies} copies)`);
            this.components.led.setColor(0, 0, 255, 100); // Blue for processing
        });

        this.components.queue.on('printRequest', async (job) => {
            try {
                const result = await this.components.printer.print(job);
                await this.components.queue.completeCurrentJob(result);
            } catch (error) {
                await this.components.queue.failCurrentJob(error);
            }
        });

        this.components.queue.on('jobCompleted', (job) => {
            console.log(`Print job completed: ${job.template}`);
            this.components.led.setColor(0, 255, 0, 100); // Green for success
            this.components.mqtt.publishSuccess(job);
        });

        this.components.queue.on('jobFailed', (job, error) => {
            console.error(`Print job failed: ${job.template}`, error);
            this.components.led.setColor(255, 0, 0, 100); // Red for error
            this.components.mqtt.publishFailure(job, error);
        });

        // Monitor events
        this.components.monitor.on('statusUpdate', (status) => {
            // Add queue status to the monitor status
            const queueStatus = this.components.queue.getQueueStatus();
            const enhancedStatus = {
                ...status,
                queueLength: queueStatus.length,
                processing: queueStatus.processing,
                media: this.config.printer.media
            };
            
            this.components.mqtt.publishStatus(enhancedStatus);
            this.updateStatusLed(enhancedStatus);
        });

        // MQTT connection events
        this.components.mqtt.on('connected', () => {
            console.log('✓ MQTT connected');
        });

        this.components.mqtt.on('disconnected', () => {
            console.log('✗ MQTT disconnected');
            this.components.led.setColor(255, 255, 0, 300); // Yellow for offline
        });

        this.components.mqtt.on('error', (error) => {
            console.error('MQTT error:', error);
            this.components.led.setColor(255, 0, 0, 300); // Red for error
        });

        // Printer events
        this.components.printer.on('statusChanged', (status) => {
            console.log(`Printer status: ${status}`);
            
            // Try to reconnect if device becomes available
            if (status === 'device not available' || status === 'device disconnected') {
                setTimeout(() => {
                    this.components.printer.retryConnection();
                }, 5000);
            }
        });

        this.components.printer.on('error', (error) => {
            console.error('Printer error:', error);
            // Don't emit global error for device unavailable
            if (!error.message.includes('device not available') && 
                !error.message.includes('Cannot access printer device')) {
                this.emit('error', error);
            }
        });

        // Global error handling
        this.on('error', (error) => {
            console.error('Application error:', error);
            this.components.led.setColor(255, 0, 0, 100); // Red for error
        });
    }

    updateStatusLed(status) {
        if (this.isShuttingDown) return;

        // Priority order: error > paper out > processing > wifi signal
        if (status.printer === 'error' || !status.usbConnected) {
            this.components.led.setColor(255, 0, 0, 300); // Red for error
        } else if (status.printer === 'paper out') {
            this.components.led.setColor(255, 0, 0, 300); // Red for paper out
        } else if (status.queueLength > 0) {
            this.components.led.setColor(0, 0, 255, 100); // Blue for processing
        } else {
            // Show WiFi signal strength
            const signalColor = this.wifiSignalToColor(status.wifi || 0);
            this.components.led.setColor(signalColor.r, signalColor.g, signalColor.b, 300);
        }
    }

    wifiSignalToColor(signal) {
        // Convert 0-1 signal to color (green=good, yellow=ok, red=bad)
        if (signal > 0.7) return { r: 0, g: 255, b: 0 };     // Green
        if (signal > 0.4) return { r: 255, g: 255, b: 0 };   // Yellow
        return { r: 255, g: 0, b: 0 };                        // Red
    }

    async shutdown() {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;

        console.log('Shutting down gracefully...');

        try {
            // Stop monitoring
            this.components.monitor?.stop();

            // Finish current print jobs
            await this.components.queue?.drain();

            // Disconnect MQTT
            await this.components.mqtt?.disconnect();

            // Turn off LED
            await this.components.led?.setColor(0, 0, 0, 100);

            console.log('✓ Graceful shutdown completed');
        } catch (error) {
            console.error('Error during shutdown:', error);
        }

        process.exit(0);
    }
}

// Create and start the application
const app = new PrinterApp();

// Handle termination signals
process.on('SIGTERM', () => app.shutdown());
process.on('SIGINT', () => app.shutdown());

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    app.shutdown();
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled rejection at:', promise, 'reason:', reason);
    app.shutdown();
});

// Start the application
try {
    await app.initialize();
} catch (error) {
    console.error('Failed to start application:', error);
    process.exit(1);
}