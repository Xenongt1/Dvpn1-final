import io from 'socket.io-client';
import axios from 'axios';

const API_URL = 'http://' + window.location.hostname + ':3006/api';
const socket = io('http://' + window.location.hostname + ':3006', {
  transports: ['websocket', 'polling'],
  reconnectionAttempts: 5,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 20000,
  autoConnect: true,
  forceNew: true
});

// Add connection event listeners
socket.on('connect', () => {
  console.log('Socket.io connected successfully');
});

socket.on('connected', (data: { status: string }) => {
  console.log('Received connection acknowledgment:', data);
});

socket.on('connect_error', (error: Error) => {
  console.error('Socket.io connection error:', error);
});

socket.on('disconnect', (reason: string) => {
  console.log('Socket.io disconnected:', reason);
  if (reason === 'io server disconnect') {
    // the disconnection was initiated by the server, you need to reconnect manually
    socket.connect();
  }
});

export interface PendingNode {
  address: string;
  ipAddress: string;
  owner: string;
  friendlyName: string;
  country: string;
  publicKey: string;
  price: string;
  capacity: number;
  currentLoad: number;
  supportedProtocols: string[];
  apiPort: number;
  wireguardPort: number;
  status: 'pending' | 'approved' | 'rejected';
  submission_time: string;
}

class NodeService {
  private listeners: { [key: string]: Function[] } = {};

  constructor() {
    // Listen for new pending nodes
    socket.on('newPendingNode', (node: PendingNode) => {
      this.notifyListeners('newPendingNode', node);
    });

    // Listen for node status updates
    socket.on('nodeStatusUpdate', (update: { address: string; status: string }) => {
      this.notifyListeners('nodeStatusUpdate', update);
    });
  }

  // Add event listener
  addEventListener(event: string, callback: Function) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(callback);
  }

  // Remove event listener
  removeEventListener(event: string, callback: Function) {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
    }
  }

  // Notify all listeners of an event
  private notifyListeners(event: string, data: any) {
    if (this.listeners[event]) {
      this.listeners[event].forEach(callback => callback(data));
    }
  }

  // Get all pending nodes
  async getPendingNodes(): Promise<PendingNode[]> {
    try {
      const response = await axios.get(`${API_URL}/pending-nodes`);
      return response.data;
    } catch (error) {
      console.error('Error fetching pending nodes:', error);
      return [];
    }
  }

  // Register a new node
  async registerNode(
    address: string,
    ipAddress: string,
    owner: string,
    friendlyName: string,
    country: string
  ): Promise<boolean> {
    try {
      const response = await axios.post(`${API_URL}/nodes/register`, {
        address,
        ipAddress,
        owner,
        friendlyName,
        country
      });
      return response.data && response.data.message === 'Node registration submitted successfully';
    } catch (error: any) {
      console.error('Error registering node:', error.response?.data?.error || error.message);
      throw new Error(error.response?.data?.error || 'Failed to register node');
    }
  }

  // Update node status
  async updateNodeStatus(address: string, status: 'approved' | 'rejected'): Promise<boolean> {
    try {
      await axios.post(`${API_URL}/nodes/${address}/status`, { status });
      return true;
    } catch (error) {
      console.error('Error updating node status:', error);
      return false;
    }
  }
}

export const nodeService = new NodeService(); 