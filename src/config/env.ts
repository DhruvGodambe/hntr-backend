import dotenv from 'dotenv';
import path from 'path';

// Load the root hntr workspace .env
dotenv.config({ path: path.resolve(__dirname, '../../../../hntr/.env') });
// Also load the local .env as fallback/overrides
dotenv.config();

export const ENV = {
  PORT: process.env.PORT || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  MONGO_URI: process.env.MONGO_URI || 'mongodb://localhost:27017/hntr',
  RPC_URL: process.env.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com',
  CONTRACT_ADDRESS: process.env.CONTRACT_ADDRESS || '0xd0930a746470f8555b18B7afdf118FAd05A71a00',
  PRIVATE_KEY: process.env.PRIVATE_KEY || '',
};
