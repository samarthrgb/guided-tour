import { driver } from 'driver.js';
import type { DriveStep } from 'driver.js';
import type { Tour, Step, ThemeOverrides } from './schema.js';
import { resolveAnchor, waitForAnchor, type AnchorMetaMap } from './resolver.js';
import { decodeLocator, waitForLocator } from './locator.js';
import { emit } from './telemetry.js';

export interface PlayerOptions {
  tour: Tour;
  anchorMeta?: AnchorMetaMap;
  theme?: ThemeOverrides;
  onComplete?: () => void;
  onSkip?: (stepIndex: number) => void;
  /** Fired with the 0-based index of each step as it's shown. */
  onStepChange?: (stepIndex: number) => void;
  /** No step could be shown (all anchored targets missing). The caller should
   *  NOT mark the tour seen so it can show once the UI is fixed. */
  onUnavailable?: (missingAnchors: string[]) => void;
  navigate?: (route: string) => void | Promise<void>;
  waitForElement?: (selector: string, timeoutMs?: number) => Promise<Element | null>;
}

function waitMs(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function runPrepare(
  step: Step,
  anchorMeta: AnchorMetaMap,
  navigate: PlayerOptions['navigate'],
  waitForElement: PlayerOptions['waitForElement'],
): Promise<void> {
  if (!step.prepare?.length) return;

  for (const action of step.prepare) {
    if (action.action === 'navigate') {
      if (navigate) await navigate(action.route);
      // Give React time to commit the new route before continuing
      await waitMs(300);
    } else if (action.action === 'click') {
      const el = resolveAnchor(action.anchorId, anchorMeta);
      if (el) (el as HTMLElement).click();
      await waitMs(150);
    } else if (action.action === 'wait') {
      if (action.anchorId && waitForElement) {
        const selector = `[data-tour="${CSS.escape(action.anchorId)}"]`;
        await waitForElement(selector, action.timeoutMs);
      } else {
        await waitMs(action.timeoutMs ?? 300);
      }
    }
  }
}

// The full polished stylesheet is static and driven by CSS variables with good
// defaults; a tour/provider theme only overrides the variables it sets. This is
// injected once (idempotent) so even an un-themed tour looks modern out of the box.
// Note: backdrop-filter: blur() is intentionally excluded — it blurs the cutout too.
const TOUR_STYLESHEET = `
.driver-popover {
  background: var(--tour-bg, #ffffff);
  color: var(--tour-text, #0f172a);
  font-family: var(--tour-font, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);
  border-radius: var(--tour-radius, 14px);
  border: 1px solid var(--tour-border, rgba(15,23,42,0.08));
  box-shadow: var(--tour-shadow, 0 16px 40px rgba(2,6,23,0.28), 0 2px 8px rgba(2,6,23,0.12));
  padding: 18px 18px 14px;
  max-width: 340px;
  animation: tour-pop-in 0.24s cubic-bezier(0.16, 1, 0.3, 1) both;
}
.driver-popover-title {
  font-size: 15px; font-weight: 650; line-height: 1.35;
  color: var(--tour-text, #0f172a); margin: 0 0 6px;
}
.driver-popover-description {
  font-size: 13px; line-height: 1.55;
  color: var(--tour-muted, #64748b); margin: 0;
}
.driver-popover-progress-text {
  font-size: 11px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase;
  color: var(--tour-muted, #94a3b8);
}
.driver-popover-footer { margin-top: 16px; gap: 8px; }
.driver-popover-footer button {
  font-family: inherit; font-size: 12.5px; font-weight: 600;
  padding: 7px 14px; border-radius: calc(var(--tour-radius, 14px) * 0.55);
  cursor: pointer; text-shadow: none;
  transition: background 0.15s ease, box-shadow 0.15s ease, filter 0.15s ease, transform 0.06s ease;
}
.driver-popover-footer button:active { transform: translateY(0.5px); }
.driver-popover-footer button:focus-visible {
  outline: 2px solid var(--tour-primary, #6366f1); outline-offset: 2px;
}
.driver-popover-next-btn, .driver-popover-done-btn {
  background: var(--tour-primary, #6366f1);
  color: var(--tour-primary-text, #ffffff);
  border: 1px solid var(--tour-primary, #6366f1);
}
.driver-popover-next-btn:hover, .driver-popover-done-btn:hover {
  filter: brightness(1.08);
}
.driver-popover-prev-btn {
  background: transparent; color: var(--tour-muted, #64748b);
  border: 1px solid var(--tour-border, rgba(100,116,139,0.30));
}
.driver-popover-prev-btn:hover { background: var(--tour-hover, rgba(15,23,42,0.05)); }
.driver-popover-close-btn {
  color: var(--tour-muted, #94a3b8);
  transition: color 0.15s ease, transform 0.15s ease;
}
.driver-popover-close-btn:hover { color: var(--tour-text, #0f172a); transform: scale(1.12); }
.driver-popover-arrow-side-left.driver-popover-arrow { border-left-color: var(--tour-bg, #ffffff); }
.driver-popover-arrow-side-right.driver-popover-arrow { border-right-color: var(--tour-bg, #ffffff); }
.driver-popover-arrow-side-top.driver-popover-arrow { border-top-color: var(--tour-bg, #ffffff); }
.driver-popover-arrow-side-bottom.driver-popover-arrow { border-bottom-color: var(--tour-bg, #ffffff); }
@keyframes tour-pop-in { from { opacity: 0; transform: translateY(6px) scale(0.98); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .driver-popover { animation: none; } }
`;

function injectThemeStyle(theme: ThemeOverrides): void {
  let el = document.getElementById('__tour-theme__');
  if (!el) {
    el = document.createElement('style');
    el.id = '__tour-theme__';
    document.head.appendChild(el);
  }

  // Only the variables the theme overrides are emitted; everything else uses the
  // built-in defaults baked into TOUR_STYLESHEET via var() fallbacks.
  const vars: string[] = [];
  if (theme.popoverBg) vars.push(`--tour-bg:${theme.popoverBg}`);
  if (theme.textColor) vars.push(`--tour-text:${theme.textColor}`);
  if (theme.mutedColor) vars.push(`--tour-muted:${theme.mutedColor}`);
  if (theme.primaryColor) vars.push(`--tour-primary:${theme.primaryColor}`);
  if (theme.primaryTextColor) vars.push(`--tour-primary-text:${theme.primaryTextColor}`);
  if (theme.borderRadius) vars.push(`--tour-radius:${theme.borderRadius}`);
  if (theme.fontFamily) vars.push(`--tour-font:${theme.fontFamily}`);
  if (theme.shadow) vars.push(`--tour-shadow:${theme.shadow}`);

  el.textContent = `${vars.length ? `:root{${vars.join(';')}}` : ''}\n${TOUR_STYLESHEET}`;
}

// ─── Step rendering ─────────────────────────────────────────────────────────
// One driver.js instance is reused for the whole tour (see playTour). Calling
// highlight() on the same instance per step makes driver.js *animate* the
// spotlight sliding/scrolling from one element to the next, instead of the
// overlay vanishing and rebuilding (which a new instance per step would cause).

type StepAction = 'next' | 'skip';

function buildPopover(
  step: Step,
  stepNumber: number,
  totalVisible: number,
  isLast: boolean,
): NonNullable<DriveStep['popover']> {
  type Side = 'top' | 'bottom' | 'left' | 'right';
  const side: Side | undefined =
    step.placement === 'auto' ? undefined : (step.placement as Side);

  return {
    title: step.title,
    description: step.body,
    showButtons: ['next', 'close'],
    showProgress: true,
    progressText: `${stepNumber} of ${totalVisible}`,
    ...(isLast ? { nextBtnText: 'Done' } : {}),
    ...(side ? { side } : {}),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function playTour(opts: PlayerOptions): Promise<void> {
  const { tour, anchorMeta = {}, theme, onComplete, onSkip, onStepChange, onUnavailable, navigate, waitForElement } = opts;

  // Always inject — the stylesheet carries the polished defaults, and any theme
  // (provider theme < tour.theme) just overrides the CSS variables it sets.
  const mergedTheme: ThemeOverrides = { ...theme, ...(tour.theme ?? {}) };
  injectThemeStyle(mergedTheme);

  emit({ type: 'tour.started', tourId: tour.id });

  // Count displayable steps upfront for the progress indicator.
  // Floating steps (no anchorId) always count; anchored steps count even if
  // the element isn't in DOM yet — we'll wait for it below.
  const totalVisible = tour.steps.length;
  let stepNumber = 0;
  let shownCount = 0;                 // steps actually displayed
  const missingAnchors: string[] = []; // anchored steps whose target never resolved

  // ── One persistent driver instance for the whole tour ──────────────────────
  // Reusing it lets driver.js animate the spotlight gliding between elements (and
  // smooth-scroll them into view) — the "shifting focus" feel — instead of the
  // overlay disappearing and popping back for each step.
  let currentResolve: ((a: StepAction) => void) | null = null;
  let torn = false;
  const settle = (action: StepAction) => {
    const resolve = currentResolve;
    currentResolve = null;
    resolve?.(action);
  };
  const teardown = () => {
    if (torn) return;
    torn = true;
    driverObj.destroy();
  };

  const driverObj = driver({
    allowClose: true,
    overlayColor: mergedTheme.overlayColor ?? '#0b1220',
    overlayOpacity: mergedTheme.overlayOpacity ?? 0.55,
    stagePadding: mergedTheme.stagePadding ?? 8,
    stageRadius: mergedTheme.stageRadius ?? 8,
    animate: mergedTheme.animate ?? true,
    smoothScroll: true,
    ...(mergedTheme.popoverClass ? { popoverClass: mergedTheme.popoverClass } : {}),

    // Manual mode (hooks defined): the buttons do only what these say, so we
    // drive step transitions ourselves via highlight() — keeping one instance.
    // Next does NOT destroy; we just resolve and the loop highlights the next
    // step on the same instance (the animated move). Close/esc tear down.
    onNextClick: () => settle('next'),
    onCloseClick: () => settle('skip'),
    onDestroyStarted: () => { settle('skip'); teardown(); },
  });

  const waitForAction = () => new Promise<StepAction>(resolve => { currentResolve = resolve; });

  for (let i = 0; i < tour.steps.length; i++) {
    const step = tour.steps[i];
    if (!step) continue;

    // ── 1. Run this step's prepare path (navigate + click + wait) ──────────
    // This runs just before the step is shown, NOT at tour start.
    // Navigations actually fire here, in the right sequence.
    await runPrepare(step, anchorMeta, navigate, waitForElement);

    // ── 2. Wait for the anchor element to appear in the DOM ────────────────
    // Only wait the full timeout when this step navigated (new route renders
    // async); otherwise a short wait, so a missing anchor doesn't hang for 5s.
    const locator = step.anchorId ? decodeLocator(step.anchorId) : null;
    if (step.anchorId) {
      const hadNav = step.prepare?.some(a => a.action === 'navigate') ?? false;
      const timeout = hadNav ? 5000 : 1500;
      if (locator) {
        // Encoded multi-signal locator — wait for it to resolve (signals/heal).
        await waitForLocator(locator, timeout);
      } else if (waitForElement) {
        await waitForElement(`[data-tour="${CSS.escape(step.anchorId)}"]`, timeout);
      } else {
        await waitForAnchor(step.anchorId, timeout);
      }
    }

    // ── 3. Resolve element ────────────────────────────────────────────────
    let element: Element | undefined;
    if (step.anchorId) {
      const el = resolveAnchor(step.anchorId, anchorMeta, tour.id, i);
      if (!el) {
        // Target missing — skip this step but keep the tour going. Telemetry
        // (anchor.broken) already emitted by resolveAnchor.
        missingAnchors.push(step.anchorId);
        continue;
      }
      element = el;
      // No manual scroll/settle here — driver.js (smoothScroll) scrolls the
      // element into view and animates the stage as part of highlight().
    }

    stepNumber++;
    const isLast = i === tour.steps.length - 1;

    // ── 4. Emit telemetry + notify step change ─────────────────────────────
    onStepChange?.(i);
    const viewedEvent = step.anchorId
      ? { type: 'step.viewed' as const, tourId: tour.id, stepIndex: i, anchorId: step.anchorId }
      : { type: 'step.viewed' as const, tourId: tour.id, stepIndex: i };
    emit(viewedEvent);

    // ── 5. Move the spotlight to this step (animated) and wait for action ──
    driverObj.highlight({
      ...(element ? { element } : {}),
      popover: buildPopover(step, stepNumber, totalVisible, isLast),
    });
    shownCount++;

    const action = await waitForAction();

    if (action === 'skip') {
      emit({ type: 'tour.skipped', tourId: tour.id, stepIndex: i });
      teardown();
      onSkip?.(i);
      return;
    }
    if (isLast) {
      emit({ type: 'tour.completed', tourId: tour.id });
      teardown();
      onComplete?.();
      return;
    }
    // action === 'next' — loop continues; the next highlight() animates the move
  }

  // Loop finished without the user skipping/completing mid-way.
  teardown();
  if (shownCount === 0) {
    // Every anchored step's target was missing — nothing was shown. Do NOT
    // complete or mark seen; surface it so it can show once the UI is fixed.
    emit({ type: 'tour.unavailable', tourId: tour.id, missingAnchors });
    onUnavailable?.(missingAnchors);
    return;
  }

  emit({ type: 'tour.completed', tourId: tour.id });
  onComplete?.();
}
