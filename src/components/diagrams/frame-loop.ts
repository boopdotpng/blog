import { useEffect } from 'preact/hooks';
import type { RefObject } from 'preact';

export const prefersReducedMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * Calls `frame(elapsedMs)` once per animation frame while `target` is on screen
 * and the tab is visible. Elapsed time is paused while hidden, so a looping
 * animation resumes where it left off instead of jumping ahead.
 *
 * Under prefers-reduced-motion the loop never starts; `frame(stillAt)` is drawn
 * once instead, so callers can pick a meaningful resting frame.
 */
export function useFrameLoop(
  target: RefObject<Element>,
  frame: (elapsedMs: number) => void,
  deps: unknown[],
  stillAt = 0,
) {
  useEffect(() => {
    const el = target.current;
    if (!el) return;
    if (prefersReducedMotion()) {
      frame(stillAt);
      return;
    }

    let raf = 0;
    let last = 0;
    let elapsed = 0;
    let onScreen = false;
    const tick = (now: number) => {
      // Clamp long gaps (e.g. a dropped frame burst) so motion never teleports.
      elapsed += last ? Math.min(now - last, 100) : 0;
      last = now;
      frame(elapsed);
      raf = requestAnimationFrame(tick);
    };
    const sync = () => {
      if (onScreen && !document.hidden) {
        if (!raf) {
          last = 0;
          raf = requestAnimationFrame(tick);
        }
      } else {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    };
    const io = new IntersectionObserver(([entry]) => {
      onScreen = entry.isIntersecting;
      sync();
    });
    io.observe(el);
    document.addEventListener('visibilitychange', sync);
    frame(0);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      document.removeEventListener('visibilitychange', sync);
    };
  }, deps);
}
