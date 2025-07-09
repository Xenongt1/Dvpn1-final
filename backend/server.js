const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const { Server } = require('socket.io');
const http = require('http');
const { NodeSSH } = require('node-ssh');
const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');

const app = express();
const server = http.createServer(app);

// Configure Socket.IO with proper CORS and transport options
const io = new Server(server, {
  cors: {
    origin: ["http://localhost:3000", "http://localhost:3001"],
    methods: ["GET", "POST"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"]
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});

// Configure Express CORS
app.use(cors({
  origin: ["http://localhost:3000", "http://localhost:3001"],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.use(express.json());

// VPN Node Configuration
const VPN_NODE = {
  host: '34.89.26.3',
  username: 'mbrktijani',
  port: 22,
  publicKey: process.env.VPN_PUBLIC_KEY || 'bUe6P3MbDPSihQLfEU3GQZD+IgCd+sPuGd5GN0r2Qi8='
};

const ssh = new NodeSSH();

// Connect to VPN node
async function connectToVPNNode() {
  try {
    await ssh.connect(VPN_NODE);
    console.log('Connected to VPN node');
  } catch (error) {
    console.error('Failed to connect to VPN node:', error);
  }
}

// Initialize connection
connectToVPNNode();

// Initialize SQLite database
const db = new sqlite3.Database('./dvpn.db', (err) => {
  if (err) {
    console.error('Error opening database:', err);
  } else {
    console.log('Connected to SQLite database');
    // Create pending_nodes table if it doesn't exist
    db.run(`CREATE TABLE IF NOT EXISTS pending_nodes (
      address TEXT PRIMARY KEY,
      ip_address TEXT NOT NULL,
      owner TEXT NOT NULL,
      friendly_name TEXT NOT NULL,
      country TEXT NOT NULL,
      submission_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      status TEXT DEFAULT 'pending'
    )`);
  }
});

// Enhanced WebSocket connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Send immediate acknowledgment
  socket.emit('connected', { status: 'ok' });

  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });

  socket.on('disconnect', (reason) => {
    console.log('Client disconnected:', socket.id, 'Reason:', reason);
  });
});

// Get all pending nodes
app.get('/api/pending-nodes', (req, res) => {
  db.all('SELECT * FROM pending_nodes WHERE status = ?', ['pending'], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

// Submit a new node for approval
app.post('/api/nodes/register', (req, res) => {
  const { address, ipAddress, owner, friendlyName, country } = req.body;
  
  if (!friendlyName || !country) {
    res.status(400).json({ error: 'Friendly name and country are required' });
    return;
  }

  // First check if the node is already pending
  db.get('SELECT * FROM pending_nodes WHERE address = ?', [address], (err, row) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }

    if (row) {
      // Node is already pending, update its details
      db.run(
        'UPDATE pending_nodes SET ip_address = ?, owner = ?, friendly_name = ?, country = ?, submission_time = CURRENT_TIMESTAMP, status = ? WHERE address = ?',
        [ipAddress, owner, friendlyName, country, 'pending', address],
        function(err) {
          if (err) {
            res.status(500).json({ error: err.message });
            return;
          }
          
          const updatedNode = {
            address,
            ipAddress,
            owner,
            friendlyName: friendlyName,
            country,
            status: 'pending',
            submission_time: new Date().toISOString()
          };
          
          io.emit('newPendingNode', updatedNode);
          
          res.json({
            message: 'Node registration updated successfully',
            node: updatedNode
          });
        }
      );
    } else {
      // New node registration
      db.run(
        'INSERT INTO pending_nodes (address, ip_address, owner, friendly_name, country) VALUES (?, ?, ?, ?, ?)',
        [address, ipAddress, owner, friendlyName, country],
        function(err) {
          if (err) {
            res.status(500).json({ error: err.message });
            return;
          }
          
          const newNode = {
            address,
            ipAddress,
            owner,
            friendlyName: friendlyName,
            country,
            status: 'pending',
            submission_time: new Date().toISOString()
          };
          
          io.emit('newPendingNode', newNode);
          
          res.json({
            message: 'Node registration submitted successfully',
            node: newNode
          });
        }
      );
    }
  });
});

// Update node status (approve/reject)
app.post('/api/nodes/:address/status', (req, res) => {
  const { address } = req.params;
  const { status } = req.body;
  
  db.run(
    'UPDATE pending_nodes SET status = ? WHERE address = ?',
    [status, address],
    function(err) {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }
      
      // Notify all connected clients about the status update
      io.emit('nodeStatusUpdate', { address, status });
      
      res.json({
        message: `Node ${status} successfully`,
        address
      });
    }
  );
});

// VPN Connection Management Endpoints
app.post('/api/vpn/connect', async (req, res) => {
  const { userAddress } = req.body;
  
  try {
    // Check if user exists and is approved
    const user = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM pending_nodes WHERE address = ? AND status = ?', 
        [userAddress, 'approved'], 
        (err, row) => {
          if (err) reject(err);
          resolve(row);
        });
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found or not approved' });
    }

    // Call the VM's API to generate a peer
    const vmResponse = await axios({
      method: 'post',
      url: 'http://35.246.119.40:5000/generate-peer',
      responseType: 'arraybuffer'
    });

    // Forward the configuration file to the client
    res.setHeader('Content-Type', 'application/x-wireguard-config');
    res.setHeader('Content-Disposition', 'attachment; filename="wg0-client.conf"');
    res.send(vmResponse.data);

  } catch (error) {
    console.error('VPN connection error:', error);
    res.status(500).json({ error: 'Failed to establish VPN connection' });
  }
});

app.post('/api/vpn/disconnect', async (req, res) => {
  const { userAddress } = req.body;
  
  try {
    const user = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM pending_nodes WHERE address = ?', 
        [userAddress], 
        (err, row) => {
          if (err) reject(err);
          resolve(row);
        });
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Remove peer from WireGuard
    const removePeerCmd = `sudo wg set wg0 peer ${user.public_key} remove`;
    const result = await ssh.execCommand(removePeerCmd);
    
    if (result.stderr) {
      throw new Error(result.stderr);
    }

    res.json({ status: 'disconnected' });

  } catch (error) {
    console.error('VPN disconnection error:', error);
    res.status(500).json({ error: 'Failed to disconnect VPN' });
  }
});

app.get('/api/vpn/status/:address', async (req, res) => {
  const { address } = req.params;
  
  try {
    const user = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM pending_nodes WHERE address = ?', 
        [address], 
        (err, row) => {
          if (err) reject(err);
          resolve(row);
        });
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check connection status
    const status = await ssh.execCommand(`sudo wg show wg0 | grep ${user.public_key} -A 2`);
    
    const isConnected = status.stdout.length > 0;
    const lastHandshake = status.stdout.match(/latest handshake: (.*)/)?.[1] || null;
    
    res.json({
      status: isConnected ? 'connected' : 'disconnected',
      lastHandshake,
      details: status.stdout
    });

  } catch (error) {
    console.error('VPN status check error:', error);
    res.status(500).json({ error: 'Failed to check VPN status' });
  }
});

// Add generate-peer endpoint with proxy to VPN node
app.post('/generate-peer', async (req, res) => {
  try {
    const { eth_address, user_id } = req.body;
    
    if (!eth_address) {
      return res.status(400).json({ error: 'eth_address is required' });
    }

    console.log('Generating peer for:', { eth_address, user_id });

    // Try to connect directly to the VPN node's API
    try {
      const vpnResponse = await axios.post(`http://${VPN_NODE.host}:5000/generate-peer`, {
        eth_address,
        user_id
      }, {
        timeout: 5000,
        headers: {
          'Content-Type': 'application/json'
        }
      });

      console.log('Received response from VPN node:', vpnResponse.data);

      return res.json(vpnResponse.data);
    } catch (vpnError) {
      console.error('Failed to connect to VPN node directly:', vpnError.message);
      
      // Fallback to generating a local configuration
      const config = `[Interface]
PrivateKey = ${generatePrivateKey()}
Address = 10.0.0.2/24
DNS = 8.8.8.8, 8.8.4.4

[Peer]
PublicKey = ${VPN_NODE.publicKey}
AllowedIPs = 0.0.0.0/0
Endpoint = ${VPN_NODE.host}:51820
PersistentKeepalive = 25`;

      // Ensure vpn-configs directory exists
      const configDir = path.join(__dirname, 'vpn-configs');
      try {
        await fs.mkdir(configDir, { recursive: true });
      } catch (mkdirError) {
        console.error('Error creating vpn-configs directory:', mkdirError);
      }

      // Save the configuration
      const configPath = path.join(configDir, `${user_id}.conf`);
      await fs.writeFile(configPath, config);

      console.log('Generated local configuration for:', user_id);

      return res.json({
        config: config,
        connection_info: {
          client_ip: '10.0.0.2',
          expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
        }
      });
    }
  } catch (error) {
    console.error('Error in generate-peer endpoint:', error);
    res.status(500).json({ 
      error: 'Failed to generate peer configuration',
      details: error.message
    });
  }
});

// VPN peer generation proxy endpoint
app.post('/api/vpn/generate-peer', async (req, res) => {
  try {
    const { eth_address, public_key, client_ip } = req.body;
    console.log('Received peer generation request:', { eth_address, public_key, client_ip });

    if (!eth_address) {
      console.error('Missing eth_address parameter');
      return res.status(400).json({ error: 'Missing eth_address parameter' });
    }

    const apiKey = 'i1YjqNbMhJg1o-3lgiXgwv073dEHddv3_pHmQf1gg9M';
    const vpnNodeUrl = 'http://34.89.26.3:5000/generate-peer';
    
    console.log('Forwarding request to VPN node:', vpnNodeUrl);
    
    // Forward the request to the VPN node
    const response = await axios.post(vpnNodeUrl, {
      eth_address,
      public_key,
      client_ip
    }, {
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey
      }
    });

    console.log('VPN node response:', response.data);
    
    // Send the configuration back to the client
    res.send(response.data);
  } catch (error) {
    console.error('Error generating peer:', error.message);
    console.error('Full error:', error);
    
    // Enhanced error response
    const errorResponse = {
      error: 'Failed to generate peer configuration',
      message: error.message,
      details: error.response?.data || 'No additional details',
      statusCode: error.response?.status || 500
    };
    
    res.status(errorResponse.statusCode).json(errorResponse);
  }
});

function generatePrivateKey() {
  // In production, use proper WireGuard key generation
  // For testing, return a sample key
  return 'YJqz+vuQjYmwuJtl4LNiS4yGrVVNGFI7tGHt6Ut4C0Y=';
}

// Start the server
const PORT = process.env.PORT || 3006;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 