import { describe, it, expect } from 'vitest';
import { Tour, parseTours, parseTour } from './schema.js';

const validTour = {
  id: 'onboarding-v1',
  type: 'onboarding',
  steps: [
    { anchorId: 'home.welcome', title: 'Welcome!', body: 'Let us show you around.' },
    { title: 'Note', body: 'No anchor — floating step' },
  ],
};

describe('Tour schema', () => {
  it('parses a valid tour', () => {
    const t = parseTour(validTour);
    expect(t.id).toBe('onboarding-v1');
    expect(t.status).toBe('active'); // default
    expect(t.steps[0]?.placement).toBe('auto'); // default
    expect(t.conditions).toEqual([]);
  });

  it('rejects a tour with no steps', () => {
    expect(() => parseTour({ ...validTour, steps: [] })).toThrow();
  });

  it('rejects unknown condition kind', () => {
    expect(() =>
      parseTour({ ...validTour, conditions: [{ kind: 'unknown', value: true }] }),
    ).toThrow();
  });

  it('parseTours filters invalid entries and logs a warning', () => {
    const tours = parseTours([validTour, { id: 'bad', steps: [] }]);
    expect(tours).toHaveLength(1);
    expect(tours[0]?.id).toBe('onboarding-v1');
  });

  it('parses conditions correctly', () => {
    const t = parseTour({
      ...validTour,
      conditions: [
        { kind: 'route', match: '/home' },
        { kind: 'version', range: '>=5.0.0' },
        { kind: 'seen', tourId: 'other', value: false },
      ],
    });
    expect(t.conditions).toHaveLength(3);
  });

  it('parses prepare paths', () => {
    const t = parseTour({
      ...validTour,
      steps: [
        {
          anchorId: 'topstories.deepdive.tab',
          title: 'Deep Dive',
          body: 'Click here.',
          prepare: [
            { action: 'click', anchorId: 'topstories.story-card' },
            { action: 'wait', anchorId: 'topstories.deepdive.tab', timeoutMs: 2000 },
          ],
        },
      ],
    });
    expect(t.steps[0]?.prepare).toHaveLength(2);
  });
});
