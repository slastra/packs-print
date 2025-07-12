import { EventEmitter } from 'events';
import mqtt from 'mqtt';

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
            console.log('MQTT client already connected or connecting');
            return;
        }

        try {
            console.log(`Connecting to MQTT broker at ${this.config.host}:${this.config.port}`);
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
            console.error('MQTT connection failed:', error);
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
                    console.error('MQTT subscription error:', err);
                    this.emit('error', err);
                } else {
                    // Subscribed successfully
                    this.emit('connected');
                }
            });
        });

        this.client.on('message', (topic, message) => {
            try {
                this.handleMessage(topic, message);
            } catch (error) {
                console.error('Error handling MQTT message:', error);
                this.emit('error', error);
            }
        });

        this.client.on('error', (error) => {
            console.error('MQTT error:', error);
            this.connected = false;
            this.emit('error', error);
        });

        this.client.on('offline', () => {
            // MQTT client offline
            this.connected = false;
            this.emit('disconnected');
        });

        this.client.on('reconnect', () => {
            this.reconnectAttempts++;
            // Reconnecting

            if (this.reconnectAttempts >= this.maxReconnectAttempts) {
                console.error('Max MQTT reconnect attempts reached');
                this.client.end();
                this.emit('error', new Error('Max reconnect attempts reached'));
            }
        });

        this.client.on('close', () => {
            console.log('MQTT connection closed');
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
                console.warn('Missing template in message:', messageData);
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

            console.log(`Print job: ${template} x${copies}`);

            this.emit('printJob', job);

        } catch (error) {
            console.error('Error parsing MQTT message:', error);

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

        } catch (error) {
            console.error('Error publishing status:', error);
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

        } catch (error) {
            console.error('Error publishing success:', error);
        }
    }

    async publishFailure(job, error) {
        if (!this.connected) return;

        try {
            const failureData = {
                template: job.template,
                copies: job.copies,
                error: error.message,
                timestamp: new Date().toISOString()
            };

            await this.publish(`packs/labels/${this.hostname}/failure`, failureData, {
                qos: 1
            });

        } catch (error) {
            console.error('Error publishing failure:', error);
        }
    }

    async publishError(errorData) {
        if (!this.connected) return;

        try {
            await this.publish(`packs/printers/${this.hostname}/errors`, errorData, {
                qos: 1
            });

        } catch (error) {
            console.error('Error publishing error:', error);
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
            console.error('Error publishing offline status:', error);
        }

        return new Promise((resolve) => {
            this.client.end(false, {}, () => {
                console.log('✓ MQTT disconnected');
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
