import { driver } from 'driver.js';
import type { DriveStep } from 'driver.js';
import type { Tour, Step, ThemeOverrides } from './schema.js';
import { resolveAnchor, waitForAnchor, type AnchorMetaMap } from './resolver.js';
import { decodeLocator, resolveLocator, resolveXPath, waitForLocator, type TourLocator } from './locator.js';
import { showInteractiveStep, teardownInteractiveOverlay, repointInteractiveOverlay } from './interactive.js';
import { emit } from './telemetry.js';

// Resolve a step's target RIGHT NOW without emitting telemetry — used to check if
// it's already rendered (so we can show instantly instead of waiting).
function resolveNow(anchorId: string): Element | null {
  const loc = decodeLocator(anchorId);
  if (loc) return resolveLocator(loc).el;
  try {
    return document.querySelector(`[data-tour="${CSS.escape(anchorId)}"]`);
  } catch {
    return null;
  }
}

// When a target isn't rendered yet (its section is still loading), walk UP its
// xpath to the nearest ancestor that IS present — so the tour can point at that
// section ("data is coming here") and snap to the exact element once it loads.
function nearestRenderedAncestor(xpath: string): Element | null {
  let parts = xpath.split('/');
  for (let i = 0; i < 6 && parts.length > 1; i++) {
    parts = parts.slice(0, -1);
    const candidate = parts.join('/');
    if (!candidate || candidate === '/' || candidate === '//') break;
    const el = resolveXPath(candidate);
    if (el) {
      const tag = el.tagName.toLowerCase();
      return tag === 'body' || tag === 'html' ? null : el; // too broad to be a "section"
    }
  }
  return null;
}

// An element can be in the DOM but not yet "laid out": zero-size box, display:none,
// visibility:hidden, or mid-load/animation. Showing a step on it would place the
// spotlight/tooltip at the top-left corner (rect is {0,0,0,0}), so we must wait.
function isLaidOut(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width <= 1 || r.height <= 1) return false;
  const cs = window.getComputedStyle(el as HTMLElement);
  return cs.visibility !== 'hidden' && cs.display !== 'none';
}

// Resolve once the element actually has a visible box (or time out). Uses a
// ResizeObserver for instant reaction plus a slow interval as a backstop (a
// display:none → block flip doesn't always fire ResizeObserver).
function waitForVisible(el: Element, timeoutMs: number): Promise<boolean> {
  if (isLaidOut(el)) return Promise.resolve(true);
  return new Promise<boolean>(resolve => {
    let done = false;
    let ro: ResizeObserver | null = null;
    const tick = () => { if (isLaidOut(el)) finish(true); };
    const iv = setInterval(tick, 100);
    const to = setTimeout(() => finish(false), timeoutMs);
    function finish(v: boolean): void {
      if (done) return;
      done = true;
      try { ro?.disconnect(); } catch { /* ignore */ }
      clearInterval(iv);
      clearTimeout(to);
      resolve(v);
    }
    try { ro = new ResizeObserver(tick); ro.observe(el); } catch { /* ignore */ }
    tick();
  });
}

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
  /** Restore the app mode/context the tour was recorded in (e.g. experience) BEFORE
   *  it plays. The host owns the semantics; the library just passes tour.context.
   *  Should be idempotent and may return a Promise (e.g. to await a transition). */
  applyContext?: (context: Record<string, unknown>) => void | Promise<void>;
}

function waitMs(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function runPrepare(
  step: Step,
  anchorMeta: AnchorMetaMap,
  waitForElement: PlayerOptions['waitForElement'],
): Promise<void> {
  if (!step.prepare?.length) return;

  for (const action of step.prepare) {
    if (action.action === 'navigate') {
      // Navigation is handled centrally (ensureRoute) so Back can also return to
      // the right page; skip it here to avoid a redundant double-navigate.
      continue;
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
  padding-right: 56px; /* clear the top-right counter + close icon */
}
.driver-popover-description {
  font-size: 13px; line-height: 1.55;
  color: var(--tour-muted, #64748b); margin: 0;
}
/* Fallback / slide image: skeleton reserves space + shimmers until the image
   decodes; the image fades in on load (onPopoverRender toggles .is-loaded). */
.driver-popover .tour-img-wrap {
  position: relative; width: 100%; min-height: 140px; max-height: 320px;
  margin: 0 0 10px; border-radius: 8px; overflow: hidden;
}
.driver-popover .tour-img-skel {
  position: absolute; inset: 0;
  background: linear-gradient(100deg, rgba(148,163,184,0.12) 30%, rgba(148,163,184,0.28) 50%, rgba(148,163,184,0.12) 70%);
  background-size: 200% 100%; animation: tour-img-shimmer 1.2s ease-in-out infinite;
}
.driver-popover .tour-img {
  display: block; width: 100%; max-height: 320px; object-fit: contain;
  border-radius: 8px; opacity: 0; transition: opacity 0.2s ease;
}
.driver-popover .tour-img-wrap.is-loaded { min-height: 0; }
.driver-popover .tour-img-wrap.is-loaded .tour-img-skel { display: none; }
.driver-popover .tour-img-wrap.is-loaded .tour-img { opacity: 1; }
@keyframes tour-img-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
/* Counter + ✕ on the SAME top line (small + quiet). The .driver-popover prefix
   raises specificity so these beat driver.js's own (later-injected) defaults. */
.driver-popover .driver-popover-close-btn {
  top: 14px; right: 7px; padding: 0;
  color: var(--tour-muted, #94a3b8); transition: color 0.15s ease;
}
.driver-popover .driver-popover-close-btn:hover { color: var(--tour-text, #0f172a); }
.driver-popover .driver-popover-progress-text {
  position: absolute; top: 20px; right: 42px; margin: 0;
  font-size: 10px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--tour-muted, #94a3b8);
}
.driver-popover .driver-popover-footer { margin-top: 18px; gap: 4px; }
.driver-popover .driver-popover-footer button {
  font-family: inherit; font-size: 11.5px; font-weight: 600; line-height: 1.35;
  border-radius: calc(var(--tour-radius, 14px) * 0.5);
  cursor: pointer; text-shadow: none;
  transition: background 0.15s ease, filter 0.15s ease, transform 0.06s ease;
}
.driver-popover .driver-popover-footer button:active { transform: translateY(0.5px); }
.driver-popover .driver-popover-footer button:focus-visible {
  outline: 2px solid var(--tour-primary, #6366f1); outline-offset: 2px;
}
/* Next — light/white surface button (stands out on the dark popover; no shift on hover). */
.driver-popover .driver-popover-next-btn, .driver-popover .driver-popover-done-btn {
  background: var(--tour-next-bg, #ffffff); color: var(--tour-next-text, #0f172a);
  border: 1px solid var(--tour-next-bg, #ffffff);
  padding: 6px 12px;
  max-width: 190px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.driver-popover .driver-popover-next-btn:hover, .driver-popover .driver-popover-done-btn:hover {
  background: var(--tour-next-bg, #ffffff); color: var(--tour-next-text, #0f172a); filter: none;
}
/* Back — ghost: no fill, no border. */
.driver-popover .driver-popover-prev-btn {
  background: transparent; border: 1px solid transparent; color: var(--tour-muted, #64748b); padding: 6px 10px;
}
.driver-popover .driver-popover-prev-btn:hover { background: transparent; color: var(--tour-text, #0f172a); }
/* Skip tour — quiet text link, bottom-left, no fill. */
.driver-popover .driver-popover-skip-btn {
  margin-right: auto; background: transparent; border: none; cursor: pointer;
  color: var(--tour-muted, #94a3b8); font: inherit; font-size: 11.5px; font-weight: 500;
  padding: 6px 2px; text-decoration: underline; text-underline-offset: 2px;
}
.driver-popover .driver-popover-skip-btn:hover { background: transparent; color: var(--tour-text, #0f172a); }
.driver-popover-arrow-side-left.driver-popover-arrow { border-left-color: var(--tour-bg, #ffffff); }
.driver-popover-arrow-side-right.driver-popover-arrow { border-right-color: var(--tour-bg, #ffffff); }
.driver-popover-arrow-side-top.driver-popover-arrow { border-top-color: var(--tour-bg, #ffffff); }
.driver-popover-arrow-side-bottom.driver-popover-arrow { border-bottom-color: var(--tour-bg, #ffffff); }
/* Centered cards (floating "slides" + fallbacks) have no target: driver highlights
   a center "dummy" element with side "over" and still emits an arrow (arrow-none is
   only added when NO side fits). driver.css has no rule for arrow-side-over, so that
   stray triangle shows and reads as if the card is anchored to the previous element.
   Hide it so a targetless card is a clean, anchorless modal. */
.driver-popover-arrow-side-over.driver-popover-arrow { display: none !important; }
@keyframes tour-pop-in { from { opacity: 0; transform: translateY(6px) scale(0.98); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .driver-popover { animation: none; } .driver-popover .tour-img-skel { animation: none; } }
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

type StepAction = 'next' | 'prev' | 'skip';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// driver.js renders popover.description via innerHTML, so we compose safe HTML:
// the (escaped) body text, optionally preceded by an image. The image is shown
// only on centered cards (floating/modal "slides" and fallbacks), not squeezed
// into an anchored popover beside a small element.
// Keep a button label readable — long step titles get truncated in "Next: …".
function truncate(s: string, max = 28): string {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

function buildPopover(
  step: Step,
  stepNumber: number,
  totalVisible: number,
  isLast: boolean,
  opts: { centered?: boolean; fallback?: boolean; nextTitle?: string | undefined; showBack?: boolean } = {},
): NonNullable<DriveStep['popover']> {
  type Side = 'top' | 'bottom' | 'left' | 'right';
  const side: Side | undefined =
    step.placement === 'auto' ? undefined : (step.placement as Side);

  const bodyText = opts.fallback ? step.fallbackBody ?? step.body : step.body;
  // Image (centered/fallback cards only) wrapped with a skeleton placeholder that
  // reserves space + shimmers while loading; onPopoverRender fades the image in and
  // repositions once it decodes (so the popover doesn't jump). See TOUR_STYLESHEET.
  const imgHtml = opts.centered && step.image
    ? `<div class="tour-img-wrap"><div class="tour-img-skel"></div>` +
      `<img class="tour-img" src="${escapeHtml(step.image)}" alt="" /></div>`
    : '';
  const description = imgHtml + (bodyText ? `<span>${escapeHtml(bodyText)}</span>` : '');

  // Descriptive Next CTA: "Next: <upcoming step>" (or Finish on the last step).
  // Truncate tighter here so the single-line CTA (capped + ellipsis in CSS) stays compact.
  // Strip a redundant leading "Next up:"/"Next:" so we never render "Next: Next up: …".
  const upcoming = opts.nextTitle?.replace(/^\s*next(\s+up)?\s*:?\s*/i, '').trim() || opts.nextTitle;
  const nextBtnText = isLast ? 'Finish' : upcoming ? `Next: ${truncate(upcoming, 20)}` : 'Next →';
  // Back only when the previous step is presentational too (never re-enter a
  // completed interaction step). ✕ exits; "Skip tour" is injected in onPopoverRender.
  const showButtons: NonNullable<DriveStep['popover']>['showButtons'] = opts.showBack
    ? ['previous', 'next', 'close']
    : ['next', 'close'];

  return {
    title: step.title,
    description,
    showButtons,
    showProgress: true,
    progressText: `${stepNumber} of ${totalVisible}`,
    nextBtnText,
    prevBtnText: 'Back',
    ...(side ? { side } : {}),
  };
}

// (Interaction steps are rendered by showInteractiveStep in ./interactive.ts —
// it owns the spotlight, tooltip, and the advance controller for the gate.)

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function playTour(opts: PlayerOptions): Promise<void> {
  const { tour, anchorMeta = {}, theme, onComplete, onSkip, onStepChange, onUnavailable, navigate, waitForElement, applyContext } = opts;

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

  // driver.js handles PRESENTATIONAL steps. Created lazily and reused across
  // consecutive presentational steps (so the spotlight animates between them);
  // destroyed when we hand off to an interaction step (rendered by our own
  // overlay) and recreated for the next presentational step.
  let driverObj: ReturnType<typeof driver> | null = null;
  const destroyDriver = () => {
    if (driverObj) { const d = driverObj; driverObj = null; d.destroy(); }
  };
  const getDriver = () => {
    if (driverObj) return driverObj;
    driverObj = driver({
      allowClose: true,
      overlayColor: mergedTheme.overlayColor ?? '#0b1220',
      overlayOpacity: mergedTheme.overlayOpacity ?? 0.55,
      stagePadding: mergedTheme.stagePadding ?? 4,
      stageRadius: mergedTheme.stageRadius ?? 6,
      animate: mergedTheme.animate ?? true,
      smoothScroll: true,
      ...(mergedTheme.popoverClass ? { popoverClass: mergedTheme.popoverClass } : {}),
      onNextClick: () => settle('next'),
      onPrevClick: () => settle('prev'),
      onCloseClick: () => settle('skip'),
      onDestroyStarted: () => { settle('skip'); teardown(); },
      // Inject a visible "Skip tour" button alongside driver's ✕. We only build
      // the node here; the click is handled by a delegated document listener
      // (see below) because driver.js recreates the footer button nodes on every
      // re-render, which strips any listener attached directly to the button.
      onPopoverRender: popover => {
        // Fallback/slide image: fade in + reposition once it decodes, so the
        // popover is sized/centered correctly instead of jumping when the image
        // pops in. The skeleton (reserved space + shimmer) shows until then.
        const wrap = popover.wrapper?.querySelector('.tour-img-wrap');
        const img = wrap?.querySelector('.tour-img') as HTMLImageElement | null;
        if (wrap && img) {
          const done = () => {
            wrap.classList.add('is-loaded');
            driverObj?.refresh(); // re-center/re-place now that height is known
          };
          if (img.complete && img.naturalWidth > 0) done();
          else {
            img.addEventListener('load', done, { once: true });
            // On error, drop the skeleton so it doesn't shimmer forever.
            img.addEventListener('error', () => wrap.classList.add('is-loaded'), { once: true });
          }
        }

        if (popover.footerButtons?.querySelector('.driver-popover-skip-btn')) return;
        const skip = document.createElement('button');
        skip.type = 'button';
        skip.textContent = 'Skip tour';
        skip.className = 'driver-popover-skip-btn';
        popover.footerButtons?.prepend(skip);
      },
    });
    return driverObj;
  };
  let removeSkipDelegation: (() => void) | null = null;
  const teardown = () => {
    if (torn) return;
    torn = true;
    removeSkipDelegation?.();
    destroyDriver();
    teardownInteractiveOverlay();
    // Belt-and-suspenders: if driver left any DOM behind (stale instance, etc.),
    // physically remove its popover/overlay so the tour visibly ends.
    document.querySelectorAll('.driver-popover, .driver-overlay, svg.driver-overlay').forEach(n => n.remove());
    document.documentElement.classList.remove('driver-active', 'driver-fade');
    document.body.classList.remove('driver-active', 'driver-fade');
  };

  // Delegated skip handler — survives driver recreating the button node. Capture
  // phase + stopPropagation so driver's own footer-click delegation never sees it.
  const onSkipClick = (e: Event) => {
    const t = e.target as Element | null;
    if (!t || !t.closest?.('.driver-popover-skip-btn')) return;
    e.preventDefault();
    e.stopPropagation();
    settle('skip'); // resolve the awaited step → loop runs teardown + onSkip
    teardown();     // and force the overlay down regardless of driver state
  };
  document.addEventListener('click', onSkipClick, true);
  removeSkipDelegation = () => document.removeEventListener('click', onSkipClick, true);

  const waitForAction = () => new Promise<StepAction>(resolve => { currentResolve = resolve; });

  // A step's effective route. Prefer the route captured on the step itself (the
  // page its element lived on at record time) — that makes a tour play correctly
  // from ANY starting page, and each step self-navigates to its own page. Fall
  // back to the nearest `navigate` prepare at/before the step for older tours that
  // predate per-step routes. Declarative either way, so BACK re-navigates too.
  const routeForStep = (idx: number): string | undefined => {
    for (let k = idx; k >= 0; k--) {
      const s = tour.steps[k];
      if (s?.route) return s.route;
      const nav = s?.prepare?.find(a => a.action === 'navigate');
      if (nav && nav.action === 'navigate') return nav.route;
    }
    return undefined;
  };
  let currentRoute: string | undefined; // last route we navigated to

  // Restore the app mode this tour was recorded in (experience, flags, …) BEFORE
  // anything navigates or renders — host-owned semantics, idempotent, may await a
  // transition animation. A tour recorded in the old experience thus replays there.
  if (applyContext && tour.context) await applyContext(tour.context as Record<string, unknown>);

  // Index-controlled so a step can send us BACK (presentational steps only).
  let i = 0;
  while (i < tour.steps.length) {
    const step = tour.steps[i];
    if (!step) { i++; continue; }

    // ── 1. Ensure we're on the right page, then run click/wait prepare ─────
    // Navigate only when the target route differs from where we are (so same-page
    // Back is instant — no redundant navigate/300ms wait).
    const wantRoute = routeForStep(i);
    if (wantRoute && wantRoute !== currentRoute) {
      if (navigate) await navigate(wantRoute);
      currentRoute = wantRoute;
      await waitMs(300); // let React commit the new route before resolving the target
    }
    await runPrepare(step, anchorMeta, waitForElement);

    // ── 2 & 3. Resolve the element to show ─────────────────────────────────
    // Fast path: if the target is already rendered, show on it immediately (no
    // wait). If it's still loading, point at its nearest rendered ancestor (the
    // "section" — data is coming there) and remember to SNAP onto the exact
    // element once it appears. Only when neither is available do we wait.
    const locator = step.anchorId ? decodeLocator(step.anchorId) : null;
    let element: Element | undefined;
    let renderFallback = false;
    let pendingTarget: TourLocator | null = null; // target still loading → snap when ready
    if (step.anchorId) {
      const hadNav = step.prepare?.some(a => a.action === 'navigate') ?? false;
      // After an interactive step the user just triggered something that often
      // renders the next target async — wait generously rather than skip it.
      const prevInteractive = i > 0 && tour.steps[i - 1]?.advance === 'interaction';
      const timeout = hadNav || prevInteractive ? 8000 : 2000;

      const isInteractiveStep = step.advance === 'interaction';
      // A step with fallback content is ALWAYS anchorless when its target is
      // missing — it renders as a centered modal (never anchored to a section).
      const hasFallback = !!(step.image || step.fallbackBody);
      // Fallback steps fall back FAST — don't make the user wait out the full
      // resolve window on a genuinely-missing target; the centered card is graceful.
      const resolveTimeout = hasFallback ? Math.min(timeout, 1500) : timeout;

      let el = resolveNow(step.anchorId); // a) already rendered?
      // Present but not laid out yet (loading / display:none / zero box) → treat as
      // "not ready" so we wait below instead of rendering at the top-left corner.
      if (el && !isLaidOut(el)) el = null;
      if (!el && !isInteractiveStep && !hasFallback && locator?.xpath) {
        // b) (presentational, no-fallback only) loading → point at the nearest
        // present section, snap to the target later. Interaction steps must wait
        // for the REAL target; fallback steps go straight to a centered modal.
        const section = nearestRenderedAncestor(locator.xpath);
        if (section) { el = section; pendingTarget = locator; }
      }
      if (!el) {
        // c) nothing to point at yet → wait for the target to render.
        if (locator) await waitForLocator(locator, resolveTimeout);
        else if (waitForElement) await waitForElement(`[data-tour="${CSS.escape(step.anchorId)}"]`, resolveTimeout);
        else await waitForAnchor(step.anchorId, resolveTimeout);
        el = resolveAnchor(step.anchorId, anchorMeta, tour.id, i);
        // It may have just appeared but not be laid out yet → wait for a real box.
        // Only then is it safe to show; otherwise treat as missing (skip/fallback).
        if (el && !isLaidOut(el)) {
          const visible = await waitForVisible(el, resolveTimeout);
          if (!visible) el = null;
        }
      }
      if (!el) {
        // Target missing. If the step carries fallback content (alt text and/or
        // an image), render a centered card so the tour still teaches; else skip.
        missingAnchors.push(step.anchorId);
        if (step.image || step.fallbackBody) renderFallback = true;
        else { i++; continue; }
      } else {
        element = el;
      }
    }

    stepNumber = i + 1;
    const isLast = i === tour.steps.length - 1;
    const nextTitle = tour.steps[i + 1]?.title;
    const interactive = step.advance === 'interaction' && !!element && !renderFallback;
    // Back only when this step AND the previous one are presentational — never
    // re-enter a completed interaction step (re-arming its gate could trap the user).
    const showBack = !interactive && i > 0 && tour.steps[i - 1]?.advance !== 'interaction';

    // ── 4. Emit telemetry + notify step change ─────────────────────────────
    onStepChange?.(i);
    const viewedEvent = step.anchorId
      ? { type: 'step.viewed' as const, tourId: tour.id, stepIndex: i, anchorId: step.anchorId }
      : { type: 'step.viewed' as const, tourId: tour.id, stepIndex: i };
    emit(viewedEvent);

    // ── 5. Show the step and wait for the user's action ───────────────────
    // When we're pointing at a loading section, watch for the exact target and
    // SNAP onto it once it renders (the overlay slides over). `active` guards
    // against snapping after the step has already advanced.
    let action: StepAction;
    const watchAndSnap = (apply: (target: Element) => void): (() => void) | undefined => {
      if (!pendingTarget) return undefined;
      let active = true;
      void waitForLocator(pendingTarget, 8000).then(async target => {
        if (!target || !active || torn) return;
        // Snap only once the target is actually laid out — otherwise we'd slide
        // the overlay onto a zero-box element (top-left corner).
        if (!isLaidOut(target)) {
          const visible = await waitForVisible(target, 8000);
          if (!visible || !active || torn) return;
        }
        apply(target);
      });
      return () => { active = false; };
    };

    if (interactive) {
      // Hand off from the presentational driver to our own interactive renderer
      // (own non-blocking spotlight + tooltip + signal-based advance).
      destroyDriver();
      shownCount++;
      const stopSnap = watchAndSnap(target => repointInteractiveOverlay(target));
      action = await showInteractiveStep({ element: element!, step, stepNumber, totalVisible, theme: mergedTheme, nextTitle });
      stopSnap?.();
    } else {
      // Presentational, floating (no target), or fallback (target missing) →
      // a driver.js popover; with no element it renders as a centered card.
      // Leaving interactive mode → remove the interactive overlay (driver takes over).
      teardownInteractiveOverlay();
      const centered = !element; // floating step or fallback → centered "slide"
      const popover = buildPopover(step, stepNumber, totalVisible, isLast, { centered, fallback: renderFallback, nextTitle, showBack });
      getDriver().highlight({ ...(element ? { element } : {}), popover });
      shownCount++;
      const stopSnap = watchAndSnap(target => getDriver().highlight({ element: target, popover }));
      action = await waitForAction();
      stopSnap?.();
    }

    if (action === 'skip') {
      emit({ type: 'tour.skipped', tourId: tour.id, stepIndex: i });
      teardown();
      onSkip?.(i);
      return;
    }
    if (action === 'prev') {
      i = Math.max(0, i - 1); // Back — re-show the previous (presentational) step
      continue;
    }
    if (isLast) {
      emit({ type: 'tour.completed', tourId: tour.id });
      teardown();
      onComplete?.();
      return;
    }
    i++; // action === 'next' — advance; the next highlight() animates the move
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
