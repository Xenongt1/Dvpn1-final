# VPN Tray Application

This is a system tray application that manages WireGuard VPN connections. It provides a WebSocket interface for the frontend to send VPN configurations and control VPN connections.

## Prerequisites

1. Python 3.7 or higher
2. WireGuard installed on your system
   - Windows: Install from https://www.wireguard.com/install/
   - Linux: `sudo apt install wireguard` (Ubuntu/Debian) or equivalent for your distribution
   - macOS: `brew install wireguard-tools` (using Homebrew)

## Installation

1. Create a virtual environment (recommended):
   ```bash
   python -m venv venv
   source venv/bin/activate  # Linux/macOS
   venv\Scripts\activate     # Windows
   ```

2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

## Usage

1. Start the tray application:
   ```bash
   python vpn_tray.py
   ```

2. The application will:
   - Create a system tray icon
   - Start a WebSocket server on `ws://localhost:8765`
   - Handle VPN connections from the frontend

## WebSocket API

The application accepts the following WebSocket commands:

### Connect to VPN
```json
{
    "command": "connect",
    "config": "WireGuard configuration content",
    "filename": "vpn-config-name.conf"
}
```

### Disconnect from VPN
```json
{
    "command": "disconnect"
}
```

## Features

- System tray integration
- Automatic WireGuard tunnel management
- Configuration file sanitization
- Cross-platform support (Windows, Linux, macOS)
- Secure WebSocket communication with frontend
- Proper cleanup on disconnect

## Logging

Logs are written to `vpn_tray.log` in the application directory. Check this file for troubleshooting. 