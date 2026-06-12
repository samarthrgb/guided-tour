// Note: import 'driver.js/dist/driver.css' in your app entry point.

export { TourProvider } from './TourProvider.js';
export type { TourProviderProps, TourContextValue } from './TourProvider.js';
export { TourContext } from './TourProvider.js';
export { useTour } from './useTour.js';
export { ReleaseSidebar } from './ReleaseSidebar.js';
export type { ReleaseSidebarProps } from './ReleaseSidebar.js';

// Re-export core types for convenience
export type {
  Tour,
  Step,
  Condition,
  ThemeOverrides,
  TourEvent,
  TelemetryHandler,
  SeenStore,
  AnchorMetaMap,
} from '@guided-tour-s4marth/core';
export {
  setTelemetryHandler,
  PREVIEW_TOUR_ID,
  localSeenStore,
  createBackendSeenStore,
  parseTour,
  parseTours,
} from '@guided-tour-s4marth/core';
