import React, { useCallback, useEffect, useRef, useState } from 'react';
import { exportRecording } from '../export.js';
import type { Tour, Step, InteractionAction } from '@guided-tour-s4marth/core';
import { playTour, parseTour, buildLocator, encodeLocator, decodeLocator, resolveLocator, PREVIEW_TOUR_ID, type PlayerOptions } from '@guided-tour-s4marth/core';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DraftStep {
  // Encoded multi-signal locator (`loc:<json>`) — carries the signals + signature
  // used to target the element at runtime. No build-time data-tour needed.
  // Omitted for a "floating" step: no target → the player shows it as a centered
  // modal (e.g. an intro/outro banner). Such a step has no anchorId in the payload.
  anchorId?: string;
  title: string;
  body: string;
  placement: NonNullable<Step['placement']>;
  interactionPath: InteractionAction[];
  // Preview-only (not serialized): exact element fast-path while still mounted.
  element?: Element;
}

export interface RecorderOverlayProps {
  tourType?: Tour['type'];
  /**
   * Called when the author clicks Submit. Receives the recorded tour draft. Each
   * step targets its element by an encoded locator+signature, so the tour works
   * at runtime with no code change / deploy. The host decides what to do with it
   * (e.g. publish to the backend, or create a ticket).
   */
  onSubmit?: (result: ReturnType<typeof exportRecording>) => void;
  /** Called when saving repairs to an existing tour (repair mode). The host
   *  should persist the edited steps to the existing tour (update by id) so the
   *  fix takes effect with no deploy. Falls back to onSubmit if not provided. */
  onSaveRepair?: (result: ReturnType<typeof exportRecording>) => void;
  /** Router navigate, used by Preview to replay `prepare` navigation steps.
   *  Without it, cross-screen preview can't change routes (same-screen still works). */
  navigate?: (route: string) => void | Promise<void>;
  /** When set, the overlay opens in repair mode preloaded with this tour's steps.
   *  Each step shows a live health badge; broken/mismatch steps can be re-captured
   *  in place. Saving calls onSubmit with the edited draft (host updates by id). */
  repairTour?: Tour | null;
  /** Fired once the overlay has consumed `repairTour` and loaded its steps. The
   *  host should clear its repairTour state so the same tour can be repaired again. */
  onRepairConsumed?: () => void;
}

// ── Per-step health (live, current-screen) ─────────────────────────────────────
// Best-effort check against the current DOM. Authoritative cross-route health
// comes from runtime telemetry; this is the live signal while repairing.
type StepHealth = 'ok' | 'healed' | 'mismatch' | 'broken' | 'legacy-ok' | 'legacy-broken' | 'floating';

function stepHealth(step: { anchorId?: string }): StepHealth {
  if (!step.anchorId) return 'floating'; // centered modal — nothing to resolve
  const loc = decodeLocator(step.anchorId);
  if (loc) return resolveLocator(loc).status;
  if (document.querySelector(`[data-tour="${CSS.escape(step.anchorId)}"]`)) return 'legacy-ok';
  return 'legacy-broken';
}

function healthBadge(h: StepHealth): { color: string; label: string } {
  switch (h) {
    case 'ok': return { color: '#10b981', label: '✓ ok' };
    case 'healed': return { color: '#22d3ee', label: '↻ healed' };
    case 'mismatch': return { color: '#f59e0b', label: '⚠ wrong element' };
    case 'legacy-ok': return { color: '#10b981', label: '✓ data-tour' };
    case 'floating': return { color: '#94a3b8', label: '◇ modal' };
    case 'broken':
    case 'legacy-broken':
    default: return { color: '#ef4444', label: '✕ broken' };
  }
}

function tourToDraftSteps(tour: Tour): DraftStep[] {
  return tour.steps.map(s => {
    const step: DraftStep = {
      title: s.title,
      body: s.body,
      placement: s.placement ?? 'auto',
      interactionPath: s.prepare ?? [],
    };
    if (s.anchorId) step.anchorId = s.anchorId;
    return step;
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const INTERACTIVE_SELECTOR =
  'button,a,input,select,textarea,[role="button"],[role="tab"],[role="menuitem"],[role="option"]';

function findBestTarget(el: Element): Element {
  const interactive = el.closest(INTERACTIVE_SELECTOR);
  return interactive ?? el;
}

// The recorder's own UI is marked with data-tour-recorder so neither capture nor
// the prepare-click tracker ever targets/records the panel, FAB, or banner.
// (panelRef alone misses the FAB and banner, which live outside the panel div.)
function isRecorderUI(el: EventTarget | Element | null): boolean {
  return !!(el && (el as Element).closest?.('[data-tour-recorder]'));
}

// ── Readable label for a captured element / encoded locator ────────────────────
// (buildLocator + getXPath now live in @guided-tour-s4marth/core — single source shared with
// the offline health auditor, so there's no copy to keep in sync.)
function elementLabel(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const name =
    el.getAttribute('aria-label')?.trim() ||
    (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 32);
  return name ? `${tag} · ${name}` : tag;
}

function locatorLabel(anchorId?: string): string {
  if (!anchorId) return '◇ centered modal (no target)';
  const loc = decodeLocator(anchorId);
  if (!loc) return anchorId;
  const sig = loc.signature;
  const primary = sig.name || sig.text || loc.testid || loc.domId;
  return primary ? `${sig.tag} · ${primary}` : sig.tag;
}

function currentRoute(): string {
  return window.location.pathname + window.location.search;
}

// ─── Navigation tracker ───────────────────────────────────────────────────────
// Patches history.pushState/replaceState and listens to popstate to detect
// all SPA route changes (React Router, Next.js, etc.) while recording.

function useNavigationTracking(
  enabled: boolean,
  onNavigate: (route: string) => void,
) {
  useEffect(() => {
    if (!enabled) return;

    const origPush = history.pushState.bind(history);
    const origReplace = history.replaceState.bind(history);

    history.pushState = (...args: Parameters<typeof history.pushState>) => {
      origPush(...args);
      onNavigate(currentRoute());
    };
    history.replaceState = (...args: Parameters<typeof history.replaceState>) => {
      origReplace(...args);
      onNavigate(currentRoute());
    };
    const onPop = () => onNavigate(currentRoute());
    window.addEventListener('popstate', onPop);

    return () => {
      history.pushState = origPush;
      history.replaceState = origReplace;
      window.removeEventListener('popstate', onPop);
    };
  }, [enabled, onNavigate]);
}

// ─── Spotlight ────────────────────────────────────────────────────────────────

function Spotlight({ rect }: { rect: DOMRect }) {
  const PAD = 4;
  const W = window.innerWidth;
  const H = window.innerHeight;
  const l = rect.left - PAD, t = rect.top - PAD;
  const r = rect.right + PAD, b = rect.bottom + PAD;
  const dim: React.CSSProperties = { position: 'fixed', background: 'rgba(0,0,0,0.42)', zIndex: 99997, pointerEvents: 'none' };
  return (
    <>
      <div style={{ ...dim, top: 0, left: 0, right: 0, height: Math.max(0, t) }} />
      <div style={{ ...dim, top: Math.min(H, b), left: 0, right: 0, bottom: 0 }} />
      <div style={{ ...dim, top: t, left: 0, width: Math.max(0, l), height: b - t }} />
      <div style={{ ...dim, top: t, left: Math.min(W, r), right: 0, height: b - t }} />
    </>
  );
}

// ─── Highlight ring ───────────────────────────────────────────────────────────

function HighlightRing({ rect, anchorId, isGap }: { rect: DOMRect; anchorId?: string | null; isGap?: boolean }) {
  const color = !anchorId ? '#94a3b8' : isGap ? '#f59e0b' : '#6366f1';
  const PAD = 4;
  return (
    <>
      <Spotlight rect={rect} />
      <div style={{
        position: 'fixed',
        top: rect.top - PAD, left: rect.left - PAD,
        width: rect.width + PAD * 2, height: rect.height + PAD * 2,
        border: `2px solid ${color}`, borderRadius: 6,
        boxShadow: `0 0 10px ${color}88`,
        pointerEvents: 'none', zIndex: 99998,
        transition: 'top 60ms ease,left 60ms ease,width 60ms ease,height 60ms ease',
      }} />
      {anchorId && (
        <div style={{
          position: 'fixed',
          top: Math.max(4, rect.top - PAD - 24), left: rect.left - PAD,
          background: color, color: '#fff',
          fontSize: 11, fontWeight: 600, fontFamily: 'monospace',
          padding: '2px 8px', borderRadius: 4,
          whiteSpace: 'nowrap', pointerEvents: 'none', zIndex: 99999,
        }}>
          {anchorId}{isGap ? ' ⚠ new anchor' : ''}
        </div>
      )}
    </>
  );
}

// ─── Pending path pill ────────────────────────────────────────────────────────

function PathPills({ path }: { path: InteractionAction[] }) {
  if (!path.length) return null;
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
      {path.map((a, i) => (
        <span key={i} style={{
          fontSize: 10, padding: '2px 6px', borderRadius: 10,
          background: a.action === 'navigate' ? '#1e3a5f' : '#1e293b',
          color: a.action === 'navigate' ? '#7dd3fc' : '#94a3b8',
          fontFamily: 'monospace', whiteSpace: 'nowrap',
        }}>
          {a.action === 'navigate' ? `→ ${a.route}` : a.action === 'click' ? `click: ${locatorLabel(a.anchorId)}` : `wait`}
        </span>
      ))}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function RecorderOverlay({ tourType: initialTourType = 'release', onSubmit, onSaveRepair, navigate, repairTour, onRepairConsumed }: RecorderOverlayProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  // Repair mode: editing an existing tour. `recaptureIdx` is the step being
  // re-targeted (the next capture click replaces that step's locator in place).
  const [repairing, setRepairing] = useState(false);
  const [recaptureIdx, setRecaptureIdx] = useState<number | null>(null);
  const loadedRepairId = useRef<string | null>(null);
  // The original tour id, preserved across an editable title so repair saves
  // PATCH the right record even when title !== id.
  const repairOriginalId = useRef<string | null>(null);
  // Tour type is selectable in the panel; seeded from the prop default.
  const [tourType, setTourType] = useState<Tour['type']>(initialTourType);

  // Accumulated interaction path since last step (navigations + anchor clicks)
  const [pendingPath, setPendingPath] = useState<InteractionAction[]>([]);

  // Hover state during capture mode
  const [hoveredRect, setHoveredRect] = useState<DOMRect | null>(null);
  const [hoveredAnchorId, setHoveredAnchorId] = useState<string | null>(null);

  // Pending element — clicked, waiting for step form
  const [pendingEl, setPendingEl] = useState<Element | null>(null);
  const [pendingRect, setPendingRect] = useState<DOMRect | null>(null);
  // Floating (no-target) step being authored — shows the step form with no element,
  // producing a centered-modal step (e.g. an intro/outro banner).
  const [floatingForm, setFloatingForm] = useState(false);

  // Step form
  const [stepTitle, setStepTitle] = useState('');
  const [stepBody, setStepBody] = useState('');
  const [stepPlacement, setStepPlacement] = useState<NonNullable<Step['placement']>>('auto');

  // Tour
  const [steps, setSteps] = useState<DraftStep[]>([]);
  const [tourId, setTourId] = useState('');
  const [submitted, setSubmitted] = useState(false);
  // Two phases: recording (capture steps) → review (preview tiles, then submit).
  const [reviewing, setReviewing] = useState(false);

  // Step hover highlight
  const [stepHighlight, setStepHighlight] = useState<{ rect: DOMRect; anchorId: string } | null>(null);
  const stepHighlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const lastRouteRef = useRef(currentRoute());

  // ── Navigation tracking ────────────────────────────────────────────────────
  // Track route changes whenever the panel is open so navigations between
  // steps get recorded as prepare actions on the next step.
  const handleNavigate = useCallback((route: string) => {
    if (route === lastRouteRef.current) return;
    lastRouteRef.current = route;
    setPendingPath(prev => [...prev, { action: 'navigate', route }]);
  }, []);

  useNavigationTracking(isOpen, handleNavigate);

  // ── Repair mode load ────────────────────────────────────────────────────────
  // When the host hands us a tour to repair, preload its steps and jump straight
  // to the review/repair view. Guard on id so we don't clobber edits on re-render.
  useEffect(() => {
    if (!repairTour) {
      loadedRepairId.current = null;
      return;
    }
    if (loadedRepairId.current === repairTour.id) return;
    loadedRepairId.current = repairTour.id;
    repairOriginalId.current = repairTour.id;
    setSteps(tourToDraftSteps(repairTour));
    setTourId(repairTour.title || repairTour.id);
    setTourType(repairTour.type);
    // Clear any in-progress capture so it doesn't bleed into the repair session.
    setPendingEl(null);
    setPendingRect(null);
    setPendingPath([]);
    setFloatingForm(false);
    setRecaptureIdx(null);
    setIsCapturing(false);
    setRepairing(true);
    setReviewing(true);
    setIsOpen(true);
    setSubmitted(false);
    onRepairConsumed?.();
  }, [repairTour, onRepairConsumed]);

  // ── Capture mode event listeners ──────────────────────────────────────────
  useEffect(() => {
    if (!isCapturing) return;

    const onMouseMove = (e: MouseEvent) => {
      const raw = document.elementFromPoint(e.clientX, e.clientY);
      if (!raw || isRecorderUI(raw)) {
        setHoveredRect(null); setHoveredAnchorId(null); return;
      }
      const best = findBestTarget(raw);
      setHoveredRect(best.getBoundingClientRect());
      setHoveredAnchorId(elementLabel(best));
    };

    const onClick = (e: MouseEvent) => {
      const raw = document.elementFromPoint(e.clientX, e.clientY);
      if (!raw || isRecorderUI(raw)) return;
      e.preventDefault();
      e.stopPropagation();

      const best = findBestTarget(raw);

      // Repair mode: re-target an existing step in place (no step form).
      if (recaptureIdx !== null) {
        const anchorId = encodeLocator(buildLocator(best));
        setSteps(prev => prev.map((s, i) => (i === recaptureIdx ? { ...s, anchorId, element: best } : s)));
        setRecaptureIdx(null);
        setIsCapturing(false);
        setHoveredRect(null); setHoveredAnchorId(null);
        return;
      }

      setIsCapturing(false);
      setHoveredRect(null); setHoveredAnchorId(null);
      setPendingEl(best);
      setPendingRect(best.getBoundingClientRect());
      setStepTitle(''); setStepBody(''); setStepPlacement('auto');
      setTimeout(() => titleInputRef.current?.focus(), 50);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setIsCapturing(false); setRecaptureIdx(null); setHoveredRect(null); setHoveredAnchorId(null); }
    };

    document.addEventListener('mousemove', onMouseMove, { passive: true });
    document.addEventListener('click', onClick, { capture: true });
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('click', onClick, { capture: true });
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isCapturing, recaptureIdx]);

  // ── Non-capture anchor clicks → add to pending path ────────────────────────
  // When the panel is open but NOT in capture mode, clicks on anchored elements
  // are recorded as prepare actions (e.g. opening a modal before the target step).
  useEffect(() => {
    if (!isOpen || isCapturing || pendingEl) return;

    const onClick = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target || isRecorderUI(target)) return;
      const best = findBestTarget(target);
      // Only interactive clicks are meaningful prepare actions (e.g. opening a
      // menu/modal before the next step) — ignore stray clicks on plain text.
      if (!best.matches(INTERACTIVE_SELECTOR)) return;
      setPendingPath(prev => [...prev, { action: 'click', anchorId: encodeLocator(buildLocator(best)) }]);
    };

    document.addEventListener('click', onClick, { passive: true });
    return () => document.removeEventListener('click', onClick);
  }, [isOpen, isCapturing, pendingEl]);

  // ── Confirm step ──────────────────────────────────────────────────────────
  const confirmStep = useCallback(() => {
    // A targeted step needs a captured element; a floating step needs neither.
    if ((!pendingEl && !floatingForm) || !stepTitle.trim()) return;

    const step: DraftStep = {
      title: stepTitle.trim(),
      body: stepBody.trim(),
      placement: stepPlacement,
      interactionPath: [...pendingPath],
    };
    if (pendingEl) {
      step.anchorId = encodeLocator(buildLocator(pendingEl));
      step.element = pendingEl;
    }

    setSteps(prev => [...prev, step]);
    setPendingPath([]); // reset path — starts fresh for the next step
    setPendingEl(null); setPendingRect(null); setFloatingForm(false);
    setStepTitle(''); setStepBody(''); setStepPlacement('auto');
    setSubmitted(false);
  }, [pendingEl, floatingForm, stepTitle, stepBody, stepPlacement, pendingPath]);

  const onTitleKeyDown = (e: React.KeyboardEvent) => { if (e.key === 'Enter') confirmStep(); };

  // ── Step list interactions ────────────────────────────────────────────────
  const highlightStep = (step: DraftStep) => {
    if (!step.anchorId) return; // floating step — no element to highlight
    // Resolve order: live element while still mounted (exact) → encoded locator
    // (signals + signature self-heal, resilient after a re-render).
    let el: Element | null = null;
    if (step.element && step.element.isConnected) el = step.element;
    if (!el) {
      const loc = decodeLocator(step.anchorId);
      if (loc) el = resolveLocator(loc).el;
    }
    if (!el) return;

    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Draw immediately, then re-measure once the smooth scroll settles so the
    // ring lands on the final position (not the pre-scroll rect).
    const target = el;
    const label = locatorLabel(step.anchorId);
    const draw = () => setStepHighlight({ rect: target.getBoundingClientRect(), anchorId: label });
    draw();
    window.setTimeout(draw, 360);

    if (stepHighlightTimer.current) clearTimeout(stepHighlightTimer.current);
    stepHighlightTimer.current = setTimeout(() => setStepHighlight(null), 2500);
  };

  const removeStep = (idx: number) => {
    setSteps(prev => prev.filter((_, i) => i !== idx));
    setSubmitted(false);
  };

  // Drop a step's target so it renders as a centered modal (no anchorId in payload).
  const makeStepFloating = (idx: number) => {
    setSteps(prev =>
      prev.map((s, i) => {
        if (i !== idx) return s;
        const { anchorId: _a, element: _e, ...rest } = s;
        return rest;
      }),
    );
    setSubmitted(false);
  };

  // ── Submit ──────────────────────────────────────────────────────────────────
  // Hands the recorded tour draft to the host. Each step targets its element by
  // an encoded locator+signature, so the tour works at runtime with no deploy.
  const handleSubmit = () => {
    const result = exportRecording(tourId, tourType, undefined, steps, []);
    if (repairing && onSaveRepair) {
      // Preserve the original id so we PATCH the existing record, not create a
      // new one keyed by the (editable) title.
      if (repairOriginalId.current) result.draft.id = repairOriginalId.current;
      onSaveRepair(result);
    } else {
      onSubmit?.(result);
    }
    setSubmitted(true);
  };

  // ── Preview ───────────────────────────────────────────────────────────────
  // Plays the recorded tour with the real @guided-tour-s4marth/core player. Steps resolve via
  // their encoded locator (carried in anchorId). The panel is hidden while the
  // tour plays, then restored.
  const handlePreview = useCallback(async () => {
    if (!steps.length) return;
    const result = exportRecording(tourId, tourType, undefined, steps, []);
    let tour;
    try {
      // Preview is a dry run of an unsaved draft — use the preview id so the
      // host ignores its telemetry (no health reporting / no 404 for an unsaved tour).
      tour = { ...parseTour(result.draft), id: PREVIEW_TOUR_ID };
    } catch {
      return;
    }
    setIsOpen(false); // hide the panel so the tour is visible
    const restore = () => setIsOpen(true);
    const opts: PlayerOptions = { tour, onComplete: restore, onSkip: restore, onUnavailable: restore };
    if (navigate) opts.navigate = navigate;
    await playTour(opts);
  }, [steps, tourId, tourType, navigate]);

  // ── Reset to a fresh NEW-tour state ─────────────────────────────────────────
  // Used by "Clear" and "Start new tour" — wipes steps AND exits repair mode, so
  // the next Submit creates a new tour instead of PATCHing the one being repaired.
  const resetAll = useCallback(() => {
    setSteps([]);
    setPendingPath([]);
    setPendingEl(null);
    setPendingRect(null);
    setFloatingForm(false);
    setReviewing(false);
    setRepairing(false);
    setRecaptureIdx(null);
    setSubmitted(false);
    setTourId('');
    repairOriginalId.current = null;
    loadedRepairId.current = null;
  }, []);

  return (
    <>
      {/* Hover highlight — shows what will be captured (tag · label) */}
      {isCapturing && hoveredRect && (
        <HighlightRing rect={hoveredRect} anchorId={hoveredAnchorId} isGap={false} />
      )}
      {/* Pending element highlight */}
      {pendingRect && pendingEl && (
        <HighlightRing rect={pendingRect} anchorId={elementLabel(pendingEl)} isGap={false} />
      )}
      {/* Step hover highlight */}
      {stepHighlight && (
        <HighlightRing rect={stepHighlight.rect} anchorId={stepHighlight.anchorId} isGap={false} />
      )}

      {/* Capture mode banner */}
      {isCapturing && (
        <div data-tour-recorder="1" style={{
          position: 'fixed', top: 0, left: 0, right: 0, height: 44,
          background: '#6366f1', color: '#fff', zIndex: 100001,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          gap: 16, fontSize: 13, fontWeight: 600,
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}>
          <span>
            {recaptureIdx !== null
              ? `● Re-targeting step ${recaptureIdx + 1} — click the new element`
              : '● Hover to target — click to capture  |  navigate freely, it will be recorded'}
          </span>
          <button
            onClick={() => { setIsCapturing(false); setRecaptureIdx(null); setHoveredRect(null); setHoveredAnchorId(null); }}
            style={btn('#ffffff33')}
          >
            ESC  Cancel
          </button>
        </div>
      )}

      {/* Toggle button */}
      <button
        data-tour-recorder="1"
        onClick={() => setIsOpen(o => !o)}
        title="Tour Recorder"
        style={{
          position: 'fixed', bottom: 24, right: 24,
          width: 48, height: 48, borderRadius: '50%',
          background: isOpen ? '#334155' : '#6366f1',
          border: 'none', color: '#fff', fontSize: 20,
          cursor: 'pointer', zIndex: 100000,
          boxShadow: '0 4px 16px rgba(99,102,241,0.45)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'background 0.15s',
        }}
      >
        {isOpen ? '✕' : '⏺'}
      </button>

      {/* Panel */}
      {isOpen && (
        <div ref={panelRef} data-tour-recorder="1" style={{
          position: 'fixed', bottom: 84, right: 24,
          width: 370, maxHeight: '80vh',
          background: '#0f172a', border: '1px solid #1e293b',
          borderRadius: 12, boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
          color: '#f1f5f9', fontFamily: 'system-ui, -apple-system, sans-serif',
          fontSize: 13, zIndex: 99999,
          display: 'flex', flexDirection: 'column', overflow: 'scroll',
        }}>

          {/* Header */}
          <div style={{ padding: '12px 14px', borderBottom: '1px solid #1e293b', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                {repairing ? 'Repairing tour' : 'Tour Recorder'}
              </div>
              {repairing && (
                <button
                  onClick={resetAll}
                  title="Discard this edit and start a brand-new tour"
                  style={{ ...btn('#1e293b'), fontSize: 11, padding: '3px 8px', color: '#a5b4fc' }}>
                  + New tour
                </button>
              )}
            </div>
            {repairing && (
              <div style={{ fontSize: 11, color: '#fbbf24', marginBottom: 8 }}>
                ✎ Editing an existing tour — Save updates it in place. Use “+ New tour” to create a fresh one.
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: 11, color: '#64748b', marginBottom: 3 }}>Title</label>
                <input
                  value={tourId}
                  onChange={e => setTourId(e.target.value)}
                  placeholder="e.g. v4.14  or  v4.14-knowledge-center"
                  style={INPUT}
                />
              </div>
              <div style={{ width: 120, flexShrink: 0 }}>
                <label style={{ display: 'block', fontSize: 11, color: '#64748b', marginBottom: 3 }}>Type</label>
                <select
                  value={tourType}
                  onChange={e => setTourType(e.target.value as Tour['type'])}
                  style={{ ...INPUT, height: 31, padding: '0 8px' }}
                >
                  <option value="release">release</option>
                  <option value="onboarding">onboarding</option>
                </select>
              </div>
            </div>
            <div style={{ fontSize: 10, color: '#475569', marginTop: 4 }}>
              Full release tour: name it the version (<code>v4.14</code>). Feature tour: prefix it (<code>v4.14-feature</code>).
            </div>
          </div>

          {/* Pending path pills — shown between steps */}
          {!pendingEl && !floatingForm && pendingPath.length > 0 && (
            <div style={{ padding: '8px 14px', borderBottom: '1px solid #1e293b', background: '#060f1e', flexShrink: 0 }}>
              <div style={{ fontSize: 11, color: '#475569', marginBottom: 2 }}>Recorded since last step:</div>
              <PathPills path={pendingPath} />
            </div>
          )}

          {/* Step form — for a captured element OR a floating (centered-modal) step */}
          {(pendingEl || floatingForm) && (() => {
            const loc = pendingEl ? buildLocator(pendingEl) : null;
            const signals = loc
              ? ([loc.testid && 'testid', loc.domId && 'id', loc.xpath && 'xpath'].filter(Boolean) as string[])
              : [];
            return (
            <div style={{ padding: '12px 14px', borderBottom: '1px solid #1e293b', background: '#060f1e', flexShrink: 0 }}>
              {pendingEl ? (
                <>
                  {/* Locator target status — captured automatically, no data-tour needed */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: '#10b981' }} />
                    <code style={{
                      fontSize: 11, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#6ee7b7',
                    }}>
                      {elementLabel(pendingEl)}
                    </code>
                    <span style={{ fontSize: 10, color: '#10b981' }}>✓ targetable</span>
                  </div>
                  <div style={{ fontSize: 10, color: '#475569', marginBottom: 8 }}>
                    Targets via {signals.join(' → ')} + signature — works at runtime with no code change.
                  </div>
                </>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: '#94a3b8' }} />
                  <code style={{ fontSize: 11, flex: 1, color: '#cbd5e1' }}>◇ Centered modal — no target</code>
                  <span style={{ fontSize: 10, color: '#94a3b8' }}>intro / banner</span>
                </div>
              )}

              {/* Prepare path for this step */}
              {pendingPath.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 11, color: '#475569', marginBottom: 2 }}>Prepare path for this step:</div>
                  <PathPills path={pendingPath} />
                </div>
              )}

              <input
                ref={titleInputRef}
                placeholder="Step title  (required)"
                value={stepTitle}
                onChange={e => setStepTitle(e.target.value)}
                onKeyDown={onTitleKeyDown}
                style={{ ...INPUT, marginBottom: 6 }}
              />
              <textarea
                placeholder="Description (optional)"
                value={stepBody}
                onChange={e => setStepBody(e.target.value)}
                rows={3}
                style={{ ...INPUT, resize: 'vertical', height: 60 }}
              />
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                <select
                  value={stepPlacement}
                  onChange={e => setStepPlacement(e.target.value as NonNullable<Step['placement']>)}
                  style={{ ...INPUT, flex: 1, height: 30, padding: '0 8px' }}
                >
                  {(['auto', 'top', 'bottom', 'left', 'right'] as const).map(p => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
                <button onClick={confirmStep} disabled={!stepTitle.trim()} style={btn(stepTitle.trim() ? '#6366f1' : '#1e293b')}>
                  Add Step
                </button>
                <button onClick={() => { setPendingEl(null); setPendingRect(null); setFloatingForm(false); }} style={btn('#374151')}>
                  Cancel
                </button>
              </div>
            </div>
            );
          })()}

          {/* Review hint */}
          {reviewing && steps.length > 0 && (
            <div style={{ padding: '8px 14px', borderBottom: '1px solid #1e293b', background: '#0b1220', flexShrink: 0, fontSize: 11, color: '#94a3b8' }}>
              {repairing
                ? 'Repairing — badges show live health on this screen. Click ⟳ to re-target a broken step, then Save. (Navigate to a step’s screen to check it.)'
                : 'Preview — hover or click a step to highlight it on the page. Remove any you don’t want, then Submit.'}
            </div>
          )}

          {/* Steps list */}
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {steps.length === 0 && !pendingEl ? (
              <div style={{ padding: '28px 14px', textAlign: 'center', color: '#475569', lineHeight: 1.7 }}>
                No steps yet.<br />
                <span style={{ fontSize: 12 }}>Navigate to the first element and click<br />"+ Capture element".</span>
              </div>
            ) : (
              steps.map((step, idx) => (
                <div
                  key={idx}
                  onMouseEnter={() => highlightStep(step)}
                  onClick={() => highlightStep(step)}
                  style={{ padding: '9px 14px', borderBottom: '1px solid #1e293b', display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}
                  onMouseOver={e => (e.currentTarget.style.background = '#111827')}
                  onMouseOut={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <span style={{ color: '#334155', fontSize: 11, marginTop: 2, width: 16, flexShrink: 0 }}>{idx + 1}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {step.title}
                    </div>
                    <div style={{ fontSize: 11, marginTop: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <code style={{ color: '#6ee7b7', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {locatorLabel(step.anchorId)}
                      </code>
                      {reviewing && (() => {
                        const b = healthBadge(stepHealth(step));
                        return <span style={{ fontSize: 10, color: b.color, flexShrink: 0 }}>{b.label}</span>;
                      })()}
                    </div>
                    {step.interactionPath.length > 0 && (
                      <PathPills path={step.interactionPath} />
                    )}
                  </div>
                  {reviewing && (
                    <button
                      title="Re-capture this step's target"
                      onClick={e => { e.stopPropagation(); setRecaptureIdx(idx); setIsCapturing(true); }}
                      style={{ ...btn('#1e293b'), padding: '0 7px', minWidth: 24, flexShrink: 0 }}
                    >⟳</button>
                  )}
                  {step.anchorId && (
                    <button
                      title="Remove target — show as a centered modal"
                      onClick={e => { e.stopPropagation(); makeStepFloating(idx); }}
                      style={{ ...btn('#1e293b'), padding: '0 7px', minWidth: 24, flexShrink: 0 }}
                    >◇</button>
                  )}
                  <button onClick={e => { e.stopPropagation(); removeStep(idx); }} style={{ ...btn('#1e293b'), padding: '0 7px', minWidth: 24, flexShrink: 0 }}>✕</button>
                </div>
              ))
            )}
          </div>

          {/* Footer actions */}
          <div style={{ padding: '10px 14px', borderTop: '1px solid #1e293b', display: 'flex', flexWrap: 'wrap', gap: 6, flexShrink: 0 }}>
            {/* ── Recording phase: capture steps, then Done ── */}
            {!reviewing && (
              <>
                {!pendingEl && !floatingForm && (
                  <button onClick={() => setIsCapturing(true)} style={btn('#6366f1')}>
                    + Capture element
                  </button>
                )}
                {!pendingEl && !floatingForm && (
                  <button
                    onClick={() => { setFloatingForm(true); setStepTitle(''); setStepBody(''); setStepPlacement('auto'); setTimeout(() => titleInputRef.current?.focus(), 50); }}
                    title="Add a centered modal step with no target (intro / banner)"
                    style={btn('#334155')}>
                    + Modal step
                  </button>
                )}
                {steps.length > 0 && !pendingEl && !floatingForm && (
                  <button onClick={() => { setReviewing(true); setSubmitted(false); }} style={btn('#0d9488')}>
                    ✓ Done
                  </button>
                )}
                {steps.length > 0 && (
                  <button onClick={resetAll} style={btn('#374151')}>
                    Clear
                  </button>
                )}
              </>
            )}

            {/* ── Review phase: preview tiles, then Submit ── */}
            {reviewing && (
              <>
                <button onClick={() => void handlePreview()} style={btn('#0d9488')}>
                  ▶ Preview
                </button>
                <button onClick={handleSubmit} disabled={!tourId.trim()} style={btn(tourId.trim() ? '#6366f1' : '#1e293b')}>
                  {repairing ? '✓ Save repairs' : '✓ Submit tour'}
                </button>
                <button onClick={() => { setReviewing(false); setSubmitted(false); }} style={btn('#374151')}>
                  ← Add more
                </button>
                <button onClick={resetAll} style={btn('#374151')}>
                  Clear
                </button>
              </>
            )}
          </div>

          {/* Submitted confirmation */}
          {submitted && (
            <div style={{ padding: '10px 14px', background: '#052e16', borderTop: '1px solid #166534', flexShrink: 0 }}>
              <div style={{ fontSize: 12, color: '#4ade80', fontWeight: 600 }}>
                ✓ Submitted — {steps.length} step{steps.length > 1 ? 's' : ''}
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

// ─── Shared styles ────────────────────────────────────────────────────────────

const INPUT: React.CSSProperties = {
  width: '100%', background: '#1e293b', border: '1px solid #334155',
  borderRadius: 6, color: '#f1f5f9', padding: '6px 10px',
  fontSize: 12, outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit',
};

function btn(bg: string): React.CSSProperties {
  return {
    background: bg, border: 'none', borderRadius: 6, color: '#f1f5f9',
    cursor: 'pointer', fontSize: 12, padding: '5px 12px', minHeight: 30,
    fontWeight: 500, whiteSpace: 'nowrap', flexShrink: 0,
  };
}
