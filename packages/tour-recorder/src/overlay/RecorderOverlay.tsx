import React, { useCallback, useEffect, useRef, useState } from 'react';
import { exportRecording } from '../export.js';
import type { Tour, Step, InteractionAction, StepGate } from '@guided-tour-s4marth/core';
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
  // Interactive step: wait for the user to act (gate) before advancing.
  advance?: Step['advance'];
  gate?: StepGate;
  allowSkip?: boolean;
  // Optional image (URL/data URI) shown when the step renders as a centered card
  // (a modal "slide" or a fallback). `fallbackBody` is alt text shown — together
  // with the image — when an anchored target can't be resolved at runtime.
  image?: string;
  fallbackBody?: string;
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
    if (s.advance) step.advance = s.advance;
    if (s.gate) step.gate = s.gate;
    if (s.allowSkip != null) step.allowSkip = s.allowSkip;
    if (s.image) step.image = s.image;
    if (s.fallbackBody) step.fallbackBody = s.fallbackBody;
    return step;
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const INTERACTIVE_SELECTOR =
  'button,a,input,select,textarea,[role="button"],[role="tab"],[role="menuitem"],[role="option"]';

function findBestTarget(el: Element): Element {
  const interactive = el.closest(INTERACTIVE_SELECTOR);
  if (interactive) return interactive;
  // Many controls (e.g. custom dropdown triggers) are <div onClick> with no role.
  // Climb to the nearest ancestor that *looks* clickable (cursor: pointer) so we
  // capture the trigger, not a giant text container behind it.
  let node: Element | null = el;
  for (let i = 0; node && i < 5; i++, node = node.parentElement) {
    try {
      if (getComputedStyle(node).cursor === 'pointer') return node;
    } catch {
      /* getComputedStyle can throw on detached nodes — ignore */
    }
  }
  return el;
}

// The recorder's own UI is marked with data-tour-recorder so neither capture nor
// the prepare-click tracker ever targets/records the panel, FAB, or banner.
// (panelRef alone misses the FAB and banner, which live outside the panel div.)
function isRecorderUI(el: EventTarget | Element | null): boolean {
  return !!(el && (el as Element).closest?.('[data-tour-recorder]'));
}

// Selectors that indicate an open dropdown / menu / popup appeared after a click.
// Used to detect the "open the selector" interaction so the step is gated on that
// click (and the NEXT step's target — inside the menu — is present at runtime).
const POPUP_SELECTOR =
  '[role="listbox"],[role="menu"],[role="tree"],[role="grid"],[role="dialog"],[aria-expanded="true"]';

function countPopups(): number {
  try { return document.querySelectorAll(POPUP_SELECTOR).length; } catch { return 0; }
}

// The first query param whose value changed between two URL search strings
// (added or modified). This is how we detect a "selection" (e.g. ?datasetId=42581)
// and gate the step on that param at runtime — robust, no DOM resolution needed.
function firstChangedParam(beforeSearch: string, afterSearch: string): string | null {
  const before = new URLSearchParams(beforeSearch);
  const after = new URLSearchParams(afterSearch);
  for (const [key, val] of after.entries()) {
    if (before.get(key) !== val) return key;
  }
  return null;
}

// Classify what a click DID, which decides how the step advances at runtime.
type ClickEffect =
  | { kind: 'navigate' }                          // changed the route path → replayed as `prepare`
  | { kind: 'select'; param: string }             // changed a URL param → gate on that param
  | { kind: 'open' }                              // opened a menu/popup → gate on the click
  | { kind: 'plain' };                            // nothing notable → presentational (Next)

function classifyClick(
  target: Element,
  before: { path: string; search: string; popups: number; hadPopupAttr: boolean },
): ClickEffect {
  if (window.location.pathname !== before.path) return { kind: 'navigate' };
  const param = firstChangedParam(before.search, window.location.search);
  if (param) return { kind: 'select', param };
  const openedPopup =
    countPopups() > before.popups ||
    (before.hadPopupAttr && target.getAttribute('aria-expanded') === 'true');
  if (openedPopup) return { kind: 'open' };
  return { kind: 'plain' };
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

function HighlightRing({ rect, anchorId, isGap, dim = true }: { rect: DOMRect; anchorId?: string | null; isGap?: boolean; dim?: boolean }) {
  const color = !anchorId ? '#94a3b8' : isGap ? '#f59e0b' : '#6366f1';
  const PAD = 4;
  return (
    <>
      {dim && <Spotlight rect={rect} />}
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
  // How the step being authored advances (auto-detected from what the click did;
  // editable in the form). undefined/'button' → Next; 'interaction' + gate → wait.
  const [stepAdvance, setStepAdvance] = useState<Step['advance']>(undefined);
  const [stepGate, setStepGate] = useState<StepGate | null>(null);
  // Optional centered-card image (modal slide / fallback) + alt text for when an
  // anchored target can't be resolved at runtime (e.g. a no-data user).
  const [stepImage, setStepImage] = useState('');
  const [stepFallbackBody, setStepFallbackBody] = useState('');

  // Record mode: the author walks through the real flow. Each click is captured,
  // classified (navigate / open menu / select / plain), and a detail form opens
  // pre-filled so they name it before moving on. Navigations replay as `prepare`.
  const [recordingFlow, setRecordingFlow] = useState(false);
  const recordingFlowRef = useRef(false);     // read inside the memoized nav handler
  const formOpenRef = useRef(false);          // a step form is open (configuring a step)
  // Capture mode while recording:
  //   'do'    — clicks pass through and perform the real action (navigate / open
  //             menu / select); the click is classified into a gated step.
  //   'point' — clicks are swallowed (no navigation); each just highlights the
  //             element as a "look here" Next step. For walkthroughs/explainers.
  const [captureMode, setCaptureMode] = useState<'do' | 'point'>('do');
  const captureModeRef = useRef<'do' | 'point'>('do');
  // The previous confirmed step's signature — used to skip a duplicate "open"
  // step when the author re-opens the same menu to continue capturing inside it.
  const lastConfirmedRef = useRef<{ anchorId?: string; click?: boolean } | null>(null);

  // Tour
  const [steps, setSteps] = useState<DraftStep[]>([]);
  const stepsCountRef = useRef(0); // live count for handlers inside stable effects
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

  // Panel placement: draggable (so it never blocks the element you're capturing)
  // and minimizable. `panelPos` null = default bottom-right anchor; once dragged
  // it switches to absolute left/top.
  const [panelPos, setPanelPos] = useState<{ x: number; y: number } | null>(null);
  const [minimized, setMinimized] = useState(false);

  // Drag the panel by its header. Ignore drags that start on a control.
  const startDrag = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button,input,select,textarea')) return;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    const offX = e.clientX - rect.left;
    const offY = e.clientY - rect.top;
    const onMove = (ev: MouseEvent) => {
      const x = Math.max(0, Math.min(window.innerWidth - 80, ev.clientX - offX));
      const y = Math.max(0, Math.min(window.innerHeight - 30, ev.clientY - offY));
      setPanelPos({ x, y });
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  }, []);

  // ── Navigation tracking ────────────────────────────────────────────────────
  // Track route changes whenever the panel is open so navigations between
  // steps get recorded as prepare actions on the next step.
  const handleNavigate = useCallback((route: string) => {
    // Track the current route only (for the click classifier's path-change
    // detection). Navigations are captured as their own gated "Go to …" steps
    // during recording, so we no longer write an implicit prepare path here —
    // that was leaking pre-recording/stray navigations into the first step.
    if (route === lastRouteRef.current) return;
    lastRouteRef.current = route;
  }, []);

  useEffect(() => { formOpenRef.current = !!pendingEl || floatingForm; }, [pendingEl, floatingForm]);
  useEffect(() => { recordingFlowRef.current = recordingFlow; }, [recordingFlow]);
  useEffect(() => { captureModeRef.current = captureMode; }, [captureMode]);
  useEffect(() => { stepsCountRef.current = steps.length; }, [steps]);

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

  // (Removed) The legacy "record stray clicks as prepare actions while the panel
  // is open but not recording" tracker. It caused recorder-UI and pre-recording
  // clicks to leak into the first step's prepare path. In the current model,
  // navigation is captured as its own gated step during recording, so no implicit
  // prepare path is needed — steps start with an empty prepare.

  // ── Record mode: capture each click, classify it, open the detail form ──────
  // We do NOT preventDefault, so the app behaves normally (links navigate, menus
  // open, selections happen). After the app reacts we classify the click by its
  // EFFECT and open a detail form pre-filled with a sensible title + the right
  // advance mode — the author writes the title/description, then "Add & continue".
  //   • navigate → recorded as `prepare`; the tour replays it (no step form).
  //   • open menu → interactive step gated on the click (so the menu is open for
  //                 the next step).
  //   • URL param changes → interactive step gated on that param ("select").
  //   • anything else → presentational step (advance on Next).
  useEffect(() => {
    if (!recordingFlow) return;

    const onClick = (e: MouseEvent) => {
      const raw = e.target as Element | null;
      if (!raw || isRecorderUI(raw)) return;
      // Don't capture while a detail form is open — the author is naming a step.
      if (formOpenRef.current) return;

      // ── Pointing mode: swallow the click (no navigation / no app action) and
      // add a presentational "look here" step. For explainer walkthroughs. ──
      if (captureModeRef.current === 'point') {
        e.preventDefault();
        e.stopPropagation();
        const target = findBestTarget(raw);
        setPendingEl(target);
        setPendingRect(target.getBoundingClientRect());
        setStepTitle('Look here');
        setStepBody('');
        setStepPlacement('auto');
        setStepAdvance('button');
        setStepGate(null);
        setStepImage(''); setStepFallbackBody('');
        setTimeout(() => titleInputRef.current?.focus(), 60);
        return;
      }

      const target = findBestTarget(raw);
      const before = {
        path: window.location.pathname,
        search: window.location.search,
        popups: countPopups(),
        hadPopupAttr: target.getAttribute('aria-haspopup') != null || target.getAttribute('aria-expanded') != null,
      };

      // Defer so the app has reacted (route pushed, menu opened, param changed).
      // SPA navigations can take a beat to commit, so we wait long enough to
      // catch them reliably — otherwise a nav click is mis-read as a plain step.
      window.setTimeout(() => {
        if (formOpenRef.current) return; // a capture already opened a form
        const effect = classifyClick(target, before);

        // Skip a duplicate "open" of the same menu (author re-opening it to keep
        // capturing the selection inside) — we already have that open step.
        const anchorId = encodeLocator(buildLocator(target));
        if (effect.kind === 'open' && lastConfirmedRef.current?.click && lastConfirmedRef.current.anchorId === anchorId) {
          return;
        }

        // Pre-fill the detail form for this capture.
        let title = 'Look here';
        let advance: Step['advance'] = 'button';
        let gate: StepGate | null = null;
        if (effect.kind === 'navigate') {
          // The click moved to a new screen → a gated "go here" step. Highlight
          // the link/control they clicked; advance when the path is reached, so
          // the tour navigates correctly when played from any starting page.
          const path = window.location.pathname;
          const seg = path.split('/').filter(Boolean).pop() || 'the next screen';
          title = `Go to ${seg}`;
          advance = 'interaction';
          gate = { route: { match: path } };
        }
        else if (effect.kind === 'select') { title = `Select a value for "${effect.param}"`; advance = 'interaction'; gate = { route: { param: effect.param } }; }
        else if (effect.kind === 'open') { title = 'Open this'; advance = 'interaction'; gate = { click: true }; }

        setPendingEl(target);
        setPendingRect(target.getBoundingClientRect());
        setStepTitle(title);
        setStepBody('');
        setStepPlacement('auto');
        setStepAdvance(advance);
        setStepGate(gate);
        setStepImage(''); setStepFallbackBody('');
        setTimeout(() => titleInputRef.current?.focus(), 60);
      }, 450);
    };
    // Hover highlight — show which element/div a click would capture, so the
    // author can see the exact target before committing (not everything is a click).
    const onMouseMove = (e: MouseEvent) => {
      if (formOpenRef.current) { setHoveredRect(null); setHoveredAnchorId(null); return; }
      const raw = document.elementFromPoint(e.clientX, e.clientY);
      if (!raw || isRecorderUI(raw)) { setHoveredRect(null); setHoveredAnchorId(null); return; }
      const best = findBestTarget(raw);
      setHoveredRect(best.getBoundingClientRect());
      setHoveredAnchorId(elementLabel(best));
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !formOpenRef.current) {
        setRecordingFlow(false);
        setHoveredRect(null); setHoveredAnchorId(null);
        setReviewing(prev => prev || stepsCountRef.current > 0);
      }
    };

    document.addEventListener('click', onClick, true); // capture phase; no preventDefault
    document.addEventListener('mousemove', onMouseMove, { passive: true });
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('keydown', onKey);
      setHoveredRect(null); setHoveredAnchorId(null);
    };
  }, [recordingFlow]);

  // ── Confirm step ──────────────────────────────────────────────────────────
  const confirmStep = useCallback(() => {
    // A targeted step needs a captured element; a floating step needs neither.
    if ((!pendingEl && !floatingForm) || !stepTitle.trim()) return;

    const interaction = stepAdvance === 'interaction' && stepGate != null;
    const step: DraftStep = {
      title: stepTitle.trim(),
      body: stepBody.trim(),
      placement: stepPlacement,
      interactionPath: [...pendingPath],
    };
    if (pendingEl) {
      const anchorId = encodeLocator(buildLocator(pendingEl));
      step.anchorId = anchorId;
      step.element = pendingEl;
      // Remember this step so re-opening the same menu doesn't add a duplicate.
      lastConfirmedRef.current = { anchorId, click: interaction && !!stepGate?.click };
    } else {
      lastConfirmedRef.current = null;
    }
    if (interaction) {
      step.advance = 'interaction';
      step.gate = stepGate ?? undefined;
      step.allowSkip = true;
    }
    if (stepImage.trim()) step.image = stepImage.trim();
    if (stepFallbackBody.trim()) step.fallbackBody = stepFallbackBody.trim();

    setSteps(prev => [...prev, step]);
    setPendingPath([]); // reset path — starts fresh for the next step
    setPendingEl(null); setPendingRect(null); setFloatingForm(false);
    setStepTitle(''); setStepBody(''); setStepPlacement('auto');
    setStepAdvance(undefined); setStepGate(null);
    setStepImage(''); setStepFallbackBody('');
    setSubmitted(false);
  }, [pendingEl, floatingForm, stepTitle, stepBody, stepPlacement, stepAdvance, stepGate, stepImage, stepFallbackBody, pendingPath]);

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

  const updateStep = (idx: number, patch: Partial<DraftStep>) => {
    setSteps(prev => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
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
    setRecordingFlow(false);
    recordingFlowRef.current = false;
    setStepAdvance(undefined);
    setStepGate(null);
    setStepImage(''); setStepFallbackBody('');
    lastConfirmedRef.current = null;
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
      {/* Recording hover — ring + label only (no dim, so the live app stays clear) */}
      {recordingFlow && !pendingEl && !floatingForm && hoveredRect && (
        <HighlightRing rect={hoveredRect} anchorId={hoveredAnchorId} isGap={false} dim={false} />
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

      {/* Recording banner — the author walks the real flow, one step at a time */}
      {recordingFlow && (
        <div data-tour-recorder="1" style={{
          position: 'fixed', top: 0, left: 0, right: 0, height: 44,
          background: '#4f46e5', color: '#fff', zIndex: 100001,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          gap: 16, fontSize: 13, fontWeight: 600,
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}>
          <span>
            {pendingEl
              ? '✍️ Name this step in the panel, then “Add & continue”'
              : captureMode === 'point'
                ? `✋ Pointing — click anything to add a “look here” step (no navigation)${steps.length > 0 ? `  ·  ${steps.length} step${steps.length > 1 ? 's' : ''}` : ''}`
                : `● Doing — click to perform & capture the real action${steps.length > 0 ? `  ·  ${steps.length} step${steps.length > 1 ? 's' : ''}` : ''}`}
          </span>
          {!pendingEl && (
            <>
              {/* Pointing / Doing toggle */}
              <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid #ffffff44' }}>
                <button
                  onClick={() => setCaptureMode('point')}
                  title="Point at elements and add explain/Next steps — clicks won't navigate"
                  style={{ ...btn(captureMode === 'point' ? '#ffffff' : 'transparent'), color: captureMode === 'point' ? '#4f46e5' : '#fff', borderRadius: 0, padding: '5px 10px' }}>
                  ✋ Point
                </button>
                <button
                  onClick={() => setCaptureMode('do')}
                  title="Perform the real flow — clicks navigate, open menus, select; each becomes an interactive step"
                  style={{ ...btn(captureMode === 'do' ? '#ffffff' : 'transparent'), color: captureMode === 'do' ? '#4f46e5' : '#fff', borderRadius: 0, padding: '5px 10px' }}>
                  ● Do
                </button>
              </div>
              <button
                onClick={() => { setRecordingFlow(false); setReviewing(steps.length > 0); }}
                style={btn('#ffffff33')}
              >
                ⏹  Stop  (Esc)
              </button>
            </>
          )}
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
          position: 'fixed',
          ...(panelPos ? { left: panelPos.x, top: panelPos.y } : { bottom: 84, right: 24 }),
          width: 370, maxHeight: minimized ? 44 : '80vh',
          background: '#0f172a', border: '1px solid #1e293b',
          borderRadius: 12, boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
          color: '#f1f5f9', fontFamily: 'system-ui, -apple-system, sans-serif',
          fontSize: 13, zIndex: 99999,
          display: 'flex', flexDirection: 'column', overflow: minimized ? 'hidden' : 'scroll',
        }}>

          {/* Header */}
          <div style={{ padding: '12px 14px', borderBottom: '1px solid #1e293b', flexShrink: 0 }}>
            {/* Title row doubles as the drag handle */}
            <div
              onMouseDown={startDrag}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: minimized ? 0 : 10, cursor: 'move', userSelect: 'none' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                ⠿ {repairing ? 'Repairing tour' : 'Tour Recorder'}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {repairing && !minimized && (
                  <button
                    onClick={resetAll}
                    title="Discard this edit and start a brand-new tour"
                    style={{ ...btn('#1e293b'), fontSize: 11, padding: '3px 8px', color: '#a5b4fc' }}>
                    + New tour
                  </button>
                )}
                <button
                  onClick={() => setMinimized(m => !m)}
                  title={minimized ? 'Expand' : 'Minimize'}
                  style={{ ...btn('#1e293b'), fontSize: 13, padding: '2px 9px', lineHeight: 1 }}>
                  {minimized ? '▢' : '—'}
                </button>
              </div>
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

              {/* Advance mode — auto-detected from what the click did, editable. */}
              {pendingEl && (() => {
                const mode = stepAdvance !== 'interaction'
                  ? 'next'
                  : stepGate?.route?.param != null ? 'param'
                  : stepGate?.route?.match != null ? 'navigate'
                  : 'click';
                return (
                  <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 11, color: '#94a3b8' }}>Advance:</span>
                    <select
                      value={mode}
                      onChange={e => {
                        const m = e.target.value;
                        if (m === 'next') { setStepAdvance('button'); setStepGate(null); }
                        else if (m === 'click') { setStepAdvance('interaction'); setStepGate({ click: true }); }
                        else if (m === 'navigate') { setStepAdvance('interaction'); setStepGate({ route: { match: stepGate?.route?.match || window.location.pathname } }); }
                        else { setStepAdvance('interaction'); setStepGate({ route: { param: stepGate?.route?.param || '' } }); }
                      }}
                      style={{ ...INPUT, width: 'auto', flex: 'none', height: 28, padding: '0 6px', fontSize: 11 }}
                    >
                      <option value="next">▸ Next button</option>
                      <option value="click">👆 Wait for click</option>
                      <option value="param">◎ Wait for URL param</option>
                      <option value="navigate">→ Wait for navigation</option>
                    </select>
                    {mode === 'param' && (
                      <input
                        value={stepGate?.route?.param || ''}
                        onChange={e => setStepGate({ route: { param: e.target.value } })}
                        placeholder="datasetId"
                        style={{ ...INPUT, width: 120, flex: 'none', height: 28, padding: '0 6px', fontSize: 11, fontFamily: 'monospace' }}
                      />
                    )}
                    {mode === 'navigate' && (
                      <input
                        value={stepGate?.route?.match || ''}
                        onChange={e => setStepGate({ route: { match: e.target.value } })}
                        placeholder="/app/explorer"
                        style={{ ...INPUT, width: 150, flex: 'none', height: 28, padding: '0 6px', fontSize: 11, fontFamily: 'monospace' }}
                      />
                    )}
                  </div>
                );
              })()}

              {/* Image (modal "slide") + fallback (shown if the target is missing) */}
              <div style={{ marginTop: 8, padding: '8px 10px', background: '#0b1220', borderRadius: 6, border: '1px solid #1e293b' }}>
                <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>
                  {pendingEl ? '🖼 Fallback (shown if the target isn’t on the page)' : '🖼 Slide image (optional)'}
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input
                    value={stepImage}
                    onChange={e => setStepImage(e.target.value)}
                    placeholder="Image URL"
                    style={{ ...INPUT, flex: 1, height: 28, padding: '0 6px', fontSize: 11 }}
                  />
                  <label style={{ ...btn('#334155'), fontSize: 11, padding: '5px 8px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}>
                    Upload
                    <input
                      type="file"
                      accept="image/*"
                      style={{ display: 'none' }}
                      onChange={e => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        const reader = new FileReader();
                        reader.onload = () => setStepImage(typeof reader.result === 'string' ? reader.result : '');
                        reader.readAsDataURL(file);
                      }}
                    />
                  </label>
                </div>
                {stepImage && (
                  <img src={stepImage} alt="" style={{ marginTop: 6, maxWidth: '100%', maxHeight: 90, borderRadius: 4, display: 'block', objectFit: 'contain' }} />
                )}
                {pendingEl && (
                  <input
                    value={stepFallbackBody}
                    onChange={e => setStepFallbackBody(e.target.value)}
                    placeholder="Fallback text (defaults to the description)"
                    style={{ ...INPUT, marginTop: 6, height: 28, padding: '0 6px', fontSize: 11 }}
                  />
                )}
              </div>

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
                  {recordingFlow ? 'Add & continue' : 'Add Step'}
                </button>
                <button
                  onClick={() => { setPendingEl(null); setPendingRect(null); setFloatingForm(false); setStepAdvance(undefined); setStepGate(null); setStepImage(''); setStepFallbackBody(''); }}
                  style={btn('#374151')}>
                  {recordingFlow ? 'Skip' : 'Cancel'}
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
                <span style={{ fontSize: 12 }}>Click <b style={{ color: '#818cf8' }}>● Record</b>, then click through the<br />flow — name each step as you go.</span>
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
                    {reviewing ? (
                      <input
                        value={step.title}
                        onChange={e => updateStep(idx, { title: e.target.value })}
                        onClick={e => e.stopPropagation()}
                        placeholder="Step title"
                        style={{
                          ...INPUT, padding: '3px 6px', fontSize: 12, fontWeight: 500,
                          background: '#0b1220', border: '1px solid #1e293b',
                        }}
                      />
                    ) : (
                      <div style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {step.title}
                      </div>
                    )}
                    <div style={{ fontSize: 11, marginTop: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <code style={{ color: '#6ee7b7', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {locatorLabel(step.anchorId)}
                      </code>
                      {step.advance === 'interaction' && (() => {
                        const g = step.gate;
                        const label = g?.route?.param ? `?${g.route.param}` : g?.route?.match ? `→ ${g.route.match}` : 'click';
                        const title = g?.route?.param ? `waits for ?${g.route.param}` : g?.route?.match ? `waits until at ${g.route.match}` : 'waits for a click';
                        return (
                          <span style={{ fontSize: 10, color: '#a5b4fc', flexShrink: 0 }} title={title}>
                            🖱 {label}
                          </span>
                        );
                      })()}
                      {(step.image || step.fallbackBody) && (
                        <span style={{ fontSize: 10, color: '#fbbf24', flexShrink: 0 }} title={step.image ? 'Has fallback image/text' : 'Has fallback text'}>
                          🖼 fallback
                        </span>
                      )}
                      {reviewing && (() => {
                        const h = stepHealth(step);
                        // For interaction steps, the target often lives inside a menu/popup
                        // that only exists after the PRIOR step opens it — so a live
                        // "broken" here is expected, not an error. Show a neutral note.
                        if (step.advance === 'interaction' && (h === 'broken' || h === 'mismatch')) {
                          return <span style={{ fontSize: 10, color: '#94a3b8', flexShrink: 0 }} title="Target appears once the previous step runs (e.g. an open menu). Verify with Preview.">◷ at runtime</span>;
                        }
                        const b = healthBadge(h);
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
            {!reviewing && !recordingFlow && (
              <>
                {!pendingEl && !floatingForm && (
                  <button
                    onClick={() => { lastConfirmedRef.current = null; setRecordingFlow(true); }}
                    title="Walk through the flow. Each click is captured and you name it before continuing — navigations replay automatically, dropdowns become guided 'open then select' steps."
                    style={btn('#6366f1')}>
                    ● Record
                  </button>
                )}
                {!pendingEl && !floatingForm && (
                  <button
                    onClick={() => { setFloatingForm(true); setStepTitle(''); setStepBody(''); setStepPlacement('auto'); setStepAdvance(undefined); setStepGate(null); setStepImage(''); setStepFallbackBody(''); setTimeout(() => titleInputRef.current?.focus(), 50); }}
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

            {/* ── Recording in progress (form, if open, is shown above) ── */}
            {!reviewing && recordingFlow && !pendingEl && !floatingForm && (
              <>
                <span style={{ fontSize: 12, color: '#a5b4fc', fontWeight: 600, alignSelf: 'center', marginRight: 'auto' }}>
                  {captureMode === 'point' ? '✋ Pointing — click to explain (no navigation)' : '● Doing — click to perform & capture'}
                </span>
                <button
                  onClick={() => { setFloatingForm(true); setStepTitle(''); setStepBody(''); setStepPlacement('auto'); setStepAdvance(undefined); setStepGate(null); setStepImage(''); setStepFallbackBody(''); setTimeout(() => titleInputRef.current?.focus(), 50); }}
                  title="Add a centered modal step (e.g. a Welcome slide) — no target"
                  style={btn('#334155')}>
                  + Modal
                </button>
                <button
                  onClick={() => { setRecordingFlow(false); setReviewing(stepsCountRef.current > 0); }}
                  style={btn('#dc2626')}>
                  ⏹ Stop{stepsCountRef.current > 0 ? ` (${stepsCountRef.current})` : ''}
                </button>
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
