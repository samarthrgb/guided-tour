import { emit } from './telemetry.js';
import { decodeLocator, resolveLocator } from './locator.js';

export interface AnchorMeta {
  testid?: string;
  role?: string;
  name?: string;
}

export type AnchorMetaMap = Record<string, AnchorMeta>;

/**
 * Resolve a step's target from its `anchorId`.
 *
 * `anchorId` carries one of two things (no schema change — the field is reused):
 *   - an encoded multi-signal locator (`loc:<json>`) → resolved via signals +
 *     signature, with self-heal and rot detection (the modern path), or
 *   - a plain string → treated as a legacy `data-tour` selector.
 *
 * Emits telemetry: `anchor.healed` (recovered via signature), `anchor.mismatch`
 * (resolved the wrong element — skipped), `anchor.broken` (nothing found).
 */
export function resolveAnchor(
  anchorId: string,
  metaMap: AnchorMetaMap = {},
  tourId = '',
  stepIndex = 0,
): Element | null {
  // ── Modern path: encoded locator + signature ──────────────────────────────
  const locator = decodeLocator(anchorId);
  if (locator) {
    const { el, status } = resolveLocator(locator);
    if (status === 'healed') emit({ type: 'anchor.healed', anchorId, tourId, stepIndex });
    if (status === 'mismatch') emit({ type: 'anchor.mismatch', anchorId, tourId, stepIndex });
    if (!el) {
      if (status !== 'mismatch') emit({ type: 'anchor.broken', anchorId, tourId, stepIndex });
      return null;
    }
    return el;
  }

  // ── Legacy path: plain data-tour selector (+ registry metadata fallbacks) ──
  const escaped = CSS.escape(anchorId);
  const primary = document.querySelector(`[data-tour="${escaped}"]`);
  if (primary) return primary;

  const meta = metaMap[anchorId];
  if (meta?.testid) {
    const v = CSS.escape(meta.testid);
    const el = document.querySelector(`[data-testid="${v}"],[data-test="${v}"]`);
    if (el) {
      emit({ type: 'anchor.fallback', anchorId, strategy: 'testid' });
      return el;
    }
  }
  if (meta?.role && meta?.name) {
    const candidates = document.querySelectorAll(`[role="${meta.role}"]`);
    for (const el of Array.from(candidates)) {
      const label =
        el.getAttribute('aria-label') ??
        el.getAttribute('aria-labelledby') ??
        el.textContent?.trim();
      if (label === meta.name) {
        emit({ type: 'anchor.fallback', anchorId, strategy: 'role' });
        return el;
      }
    }
  }

  emit({ type: 'anchor.broken', anchorId, tourId, stepIndex });
  return null;
}

export function waitForAnchor(anchorId: string, timeoutMs = 5000): Promise<Element | null> {
  return new Promise(resolve => {
    const escaped = CSS.escape(anchorId);
    const existing = document.querySelector(`[data-tour="${escaped}"]`);
    if (existing) {
      resolve(existing);
      return;
    }
    const observer = new MutationObserver(() => {
      const el = document.querySelector(`[data-tour="${escaped}"]`);
      if (el) {
        observer.disconnect();
        clearTimeout(timer);
        resolve(el);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    const timer = setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeoutMs);
  });
}
