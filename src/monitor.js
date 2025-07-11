import { EventEmitter } from 'events';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';
import { promises as fs } from 'fs';
import fsSync from 'fs';

const execAsync = promisify(exec);
const require = createRequire(import.meta.url);

// USB module removed - not needed with direct printer status monitoring

// Try to import ioctl for printer status
let ioctl;
try {
    ioctl = require('ioctl');
} catch (error) {
    console.log('ioctl module not available, using fallback implementation');
    ioctl = null;
}

// Printer status constants
const LPGETSTATUS = 0x060b;
const PRINTER_STATUS = {
    READY: 0x18,
    PAPER_OUT: 0x30,
    CALIBRATING: 0x50,
    LOADING: 0xb0,
    ERROR: 0x08
};

class Monitor extends EventEmitter {
    constructor(config) {
        super();
        this.config = config;
        this.statusInterval = config.statusInterval || 10000;
        this.wifiInterface = config.wifiInterface || 'wlan0';
        this.monitorInterval = null;
        this.running = false;
        this.lastStatus = null;
        this.lastPrinterHardwareStatus = null;
        
        // Printer device path
        this.printerDevice = process.env.PRINTER_DEVICE || '/dev/usb/lp0';
    }

    start() {
        if (this.running) {
            console.warn('Monitor already running');
            return;
        }

        console.log(`Starting system monitor (interval: ${this.statusInterval}ms)`);
        this.running = true;

        // Initial status check
        this.checkStatus();

        // Set up interval
        this.monitorInterval = setInterval(() => {
            this.checkStatus();
        }, this.statusInterval);

        this.emit('started');
    }

    stop() {
        if (!this.running) {
            return;
        }

        console.log('Stopping system monitor');
        this.running = false;

        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
            this.monitorInterval = null;
        }

        this.emit('stopped');
    }

    async checkStatus() {
        try {
            const [wifiStatus, printerStatus] = await Promise.all([
                this.getWifiStatus(),
                this.getPrinterStatus()
            ]);

            const status = {
                ...wifiStatus,
                ...printerStatus,
                timestamp: new Date().toISOString(),
                uptime: process.uptime()
            };

            // Only emit if status changed significantly
            if (this.hasStatusChanged(status)) {
                this.lastStatus = status;
                this.emit('statusUpdate', status);
            }

        } catch (error) {
            console.error('Error checking system status:', error);
            this.emit('error', error);
        }
    }

    hasStatusChanged(newStatus) {
        if (!this.lastStatus) {
            return true;
        }

        // Check for significant changes
        const significantFields = ['ssid', 'wifi', 'status'];
        
        for (const field of significantFields) {
            if (this.lastStatus[field] !== newStatus[field]) {
                return true;
            }
        }

        // Check if WiFi signal changed significantly (>5%)
        if (Math.abs((this.lastStatus.wifi || 0) - (newStatus.wifi || 0)) > 0.05) {
            return true;
        }

        return false;
    }

    async getWifiStatus() {
        try {
            // Try iwconfig with full path first
            let stdout;
            try {
                const result = await execAsync(`/usr/sbin/iwconfig ${this.wifiInterface} 2>/dev/null || /sbin/iwconfig ${this.wifiInterface} 2>/dev/null || iwconfig ${this.wifiInterface} 2>/dev/null`);
                stdout = result.stdout;
            } catch (iwconfigError) {
                // Fallback to alternative methods
                try {
                    const result = await execAsync(`iw dev ${this.wifiInterface} link 2>/dev/null`);
                    return this.parseIwOutput(result.stdout);
                } catch (iwError) {
                    // Try cat /proc/net/wireless as final fallback
                    const result = await execAsync(`cat /proc/net/wireless 2>/dev/null | grep ${this.wifiInterface}`);
                    return this.parseWirelessProcOutput(result.stdout);
                }
            }
            
            const essidMatch = stdout.match(/ESSID:"([^"]+)"/);
            const signalLevelMatch = stdout.match(/Signal level=(-?\d+) dBm/);
            const linkQualityMatch = stdout.match(/Link Quality=(\d+)\/(\d+)/);

            if (essidMatch) {
                const essid = essidMatch[1];
                let wifi = 0;
                let signalDbm = null;

                if (signalLevelMatch) {
                    signalDbm = parseInt(signalLevelMatch[1], 10);
                    // Convert dBm to 0-1 scale (assuming -30 dBm = excellent, -90 dBm = unusable)
                    wifi = Math.max(0, Math.min(1, (signalDbm + 90) / 60));
                } else if (linkQualityMatch) {
                    // Fallback to link quality if signal level not available
                    const quality = parseInt(linkQualityMatch[1], 10);
                    const maxQuality = parseInt(linkQualityMatch[2], 10);
                    wifi = quality / maxQuality;
                }

                return {
                    ssid: essid,
                    wifi: Number(wifi.toFixed(2)),
                    signalDbm,
                    connected: true
                };
            } else {
                return {
                    ssid: null,
                    wifi: 0,
                    signalDbm: null,
                    connected: false
                };
            }
        } catch (error) {
            console.debug('Error getting WiFi status:', error.message);
            return {
                ssid: null,
                wifi: 0,
                signalDbm: null,
                connected: false
            };
        }
    }

    parseIwOutput(stdout) {
        try {
            const ssidMatch = stdout.match(/SSID: (.+)/);
            const signalMatch = stdout.match(/signal: (-?\d+) dBm/);
            
            if (ssidMatch) {
                const ssid = ssidMatch[1];
                let wifi = 0;
                let signalDbm = null;

                if (signalMatch) {
                    signalDbm = parseInt(signalMatch[1], 10);
                    wifi = Math.max(0, Math.min(1, (signalDbm + 90) / 60));
                }

                return {
                    ssid,
                    wifi: Number(wifi.toFixed(2)),
                    signalDbm,
                    connected: true
                };
            }
        } catch (error) {
            console.debug('Error parsing iw output:', error.message);
        }
        
        return {
            ssid: null,
            wifi: 0,
            signalDbm: null,
            connected: false
        };
    }

    parseWirelessProcOutput(stdout) {
        try {
            // Format: interface status quality signal noise
            const parts = stdout.trim().split(/\s+/);
            if (parts.length >= 4) {
                const quality = parseInt(parts[2], 10);
                const signal = parseInt(parts[3], 10);
                
                return {
                    ssid: 'connected', // Can't get SSID from proc
                    wifi: Math.max(0, Math.min(1, quality / 70)), // Assume max quality 70
                    signalDbm: signal,
                    connected: true
                };
            }
        } catch (error) {
            console.debug('Error parsing wireless proc output:', error.message);
        }
        
        return {
            ssid: null,
            wifi: 0,
            signalDbm: null,
            connected: false
        };
    }

    async getPrinterStatus() {
        try {
            // First check if device is accessible
            await fs.access(this.printerDevice, fs.constants.W_OK);
            
            // If we can access it, get hardware status
            if (!ioctl) {
                // Mock status for development
                return {
                    status: 'ready',
                    statusCode: 0x18,
                    statusHex: '0x18'
                };
            }

            const fd = fsSync.openSync(this.printerDevice, 'r+');
            const buffer = Buffer.alloc(1);
            
            ioctl(fd, LPGETSTATUS, buffer);
            const statusCode = buffer[0];
            
            fsSync.closeSync(fd);
            
            // Log status changes
            if (statusCode !== this.lastPrinterHardwareStatus) {
                const statusString = this.printerStatusToString(statusCode);
                console.log(`Printer status: ${statusString}`);
                this.lastPrinterHardwareStatus = statusCode;
            }
            
            return {
                status: this.printerStatusToString(statusCode),
                statusCode: statusCode,
                statusHex: `0x${statusCode.toString(16)}`
            };
        } catch (error) {
            // Device not available or error reading
            if (this.lastPrinterHardwareStatus !== null) {
                console.log('Printer status: disconnected');
                this.lastPrinterHardwareStatus = null;
            }
            
            return {
                status: 'disconnected',
                statusCode: null,
                statusHex: null
            };
        }
    }

    printerStatusToString(status) {
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

    // USB status checking removed - redundant with direct printer status monitoring

    async getSystemInfo() {
        try {
            const [loadavg, meminfo, diskinfo] = await Promise.all([
                this.getLoadAverage(),
                this.getMemoryInfo(),
                this.getDiskInfo()
            ]);

            return {
                loadavg,
                memory: meminfo,
                disk: diskinfo,
                uptime: process.uptime(),
                nodeVersion: process.version,
                platform: process.platform,
                arch: process.arch
            };
        } catch (error) {
            console.error('Error getting system info:', error);
            return {
                error: error.message
            };
        }
    }

    async getLoadAverage() {
        try {
            const { stdout } = await execAsync('uptime');
            const match = stdout.match(/load average: ([\d.]+), ([\d.]+), ([\d.]+)/);
            if (match) {
                return {
                    '1min': parseFloat(match[1]),
                    '5min': parseFloat(match[2]),
                    '15min': parseFloat(match[3])
                };
            }
        } catch (error) {
            console.debug('Error getting load average:', error.message);
        }
        return { '1min': 0, '5min': 0, '15min': 0 };
    }

    async getMemoryInfo() {
        try {
            const { stdout } = await execAsync('free -m');
            const lines = stdout.trim().split('\n');
            const memLine = lines[1].split(/\s+/);
            
            const total = parseInt(memLine[1], 10);
            const used = parseInt(memLine[2], 10);
            const free = parseInt(memLine[3], 10);
            
            return {
                total,
                used,
                free,
                percentage: Math.round((used / total) * 100)
            };
        } catch (error) {
            console.debug('Error getting memory info:', error.message);
            return { total: 0, used: 0, free: 0, percentage: 0 };
        }
    }

    async getDiskInfo() {
        try {
            const { stdout } = await execAsync('df -h / | tail -1');
            const parts = stdout.trim().split(/\s+/);
            
            return {
                total: parts[1],
                used: parts[2],
                free: parts[3],
                percentage: parseInt(parts[4], 10)
            };
        } catch (error) {
            console.debug('Error getting disk info:', error.message);
            return { total: '0', used: '0', free: '0', percentage: 0 };
        }
    }

    getStatus() {
        return {
            running: this.running,
            interval: this.statusInterval,
            wifiInterface: this.wifiInterface,
            lastStatus: this.lastStatus
        };
    }

    async testConnectivity() {
        try {
            const { stdout } = await execAsync('ping -c 1 -W 3 8.8.8.8');
            return {
                internetConnected: stdout.includes('1 received'),
                latency: stdout.match(/time=(\d+\.?\d*) ms/)?.[1] || null
            };
        } catch (error) {
            return {
                internetConnected: false,
                error: error.message
            };
        }
    }
}

export function createMonitor(config) {
    return new Monitor(config);
}