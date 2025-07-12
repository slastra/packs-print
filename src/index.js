import dotenv from 'dotenv';
dotenv.config();

import { EventEmitter } from 'events';
import os from 'os';
import process from 'process';

import { createPrinter } from './printer.js';
import { createMqttClient } from './mqtt.js';
import { createPrintQueue } from './queue.js';
import { createLedController } from './led.js';
import { createMonitor } from './monitor.js';
import { logger, MODULES } from './logger.js';

const config = {
    mqtt: {
        host: process.env.MQTT_HOST,
        port: parseInt(process.env.MQTT_PORT || '1883'),
        username: process.env.MQTT_USERNAME,
        password: process.env.MQTT_PASSWORD
    },
    printer: {
        media: process.env.PRINTER_MEDIA || '2x1',
        device: process.env.PRINTER_DEVICE || '/dev/usb/lp0',
        printDelay: parseInt(process.env.PRINT_DELAY_MS || '2000')
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
        logger.info(MODULES.APP, `Starting Packs Print on ${this.hostname}`);

        try {
            // Initialize components
            this.components.led = createLedController(this.config.led);
            this.components.printer = createPrinter(this.config.printer);
            this.components.queue = createPrintQueue();
            this.components.monitor = createMonitor(this.config.monitoring);
            this.components.mqtt = createMqttClient(this.config.mqtt, this.hostname);

            // Set up event listeners
            this.setupEventListeners();

            // Initialize LED with cool startup effect
            await this.components.led.initialize();
            await this.components.led.startupEffect();

            // Initialize printer (don't fail if device not available)
            const printerInitialized = await this.components.printer.initialize();
            if (!printerInitialized) {
                logger.warn(MODULES.APP, 'Continuing without printer device');
            }

            // Start monitoring
            this.components.monitor.start();

            // Connect MQTT
            await this.components.mqtt.connect();

            logger.success(MODULES.APP, 'Application ready');

        } catch (error) {
            logger.error(MODULES.APP, `Initialization failed: ${error.message}`);
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
                logger.error(MODULES.APP, `Failed to queue job: ${error.message}`);
                this.emit('error', error);
            }
        });

        // Print queue events
        this.components.queue.on('jobStarted', (job) => {
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
            this.components.led.setColor(0, 255, 0, 100); // Green for success
            this.components.mqtt.publishSuccess(job);
        });

        this.components.queue.on('jobFailed', (job, error) => {
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

            // Only publish if MQTT is connected
            if (this.components.mqtt.connected) {
                this.components.mqtt.publishStatus(enhancedStatus);
            }
            this.updateStatusLed(enhancedStatus);
        });

        // MQTT connection events
        this.components.mqtt.on('connecting', () => {
            this.components.led.pulse(255, 255, 0, 1000); // Pulsing yellow while connecting
        });

        this.components.mqtt.on('connected', () => {
            // LED will be updated by next status update
        });

        this.components.mqtt.on('disconnected', () => {
            // Don't override LED here - let status update handle it
        });

        this.components.mqtt.on('error', (error) => {
            logger.error(MODULES.APP, `MQTT error: ${error.message}`);
            this.components.led.setColor(255, 0, 0, 300); // Red for error
        });

        // Printer events
        this.components.printer.on('statusChanged', (status) => {
            logger.debug(MODULES.APP, `Printer status: ${status}`);

            // Try to reconnect if device becomes available
            if (status === 'device not available' || status === 'device disconnected') {
                setTimeout(() => {
                    this.components.printer.retryConnection();
                }, 5000);
            }
        });

        this.components.printer.on('error', (error) => {
            // Don't emit global error for device unavailable
            if (!error.message.includes('device not available') &&
                !error.message.includes('Cannot access printer device')) {
                logger.error(MODULES.APP, `Printer error: ${error.message}`);
                this.emit('error', error);
            }
        });

        // Global error handling
        this.on('error', (error) => {
            logger.error(MODULES.APP, error.message);
            this.components.led.setColor(255, 0, 0, 100); // Red for error
        });
    }

    updateStatusLed(status) {
        if (this.isShuttingDown) return;

        // Priority order: no wifi > printer not ready > queue > green
        if (!status.ssid) {
            // No WiFi = Red
            this.components.led.setColor(255, 0, 0, 300);
        } else if (status.status === 'calibrating') {
            // Printer calibrating = Pulsing white
            this.components.led.pulse(255, 255, 255, 1000);
        } else if (status.status !== 'ready') {
            // Printer not ready = Orange
            this.components.led.setColor(255, 165, 0, 300);
        } else if (status.queueLength > 0) {
            // Queue has items = Blue
            this.components.led.setColor(0, 0, 255, 300);
        } else {
            // Everything good = Green
            this.components.led.setColor(0, 255, 0, 300);
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

        logger.info(MODULES.APP, 'Shutting down gracefully');

        try {
            // Stop monitoring
            this.components.monitor?.stop();

            // Finish current print jobs
            await this.components.queue?.drain();

            // Disconnect MQTT
            await this.components.mqtt?.disconnect();

            // Turn off LED
            await this.components.led?.setColor(0, 0, 0, 100);

            logger.success(MODULES.APP, 'Shutdown completed');
        } catch (error) {
            logger.error(MODULES.APP, `Shutdown error: ${error.message}`);
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
    logger.error(MODULES.APP, `Uncaught exception: ${error.message}`);
    app.shutdown();
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error(MODULES.APP, `Unhandled rejection: ${reason}`);
    app.shutdown();
});

// Start the application
try {
    await app.initialize();
} catch (error) {
    logger.error(MODULES.APP, `Failed to start: ${error.message}`);
    process.exit(1);
}
