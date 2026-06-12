import type { InteractionAction } from '@guided-tour-s4marth/core';

export interface CapturedTarget {
  element: Element;
  anchorId?: string;
  sourceFile?: string;
  sourceLine?: number;
  componentName?: string;
  interactionPath: InteractionAction[];
}

export interface CaptureSession {
  targets: CapturedTarget[];
  start(): void;
  stop(): void;
  clear(): void;
  undo(): void;
}

/**
 * Creates a capture session that records click targets and builds
 * the interaction path (sequence of user actions) for each one.
 *
 * All clicks within a step are accumulated as the `prepare` path until
 * the author explicitly "adds" the target to the step list.
 */
export function createCaptureSession(
  onTargetAdded: (target: CapturedTarget) => void,
): CaptureSession {
  let active = false;
  const targets: CapturedTarget[] = [];
  const pendingPath: InteractionAction[] = [];

  function handleClick(e: MouseEvent) {
    if (!active) return;
    e.preventDefault();
    e.stopPropagation();

    const el = e.target as Element | null;
    if (!el) return;

    const anchorId = el.closest('[data-tour]')?.getAttribute('data-tour') ?? null;

    if (anchorId) {
      pendingPath.push({ action: 'click', anchorId });
    }
  }

  function addTarget(element: Element): CapturedTarget {
    const anchorId = element.closest('[data-tour]')?.getAttribute('data-tour') ?? null;
    const target: CapturedTarget = {
      element,
      interactionPath: [...pendingPath],
    };
    if (anchorId) target.anchorId = anchorId;
    targets.push(target);
    pendingPath.length = 0;
    onTargetAdded(target);
    return target;
  }

  return {
    targets,
    start() {
      active = true;
      document.addEventListener('click', handleClick, { capture: true });
    },
    stop() {
      active = false;
      document.removeEventListener('click', handleClick, { capture: true });
    },
    clear() {
      targets.length = 0;
      pendingPath.length = 0;
    },
    undo() {
      targets.pop();
    },
  };
}
