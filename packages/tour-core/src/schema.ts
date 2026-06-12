import { z } from 'zod';

export const Condition = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('route'), match: z.string() }),
  z.object({ kind: z.literal('role'), in: z.array(z.string()) }),
  z.object({ kind: z.literal('version'), range: z.string() }),
  z.object({ kind: z.literal('flag'), key: z.string(), on: z.boolean() }),
  z.object({ kind: z.literal('seen'), tourId: z.string(), value: z.boolean() }),
  z.object({ kind: z.literal('custom'), predicateId: z.string() }),
]);

export const InteractionAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('click'), anchorId: z.string() }),
  z.object({
    action: z.literal('navigate'),
    route: z.string(),
  }),
  z.object({
    action: z.literal('wait'),
    anchorId: z.string().optional(),
    timeoutMs: z.number().optional(),
  }),
]);

export const Step = z.object({
  anchorId: z.string().optional(),
  title: z.string(),
  body: z.string(),
  placement: z.enum(['top', 'bottom', 'left', 'right', 'auto']).default('auto'),
  prepare: z.array(InteractionAction).optional(),
});

export const ThemeOverrides = z.object({
  // Overlay (the dimmed backdrop with the spotlight cutout)
  overlayColor: z.string().optional(),
  overlayOpacity: z.number().min(0).max(1).optional(),
  // Popover surface
  popoverBg: z.string().optional(),       // popover background
  textColor: z.string().optional(),       // title / primary text
  mutedColor: z.string().optional(),      // description, progress, secondary text
  primaryColor: z.string().optional(),    // accent: primary buttons, highlights
  primaryTextColor: z.string().optional(),// text on primary buttons (default #fff)
  borderRadius: z.string().optional(),    // popover radius (buttons derive from it)
  fontFamily: z.string().optional(),
  shadow: z.string().optional(),          // popover box-shadow
  // Spotlight cutout shaping (driver.js stage)
  stagePadding: z.number().optional(),    // px of breathing room around the target
  stageRadius: z.number().optional(),     // px corner radius of the cutout
  animate: z.boolean().optional(),        // stage move animation (default true)
  popoverClass: z.string().optional(),    // extra class for deep custom overrides
});

export const Tour = z.object({
  id: z.string().min(1),
  title: z.string().nullish(),
  type: z.enum(['onboarding', 'release']),
  version: z.string().nullish(),
  status: z.enum(['active', 'deprecated', 'archived']).default('active'),
  conditions: z.array(Condition).default([]),
  theme: ThemeOverrides.nullish(),
  steps: z.array(Step).min(1),
  // Per-user annotations computed by the backend on GET (keyed off the
  // userId the frontend passes). Not authored — read-only at runtime.
  //   seen     — this user has already completed or dismissed the tour
  //   autoplay — backend designates exactly one tour to auto-start: the
  //              newest (by created_at) active, unseen release tour
  seen: z.boolean().nullish().transform(v => v ?? false),
  autoplay: z.boolean().nullish().transform(v => v ?? false),
});

export type Condition = z.infer<typeof Condition>;
export type InteractionAction = z.infer<typeof InteractionAction>;
export type Step = z.infer<typeof Step>;
export type ThemeOverrides = z.infer<typeof ThemeOverrides>;
export type Tour = z.infer<typeof Tour>;

export function parseTour(raw: unknown): Tour {
  return Tour.parse(raw);
}

export function parseTours(raw: unknown[]): Tour[] {
  return raw.flatMap(item => {
    const result = Tour.safeParse(item);
    if (!result.success) {
      console.warn('[tour] invalid tour definition:', result.error.issues, item);
      return [];
    }
    return [result.data];
  });
}
