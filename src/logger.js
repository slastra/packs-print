// Centralized logging utility with normalized format
// Format: [LEVEL] [MODULE] Message

const DEBUG = process.env.DEBUG === 'true';

function formatMessage(level, module, message) {
    const timestamp = new Date().toISOString().slice(11, 19); // HH:MM:SS
    return `${timestamp} [${level}] [${module}] ${message}`;
}

export const logger = {
    info: (module, message) => {
        console.log(formatMessage('INFO', module, message));
    },
    
    success: (module, message) => {
        console.log(formatMessage('SUCCESS', module, message));
    },
    
    error: (module, message) => {
        console.error(formatMessage('ERROR', module, message));
    },
    
    warn: (module, message) => {
        console.warn(formatMessage('WARN', module, message));
    },
    
    debug: (module, message) => {
        if (DEBUG) {
            console.log(formatMessage('DEBUG', module, message));
        }
    }
};

// Module constants for consistency
export const MODULES = {
    APP: 'APP',
    MQTT: 'MQTT', 
    PRINTER: 'PRINTER',
    QUEUE: 'QUEUE',
    MONITOR: 'MONITOR',
    LED: 'LED'
};