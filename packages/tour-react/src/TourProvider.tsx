import React, {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  parseTours,
  isTourEligible,
  playTour,
  localSeenStore,
  type Tour,
  type ThemeOverrides,
  type SeenStore,
  type AnchorMetaMap,
  type RuntimeContext,
} from '@guided-tour-s4marth/core';

export interface TourProviderProps {
  children: React.ReactNode;
  fetchTours: () => Promise<unknown[]>;
  appVersion: string;
  userContext: {
    userId?: string;
    role?: string;
    flags?: Record<string, boolean>;
  };
  theme?: ThemeOverrides;
  seenStore?: SeenStore;
  anchorMeta?: AnchorMetaMap;
  customPredicates?: Record<string, () => boolean>;
  navigate?: (route: string) => void | Promise<void>;
  waitForElement?: (selector: string, timeoutMs?: number) => Promise<Element | null>;
  /**
   * Restore the app mode/context a tour was recorded in (e.g. experience) before it
   * plays. Receives the tour's `context` blob; the host owns the semantics. May
   * return a Promise (e.g. to await an experience transition).
   */
  applyContext?: (context: Record<string, unknown>) => void | Promise<void>;
  /**
   * Auto-start the tour the backend marked `autoplay: true` (the newest unseen
   * release for this user), once per session. Set false to disable. Default true.
   */
  autoPlay?: boolean;
}

export interface TourContextValue {
  tours: Tour[];
  eligibleTours: Tour[];
  activeTourId: string | null;
  currentStepIndex: number;
  startTour: (tourId: string) => Promise<void>;
  stopTour: () => void;
}

// eslint-disable-next-line react-refresh/only-export-components
export const TourContext = createContext<TourContextValue | null>(null);

export function TourProvider({
  children,
  fetchTours,
  appVersion,
  userContext,
  theme,
  seenStore = localSeenStore,
  anchorMeta,
  customPredicates,
  navigate,
  waitForElement,
  applyContext,
  autoPlay = true,
}: TourProviderProps) {
  const [tours, setTours] = useState<Tour[]>([]);
  const [seenTours, setSeenTours] = useState<Set<string>>(new Set());
  const [activeTourId, setActiveTourId] = useState<string | null>(null);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);

  const userId = userContext.userId ?? 'anonymous';
  const stopRef = useRef<(() => void) | null>(null);
  // autoPlayedRef: prevents replaying the auto-play tour in the same session.
  // initialLoadRef: ensures auto-play only evaluates on the first non-empty tours
  // fetch — subsequent changes (e.g. cache invalidation after recorder create) are ignored.
  const autoPlayedRef = useRef(false);
  const initialLoadRef = useRef(false);

  useEffect(() => {
    fetchTours()
      .then(raw => setTours(parseTours(raw)))
      .catch(err => console.error('[tour] failed to fetch tours:', err));
  }, [fetchTours]);

  useEffect(() => {
    seenStore.getAll(userId).then(seen => setSeenTours(new Set(seen)));
  }, [seenStore, userId]);

  const runtimeCtx: RuntimeContext = useMemo(
    () => {
      const ctx: RuntimeContext = {
        route: typeof window !== 'undefined' ? window.location.pathname : '/',
        appVersion,
        flags: userContext.flags ?? {},
        seenTours,
      };
      if (userContext.role) ctx.role = userContext.role;
      if (customPredicates) ctx.customPredicates = customPredicates;
      return ctx;
    },
    [appVersion, userContext.role, userContext.flags, seenTours, customPredicates],
  );

  const eligibleTours = useMemo(
    () => tours.filter(t => isTourEligible(t, runtimeCtx)),
    [tours, runtimeCtx],
  );

  const stopTour = useCallback(() => {
    stopRef.current?.();
    setActiveTourId(null);
    setCurrentStepIndex(0);
  }, []);

  const startTour = useCallback(
    async (tourId: string) => {
      const tour = tours.find(t => t.id === tourId);
      if (!tour) {
        console.warn(`[tour] tour not found: "${tourId}"`);
        return;
      }

      stopTour();
      setActiveTourId(tourId);
      setCurrentStepIndex(0);

      let stopped = false;
      stopRef.current = () => { stopped = true; };

      const opts: import('@guided-tour-s4marth/core').PlayerOptions = { tour };
      if (anchorMeta) opts.anchorMeta = anchorMeta;
      if (theme) opts.theme = theme;
      if (navigate) opts.navigate = navigate;
      if (waitForElement) opts.waitForElement = waitForElement;
      if (applyContext) opts.applyContext = applyContext;
      // Completing and cancelling both mark the tour seen so it won't
      // auto-play again. Manual replays via startTour() still work.
      const finalize = async () => {
        await seenStore.markSeen(userId, tourId);
        setSeenTours(prev => new Set([...prev, tourId]));
        setActiveTourId(null);
        setCurrentStepIndex(0);
      };
      opts.onComplete = () => { if (!stopped) void finalize(); };
      opts.onSkip = () => { if (!stopped) void finalize(); };
      opts.onStepChange = (index: number) => { if (!stopped) setCurrentStepIndex(index); };
      // No step could render (all anchors missing) — clear state but DON'T mark
      // seen, so the tour can show once the anchors are fixed/deployed.
      opts.onUnavailable = () => {
        if (!stopped) { setActiveTourId(null); setCurrentStepIndex(0); }
      };

      await playTour(opts);
    },
    [tours, anchorMeta, theme, navigate, waitForElement, applyContext, seenStore, userId, stopTour],
  );

  // Auto-play the backend-designated tour (autoplay: true) once per session,
  // evaluated only on the first non-empty tours load. Subsequent tours changes
  // (e.g. cache invalidation after the recorder creates a new tour) are ignored.
  useEffect(() => {
    if (!autoPlay || activeTourId || autoPlayedRef.current || tours.length === 0) return;
    if (initialLoadRef.current) return;
    initialLoadRef.current = true;
    // Pick from eligibleTours (not all tours) so the autoplay tour still has to
    // satisfy its conditions (route/role/version/flag) — the backend `autoplay`
    // flag only encodes newest/active/unseen, not eligibility.
    const candidate = eligibleTours.find(t => t.autoplay && !seenTours.has(t.id));
    if (candidate) {
      autoPlayedRef.current = true;
      void startTour(candidate.id);
    }
  }, [autoPlay, activeTourId, tours, eligibleTours, seenTours, startTour]);

  const value = useMemo<TourContextValue>(
    () => ({ tours, eligibleTours, activeTourId, currentStepIndex, startTour, stopTour }),
    [tours, eligibleTours, activeTourId, currentStepIndex, startTour, stopTour],
  );

  return <TourContext.Provider value={value}>{children}</TourContext.Provider>;
}
