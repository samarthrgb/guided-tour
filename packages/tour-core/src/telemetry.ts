export type TourEvent =
  | { type: 'tour.started'; tourId: string }
  | { type: 'tour.completed'; tourId: string }
  | { type: 'tour.skipped'; tourId: string; stepIndex: number }
  // No step could be shown — every anchored step's target was missing. The tour
  // is NOT marked seen, so it can show once the UI/anchors are fixed.
  | { type: 'tour.unavailable'; tourId: string; missingAnchors: string[] }
  | { type: 'step.viewed'; tourId: string; stepIndex: number; anchorId?: string }
  | { type: 'anchor.fallback'; anchorId: string; strategy: 'testid' | 'role' | 'xpath' }
  // Locator self-healed to a unique element matching the signature (drift recovered).
  | { type: 'anchor.healed'; anchorId: string; tourId: string; stepIndex: number }
  // A signal resolved an element whose signature no longer matches (wrong element) — step skipped.
  | { type: 'anchor.mismatch'; anchorId: string; tourId: string; stepIndex: number }
  | { type: 'anchor.broken'; anchorId: string; tourId: string; stepIndex: number };

export type TelemetryHandler = (event: TourEvent) => void;

/** Tour id used for in-authoring preview plays. Hosts should ignore telemetry
 *  with this id (it isn't a real, persisted tour) — e.g. skip health reporting. */
export const PREVIEW_TOUR_ID = '__tour_preview__';

let _handler: TelemetryHandler = () => {};

export function setTelemetryHandler(fn: TelemetryHandler): void {
  _handler = fn;
}

export function emit(event: TourEvent): void {
  try {
    _handler(event);
  } catch {
    // telemetry errors must never crash tours
  }
}
