'use client';

import { useId, useMemo, useRef, useEffect } from 'react';
import type { InteractiveContent } from '@/lib/types/stage';
import { useInteractiveIframePool } from '@/lib/store/interactive-iframe-pool';
import { patchHtmlForIframe } from '@/lib/utils/iframe';

interface InteractiveRendererProps {
  readonly content: InteractiveContent;
  readonly sceneId: string;
}

/**
 * Placeholder for an interactive scene. The actual iframe lives in the stable
 * `InteractiveIframeHost` (keyed by sceneId) so it survives remounts (#619);
 * this component only (1) registers the scene's content in the keep-alive pool,
 * (2) marks it active/visible while mounted, and (3) reports its on-screen rect
 * so the host can position the iframe over this slot. On unmount it hides the
 * iframe but never evicts it — that preserves the document for a zero-reload
 * return on the next mount.
 */
export function InteractiveRenderer({ content, sceneId }: InteractiveRendererProps) {
  const slotRef = useRef<HTMLDivElement>(null);
  // Unique per mounted placeholder instance — its visibility ownership token, so
  // a stale unmount during the mode cross-fade can't hide a newer instance.
  const owner = useId();
  const mount = useInteractiveIframePool((s) => s.mount);
  const setRect = useInteractiveIframePool((s) => s.setRect);
  const claim = useInteractiveIframePool((s) => s.claim);
  const release = useInteractiveIframePool((s) => s.release);
  const setActive = useInteractiveIframePool((s) => s.setActive);

  const patchedHtml = useMemo(
    () => (content.html ? patchHtmlForIframe(content.html) : undefined),
    [content.html],
  );

  // Register / activate / claim visibility while mounted; release (keep-alive) on
  // unmount. A content change re-runs this and rebuilds the iframe — the only
  // intended reload path.
  useEffect(() => {
    mount(sceneId, {
      srcDoc: patchedHtml,
      src: patchedHtml ? undefined : content.url,
    });
    setActive(sceneId);
    claim(sceneId, owner);
    return () => release(sceneId, owner);
  }, [sceneId, owner, patchedHtml, content.url, mount, setActive, claim, release]);

  // Track the slot only when layout can change. The former perpetual rAF loop
  // forced a layout read on every frame even when a public classroom was idle,
  // which was especially costly on mobile devices.
  useEffect(() => {
    let raf = 0;
    const node = slotRef.current;
    if (!node) return;

    const measure = () => {
      raf = 0;
      const r = node.getBoundingClientRect();
      setRect(sceneId, { left: r.left, top: r.top, width: r.width, height: r.height });
    };

    const scheduleMeasure = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    const resizeObserver = new ResizeObserver(scheduleMeasure);
    resizeObserver.observe(node);
    window.addEventListener('resize', scheduleMeasure);
    window.addEventListener('scroll', scheduleMeasure, true);
    window.visualViewport?.addEventListener('resize', scheduleMeasure);
    window.visualViewport?.addEventListener('scroll', scheduleMeasure);
    scheduleMeasure();

    return () => {
      if (raf) cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      window.removeEventListener('resize', scheduleMeasure);
      window.removeEventListener('scroll', scheduleMeasure, true);
      window.visualViewport?.removeEventListener('resize', scheduleMeasure);
      window.visualViewport?.removeEventListener('scroll', scheduleMeasure);
    };
  }, [sceneId, setRect]);

  return <div ref={slotRef} className="w-full h-full" aria-hidden />;
}
