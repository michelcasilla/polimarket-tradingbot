import type { MakerRewardScore, MarketMetadata, MarketSignal, OrderBookSnapshot } from '@polymarket-bot/contracts';

export interface RewardsOptimizerConfig {
  minIncentiveSize: number;
  maxIncentiveSpread: number;
  minExpectedScore: number;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);

export const scoreOrder = (vMaxSpread: number, sSpread: number, size: number): number => {
  if (size <= 0 || vMaxSpread <= 0 || sSpread > vMaxSpread) return 0;
  const ratio = (vMaxSpread - sSpread) / vMaxSpread;
  return ratio * ratio * size;
};

export const computeRewardForSnapshot = (
  snapshot: OrderBookSnapshot,
  metadata: MarketMetadata | undefined,
  cfg: RewardsOptimizerConfig,
): MakerRewardScore | null => {
  if (!snapshot.midPrice || !snapshot.spread) return null;
  const minSize = cfg.minIncentiveSize;
  const size = Math.max(snapshot.bids[0]?.size ?? 0, snapshot.asks[0]?.size ?? 0);
  if (size < minSize) return null;
  const v = metadata?.liquidity ? clamp(cfg.maxIncentiveSpread * 0.5, 0.005, 0.1) : cfg.maxIncentiveSpread;
  const s = snapshot.spread;
  const expectedScore = scoreOrder(v, s, size);
  if (expectedScore < cfg.minExpectedScore) return null;
  return {
    marketId: snapshot.marketId,
    outcome: snapshot.outcome,
    expectedScore,
    vMaxSpread: v,
    sActualSpread: s,
    size,
    twoSided: true,
    computedAt: Date.now(),
  };
};

export const rewardScoreToSignal = (
  score: MakerRewardScore,
  snap: OrderBookSnapshot,
  ttlMs: number,
): MarketSignal => ({
  marketId: score.marketId,
  outcome: score.outcome,
  fairPrice: clamp(snap.midPrice ?? 0.5, 0.01, 0.99),
  confidence: clamp(score.expectedScore / Math.max(score.size, 1), 0, 1),
  reason: 'MAKER_REWARDS',
  ttlMs,
  timestamp: Date.now(),
  metadata: {
    direction: 'MAKE_TWO_SIDED',
    expectedScore: score.expectedScore,
    vMaxSpread: score.vMaxSpread,
    sActualSpread: score.sActualSpread,
    twoSided: score.twoSided,
  },
});
