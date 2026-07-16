// ─── Interactive step renderer ──────────────────────────────────────────────
// Purpose-built for action-gated steps (e.g. "open this dropdown and select a
// dataset"). Unlike the presentational driver.js path, this:
//   • renders our OWN spotlight (dim + cutout + ring) that does NOT block clicks,
//     so the user can actually operate the highlighted control,
//   • positions a tooltip with Floating UI and keeps it + the spotlight glued to
//     the target on scroll / resize / layout change,
//   • advances ONLY on the step's declared signal (route param / target click /
//     element appears / timeout) — never on a stray click,
//   • offers ✕/Esc to abandon (no Next — the action is the way forward).
//
// The spotlight + tooltip are a SINGLE persistent overlay reused across
// consecutive interaction steps, so they smoothly SLIDE / RESIZE from one target
// to the next instead of popping. The player calls teardownInteractiveOverlay()
// when it leaves interactive mode (a presentational step) or the tour ends.

import { computePosition, autoUpdate, offset, flip, shift, type Placement } from '@floating-ui/dom';
import { decodeLocator, waitForLocator } from './locator.js';
import type { Step, ThemeOverrides } from './schema.js';

export type InteractiveAction = 'next' | 'skip';

function overlayRgba(color: string | undefined, opacity: number): string {
  let r = 11, g = 18, b = 32; // default #0b1220
  const hex = (color ?? '').replace('#', '');
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    r = parseInt(hex.slice(0, 2), 16); g = parseInt(hex.slice(2, 4), 16); b = parseInt(hex.slice(4, 6), 16);
  } else if (/^[0-9a-f]{3}$/i.test(hex)) {
    r = parseInt(hex[0]! + hex[0]!, 16); g = parseInt(hex[1]! + hex[1]!, 16); b = parseInt(hex[2]! + hex[2]!, 16);
  }
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

const setStyle = (el: HTMLElement, s: Partial<CSSStyleDeclaration>) => Object.assign(el.style, s);

const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';
const SPOTLIGHT_SLIDE = `top .3s ${EASE}, left .3s ${EASE}, width .3s ${EASE}, height .3s ${EASE}, opacity .2s ease`;
const TIP_SLIDE = `top .3s ${EASE}, left .3s ${EASE}, opacity .2s ease`;

// ── Persistent overlay (shared across interaction steps) ──────────────────────
interface Overlay {
  spotlight: HTMLElement;
  tip: HTMLElement;
  title: HTMLElement;
  body: HTMLElement;
  hint: HTMLElement;
  nextUp: HTMLElement;
  prog: HTMLElement;
  skip: HTMLButtonElement;
  close: HTMLButtonElement;
  element: Element | null;
  placement: Placement;
  pad: number;
  stopAutoUpdate: (() => void) | null;
}
let overlay: Overlay | null = null;
let stepCleanups: Array<() => void> = [];

function runStepCleanups(): void {
  stepCleanups.forEach(fn => { try { fn(); } catch { /* ignore */ } });
  stepCleanups = [];
}

// Position the spotlight + tooltip on the overlay's current element. The CSS
// transitions on both make every move (incl. re-pointing) slide/resize smoothly.
function positionOverlay(ov: Overlay): void {
  if (!ov.element) return;
  const r = ov.element.getBoundingClientRect();
  setStyle(ov.spotlight, {
    top: `${r.top - ov.pad}px`, left: `${r.left - ov.pad}px`,
    width: `${r.width + ov.pad * 2}px`, height: `${r.height + ov.pad * 2}px`,
  });
  void computePosition(ov.element, ov.tip, {
    placement: ov.placement, strategy: 'fixed', middleware: [offset(12), flip(), shift({ padding: 8 })],
  }).then(({ x, y }) => setStyle(ov.tip, { left: `${x}px`, top: `${y}px` }));
}

// Glue the overlay to a (new) element — scrolls it into view and keeps the
// spotlight/tooltip tracking it. Re-pointing animates via the CSS transitions.
function trackTarget(ov: Overlay, element: Element): void {
  ov.stopAutoUpdate?.();
  ov.element = element;
  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  ov.stopAutoUpdate = autoUpdate(element, ov.tip, () => positionOverlay(ov));
}

/** Slide the live interactive overlay onto a new element (the "snap" once a
 *  loading target finishes rendering). No-op if no overlay is active. */
export function repointInteractiveOverlay(element: Element): void {
  if (overlay) trackTarget(overlay, element);
}

/** Remove the interactive overlay (called when the tour leaves interactive mode
 *  — i.e. a presentational step takes over — or the tour ends). Fades out. */
export function teardownInteractiveOverlay(): void {
  runStepCleanups();
  if (!overlay) return;
  const { spotlight, tip, stopAutoUpdate } = overlay;
  stopAutoUpdate?.();
  setStyle(spotlight, { opacity: '0' });
  setStyle(tip, { opacity: '0', transform: 'translateY(4px) scale(0.98)' });
  setTimeout(() => { spotlight.remove(); tip.remove(); }, 200);
  overlay = null;
}

function buildOverlay(theme: ThemeOverrides): Overlay {
  const radius = theme.stageRadius ?? 6;

  const spotlight = document.createElement('div');
  spotlight.setAttribute('data-tour-interactive', '');
  setStyle(spotlight, {
    position: 'fixed', zIndex: '100000', pointerEvents: 'none', borderRadius: `${radius}px`, opacity: '0',
    boxShadow: `0 0 0 9999px ${overlayRgba(theme.overlayColor, theme.overlayOpacity ?? 0.55)}`,
    border: `2px solid var(--tour-primary, ${theme.primaryColor ?? '#6366f1'})`,
    transition: 'opacity .2s ease',
  });
  document.body.appendChild(spotlight);

  const tip = document.createElement('div');
  tip.setAttribute('data-tour-interactive', '');
  setStyle(tip, {
    position: 'fixed', top: '0', left: '0', zIndex: '100001', maxWidth: '320px', opacity: '0',
    background: 'var(--tour-bg, #ffffff)', color: 'var(--tour-text, #0f172a)',
    borderRadius: 'var(--tour-radius, 14px)', border: '1px solid var(--tour-border, rgba(15,23,42,0.08))',
    boxShadow: 'var(--tour-shadow, 0 16px 40px rgba(2,6,23,0.28), 0 2px 8px rgba(2,6,23,0.12))',
    // extra top padding so the title clears the top-right counter + ✕
    padding: '14px 16px 12px', fontFamily: 'var(--tour-font, system-ui, -apple-system, sans-serif)', fontSize: '13px',
    transition: 'opacity .2s ease',
  });

  const btnBase: Partial<CSSStyleDeclaration> = {
    fontFamily: 'inherit', cursor: 'pointer', border: 'none', background: 'transparent',
    color: 'var(--tour-muted, #94a3b8)',
  };

  // ── Top row: step counter + ✕, pinned to the top-right (small + quiet) ──
  const topRow = document.createElement('div');
  setStyle(topRow, { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '10px', marginBottom: '6px' });
  const prog = document.createElement('span');
  setStyle(prog, { fontSize: '10px', fontWeight: '600', letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--tour-muted, #94a3b8)' });
  const close = document.createElement('button');
  close.textContent = '✕';
  close.title = 'Exit tour';
  setStyle(close, { ...btnBase, fontSize: '13px', lineHeight: '1', padding: '0 2px' });
  topRow.append(prog, close);

  const title = document.createElement('div');
  setStyle(title, { fontSize: '15px', fontWeight: '650', lineHeight: '1.35', marginBottom: '6px', color: 'var(--tour-text, #0f172a)' });

  const body = document.createElement('div');
  setStyle(body, { fontSize: '13px', lineHeight: '1.55', color: 'var(--tour-muted, #64748b)' });

  const hint = document.createElement('div');
  setStyle(hint, { fontSize: '11px', fontWeight: '600', color: 'var(--tour-primary, #6366f1)', marginTop: '8px' });

  // "Next: <upcoming step>" — sets expectations even though there's no Next
  // button on an interaction step (you advance by doing the action).
  const nextUp = document.createElement('div');
  setStyle(nextUp, { fontSize: '11px', color: 'var(--tour-muted, #94a3b8)', marginTop: '6px' });

  // ── Footer: "Skip tour" only, bottom-left (no Back/Next on interaction) ──
  const footer = document.createElement('div');
  setStyle(footer, { display: 'flex', alignItems: 'center', justifyContent: 'flex-start', marginTop: '14px' });
  const skip = document.createElement('button');
  skip.textContent = 'Skip tour';
  skip.title = 'Exit the tour';
  setStyle(skip, { ...btnBase, fontSize: '12px', fontWeight: '500', padding: '2px 0', textDecoration: 'underline', textUnderlineOffset: '2px' });
  footer.append(skip);

  tip.append(topRow, title, body, hint, nextUp, footer);
  document.body.appendChild(tip);

  return { spotlight, tip, title, body, hint, nextUp, prog, skip, close, element: null, placement: 'bottom', pad: 8, stopAutoUpdate: null };
}

export function showInteractiveStep(opts: {
  element: Element;
  step: Step;
  stepNumber: number;
  totalVisible: number;
  theme: ThemeOverrides;
  nextTitle?: string | undefined;
}): Promise<InteractiveAction> {
  const { element, step, stepNumber, totalVisible, theme, nextTitle } = opts;
  const gate = step.gate ?? {};
  const PAD = theme.stagePadding ?? 4;

  // Drop the PREVIOUS step's gate listeners, but keep the overlay DOM so it can
  // animate to this step's target.
  runStepCleanups();

  const created = !overlay;
  if (!overlay) overlay = buildOverlay(theme);
  const ov = overlay;

  return new Promise<InteractiveAction>(resolve => {
    let settled = false;
    const finish = (a: InteractiveAction) => {
      if (settled) return;
      settled = true;
      runStepCleanups();
      resolve(a); // overlay persists; the player tears it down when leaving interactive mode
    };

    // ── Content ──
    ov.title.textContent = step.title;
    ov.body.textContent = step.body || '';
    ov.body.style.display = step.body ? 'block' : 'none';
    const hintText = gate.click
      ? '👆 Click the highlighted item to continue'
      : gate.route?.param
        ? 'Make your selection to continue'
        : gate.route?.match
          ? '👆 Click to go to the next screen'
          : gate.appear
            ? 'The tour continues on its own once ready'
            : '';
    ov.hint.textContent = hintText;
    ov.hint.style.display = hintText ? 'block' : 'none';
    ov.nextUp.textContent = nextTitle ? `Next: ${nextTitle}` : '';
    ov.nextUp.style.display = nextTitle ? 'block' : 'none';
    ov.prog.textContent = `${stepNumber} of ${totalVisible}`;
    ov.skip.onclick = () => finish('skip');
    ov.close.onclick = () => finish('skip');

    // ── Position (animated) ──
    ov.placement = step.placement && step.placement !== 'auto' ? (step.placement as Placement) : 'bottom';
    ov.pad = PAD;
    trackTarget(ov, element);

    // First appearance: fade in AT the target (no slide-from-corner). Subsequent
    // steps reuse the overlay, so enable the slide/resize transition then.
    requestAnimationFrame(() => {
      ov.spotlight.style.opacity = '1';
      ov.tip.style.opacity = '1';
      ov.tip.style.transform = 'none';
      if (created) requestAnimationFrame(() => {
        ov.spotlight.style.transition = SPOTLIGHT_SLIDE;
        ov.tip.style.transition = TIP_SLIDE;
      });
    });

    // ── Advance controller — ONLY the declared signal advances the step ──
    // Route gate: advance when a query param changes (a "selection") OR when the
    // path reaches `match` (a "navigation"). Both watch the same history events.
    if (gate.route?.param || gate.route?.match) {
      const param = gate.route.param;
      const match = gate.route.match;
      const readParam = () => (param ? new URLSearchParams(window.location.search).get(param) : null);
      const baseParam = readParam();
      const basePath = window.location.pathname;
      const check = () => {
        if (param) { const cur = readParam(); if (cur != null && cur !== baseParam) return finish('next'); }
        if (match) { const p = window.location.pathname; if (p !== basePath && (p === match || p.startsWith(match) || p.includes(match))) return finish('next'); }
      };
      const origPush = history.pushState.bind(history);
      const origReplace = history.replaceState.bind(history);
      history.pushState = (...a: Parameters<typeof history.pushState>) => { origPush(...a); check(); };
      history.replaceState = (...a: Parameters<typeof history.replaceState>) => { origReplace(...a); check(); };
      window.addEventListener('popstate', check);
      stepCleanups.push(() => {
        history.pushState = origPush;
        history.replaceState = origReplace;
        window.removeEventListener('popstate', check);
      });
      // Navigation step but we're ALREADY on the destination → nothing to do; advance.
      if (match && !param && (basePath === match || basePath.startsWith(match) || basePath.includes(match))) {
        const t = setTimeout(() => finish('next'), 500);
        stepCleanups.push(() => clearTimeout(t));
      }
    }
    if (gate.click) {
      const onClick = (e: Event) => {
        const t = e.target as Node | null;
        if (t && (element === t || element.contains(t))) finish('next');
      };
      document.addEventListener('click', onClick, true);
      stepCleanups.push(() => document.removeEventListener('click', onClick, true));
    }
    if (gate.appear) {
      const loc = decodeLocator(gate.appear);
      if (loc) {
        let stopped = false;
        void waitForLocator(loc, 120000).then(el => { if (el && !stopped) finish('next'); });
        stepCleanups.push(() => { stopped = true; });
      }
    }
    if (gate.timeoutMs != null) {
      const t = setTimeout(() => finish('next'), gate.timeoutMs);
      stepCleanups.push(() => clearTimeout(t));
    }

    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') finish('skip'); };
    document.addEventListener('keydown', onKey);
    stepCleanups.push(() => document.removeEventListener('keydown', onKey));
  });
}
