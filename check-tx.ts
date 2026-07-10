import { ethers } from "ethers";

async function check() {
  const provider = new ethers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com");
  const receipt = await provider.getTransactionReceipt("0x704b83e649e86129696a87f4c65fc7f8403fde85bca5cb466389c4a1f3e1b775");
  console.log("Receipt found:", receipt ? receipt.status : "null");
  
  const tx2 = await provider.getTransactionReceipt("0xecf879066147efcc82ee8b56e84bf75fd6d7ba008f022a0173655d73a0ee481b");
  console.log("Tx2 Receipt found:", tx2 ? tx2.status : "null");
}

check().catch(console.error);
