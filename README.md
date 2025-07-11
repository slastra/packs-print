# Packs Print - Modern Rollo Printer Integration

A modern, lightweight Node.js application for managing Rollo label printers with direct USB communication, eliminating CUPS dependencies.

## Features

- **Direct USB Communication** - No CUPS required, communicates directly with printer via USB device files
- **Real-time Status Monitoring** - Uses ioctl calls to get accurate printer status
- **MQTT Integration** - Receives print jobs and publishes status updates
- **LED Status Indication** - Visual feedback via rgbd daemon
- **Event-driven Architecture** - Loosely coupled modules for reliability
- **Modern ES6 Modules** - Lightweight and efficient for Raspberry Pi

## Quick Start

### Prerequisites

- Node.js 20+ (LTS recommended, v22 supported)
- USB printer device at `/dev/usb/lp0` (configurable)
- rgbd daemon running for LED control
- MQTT broker access

### Installation

1. Clone and install dependencies:
   ```bash
   cd packs-print
   npm install
   ```

2. Create environment configuration:
   ```bash
   cp .env.example .env
   # Edit .env with your settings
   ```

3. Set up USB device permissions:
   ```bash
   # Add udev rule for printer access
   sudo echo 'SUBSYSTEM=="usb", ATTRS{idVendor}=="09c5", MODE="0666"' > /etc/udev/rules.d/99-rollo-printer.rules
   sudo udevadm control --reload-rules
   ```

4. Start the application:
   ```bash
   npm start
   ```

## Configuration

Environment variables in `.env`:

```bash
# MQTT Settings
MQTT_HOST=servicez.cloud
MQTT_PORT=1883
MQTT_USERNAME=rez
MQTT_PASSWORD=your_password

# Printer Settings
PRINTER_MEDIA=2x1              # Label size/type
PRINTER_DEVICE=/dev/usb/lp0    # USB device path

# Monitoring
STATUS_INTERVAL=10000          # Status publish interval (ms)
WIFI_INTERFACE=wlan0           # WiFi interface name

# LED
LED_BRIGHTNESS=0.5             # LED brightness (0-1)
```

## Usage

### MQTT Topics

**Subscribe to:**
- `printers-ng/{hostname}/+` - Print job requests

**Publish to:**
- `rez/printers-ng/{hostname}` - Status updates
- `rez/prints/{hostname}/success` - Successful prints
- `rez/prints/{hostname}/failure` - Failed prints
- `rez/errors/{hostname}` - Error details

### Print Job Format

Send JSON message to `printers-ng/{hostname}/{template}`:

```json
{
  "barcode": "123456789",
  "text": "Sample Label",
  "copies": 2
}
```

### Templates

EPL templates are stored in `templates/{media}/{template}.epl`.

Example template (`templates/2x1/test.epl`):
```
N
q609
Q203,26
B26,26,0,UA0,2,2,152,B,"{{barcode}}"
A253,26,0,3,1,1,N,"{{text}}"
P{{copies}}
```

## LED Status Indicators

- **Green** - Connected and ready
- **Blue** - Processing print job
- **Yellow** - Offline/disconnected
- **Red** - Error or paper out
- **Pulsing** - Connecting/calibrating
- **WiFi Gradient** - Signal strength indication

## Development

### Running in Development Mode

```bash
npm run dev
```

### Testing Templates

```bash
# Test LED functionality
node -e "
import('./src/led.js').then(({createLedController}) => {
  const led = createLedController({brightness: 0.5});
  led.initialize().then(() => led.testSequence());
});
"
```

### Module Structure

```
src/
├── index.js    # Main application orchestrator
├── printer.js  # USB communication & ioctl status
├── mqtt.js     # MQTT client for job handling
├── queue.js    # Print job queue management
├── led.js      # LED control via rgbd daemon
└── monitor.js  # System monitoring (WiFi, USB, etc.)
```

## Deployment

### Raspberry Pi Setup

1. Install Node.js 20+ (LTS recommended, v22 supported)
2. Set up rgbd daemon for LED control
3. Configure USB device permissions
4. Create systemd service:

```ini
[Unit]
Description=Packs Print Service
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/packs-print
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

### PM2 Deployment

1. **Set deployment environment variables (optional):**
   ```bash
   export DEPLOY_USER=your-username
   export DEPLOY_HOST=your-hostname
   export DEPLOY_REPO=https://github.com/your-username/packs-print.git
   export DEPLOY_PATH=/home/your-username/packs-print
   ```

2. **Deploy to Raspberry Pi:**
   ```bash
   # First time setup
   npm run deploy:setup
   
   # Deploy updates
   npm run deploy
   
   # Monitor remotely
   npm run pm2:monitor
   npm run pm2:logs
   ```

### Manual Testing

```bash
# Deploy to Raspberry Pi manually
rsync -av . rp30:~/packs-print/

# SSH and test
ssh rp30
cd ~/packs-print
npm start
```

## Troubleshooting

### Common Issues

1. **USB Device Not Accessible**
   - Check device permissions: `ls -la /dev/usb/lp0`
   - Verify udev rules are active
   - Ensure printer is connected and powered

2. **MQTT Connection Issues**
   - Check network connectivity
   - Verify MQTT credentials
   - Test with mosquitto client

3. **LED Not Working**
   - Ensure rgbd daemon is running
   - Check FIFO permissions: `ls -la /tmp/led_control`
   - Test with manual FIFO write

4. **Template Not Found**
   - Check template path: `templates/{media}/{template}.epl`
   - Verify template syntax (Handlebars + EPL)

### Debug Mode

```bash
DEBUG=* npm start
```

## License

ISC