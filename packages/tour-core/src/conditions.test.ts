import { describe, it, expect } from 'vitest';
import { evaluateCondition, isTourEligible, type RuntimeContext } from './conditions.js';
import type { Tour } from './schema.js';

const baseCtx: RuntimeContext = {
  route: '/home',
  role: 'admin',
  appVersion: '5.32.8',
  flags: { newDashboard: true },
  seenTours: new Set(['onboarding-v1']),
};

describe('evaluateCondition', () => {
  it('route: matches regex', () => {
    expect(evaluateCondition({ kind: 'route', match: '^/home' }, baseCtx)).toBe(true);
    expect(evaluateCondition({ kind: 'route', match: '^/dashboard' }, baseCtx)).toBe(false);
  });

  it('role: checks inclusion', () => {
    expect(evaluateCondition({ kind: 'role', in: ['admin', 'editor'] }, baseCtx)).toBe(true);
    expect(evaluateCondition({ kind: 'role', in: ['viewer'] }, baseCtx)).toBe(false);
  });

  it('role: returns false when no role in context', () => {
    const { role: _r, ...rest } = baseCtx;
    const ctx: RuntimeContext = rest;
    expect(evaluateCondition({ kind: 'role', in: ['admin'] }, ctx)).toBe(false);
  });

  it('version: semver range', () => {
    expect(evaluateCondition({ kind: 'version', range: '>=5.0.0' }, baseCtx)).toBe(true);
    expect(evaluateCondition({ kind: 'version', range: '<5.0.0' }, baseCtx)).toBe(false);
    expect(evaluateCondition({ kind: 'version', range: '~5.32.0' }, baseCtx)).toBe(true);
  });

  it('flag: matches boolean', () => {
    expect(evaluateCondition({ kind: 'flag', key: 'newDashboard', on: true }, baseCtx)).toBe(true);
    expect(evaluateCondition({ kind: 'flag', key: 'newDashboard', on: false }, baseCtx)).toBe(false);
    expect(evaluateCondition({ kind: 'flag', key: 'missing', on: false }, baseCtx)).toBe(true);
  });

  it('seen: checks presence in seenTours', () => {
    expect(evaluateCondition({ kind: 'seen', tourId: 'onboarding-v1', value: true }, baseCtx)).toBe(true);
    expect(evaluateCondition({ kind: 'seen', tourId: 'onboarding-v1', value: false }, baseCtx)).toBe(false);
    expect(evaluateCondition({ kind: 'seen', tourId: 'unknown', value: false }, baseCtx)).toBe(true);
  });

  it('custom: calls predicate', () => {
    const ctx: RuntimeContext = {
      ...baseCtx,
      customPredicates: { isWeekend: () => false, myPred: () => true },
    };
    expect(evaluateCondition({ kind: 'custom', predicateId: 'myPred' }, ctx)).toBe(true);
    expect(evaluateCondition({ kind: 'custom', predicateId: 'isWeekend' }, ctx)).toBe(false);
    expect(evaluateCondition({ kind: 'custom', predicateId: 'missing' }, ctx)).toBe(false);
  });
});

describe('isTourEligible', () => {
  const baseTour: Tour = {
    id: 'test-tour',
    type: 'release',
    status: 'active',
    conditions: [],
    steps: [{ title: 'Hello', body: 'World', placement: 'auto' }],
  };

  it('returns true for active tour with no conditions', () => {
    expect(isTourEligible(baseTour, baseCtx)).toBe(true);
  });

  it('returns false for non-active status', () => {
    expect(isTourEligible({ ...baseTour, status: 'deprecated' }, baseCtx)).toBe(false);
    expect(isTourEligible({ ...baseTour, status: 'archived' }, baseCtx)).toBe(false);
  });

  it('returns false when any condition fails', () => {
    const tour: Tour = {
      ...baseTour,
      conditions: [
        { kind: 'route', match: '^/home' },
        { kind: 'role', in: ['viewer'] },
      ],
    };
    expect(isTourEligible(tour, baseCtx)).toBe(false);
  });

  it('returns true when all conditions pass', () => {
    const tour: Tour = {
      ...baseTour,
      conditions: [
        { kind: 'route', match: '^/home' },
        { kind: 'version', range: '>=5.0.0' },
      ],
    };
    expect(isTourEligible(tour, baseCtx)).toBe(true);
  });
});
