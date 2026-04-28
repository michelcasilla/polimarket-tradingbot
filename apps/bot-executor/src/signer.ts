import { Chain, ClobClient, type ApiKeyCreds } from '@polymarket/clob-client-v2';
import { createWalletClient, http } from 'viem';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

export interface PolymarketSignerConfig {
  privateKey: string;
  proxyWallet: string;
  signatureType: 0 | 1 | 2;
  chainId: number;
  host: string;
  rpcUrl: string;
  creds?: ApiKeyCreds;
  throwOnError?: boolean;
}

export interface PolymarketSigner {
  clobClient: ClobClient;
  accountAddress: `0x${string}`;
  funderAddress: string;
}

const asHexKey = (raw: string): `0x${string}` =>
  (raw.startsWith('0x') ? raw : `0x${raw}`) as `0x${string}`;

const toChain = (chainId: number): Chain => {
  if (chainId === 137) return Chain.POLYGON;
  if (chainId === 80002) return Chain.AMOY;
  return chainId as Chain;
};

export const createPolymarketSigner = (cfg: PolymarketSignerConfig): PolymarketSigner => {
  const account = privateKeyToAccount(asHexKey(cfg.privateKey));
  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http(cfg.rpcUrl),
  });

  const options: {
    host: string;
    chain: Chain;
    signer: ReturnType<typeof createWalletClient>;
    signatureType: 0 | 1 | 2;
    funderAddress: string;
    throwOnError: boolean;
    creds?: ApiKeyCreds;
  } = {
    host: cfg.host,
    chain: toChain(cfg.chainId),
    signer: walletClient,
    signatureType: cfg.signatureType,
    funderAddress: cfg.proxyWallet,
    throwOnError: cfg.throwOnError ?? true,
  };
  if (cfg.creds) options.creds = cfg.creds;
  const clobClient = new ClobClient(options);

  return {
    clobClient,
    accountAddress: account.address,
    funderAddress: cfg.proxyWallet,
  };
};
