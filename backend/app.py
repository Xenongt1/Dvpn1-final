from flask import Flask, jsonify, request
from flask_cors import CORS
import os
from web3 import Web3

app = Flask(__name__)
CORS(app)

# Connect to Sepolia testnet
w3 = Web3(Web3.HTTPProvider('https://sepolia.infura.io/v3/YOUR_INFURA_KEY'))

# Your subscription contract address and ABI
CONTRACT_ADDRESS = '0x516Fa3Ea215c372696e6D291F00f251f49904439'
SUBSCRIPTION_ABI = [
    {
        "inputs": [{"internalType": "address", "name": "user", "type": "address"}],
        "name": "hasActiveSubscription",
        "outputs": [{"internalType": "bool", "name": "", "type": "bool"}],
        "stateMutability": "view",
        "type": "function"
    }
]

@app.route('/verify-subscription', methods=['POST'])
def verify_subscription():
    try:
        data = request.get_json()
        eth_address = data.get('eth_address')
        
        if not eth_address:
            return jsonify({'error': 'eth_address is required'}), 400
            
        # Initialize contract
        contract = w3.eth.contract(address=CONTRACT_ADDRESS, abi=SUBSCRIPTION_ABI)
        
        # Check subscription status
        is_subscribed = contract.functions.hasActiveSubscription(eth_address).call()
        
        if is_subscribed:
            return jsonify({'status': 'active'}), 200
        return jsonify({'error': 'No active subscription'}), 401

    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=3006) 