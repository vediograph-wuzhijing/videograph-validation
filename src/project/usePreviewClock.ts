import { useEffect, useMemo, useRef, useState } from 'react';

export function usePreviewClock(preview: string | null) {
  // FB-02：预览播放器每 250ms postMessage 当前时间；只接受预览 origin + iframe source 匹配的消息。
  const previewFrameRef = useRef<HTMLIFrameElement | null>(null);
  const previewTimeRef = useRef<number | null>(null);
  const [hasPreviewTime, setHasPreviewTime] = useState(false);
  const [playhead, setPlayhead] = useState<number | null>(null);
  const previewOrigin = useMemo(() => { try { return preview ? new URL(preview).origin : null; } catch { return null; } }, [preview]);
  useEffect(() => { setHasPreviewTime(false); previewTimeRef.current = null; setPlayhead(null); }, [preview]);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!previewOrigin || event.origin !== previewOrigin || event.source !== previewFrameRef.current?.contentWindow) return;
      const data = event.data as { type?: string; t?: number } | null;
      if (data?.type === 'videograph:time' && typeof data.t === 'number' && Number.isFinite(data.t)) { previewTimeRef.current = data.t; setHasPreviewTime(true); setPlayhead(data.t); }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [previewOrigin]);
  return { previewFrameRef, previewTimeRef, hasPreviewTime, playhead };
}
