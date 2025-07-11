import { promises as fs } from 'fs';
import { EventEmitter } from 'events';

const LED_CONTROL_FIFO = '/tmp/led_control';

class LedController extends EventEmitter {
    constructor(config) {
        super();
        this.config = config;
        this.brightness = config.brightness || 0.5;
        this.currentColor = { r: 0, g: 0, b: 0 };
        this.pulseInterval = null;
        this.available = false;
    }

    async initialize() {
        try {
            // Check if rgbd daemon is running by testing FIFO
            await this.checkFifoAvailable();
            // LED controller initialized
            this.available = true;
        } catch (error) {
            console.log('LED controller not available:', error.message);
            this.available = false;
        }
    }

    async checkFifoAvailable() {
        try {
            await fs.access(LED_CONTROL_FIFO, fs.constants.W_OK);
        } catch (error) {
            throw new Error(`LED control FIFO not accessible: ${LED_CONTROL_FIFO}`);
        }
    }

    async setColor(r, g, b, duration = 0) {
        if (!this.available) {
            // Would set LED color
            return;
        }

        // Stop any current pulse
        this.stopPulse();

        // Apply brightness scaling
        const scaledR = Math.floor(r * this.brightness);
        const scaledG = Math.floor(g * this.brightness);
        const scaledB = Math.floor(b * this.brightness);

        this.currentColor = { r: scaledR, g: scaledG, b: scaledB };

        try {
            const command = JSON.stringify({
                r: scaledR,
                g: scaledG,
                b: scaledB,
                duration: duration
            });

            await fs.writeFile(LED_CONTROL_FIFO, command + '\n');
            // LED color set
            
        } catch (error) {
            console.error('Error setting LED color:', error);
            this.emit('error', error);
        }
    }

    async pulse(r, g, b, interval = 500) {
        if (!this.available) {
            // Would pulse LED
            return;
        }

        this.stopPulse();

        let isOn = false;
        this.pulseInterval = setInterval(async () => {
            if (isOn) {
                await this.setColor(0, 0, 0, 0);
            } else {
                await this.setColor(r, g, b, 0);
            }
            isOn = !isOn;
        }, interval);
    }

    stopPulse() {
        if (this.pulseInterval) {
            clearInterval(this.pulseInterval);
            this.pulseInterval = null;
        }
    }

    async setBrightness(brightness) {
        this.brightness = Math.max(0, Math.min(1, brightness));
        console.log(`LED brightness set to: ${(this.brightness * 100).toFixed(1)}%`);
        
        // Reapply current color with new brightness
        const { r, g, b } = this.currentColor;
        await this.setColor(r, g, b);
    }

    async off() {
        await this.setColor(0, 0, 0);
    }

    // Predefined color methods for convenience
    async red(duration = 0) {
        await this.setColor(255, 0, 0, duration);
    }

    async green(duration = 0) {
        await this.setColor(0, 255, 0, duration);
    }

    async blue(duration = 0) {
        await this.setColor(0, 0, 255, duration);
    }

    async yellow(duration = 0) {
        await this.setColor(255, 255, 0, duration);
    }

    async white(duration = 0) {
        await this.setColor(255, 255, 255, duration);
    }

    async orange(duration = 0) {
        await this.setColor(255, 165, 0, duration);
    }

    async purple(duration = 0) {
        await this.setColor(128, 0, 128, duration);
    }

    // Status indication methods
    async showConnecting() {
        await this.pulse(255, 255, 0, 500); // Pulsing yellow
    }

    async showConnected() {
        await this.green(300); // Solid green
    }

    async showDisconnected() {
        await this.yellow(300); // Solid yellow
    }

    async showProcessing() {
        await this.blue(100); // Solid blue
    }

    async showError() {
        await this.red(100); // Solid red
    }

    async showSuccess() {
        await this.green(100); // Solid green
    }

    async showCalibrating() {
        await this.pulse(255, 255, 255, 300); // Pulsing white
    }

    async showPaperOut() {
        await this.pulse(255, 0, 0, 1000); // Slow pulsing red
    }

    // WiFi signal strength indication
    async showWifiSignal(strength) {
        // strength should be 0-1
        const normalizedStrength = Math.max(0, Math.min(1, strength));
        
        if (normalizedStrength > 0.7) {
            await this.green(300); // Strong signal - green
        } else if (normalizedStrength > 0.4) {
            await this.orange(300); // Medium signal - orange
        } else if (normalizedStrength > 0.1) {
            await this.red(300); // Weak signal - red
        } else {
            await this.pulse(255, 0, 0, 200); // No signal - fast pulsing red
        }
    }

    // Shutdown sequence
    async shutdown() {
        console.log('Shutting down LED controller...');
        
        this.stopPulse();
        
        // Fade out sequence
        if (this.available) {
            try {
                await this.setColor(255, 255, 255, 100);
                await new Promise(resolve => setTimeout(resolve, 200));
                await this.setColor(0, 0, 0, 500);
                await new Promise(resolve => setTimeout(resolve, 600));
            } catch (error) {
                console.error('Error during LED shutdown:', error);
            }
        }
        
        console.log('✓ LED controller shutdown complete');
    }

    getStatus() {
        return {
            available: this.available,
            brightness: this.brightness,
            currentColor: this.currentColor,
            pulsing: this.pulseInterval !== null
        };
    }

    // Test method for development
    async testSequence() {
        console.log('Starting LED test sequence...');
        
        const colors = [
            { name: 'Red', r: 255, g: 0, b: 0 },
            { name: 'Green', r: 0, g: 255, b: 0 },
            { name: 'Blue', r: 0, g: 0, b: 255 },
            { name: 'Yellow', r: 255, g: 255, b: 0 },
            { name: 'White', r: 255, g: 255, b: 255 }
        ];

        for (const color of colors) {
            console.log(`Testing ${color.name}...`);
            await this.setColor(color.r, color.g, color.b, 100);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        console.log('Testing pulse...');
        await this.pulse(255, 0, 255, 300);
        await new Promise(resolve => setTimeout(resolve, 3000));

        await this.off();
        console.log('LED test sequence complete');
    }
}

export function createLedController(config) {
    return new LedController(config);
}