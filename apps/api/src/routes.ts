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
import { guardianRoutes } from './modules/guardian.js';
import { accountRoutes } from './modules/account.js';
import { copyrightRoutes } from './modules/copyright.js';
import { orgRoutes } from './modules/orgs.js';
import { crmRoutes } from './modules/crm.js';
import { billingRoutes } from './modules/billing.js';
import { recommendationRoutes } from './modules/recommendations.js';
import { aiAdminRoutes } from './modules/ai-admin.js';
import { analyticsRoutes } from './modules/analytics.js';
import { flagRoutes } from './modules/flags.js';
import { opsRoutes } from './modules/ops.js';

export const routes: ApiRoute[] = [
  ...onboardingRoutes, ...profileRoutes, ...mediaRoutes, ...feedRoutes, ...socialRoutes, ...catalogRoutes,
  ...challengeRoutes, ...scoutRoutes, ...moderationRoutes, ...guardianRoutes, ...accountRoutes, ...copyrightRoutes,
  ...orgRoutes, ...crmRoutes, ...billingRoutes, ...recommendationRoutes, ...aiAdminRoutes, ...analyticsRoutes, ...flagRoutes, ...opsRoutes,
];
