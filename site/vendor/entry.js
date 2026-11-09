// The slice of viem the site needs, bundled into vendor/viem.js by vendor/build.mjs (no bundler at runtime).
export {
  BaseError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  formatEther,
  getAddress,
  http,
  isAddress,
  parseEther,
  parseEventLogs,
  zeroAddress,
} from "viem";
export { generatePrivateKey, nonceManager, privateKeyToAccount } from "viem/accounts";
