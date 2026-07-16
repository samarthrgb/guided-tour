import type { Tour, Step } from '@guided-tour-s4marth/core';

export interface RecorderStep {
  anchorId?: string;
  title: string;
  body: string;
  placement: Step['placement'];
  interactionPath?: Step['prepare'];
  // Interactive step authoring (see player advance/gate semantics).
  advance?: Step['advance'];
  gate?: Step['gate'];
  allowSkip?: boolean;
  // Centered-card image (modal slide / fallback) + alt text for a missing target.
  image?: string;
  fallbackBody?: string;
}

export interface RecorderGap {
  suggestedId: string;
  sourceFile?: string;
  sourceLine?: number;
  componentName?: string;
  /** Lowercase host tag of the clicked element (e.g. "button") — helps the
   *  codemod find the right element when the source line is approximate. */
  tagName?: string;
}

export interface RecorderExport {
  // `seen`/`autoplay` are computed per-user by the backend on GET, not authored
  // here. `status` is optional so the backend can default it to 'active'.
  draft: Omit<Tour, 'status' | 'seen' | 'autoplay'> & { status?: Tour['status'] };
  gaps: RecorderGap[];
}

export function exportRecording(
  tourId: string,
  tourType: Tour['type'],
  version: string | undefined,
  steps: RecorderStep[],
  gaps: RecorderGap[],
): RecorderExport {
  const draftSteps: Step[] = steps.map(s => ({
    anchorId: s.anchorId,
    title: s.title,
    body: s.body,
    placement: s.placement ?? 'auto',
    prepare: s.interactionPath?.length ? s.interactionPath : undefined,
    advance: s.advance,
    gate: s.gate,
    allowSkip: s.allowSkip,
    image: s.image,
    fallbackBody: s.fallbackBody,
  }));

  return {
    draft: {
      id: tourId,
      // The author-entered name is the tour's title AND the grouping key the
      // consumer uses (e.g. "v4.14" for a release, "v4.14-feature" for a feature
      // tour under it). The library stays agnostic — it just carries the title.
      title: tourId,
      type: tourType,
      version,
      conditions: [],
      steps: draftSteps,
    },
    gaps,
  };
}
