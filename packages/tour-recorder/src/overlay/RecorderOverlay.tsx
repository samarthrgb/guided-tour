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
  // The route (pathname) this step was recorded on. The player navigates here
  // before showing the step, so the tour plays from any starting page.
  route?: string;
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
  onSubmit?: (result: ReturnType<typeof exportRecording>) => void | Promise<void>;
  /** Called when saving repairs to an existing tour (repair mode). The host
   *  should persist the edited steps to the existing tour (update by id) so the
   *  fix takes effect with no deploy. Falls back to onSubmit if not provided. */
  onSaveRepair?: (result: ReturnType<typeof exportRecording>) => void | Promise<void>;
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
  /** Capture the app's current mode/context (e.g. { experience }) at record time.
   *  Stored on the tour draft and restored via applyContext before replay. */
  captureContext?: () => Record<string, unknown> | undefined;
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
    if (s.route) step.route = s.route;
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

// Downscale + re-encode an uploaded image before storing it on the step, so the
// tour payload stays small (data URIs bloat the record) and the fallback card
// renders fast. Falls back to the raw data URI if anything goes wrong.
async function compressImage(file: File, maxDim = 1000, quality = 0.8): Promise<string> {
  const raw = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(typeof r.result === 'string' ? r.result : '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('decode failed'));
      img.src = raw;
    });
    let { width, height } = img;
    if (Math.max(width, height) > maxDim) {
      const scale = maxDim / Math.max(width, height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return raw;
    ctx.drawImage(img, 0, 0, width, height);
    const out = canvas.toDataURL('image/jpeg', quality);
    return out.length < raw.length ? out : raw; // keep whichever is smaller
  } catch {
    return raw;
  }
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
  if (!anchorId) return 'Centered modal (no target)';
  const loc = decodeLocator(anchorId);
  if (!loc) return anchorId;
  const sig = loc.signature;
  const primary = sig.name || sig.text || loc.testid || loc.domId;
  return primary ? `${sig.tag} · ${primary}` : sig.tag;
}

// ── Target strength ─────────────────────────────────────────────────────────
// How durable a captured element's locator is, from its strongest signal:
//   strong — the element has its own unique test id (data-testid/data-test)
//   medium — no own test id, but anchored to a nearby test id OR an element id
//   weak   — none of the above; matched only by position (xpath) + text/signature
// Surfaced per step so authors see which targets need a data-testid to survive a
// UI refactor. Derived from a built locator (from a live element or a decoded id).
type Strength = 'strong' | 'medium' | 'weak';
interface TargetInfo {
  tier: Strength;
  via: string;
  hint: string;
}
function targetInfoFromLocator(loc: ReturnType<typeof buildLocator>): TargetInfo {
  if (loc.testid) return { tier: 'strong', via: 'data-testid', hint: 'Anchored to a unique test id — the most durable target. Survives most UI changes.' };
  if (loc.scope) return { tier: 'medium', via: 'nearby test id', hint: 'No id on the element itself, so it’s anchored to a nearby test id + position. Fairly stable.' };
  if (loc.domId) return { tier: 'medium', via: 'element id', hint: 'Anchored to the element’s id. Stable unless that id changes.' };
  return { tier: 'weak', via: 'position + text', hint: 'No id found — matched by position and text, which can break on a redesign. Add a data-testid to this element for a durable anchor.' };
}
function targetInfoFromAnchor(anchorId?: string): TargetInfo | null {
  if (!anchorId) return null;
  const loc = decodeLocator(anchorId);
  if (!loc) return null;
  // decodeLocator yields a TourLocator with the same signal fields buildLocator emits.
  return targetInfoFromLocator(loc as ReturnType<typeof buildLocator>);
}
const STRENGTH_META: Record<Strength, { color: string; bg: string; label: string }> = {
  strong: { color: '#34d399', bg: 'rgba(52,211,153,0.14)', label: 'Strong' },
  medium: { color: '#fbbf24', bg: 'rgba(251,191,36,0.14)', label: 'OK' },
  weak: { color: '#f87171', bg: 'rgba(248,113,113,0.14)', label: 'Weak' },
};

// A small strength chip (dot + label). Reused in the step form and step list.
function StrengthChip({ info, showLabel = true }: { info: TargetInfo; showLabel?: boolean }) {
  const m = STRENGTH_META[info.tier];
  return (
    <span
      title={`${m.label} target · ${info.via}\n${info.hint}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0,
        padding: showLabel ? '2px 8px' : 0, borderRadius: 999,
        background: showLabel ? m.bg : 'transparent',
        color: m.color, fontSize: 10.5, fontWeight: 600, whiteSpace: 'nowrap',
      }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: m.color, flexShrink: 0 }} />
      {showLabel && <>{m.label} · {info.via}</>}
    </span>
  );
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

export function RecorderOverlay({ tourType: initialTourType = 'release', onSubmit, onSaveRepair, navigate, repairTour, onRepairConsumed, captureContext }: RecorderOverlayProps) {
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
  // The route the element being authored lives on — captured at form-open. For a
  // click that navigated, this is the SOURCE page (before nav), NOT the destination,
  // so the step highlights the control on the page it's actually on.
  const [pendingRoute, setPendingRoute] = useState<string>('');
  // Optional centered-card image (modal slide / fallback) + alt text for when an
  // anchored target can't be resolved at runtime (e.g. a no-data user).
  const [stepImage, setStepImage] = useState('');
  const [stepFallbackBody, setStepFallbackBody] = useState('');
  // Editing an ALREADY-recorded step (from the review list): the form is opened
  // pre-filled with that step's content. Confirm updates it in place (title, body,
  // advance/gate, image, fallback, placement) — the anchor is left untouched (use
  // the re-target button to change it). null = not editing an existing step.
  const [editingIdx, setEditingIdx] = useState<number | null>(null);

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
  const [saving, setSaving] = useState(false); // awaiting onSubmit/onSaveRepair
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
        setPendingRoute(window.location.pathname); // current page (no nav happened)
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
          // The click moved to a new screen. Default to a PRESENTATIONAL "go here"
          // step: highlight the control on its SOURCE page (before.path); the tour
          // navigates on Next via the NEXT step's captured route. Authors who want
          // the user to actually click it can switch to "Wait for navigation" in
          // the Advance dropdown. (Fixes: step was forced interactive + its route
          // was the destination, so the player pre-navigated and skipped it.)
          const seg = window.location.pathname.split('/').filter(Boolean).pop() || 'the next screen';
          title = `Go to ${seg}`;
          advance = 'button';
          gate = null;
        }
        else if (effect.kind === 'select') { title = `Select a value for "${effect.param}"`; advance = 'interaction'; gate = { route: { param: effect.param } }; }
        else if (effect.kind === 'open') { title = 'Open this'; advance = 'interaction'; gate = { click: true }; }

        setPendingEl(target);
        setPendingRect(target.getBoundingClientRect());
        setPendingRoute(before.path); // SOURCE page (before this click navigated)
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

  // Reset every step-form field (shared by confirm/cancel/edit paths).
  const resetForm = useCallback(() => {
    setPendingEl(null); setPendingRect(null); setFloatingForm(false);
    setEditingIdx(null);
    setStepTitle(''); setStepBody(''); setStepPlacement('auto');
    setStepAdvance(undefined); setStepGate(null); setPendingRoute('');
    setStepImage(''); setStepFallbackBody('');
  }, []);

  // ── Confirm step ──────────────────────────────────────────────────────────
  const confirmStep = useCallback(() => {
    // Editing an existing step (from the review list): update its content in place.
    // The anchor/route/prepare are preserved — only the authored fields change.
    if (editingIdx !== null) {
      if (!stepTitle.trim()) return;
      setSteps(prev => prev.map((s, i) => {
        if (i !== editingIdx) return s;
        const next: DraftStep = { ...s, title: stepTitle.trim(), body: stepBody.trim(), placement: stepPlacement };
        // Set-or-remove optionals (exactOptionalPropertyTypes: never assign undefined).
        if (stepAdvance === 'interaction' && stepGate) {
          next.advance = 'interaction';
          next.gate = stepGate;
          next.allowSkip = true;
        } else {
          delete next.advance;
          delete next.gate;
          delete next.allowSkip;
        }
        if (stepImage.trim()) next.image = stepImage.trim(); else delete next.image;
        if (stepFallbackBody.trim()) next.fallbackBody = stepFallbackBody.trim(); else delete next.fallbackBody;
        return next;
      }));
      resetForm();
      setSubmitted(false);
      return;
    }

    // A targeted step needs a captured element; a floating step needs neither.
    if ((!pendingEl && !floatingForm) || !stepTitle.trim()) return;

    const interaction = stepAdvance === 'interaction' && stepGate != null;
    const step: DraftStep = {
      title: stepTitle.trim(),
      body: stepBody.trim(),
      placement: stepPlacement,
      // SOURCE page the element lives on (captured at form-open) — for a nav click
      // this is the page BEFORE it navigated, so the player shows it there.
      route: pendingRoute || window.location.pathname,
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
    resetForm();
    setSubmitted(false);
  }, [pendingEl, floatingForm, editingIdx, stepTitle, stepBody, stepPlacement, stepAdvance, stepGate, pendingRoute, stepImage, stepFallbackBody, pendingPath, resetForm]);

  // Open the step form to EDIT an already-recorded step's content (from review).
  // The anchor stays as-is — only title/body/advance/image/fallback/placement are
  // editable here; use the re-target button to change what the step points at.
  const editStep = useCallback((idx: number) => {
    const s = steps[idx];
    if (!s) return;
    setPendingEl(null); setPendingRect(null); setFloatingForm(false);
    setEditingIdx(idx);
    setStepTitle(s.title);
    setStepBody(s.body);
    setStepPlacement(s.placement);
    setStepAdvance(s.advance);
    setStepGate(s.gate ?? null);
    setStepImage(s.image ?? '');
    setStepFallbackBody(s.fallbackBody ?? '');
    setPendingRoute(s.route ?? '');
    setTimeout(() => titleInputRef.current?.focus(), 50);
  }, [steps]);

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
  const handleSubmit = async () => {
    if (saving) return;
    const result = exportRecording(tourId, tourType, undefined, steps, [], captureContext?.());
    setSaving(true);
    try {
      if (repairing && onSaveRepair) {
        // Preserve the original id so we PATCH the existing record, not create a
        // new one keyed by the (editable) title.
        if (repairOriginalId.current) result.draft.id = repairOriginalId.current;
        await onSaveRepair(result);
      } else {
        await onSubmit?.(result);
      }
      setSubmitted(true);
    } catch {
      /* host surfaces the error (RTK state) — just stop the spinner */
    } finally {
      setSaving(false);
    }
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
    setEditingIdx(null);
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
      {/* Recorder stylesheet — keyframes + hover/focus/entrance transitions. */}
      <style>{RECORDER_CSS}</style>
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

      {/* Unified status pill — one compact, centered element for BOTH capture and
          recording, instead of a full-width banner. Fewer things move on screen. */}
      {(isCapturing || recordingFlow) && (() => {
        const formOpen = !!pendingEl || floatingForm;
        const active = isCapturing || captureMode === 'do';
        const dot = active ? '#818cf8' : '#94a3b8';
        const count = steps.length > 0 ? `  ·  ${steps.length} step${steps.length > 1 ? 's' : ''}` : '';
        let text: string;
        if (isCapturing) {
          text = recaptureIdx !== null
            ? `Re-targeting step ${recaptureIdx + 1} — click the new element`
            : 'Click an element to capture — navigate freely, it’s recorded';
        } else if (formOpen) {
          text = 'Name this step in the panel, then Add & continue';
        } else {
          text = captureMode === 'point'
            ? `Pointing — click anything to add a “look here” step${count}`
            : `Recording — click to perform & capture${count}`;
        }
        return (
          <div data-tour-recorder="1" className="tr-pill" style={{
            position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)',
            zIndex: 100001, display: 'flex', alignItems: 'center', gap: 12,
            padding: '7px 8px 7px 16px', borderRadius: 999, maxWidth: '92vw',
            background: 'rgba(11,15,26,0.92)', backdropFilter: 'blur(10px)',
            border: `1px solid ${UI.border}`, color: UI.text, fontFamily: UI.font,
            fontSize: 12.5, fontWeight: 600, boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
          }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: dot, flexShrink: 0, boxShadow: `0 0 0 4px ${dot}22` }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{text}</span>
            {isCapturing && (
              <button
                className="tr-btn tr-ghost"
                onClick={() => { setIsCapturing(false); setRecaptureIdx(null); setHoveredRect(null); setHoveredAnchorId(null); }}
                style={{ ...btn('ghost'), padding: '5px 11px', minHeight: 28 }}>
                Cancel
              </button>
            )}
            {recordingFlow && !formOpen && (
              <>
                <span style={{ display: 'inline-flex', gap: 2, background: UI.bgInput, borderRadius: 999, padding: 2, border: `1px solid ${UI.border}` }}>
                  {(['point', 'do'] as const).map(m => (
                    <button
                      key={m}
                      className="tr-seg"
                      onClick={() => setCaptureMode(m)}
                      title={m === 'point' ? 'Point at elements — clicks won’t navigate' : 'Perform the real flow — clicks navigate, open menus, select'}
                      style={{
                        border: 'none', cursor: 'pointer', borderRadius: 999, padding: '4px 13px',
                        fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
                        background: captureMode === m ? UI.accent : 'transparent',
                        color: captureMode === m ? '#fff' : UI.muted,
                      }}>
                      {m === 'point' ? 'Point' : 'Do'}
                    </button>
                  ))}
                </span>
                <button
                  className="tr-btn"
                  onClick={() => { setRecordingFlow(false); setReviewing(steps.length > 0); }}
                  style={{ ...btn('secondary'), padding: '5px 12px', minHeight: 28 }}>
                  Stop
                </button>
              </>
            )}
          </div>
        );
      })()}

      {/* Floating toggle (FAB) — pulses while capture/recording is live. */}
      <button
        data-tour-recorder="1"
        className={`tr-fab${isCapturing || recordingFlow ? ' tr-fab-rec' : ''}`}
        onClick={() => setIsOpen(o => !o)}
        title="Tour Recorder"
        style={{
          position: 'fixed', bottom: 24, right: 24,
          width: 52, height: 52, borderRadius: '50%',
          background: isOpen ? '#1b2333' : UI.accent,
          border: `1px solid ${isOpen ? UI.border : 'transparent'}`,
          color: '#fff', cursor: 'pointer', zIndex: 100000,
          boxShadow: isOpen ? '0 6px 20px rgba(0,0,0,0.45)' : '0 6px 20px rgba(99,102,241,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
        {isOpen ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        ) : (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="#fff" strokeWidth="1.6" opacity="0.5" /><circle cx="12" cy="12" r="5" fill="#fff" /></svg>
        )}
      </button>

      {/* Panel */}
      {isOpen && (
        <div ref={panelRef} data-tour-recorder="1" className="tr-panel" style={{
          position: 'fixed',
          ...(panelPos ? { left: panelPos.x, top: panelPos.y } : { bottom: 88, right: 24 }),
          width: 384, maxHeight: minimized ? 46 : '82vh',
          background: UI.bg, border: `1px solid ${UI.border}`,
          borderRadius: UI.radius, boxShadow: '0 24px 70px rgba(0,0,0,0.62)',
          color: UI.text, fontFamily: UI.font, fontSize: 13, zIndex: 99999,
          display: 'flex', flexDirection: 'column', overflow: minimized ? 'hidden' : 'auto',
        }}>

          {/* Header */}
          <div style={{ flexShrink: 0, borderBottom: `1px solid ${UI.border}` }}>
            {/* Title row doubles as the drag handle */}
            <div
              onMouseDown={startDrag}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', cursor: 'move', userSelect: 'none' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, flexShrink: 0, background: repairing ? '#fbbf24' : UI.accent, boxShadow: `0 0 0 3px ${repairing ? 'rgba(251,191,36,0.18)' : 'rgba(99,102,241,0.2)'}` }} />
                <span style={{ fontSize: 13, fontWeight: 700, color: UI.text, letterSpacing: '-0.01em' }}>
                  {repairing ? 'Editing tour' : 'Tour Recorder'}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {repairing && !minimized && (
                  <button
                    className="tr-btn tr-ghost"
                    onClick={resetAll}
                    title="Discard this edit and start a brand-new tour"
                    style={{ ...btn('ghost'), fontSize: 11.5, padding: '4px 10px', minHeight: 26, color: '#a5b4fc' }}>
                    New tour
                  </button>
                )}
                <button
                  className="tr-btn tr-ghost"
                  onClick={() => setMinimized(m => !m)}
                  title={minimized ? 'Expand' : 'Minimize'}
                  style={{ ...btn('icon'), minWidth: 26, minHeight: 26, borderColor: 'transparent' }}>
                  {minimized
                    ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 14h6v6M20 10h-6V4" /></svg>
                    : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 12h14" /></svg>}
                </button>
              </div>
            </div>
            {!minimized && (
              <div style={{ padding: '0 14px 12px' }}>
                {repairing && (
                  <div style={{ fontSize: 11, color: '#fbbf24', marginBottom: 10, background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.22)', borderRadius: 8, padding: '6px 9px', lineHeight: 1.45 }}>
                    Editing an existing tour — Save updates it in place. Use “New tour” to start fresh.
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <div style={{ flex: 1 }}>
                    <label style={LBL}>Title</label>
                    <input
                      className="tr-input"
                      value={tourId}
                      onChange={e => setTourId(e.target.value)}
                      placeholder="e.g. v4.14 · Top Stories"
                      style={INPUT}
                    />
                  </div>
                  <div style={{ width: 118, flexShrink: 0 }}>
                    <label style={LBL}>Type</label>
                    <select
                      className="tr-input"
                      value={tourType}
                      onChange={e => setTourType(e.target.value as Tour['type'])}
                      style={{ ...INPUT, height: 33, padding: '0 8px' }}
                    >
                      <option value="release">release</option>
                      <option value="onboarding">onboarding</option>
                      <option value="feature">feature</option>
                    </select>
                  </div>
                </div>
                <div style={{ fontSize: 10.5, color: UI.faint, marginTop: 6, lineHeight: 1.5 }}>
                  {tourType === 'release'
                    ? <>Name it the release version (<code style={CODE}>v4.14</code>) to map it to the release note.</>
                    : tourType === 'feature'
                      ? <>Name it exactly the Help Center card title (e.g. <code style={CODE}>Top Stories</code>).</>
                      : <>Onboarding walkthrough — shown from the “See how DG works” entry point.</>}
                </div>
              </div>
            )}
          </div>

          {/* Pending path pills — shown between steps */}
          {!pendingEl && !floatingForm && editingIdx === null && pendingPath.length > 0 && (
            <div style={{ padding: '8px 14px', borderBottom: `1px solid ${UI.border}`, background: UI.bgSunken, flexShrink: 0 }}>
              <div style={{ fontSize: 10.5, color: UI.faint, marginBottom: 3 }}>Recorded since last step</div>
              <PathPills path={pendingPath} />
            </div>
          )}

          {/* Step form — for a NEW captured element, a NEW floating step, OR editing
              an existing step's content (from the review list). */}
          {(pendingEl || floatingForm || editingIdx !== null) && (() => {
            const editingStep = editingIdx !== null ? steps[editingIdx] : null;
            const loc = pendingEl ? buildLocator(pendingEl) : null;
            // Strength: from the live element (new capture) or the step's stored anchor (edit).
            const info = loc ? targetInfoFromLocator(loc) : editingStep ? targetInfoFromAnchor(editingStep.anchorId) : null;
            const hasTarget = !!pendingEl || !!editingStep?.anchorId;
            const label = pendingEl ? elementLabel(pendingEl) : locatorLabel(editingStep?.anchorId);
            return (
            <div style={{ padding: '13px 14px', borderBottom: `1px solid ${UI.border}`, background: UI.bgElev, flexShrink: 0 }}>
              {editingStep && (
                <div style={{ fontSize: 11, fontWeight: 600, color: '#a5b4fc', marginBottom: 8 }}>
                  Editing step {editingIdx! + 1}
                </div>
              )}
              {/* Target quality card — how durable this step's anchor is */}
              {hasTarget && info ? (
                <div style={{ marginBottom: 10, padding: '9px 11px', borderRadius: 10, background: UI.bgSunken, border: `1px solid ${UI.border}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <code style={{ fontFamily: UI.mono, fontSize: 11.5, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: UI.text }}>
                      {label}
                    </code>
                    <StrengthChip info={info} />
                  </div>
                  <div style={{ fontSize: 10.5, color: info.tier === 'weak' ? '#fca5a5' : UI.faint, marginTop: 6, lineHeight: 1.5 }}>
                    {editingStep ? 'Anchor unchanged — use the re-target button in the list to change what this step points at.' : info.hint}
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, padding: '9px 11px', borderRadius: 10, background: UI.bgSunken, border: `1px solid ${UI.border}` }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: UI.muted }} />
                  <span style={{ fontSize: 11.5, flex: 1, color: UI.muted }}>Centered modal — no target</span>
                  <span style={{ fontSize: 10.5, color: UI.faint }}>intro / banner</span>
                </div>
              )}

              {/* Prepare path for this step */}
              {pendingPath.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 10.5, color: UI.faint, marginBottom: 3 }}>Prepare path for this step</div>
                  <PathPills path={pendingPath} />
                </div>
              )}

              <input
                ref={titleInputRef}
                className="tr-input"
                placeholder="Step title  (required)"
                value={stepTitle}
                onChange={e => setStepTitle(e.target.value)}
                onKeyDown={onTitleKeyDown}
                style={{ ...INPUT, marginBottom: 6 }}
              />
              <textarea
                className="tr-input"
                placeholder="Description (optional)"
                value={stepBody}
                onChange={e => setStepBody(e.target.value)}
                rows={3}
                style={{ ...INPUT, resize: 'vertical', height: 60 }}
              />

              {/* Advance mode — auto-detected from what the click did, editable. */}
              {hasTarget && (() => {
                const mode = stepAdvance !== 'interaction'
                  ? 'next'
                  : stepGate?.route?.param != null ? 'param'
                  : stepGate?.route?.match != null ? 'navigate'
                  : 'click';
                return (
                  <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 11, color: UI.muted, fontWeight: 600 }}>Advance</span>
                    <select
                      className="tr-input"
                      value={mode}
                      onChange={e => {
                        const m = e.target.value;
                        if (m === 'next') { setStepAdvance('button'); setStepGate(null); }
                        else if (m === 'click') { setStepAdvance('interaction'); setStepGate({ click: true }); }
                        else if (m === 'navigate') { setStepAdvance('interaction'); setStepGate({ route: { match: stepGate?.route?.match || window.location.pathname } }); }
                        else { setStepAdvance('interaction'); setStepGate({ route: { param: stepGate?.route?.param || '' } }); }
                      }}
                      style={{ ...INPUT, width: 'auto', flex: 'none', height: 30, padding: '0 8px', fontSize: 11.5 }}
                    >
                      <option value="next">On Next button</option>
                      <option value="click">Wait for click</option>
                      <option value="param">Wait for URL param</option>
                      <option value="navigate">Wait for navigation</option>
                    </select>
                    {mode === 'param' && (
                      <input
                        className="tr-input"
                        value={stepGate?.route?.param || ''}
                        onChange={e => setStepGate({ route: { param: e.target.value } })}
                        placeholder="datasetId"
                        style={{ ...INPUT, width: 120, flex: 'none', height: 30, padding: '0 8px', fontSize: 11.5, fontFamily: UI.mono }}
                      />
                    )}
                    {mode === 'navigate' && (
                      <input
                        className="tr-input"
                        value={stepGate?.route?.match || ''}
                        onChange={e => setStepGate({ route: { match: e.target.value } })}
                        placeholder="/app/explorer"
                        style={{ ...INPUT, width: 150, flex: 'none', height: 30, padding: '0 8px', fontSize: 11.5, fontFamily: UI.mono }}
                      />
                    )}
                  </div>
                );
              })()}

              {/* Image (modal "slide") + fallback (shown if the target is missing) */}
              <div style={{ marginTop: 10, padding: '9px 11px', background: UI.bgSunken, borderRadius: 10, border: `1px solid ${UI.border}` }}>
                <div style={{ fontSize: 10.5, color: UI.muted, marginBottom: 6, fontWeight: 600 }}>
                  {hasTarget ? 'Fallback image — shown if the target isn’t on the page' : 'Slide image (optional)'}
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input
                    className="tr-input"
                    value={stepImage}
                    onChange={e => setStepImage(e.target.value)}
                    placeholder="Image URL"
                    style={{ ...INPUT, flex: 1, height: 30, padding: '0 8px', fontSize: 11.5 }}
                  />
                  <label className="tr-btn" style={{ ...btn('secondary'), fontSize: 11.5, padding: '6px 11px', cursor: 'pointer', minHeight: 30 }}>
                    Upload
                    <input
                      type="file"
                      accept="image/*"
                      style={{ display: 'none' }}
                      onChange={e => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        // Downscale + re-encode so the stored data URI stays small.
                        void compressImage(file).then(setStepImage);
                      }}
                    />
                  </label>
                </div>
                {stepImage && (
                  <img src={stepImage} alt="" style={{ marginTop: 7, maxWidth: '100%', maxHeight: 90, borderRadius: 6, display: 'block', objectFit: 'contain' }} />
                )}
                {hasTarget && (
                  <input
                    className="tr-input"
                    value={stepFallbackBody}
                    onChange={e => setStepFallbackBody(e.target.value)}
                    placeholder="Fallback text (defaults to the description)"
                    style={{ ...INPUT, marginTop: 7, height: 30, padding: '0 8px', fontSize: 11.5 }}
                  />
                )}
              </div>

              <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                <select
                  className="tr-input"
                  value={stepPlacement}
                  onChange={e => setStepPlacement(e.target.value as NonNullable<Step['placement']>)}
                  style={{ ...INPUT, flex: 1, height: 32, padding: '0 8px' }}
                >
                  {(['auto', 'top', 'bottom', 'left', 'right'] as const).map(p => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
                <button className="tr-btn" onClick={confirmStep} disabled={!stepTitle.trim()} style={btn(stepTitle.trim() ? 'primary' : 'secondary')}>
                  {editingIdx !== null ? 'Save changes' : recordingFlow ? 'Add & continue' : 'Add step'}
                </button>
                <button
                  className="tr-btn tr-ghost"
                  onClick={resetForm}
                  style={btn('ghost')}>
                  {editingIdx !== null ? 'Cancel' : recordingFlow ? 'Skip' : 'Cancel'}
                </button>
              </div>
            </div>
            );
          })()}

          {/* Review hint */}
          {reviewing && steps.length > 0 && (
            <div style={{ padding: '9px 14px', borderBottom: `1px solid ${UI.border}`, background: UI.bgElev, flexShrink: 0, fontSize: 11, color: UI.muted, lineHeight: 1.5 }}>
              {repairing
                ? 'Repairing — badges show live health on this screen. Use the re-target button on a broken step, then Save.'
                : 'Hover or click a step to highlight it on the page. The coloured dot shows how durable each target is.'}
            </div>
          )}

          {/* Steps list */}
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {steps.length === 0 && !pendingEl ? (
              <div style={{ padding: '32px 20px', textAlign: 'center', color: UI.faint, lineHeight: 1.7 }}>
                <div style={{ fontSize: 13, color: UI.muted, fontWeight: 600, marginBottom: 4 }}>No steps yet</div>
                <span style={{ fontSize: 12 }}>Hit <b style={{ color: '#a5b4fc' }}>Record</b> and click through the flow — name each step as you go.</span>
              </div>
            ) : (
              steps.map((step, idx) => {
                const info = targetInfoFromAnchor(step.anchorId);
                return (
                <div
                  key={idx}
                  className="tr-row"
                  onMouseEnter={() => highlightStep(step)}
                  onClick={() => highlightStep(step)}
                  style={{ padding: '10px 12px 10px 14px', borderBottom: `1px solid ${UI.border}`, display: 'flex', alignItems: 'flex-start', gap: 9, cursor: 'pointer' }}
                >
                  <span style={{ color: UI.faint, fontSize: 11, fontWeight: 600, marginTop: 3, width: 15, flexShrink: 0, textAlign: 'right' }}>{idx + 1}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {reviewing ? (
                      <input
                        className="tr-input"
                        value={step.title}
                        onChange={e => updateStep(idx, { title: e.target.value })}
                        onClick={e => e.stopPropagation()}
                        placeholder="Step title"
                        style={{ ...INPUT, padding: '4px 7px', fontSize: 12.5, fontWeight: 500, background: UI.bgInput }}
                      />
                    ) : (
                      <div style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {step.title}
                      </div>
                    )}
                    <div style={{ fontSize: 11, marginTop: 3, display: 'flex', alignItems: 'center', gap: 6 }}>
                      {info && <StrengthChip info={info} showLabel={false} />}
                      <code style={{ fontFamily: UI.mono, color: UI.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {locatorLabel(step.anchorId)}
                      </code>
                      {step.advance === 'interaction' && (() => {
                        const g = step.gate;
                        const label = g?.route?.param ? `?${g.route.param}` : g?.route?.match ? `→ ${g.route.match}` : 'click';
                        const title = g?.route?.param ? `waits for ?${g.route.param}` : g?.route?.match ? `waits until at ${g.route.match}` : 'waits for a click';
                        return (
                          <span style={{ fontSize: 10, color: '#a5b4fc', flexShrink: 0 }} title={title}>
                            {label}
                          </span>
                        );
                      })()}
                      {(step.image || step.fallbackBody) && (
                        <span style={{ fontSize: 10, color: '#fbbf24', flexShrink: 0 }} title={step.image ? 'Has fallback image/text' : 'Has fallback text'}>
                          fallback
                        </span>
                      )}
                      {reviewing && (() => {
                        const h = stepHealth(step);
                        // For interaction steps, the target often lives inside a menu/popup
                        // that only exists after the PRIOR step opens it — so a live
                        // "broken" here is expected, not an error. Show a neutral note.
                        if (step.advance === 'interaction' && (h === 'broken' || h === 'mismatch')) {
                          return <span style={{ fontSize: 10, color: UI.muted, flexShrink: 0 }} title="Target appears once the previous step runs (e.g. an open menu). Verify with Preview.">at runtime</span>;
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
                      className="tr-btn tr-ghost"
                      title="Edit this step — title, description, image / fallback, advance"
                      onClick={e => { e.stopPropagation(); editStep(idx); }}
                      style={{ ...btn('icon'), minWidth: 26, minHeight: 26, borderColor: 'transparent' }}
                    ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg></button>
                  )}
                  {reviewing && (
                    <button
                      className="tr-btn tr-ghost"
                      title="Re-capture this step's target"
                      onClick={e => { e.stopPropagation(); setRecaptureIdx(idx); setIsCapturing(true); }}
                      style={{ ...btn('icon'), minWidth: 26, minHeight: 26, borderColor: 'transparent' }}
                    ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg></button>
                  )}
                  {step.anchorId && (
                    <button
                      className="tr-btn tr-ghost"
                      title="Remove target — show as a centered modal"
                      onClick={e => { e.stopPropagation(); makeStepFloating(idx); }}
                      style={{ ...btn('icon'), minWidth: 26, minHeight: 26, borderColor: 'transparent' }}
                    ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="7" width="16" height="10" rx="2" /></svg></button>
                  )}
                  <button
                    className="tr-btn tr-ghost"
                    title="Remove step"
                    onClick={e => { e.stopPropagation(); removeStep(idx); }}
                    style={{ ...btn('icon'), minWidth: 26, minHeight: 26, borderColor: 'transparent' }}
                  ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
                </div>
                );
              })
            )}
          </div>

          {/* Footer actions */}
          <div style={{ padding: '10px 14px', borderTop: '1px solid #1e293b', display: 'flex', flexWrap: 'wrap', gap: 6, flexShrink: 0 }}>
            {/* ── Recording phase: capture steps, then Done ── */}
            {!reviewing && !recordingFlow && (
              <>
                {!pendingEl && !floatingForm && (
                  <button
                    className="tr-btn"
                    onClick={() => { lastConfirmedRef.current = null; setRecordingFlow(true); }}
                    title="Walk through the flow. Each click is captured and you name it before continuing — navigations replay automatically, dropdowns become guided 'open then select' steps."
                    style={btn('primary')}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="7" /></svg>
                    Record
                  </button>
                )}
                {!pendingEl && !floatingForm && (
                  <button
                    className="tr-btn"
                    onClick={() => { setFloatingForm(true); setPendingRoute(window.location.pathname); setStepTitle(''); setStepBody(''); setStepPlacement('auto'); setStepAdvance(undefined); setStepGate(null); setStepImage(''); setStepFallbackBody(''); setTimeout(() => titleInputRef.current?.focus(), 50); }}
                    title="Add a centered modal step with no target (intro / banner)"
                    style={btn('secondary')}>
                    + Modal step
                  </button>
                )}
                {steps.length > 0 && !pendingEl && !floatingForm && (
                  <button className="tr-btn" onClick={() => { setReviewing(true); setSubmitted(false); }} style={btn('success')}>
                    Review
                  </button>
                )}
                {steps.length > 0 && (
                  <button className="tr-btn tr-ghost" onClick={resetAll} style={btn('ghost')}>
                    Clear
                  </button>
                )}
              </>
            )}

            {/* ── Recording in progress (form, if open, is shown above) ── */}
            {!reviewing && recordingFlow && !pendingEl && !floatingForm && (
              <>
                <span style={{ fontSize: 12, color: UI.muted, fontWeight: 600, alignSelf: 'center', marginRight: 'auto' }}>
                  {captureMode === 'point' ? 'Pointing — click to explain' : 'Recording — click to capture'}
                </span>
                <button
                  className="tr-btn"
                  onClick={() => { setFloatingForm(true); setPendingRoute(window.location.pathname); setStepTitle(''); setStepBody(''); setStepPlacement('auto'); setStepAdvance(undefined); setStepGate(null); setStepImage(''); setStepFallbackBody(''); setTimeout(() => titleInputRef.current?.focus(), 50); }}
                  title="Add a centered modal step (e.g. a Welcome slide) — no target"
                  style={btn('secondary')}>
                  + Modal
                </button>
                <button
                  className="tr-btn"
                  onClick={() => { setRecordingFlow(false); setReviewing(stepsCountRef.current > 0); }}
                  style={btn('primary')}>
                  Done{stepsCountRef.current > 0 ? ` · ${stepsCountRef.current}` : ''}
                </button>
              </>
            )}

            {/* ── Review phase: preview, then Submit ── */}
            {reviewing && (
              <>
                <button className="tr-btn" onClick={() => void handlePreview()} style={btn('success')}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                  Preview
                </button>
                <button
                  className="tr-btn"
                  onClick={handleSubmit}
                  disabled={!tourId.trim() || saving}
                  style={btn(tourId.trim() && !saving ? 'primary' : 'secondary')}>
                  {saving ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span style={SPINNER} /> Saving…
                    </span>
                  ) : repairing ? (
                    'Save repairs'
                  ) : (
                    'Submit tour'
                  )}
                </button>
                <button className="tr-btn tr-ghost" onClick={() => { setReviewing(false); setSubmitted(false); }} style={btn('ghost')}>
                  Add more
                </button>
                <button className="tr-btn tr-ghost" onClick={resetAll} style={btn('ghost')}>
                  Clear
                </button>
              </>
            )}
          </div>

          {/* Submitted confirmation */}
          {submitted && (
            <div style={{ padding: '10px 14px', background: 'rgba(16,185,129,0.1)', borderTop: '1px solid rgba(16,185,129,0.28)', flexShrink: 0 }}>
              <div style={{ fontSize: 12, color: '#4ade80', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 7 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                Submitted — {steps.length} step{steps.length > 1 ? 's' : ''}
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

// ─── Design tokens + shared styles ──────────────────────────────────────────
// One cohesive dark-glass palette so the whole recorder reads as a single modern
// surface. Kept minimal on purpose — fewer moving/competing colors.
const UI = {
  bg: '#0B0F1A',            // panel base
  bgElev: '#101725',        // raised sections (form / header)
  bgSunken: '#080C15',      // inset areas (path pills)
  bgInput: '#141B2A',
  border: 'rgba(148,163,184,0.14)',
  text: '#E7ECF3',
  muted: '#8A97AB',
  faint: '#5A6678',
  accent: '#6366F1',
  radius: 16,
  font: "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif",
  mono: "'SF Mono', ui-monospace, 'JetBrains Mono', Menlo, monospace",
};

// Injected once. Real hover/focus/entrance transitions (inline styles can't do
// pseudo-states) so interactions feel smooth without per-element JS handlers.
const RECORDER_CSS = `
@keyframes tour-rec-spin{to{transform:rotate(360deg)}}
@keyframes tour-rec-panel{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:none}}
@keyframes tour-rec-pill{from{opacity:0;transform:translate(-50%,-8px)}to{opacity:1;transform:translate(-50%,0)}}
@keyframes tour-rec-pulse{0%,100%{box-shadow:0 6px 20px rgba(99,102,241,.5),0 0 0 0 rgba(99,102,241,.5)}50%{box-shadow:0 6px 20px rgba(99,102,241,.5),0 0 0 9px rgba(99,102,241,0)}}
.tr-panel{animation:tour-rec-panel .2s cubic-bezier(.2,.7,.3,1) both}
.tr-pill{animation:tour-rec-pill .2s cubic-bezier(.2,.7,.3,1) both}
.tr-btn{transition:filter .14s ease,background-color .14s ease,color .14s ease,transform .06s ease;}
.tr-btn:hover:not(:disabled){filter:brightness(1.14)}
.tr-btn:active:not(:disabled){transform:translateY(.5px)}
.tr-btn:disabled{opacity:.45;cursor:default}
.tr-ghost{transition:background-color .14s ease,color .14s ease}
.tr-ghost:hover:not(:disabled){background-color:rgba(148,163,184,.12) !important;color:${UI.text} !important}
.tr-input{transition:border-color .14s ease,box-shadow .14s ease}
.tr-input:focus{border-color:${UI.accent} !important;box-shadow:0 0 0 3px rgba(99,102,241,.2)}
.tr-input::placeholder{color:${UI.faint}}
.tr-row{transition:background-color .12s ease}
.tr-row:hover{background-color:rgba(148,163,184,.06)}
.tr-fab{transition:transform .18s ease,background-color .18s ease}
.tr-fab:hover{transform:translateY(-2px)}
.tr-fab-rec{animation:tour-rec-pulse 1.9s ease-in-out infinite}
.tr-seg{transition:background-color .14s ease,color .14s ease}
`;

const INPUT: React.CSSProperties = {
  width: '100%', background: UI.bgInput, border: `1px solid ${UI.border}`,
  borderRadius: 9, color: UI.text, padding: '7px 10px',
  fontSize: 12.5, outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit',
};

const LBL: React.CSSProperties = {
  display: 'block', fontSize: 10.5, fontWeight: 600, color: UI.muted,
  marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em',
};

const CODE: React.CSSProperties = {
  fontFamily: UI.mono, background: UI.bgInput, padding: '1px 5px',
  borderRadius: 4, fontSize: '0.95em', color: '#a5b4fc',
};

// Small spinning ring for in-flight actions (uses the injected @keyframes).
const SPINNER: React.CSSProperties = {
  width: 12, height: 12, borderRadius: '50%', display: 'inline-block',
  border: '2px solid rgba(255,255,255,0.35)', borderTopColor: '#fff',
  animation: 'tour-rec-spin 0.7s linear infinite',
};

// Semantic button variants → a consistent, modern button language. Pair with
// className "tr-btn" (base transitions) or "tr-btn tr-ghost" for the ghost hover.
type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'icon';
function btn(variant: BtnVariant = 'secondary'): React.CSSProperties {
  const base: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    border: '1px solid transparent', borderRadius: 9, cursor: 'pointer',
    fontSize: 12.5, padding: '6px 13px', minHeight: 32, fontWeight: 600,
    whiteSpace: 'nowrap', flexShrink: 0, fontFamily: 'inherit', lineHeight: 1,
  };
  switch (variant) {
    case 'primary': return { ...base, background: UI.accent, color: '#fff' };
    case 'success': return { ...base, background: '#0d9488', color: '#fff' };
    case 'danger': return { ...base, background: 'transparent', color: '#f87171', borderColor: 'rgba(248,113,113,0.3)' };
    case 'ghost': return { ...base, background: 'transparent', color: UI.muted };
    case 'icon': return { ...base, background: 'transparent', color: UI.muted, padding: 0, minWidth: 30, minHeight: 30, borderColor: UI.border };
    case 'secondary':
    default: return { ...base, background: 'rgba(148,163,184,0.1)', color: UI.text, borderColor: UI.border };
  }
}
