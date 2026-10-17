import { Router } from 'express';
import {
   httpListCreators,
   httpGetCreator,
   httpGetCreatorStats,
   httpGetTrendingCreators,
   httpGetCreatorLeaderboard,
   httpGetCreatorAnalytics,
} from './creators.controllers';
import { httpGetCreatorHolders } from './creator-holders.controller';
import { httpGetCreatorSocial } from './creator-social.controller';
import { cacheControl } from '../../middlewares/cache-control.middleware';
import { CREATOR_PUBLIC_ROUTE_CACHE_PRESETS } from '../../constants/creator-public-cache.constants';
import { CREATOR_PUBLIC_ROUTE_NAMES } from '../../constants/creator-public-routes.constants';
import { createCreatorReadMetricsMiddleware } from '../../utils/creator-read-metrics.utils';
import { normalizeTrailingSlash } from '../../middlewares/trailing-slash-normalizer.middleware';
import { validateCreatorParam } from '../../middlewares/creator-param.middleware';
import {
   requireCreatorProfileOwnership,
} from '../../middlewares/wallet-ownership.middleware';
import { requireStellarSignature } from '../../middlewares/stellar-signature.middleware';
import { httpBuyCreatorKey } from '../creator/buy.controller';
import { httpCreatePost, httpListPosts } from '../creator/post.controller';

const creatorsRouter = Router();

// Normalize trailing slashes for all creator routes so that, e.g.,
// GET /api/v1/creators/ reaches the same handler as GET /api/v1/creators.
// Scoped to this router to avoid side-effects on other route groups.
creatorsRouter.use(normalizeTrailingSlash);

creatorsRouter.post(
   '/:id/buy',
   validateCreatorParam('id'),
   requireStellarSignature(),
   httpBuyCreatorKey
);
creatorsRouter.get('/:id/posts', validateCreatorParam('id'), httpListPosts);
creatorsRouter.post(
   '/:id/posts',
   validateCreatorParam('id'),
   requireStellarSignature(),
   httpCreatePost
);

/**
 * GET /api/v1/creators
 *
 * List all creators with pagination and filtering.
 * Public endpoint with 5-minute cache.
 */
creatorsRouter.get(
   '/',
   createCreatorReadMetricsMiddleware('list'),
   cacheControl(
      CREATOR_PUBLIC_ROUTE_CACHE_PRESETS[CREATOR_PUBLIC_ROUTE_NAMES.LIST]
   ),
   httpListCreators
);
// 405 handler for /
creatorsRouter.all('/', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});

/**
 * GET /api/v1/creators/:id/stats
 *
 * Get public stats for a specific creator.
 * Public endpoint with 5-minute cache.
 */
creatorsRouter.get(
   '/:id/stats',
   validateCreatorParam('id'),
   createCreatorReadMetricsMiddleware('detail'),
   cacheControl(
      CREATOR_PUBLIC_ROUTE_CACHE_PRESETS[CREATOR_PUBLIC_ROUTE_NAMES.GET_STATS]
   ),
   httpGetCreatorStats
);
// 405 handler for /:id/stats
creatorsRouter.all('/:id/stats', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});

/**
 * GET /api/v1/creators/:id/holders
 *
 * Returns a paginated list of wallets that hold keys for a creator.
 * Supports ?sort=held_since to surface earliest supporters first.
 * Public endpoint with 5-minute cache.
 */
creatorsRouter.get(
   '/:id/holders',
   validateCreatorParam('id'),
   createCreatorReadMetricsMiddleware('holders'),
   cacheControl(
      CREATOR_PUBLIC_ROUTE_CACHE_PRESETS[CREATOR_PUBLIC_ROUTE_NAMES.GET_HOLDERS]
   ),
   httpGetCreatorHolders
);
// 405 handler for /:id/holders
creatorsRouter.all('/:id/holders', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});

/**
 * GET /api/v1/creators/:wallet/social
 *
 * Returns social metadata (display name, bio, avatar URL, social links)
 * synced from SocialMetadataUpdated events for the creator identified by
 * the given Stellar wallet address. Creator id / handle is accepted as a
 * fallback identifier.
 *
 * Public endpoint; HTTP cache is capped at 60 seconds so clients observe
 * social updates within the freshness budget.
 */
creatorsRouter.get(
   '/:wallet/social',
   validateCreatorParam('wallet'),
   createCreatorReadMetricsMiddleware('detail'),
   cacheControl(
      CREATOR_PUBLIC_ROUTE_CACHE_PRESETS[CREATOR_PUBLIC_ROUTE_NAMES.GET_SOCIAL]
   ),
   httpGetCreatorSocial
);
// 405 handler for /:wallet/social
creatorsRouter.all('/:wallet/social', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});

/**
 * GET /api/v1/creators/trending
 *
 * List trending creators ordered by 24h trading volume descending.
 */
creatorsRouter.get(
   '/trending',
   createCreatorReadMetricsMiddleware('list'),
   httpGetTrendingCreators
);

/**
 * GET /api/v1/creators/:id/analytics
 *
 * Returns buy volume and unique buyer count for the authenticated creator.
 * Protected route — requires wallet ownership via x-wallet-address header.
 */
creatorsRouter.get(
   '/:id/analytics',
   validateCreatorParam('id'),
   requireCreatorProfileOwnership('id'),
   httpGetCreatorAnalytics
);
// 405 handler for /:id/analytics
creatorsRouter.all('/:id/analytics', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});

/**
 * GET /api/v1/creators/leaderboard
 *
 * List creators ranked by holder count descending, tie-broken
 * alphabetically by creator address.
 */
creatorsRouter.get(
   '/leaderboard',
   createCreatorReadMetricsMiddleware('list'),
   httpGetCreatorLeaderboard
);

/**
 * GET /api/v1/creators/:id
 *
 * Get public details for a specific creator.
 * Public endpoint with 5-minute cache.
 */
creatorsRouter.get(
   '/:id',
   validateCreatorParam('id'),
   createCreatorReadMetricsMiddleware('detail'),
   cacheControl(
      CREATOR_PUBLIC_ROUTE_CACHE_PRESETS[CREATOR_PUBLIC_ROUTE_NAMES.GET_PROFILE]
   ),
   httpGetCreator
);
// 405 handler for /:id
creatorsRouter.all('/:id', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});

export default creatorsRouter;
