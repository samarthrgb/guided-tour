import { useContext } from 'react';
import { TourContext, type TourContextValue } from './TourProvider.js';

export function useTour(): TourContextValue {
  const ctx = useContext(TourContext);
  if (!ctx) {
    throw new Error('useTour must be used inside <TourProvider>');
  }
  return ctx;
}
