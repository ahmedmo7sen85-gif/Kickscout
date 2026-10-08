import type { ApiRoute } from './platform/route.js';
import { onboardingRoutes } from './modules/onboarding.js';
import { profileRoutes } from './modules/profiles.js';
import { mediaRoutes } from './modules/media.js';
import { feedRoutes } from './modules/feed.js';
import { socialRoutes } from './modules/social.js';
import { catalogRoutes } from './modules/catalog.js';
import { challengeRoutes } from './modules/challenges.js';
import { scoutRoutes } from './modules/scout.js';
import { moderationRoutes } from './modules/moderation.js';

export const routes: ApiRoute[] = [
  ...onboardingRoutes, ...profileRoutes, ...mediaRoutes, ...feedRoutes, ...socialRoutes, ...catalogRoutes,
  ...challengeRoutes, ...scoutRoutes, ...moderationRoutes,
];
