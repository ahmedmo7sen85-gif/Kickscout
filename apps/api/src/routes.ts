import type { ApiRoute } from './platform/route.js';
import { onboardingRoutes } from './modules/onboarding.js';
import { profileRoutes } from './modules/profiles.js';
import { mediaRoutes } from './modules/media.js';
import { feedRoutes } from './modules/feed.js';
import { socialRoutes } from './modules/social.js';
import { analysisRoutes } from './modules/analysis.js';
import { intelligenceRoutes } from './modules/intelligence.js';

export const routes: ApiRoute[] = [
  ...onboardingRoutes, ...profileRoutes, ...mediaRoutes, ...feedRoutes, ...socialRoutes, ...analysisRoutes, ...intelligenceRoutes,
];
