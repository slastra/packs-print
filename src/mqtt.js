import { EventEmitter } from 'events';
import mqtt from 'mqtt';
import { logger, MODULES } from './logger.js';

class MqttClient extends EventEmitter {
    constructor(config, hostname) {
        super();
        this.config = config;
        this.hostname = hostname;
        this.client = null;
        this.connected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
    }

    async connect() {
        if (this.client && !this.client.disconnected) {
            return;
        }

        try {
            logger.info(MODULES.MQTT, `Connecting to ${this.config.host}:${this.config.port}`);
            this.client = mqtt.connect({
                host: this.config.host,
                port: this.config.port,
                username: this.config.username,
                password: this.config.password,
                reconnectPeriod: 5000,
                connectTimeout: 30000,
                will: {
                    topic: `packs/printers/${this.hostname}/status`,
                    payload: JSON.stringify({
                        online: false,
                        timestamp: new Date().toISOString()
                    }),
                    qos: 1,
                    retain: true
                }
            });

            this.setupEventHandlers();

            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('MQTT connection timeout'));
                }, 30000);

                this.client.once('connect', () => {
                    clearTimeout(timeout);
                    resolve();
                });

                this.client.once('error', (error) => {
                    clearTimeout(timeout);
                    reject(error);
                });
            });

        } catch (error) {
            logger.error(MODULES.MQTT, `Connection failed: ${error.message}`);
            this.emit('error', error);
            throw error;
        }
    }

    setupEventHandlers() {
        this.client.on('connect', () => {
            // Connected to MQTT broker
            this.connected = true;
            this.reconnectAttempts = 0;

            // Subscribe to print job topics
            const subscribeTopics = [`packs/labels/${this.hostname}`];

            this.client.subscribe(subscribeTopics, (err) => {
                if (err) {
                    logger.error(MODULES.MQTT, `Subscription failed: ${err.message}`);
                    this.emit('error', err);
                } else {
                    logger.success(MODULES.MQTT, 'Connected and subscribed');
                    this.emit('connected');
                }
            });
        });

        this.client.on('message', (topic, message) => {
            try {
                this.handleMessage(topic, message);
            } catch (error) {
                logger.error(MODULES.MQTT, `Message handling failed: ${error.message}`);
                this.emit('error', error);
            }
        });

        this.client.on('error', (error) => {
            logger.error(MODULES.MQTT, error.message);
            this.connected = false;
            this.emit('error', error);
        });

        this.client.on('offline', () => {
            this.connected = false;
            this.emit('disconnected');
        });

        this.client.on('reconnect', () => {
            this.reconnectAttempts++;

            if (this.reconnectAttempts >= this.maxReconnectAttempts) {
                logger.error(MODULES.MQTT, 'Max reconnect attempts reached');
                this.client.end();
                this.emit('error', new Error('Max reconnect attempts reached'));
            }
        });

        this.client.on('close', () => {
            logger.info(MODULES.MQTT, 'Connection closed');
            this.connected = false;
            this.emit('disconnected');
        });
    }

    handleMessage(topic, message) {
        try {
            const messageData = JSON.parse(message.toString());

            // Extract template and copies from message data
            const { template } = messageData;
            const copies = parseInt(messageData.copies) || 1;

            if (!template) {
                logger.warn(MODULES.MQTT, 'Missing template in message');
                return;
            }

            // Remove template and copies from data to avoid conflicts
            const { template: _, copies: __, ...templateData } = messageData;

            const job = {
                template,
                data: templateData,
                copies,
                timestamp: new Date().toISOString(),
                topic
            };

            logger.info(MODULES.MQTT, `Print job received: ${template} x${copies}`);
            logger.debug(MODULES.MQTT, `Message data: ${JSON.stringify(messageData, null, 2)}`);

            this.emit('printJob', job);

        } catch (error) {
            logger.error(MODULES.MQTT, `Message parsing failed: ${error.message}`);

            // Publish error for monitoring
            this.publishError({
                error: error.message,
                topic,
                message: message.toString(),
                timestamp: new Date().toISOString()
            });
        }
    }

    async publishStatus(status) {
        if (!this.connected) {
            // Silently skip publishing when not connected
            return;
        }

        try {
            const statusData = {
                ...status,
                timestamp: new Date().toISOString()
            };


            await this.publish(`packs/printers/${this.hostname}/status`, statusData, {
                qos: 1,
                retain: true
            });

            logger.debug(MODULES.MQTT, `Status published: ${JSON.stringify(statusData, null, 2)}`);

        } catch (error) {
            logger.error(MODULES.MQTT, `Status publishing failed: ${error.message}`);
        }
    }

    async publishSuccess(job) {
        if (!this.connected) return;

        try {
            const successData = {
                template: job.template,
                copies: job.copies,
                timestamp: new Date().toISOString(),
                method: 'direct'
            };

            await this.publish(`packs/labels/${this.hostname}/success`, successData, {
                qos: 1
            });

            logger.success(MODULES.MQTT, `Print success published: ${job.template} x${job.copies}`);
            logger.debug(MODULES.MQTT, `Success data: ${JSON.stringify(successData, null, 2)}`);
        } catch (error) {
            logger.error(MODULES.MQTT, `Success publishing failed: ${error.message}`);
        }
    }

    async publishFailure(job, error) {
        if (!this.connected) return;

        try {
            // Categorize error types
            let errorType = 'unknown';
            if (error.message.includes('Failed to load template') && error.message.includes('ENOENT')) {
                errorType = 'template_not_found';
            } else if (error.message.includes('Printer not ready')) {
                errorType = 'printer_not_ready';
            } else if (error.message.includes('Printer device not available')) {
                errorType = 'printer_offline';
            }

            const failureData = {
                template: job.template,
                copies: job.copies,
                error: error.message,
                errorType: errorType,
                timestamp: new Date().toISOString()
            };

            await this.publish(`packs/labels/${this.hostname}/failure`, failureData, {
                qos: 1
            });

            logger.error(MODULES.MQTT, `Print failure published: ${job.template} - ${failureData.errorType}`);
            logger.debug(MODULES.MQTT, `Failure data: ${JSON.stringify(failureData, null, 2)}`);

        } catch (error) {
            logger.error(MODULES.MQTT, `Failure publishing failed: ${error.message}`);
        }
    }

    async publishError(errorData) {
        if (!this.connected) return;

        try {
            await this.publish(`packs/printers/${this.hostname}/errors`, errorData, {
                qos: 1
            });

        } catch (error) {
            logger.error(MODULES.MQTT, `Error publishing failed: ${error.message}`);
        }
    }

    async publish(topic, data, options = {}) {
        if (!this.connected) {
            throw new Error('MQTT not connected');
        }

        return new Promise((resolve, reject) => {
            const payload = typeof data === 'string' ? data : JSON.stringify(data);

            this.client.publish(topic, payload, options, (error) => {
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
    }

    async disconnect() {
        if (!this.client) return;

        try {
            // Publish offline status
            await this.publish(`packs/printers/${this.hostname}/status`, {
                online: false,
                timestamp: new Date().toISOString()
            }, { qos: 1, retain: true });

        } catch (error) {
            logger.error(MODULES.MQTT, `Offline status publishing failed: ${error.message}`);
        }

        return new Promise((resolve) => {
            this.client.end(false, {}, () => {
                logger.info(MODULES.MQTT, 'Disconnected');
                this.connected = false;
                resolve();
            });
        });
    }

    isConnected() {
        return this.connected;
    }

    getStats() {
        return {
            connected: this.connected,
            reconnectAttempts: this.reconnectAttempts,
            hostname: this.hostname,
            brokerHost: this.config.host,
            brokerPort: this.config.port
        };
    }
}

export function createMqttClient(config, hostname) {
    return new MqttClient(config, hostname);
}
