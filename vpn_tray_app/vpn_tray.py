import os
import sys
import json
import asyncio
import logging
import re
import subprocess
from pathlib import Path
from typing import Optional, Dict

import pystray
from PIL import Image
import websockets
from websockets.server import WebSocketServerProtocol

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('vpn_tray.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

class VPNTrayApp:
    def __init__(self):
        self.icon = None
        self.websocket_server = None
        self.current_connection: Optional[Dict] = None
        
        # WireGuard paths - use local directory for testing
        self.config_dir = Path.home() / ".vpn-configs"
        self.config_dir.mkdir(parents=True, exist_ok=True)
            
        if sys.platform == "win32":
            self.wireguard_path = Path(os.environ["ProgramFiles"]) / "WireGuard"
        else:
            self.wireguard_path = Path("/etc/wireguard")

    def sanitize_tunnel_name(self, name: str) -> str:
        """Sanitize the tunnel name to be compatible with WireGuard"""
        # Convert to lowercase and remove any non-alphanumeric characters except hyphen
        sanitized = re.sub(r'[^a-z0-9\-]', '', name.lower())
        # Replace multiple hyphens with a single hyphen
        sanitized = re.sub(r'-+', '-', sanitized)
        # Remove leading and trailing hyphens
        sanitized = sanitized.strip('-')
        # Ensure it starts with 'vpn-' prefix
        if not sanitized.startswith('vpn-'):
            sanitized = 'vpn-' + sanitized
        # Limit the length (WireGuard has a maximum interface name length)
        sanitized = sanitized[:15]
        # Ensure we have a valid name after all transformations
        if len(sanitized) < 4:  # 'vpn-' plus at least one character
            sanitized = 'vpn-default'
        return sanitized

    async def handle_websocket(self, websocket: WebSocketServerProtocol):
        """Handle WebSocket connections and messages"""
        try:
            async for message in websocket:
                try:
                    data = json.loads(message)
                    command = data.get('command')
                    
                    if command == 'connect':
                        config = data.get('config')
                        filename = data.get('filename')
                        if config and filename:
                            await self.handle_connect(websocket, config, filename)
                    
                    elif command == 'disconnect':
                        await self.handle_disconnect(websocket)
                    
                    else:
                        await websocket.send(json.dumps({
                            'status': 'error',
                            'message': f'Unknown command: {command}'
                        }))
                
                except json.JSONDecodeError:
                    await websocket.send(json.dumps({
                        'status': 'error',
                        'message': 'Invalid JSON message'
                    }))
        
        except websockets.exceptions.ConnectionClosed:
            logger.info("WebSocket connection closed")

    async def handle_connect(self, websocket: WebSocketServerProtocol, config: str, filename: str):
        """Handle VPN connection request"""
        try:
            # Sanitize the filename
            base_name = Path(filename).stem
            sanitized_name = self.sanitize_tunnel_name(base_name)
            config_path = self.config_dir / f"{sanitized_name}.conf"
            
            # Save the configuration file
            config_path.write_text(config)
            logger.info(f"Saved configuration to {config_path}")
            
            # Activate the tunnel
            if sys.platform == "win32":
                cmd = [str(self.wireguard_path / "wireguard.exe"), "/installtunnelservice", str(config_path)]
            else:
                cmd = ["wg-quick", "up", sanitized_name]
            
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            stdout, stderr = await process.communicate()
            
            if process.returncode == 0:
                self.current_connection = {
                    'tunnel_name': sanitized_name,
                    'config_path': str(config_path)
                }
                await websocket.send(json.dumps({
                    'status': 'success',
                    'message': 'VPN connection activated'
                }))
                logger.info(f"VPN connection activated: {sanitized_name}")
            else:
                error_msg = stderr.decode() if stderr else "Unknown error"
                raise Exception(f"Failed to activate tunnel: {error_msg}")
                
        except Exception as e:
            logger.error(f"Error in handle_connect: {str(e)}")
            await websocket.send(json.dumps({
                'status': 'error',
                'message': str(e)
            }))
            # Cleanup if needed
            if 'config_path' in locals() and config_path.exists():
                config_path.unlink()

    async def handle_disconnect(self, websocket: WebSocketServerProtocol):
        """Handle VPN disconnection request"""
        try:
            if not self.current_connection:
                await websocket.send(json.dumps({
                    'status': 'error',
                    'message': 'No active VPN connection'
                }))
                return
                
            tunnel_name = self.current_connection['tunnel_name']
            config_path = Path(self.current_connection['config_path'])
            
            # Deactivate the tunnel
            if sys.platform == "win32":
                cmd = [str(self.wireguard_path / "wireguard.exe"), "/uninstalltunnelservice", tunnel_name]
            else:
                cmd = ["wg-quick", "down", tunnel_name]
            
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            stdout, stderr = await process.communicate()
            
            if process.returncode == 0:
                # Remove the configuration file
                if config_path.exists():
                    config_path.unlink()
                
                self.current_connection = None
                await websocket.send(json.dumps({
                    'status': 'success',
                    'message': 'VPN connection deactivated'
                }))
                logger.info(f"VPN connection deactivated: {tunnel_name}")
            else:
                error_msg = stderr.decode() if stderr else "Unknown error"
                raise Exception(f"Failed to deactivate tunnel: {error_msg}")
                
        except Exception as e:
            logger.error(f"Error in handle_disconnect: {str(e)}")
            await websocket.send(json.dumps({
                'status': 'error',
                'message': str(e)
            }))

    async def start_websocket_server(self):
        """Start the WebSocket server"""
        self.websocket_server = await websockets.serve(
            self.handle_websocket,
            'localhost',
            8765  # WebSocket port
        )
        logger.info("WebSocket server started on ws://localhost:8765")

    def create_tray_icon(self):
        """Create and run the system tray icon"""
        # Create a simple icon (you should replace this with your own icon)
        icon_image = Image.new('RGB', (64, 64), color='blue')
        
        def on_quit():
            """Handle quit menu item"""
            logger.info("Shutting down VPN Tray App")
            if self.websocket_server:
                self.websocket_server.close()
            self.icon.stop()
            
        # Create the tray icon
        self.icon = pystray.Icon(
            "vpn_tray",
            icon_image,
            "VPN Tray",
            menu=pystray.Menu(
                pystray.MenuItem("Quit", on_quit)
            )
        )

    def run(self):
        """Run the tray app"""
        # Create and start the event loop
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        try:
            # Start WebSocket server
            loop.run_until_complete(self.start_websocket_server())
            
            # Create and run tray icon
            self.create_tray_icon()
            
            # Run the icon in a separate thread
            import threading
            icon_thread = threading.Thread(target=self.icon.run)
            icon_thread.start()
            
            # Run the event loop
            loop.run_forever()
            
        except KeyboardInterrupt:
            logger.info("Received keyboard interrupt")
        finally:
            # Cleanup
            if self.websocket_server:
                self.websocket_server.close()
            loop.close()
            if self.icon:
                self.icon.stop()

if __name__ == "__main__":
    app = VPNTrayApp()
    app.run() 