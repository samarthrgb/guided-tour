import React from 'react';
import { useTour } from './useTour.js';
import type { Tour } from '@guided-tour-s4marth/core';

export interface ReleaseSidebarProps {
  className?: string;
  renderTourRow?: (tour: Tour, onPlay: () => void) => React.ReactNode;
}

function DefaultTourRow({ tour, onPlay }: { tour: Tour; onPlay: () => void }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 16px',
        borderBottom: '1px solid #1e293b',
      }}
    >
      <div>
        <div style={{ fontWeight: 600, fontSize: '14px', color: '#000' }}>
          {tour.title ?? tour.id}
        </div>
        {tour.version && (
          <div style={{ fontSize: '12px', color: '#000', marginTop: 2 }}>
            v{tour.version}
          </div>
        )}
        {tour.status !== 'active' && (
          <div style={{ fontSize: '11px', color: '#f59e0b', marginTop: 2 }}>
            {tour.status}
          </div>
        )}
      </div>
      <button
        onClick={onPlay}
        disabled={tour.status === 'archived'}
        style={{
          padding: '6px 14px',
          borderRadius: '6px',
          border: 'none',
          background: tour.status === 'archived' ? '#334155' : 'var(--tour-primary, #6366f1)',
          color: tour.status === 'archived' ? '#64748b' : '#fff',
          cursor: tour.status === 'archived' ? 'not-allowed' : 'pointer',
          fontSize: '13px',
          fontWeight: 500,
        }}
      >
        {tour.status === 'archived' ? 'Archived' : '▶ Play'}
      </button>
    </div>
  );
}

export function ReleaseSidebar({ className, renderTourRow }: ReleaseSidebarProps) {
  const { tours, startTour, activeTourId } = useTour();
  const releaseTours = tours.filter(t => t.type === 'release');

  if (!releaseTours.length) {
    return (
      <div
        className={className}
        style={{ padding: '24px 16px', color: '#64748b', fontSize: '14px', textAlign: 'center' }}
      >
        No release tours yet.
      </div>
    );
  }

  return (
    <div
      className={className}
      style={{ fontFamily: 'var(--tour-font, inherit)' }}
    >
      <div
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid #1e293b',
          fontSize: '13px',
          fontWeight: 600,
          color: '#94a3b8',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}
      >
        Release Tours
      </div>
      {releaseTours.map(tour => {
        const onPlay = () => void startTour(tour.id);
        return (
          <div key={tour.id} style={{ opacity: activeTourId === tour.id ? 0.6 : 1 }}>
            {renderTourRow ? renderTourRow(tour, onPlay) : <DefaultTourRow tour={tour} onPlay={onPlay} />}
          </div>
        );
      })}
    </div>
  );
}
