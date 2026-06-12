import { satisfies as semverSatisfies, valid as semverValid } from 'semver';
import type { Condition, Tour } from './schema.js';

export interface RuntimeContext {
  route: string;
  role?: string;
  appVersion: string;
  flags: Record<string, boolean>;
  seenTours: Set<string>;
  customPredicates?: Record<string, () => boolean>;
}

export function evaluateCondition(condition: Condition, ctx: RuntimeContext): boolean {
  switch (condition.kind) {
    case 'route': {
      try {
        return new RegExp(condition.match).test(ctx.route);
      } catch {
        return ctx.route.includes(condition.match);
      }
    }
    case 'role':
      return ctx.role != null && condition.in.includes(ctx.role);
    case 'version': {
      if (!semverValid(ctx.appVersion)) {
        console.warn(`[tour] invalid semver for appVersion: "${ctx.appVersion}"`);
        return false;
      }
      return semverSatisfies(ctx.appVersion, condition.range);
    }
    case 'flag':
      return (ctx.flags[condition.key] ?? false) === condition.on;
    case 'seen':
      return ctx.seenTours.has(condition.tourId) === condition.value;
    case 'custom':
      return ctx.customPredicates?.[condition.predicateId]?.() ?? false;
  }
}

export function isTourEligible(tour: Tour, ctx: RuntimeContext): boolean {
  if (tour.status !== 'active') return false;
  return tour.conditions.every(c => evaluateCondition(c, ctx));
}
