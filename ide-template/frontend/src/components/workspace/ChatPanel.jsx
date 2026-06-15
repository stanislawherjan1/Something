import { useState, useRef, useEffect, useCallback, Fragment } from 'react';
import { ArrowUp, ArrowUpRight, AlertCircle, FileText, Folder, Globe, Loader2, Paperclip, RotateCcw, Square, WifiOff } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';
import { ToolChipRow } from './ToolChip.jsx';
import SpinningAvatar from './SpinningAvatar.jsx';
import useNotifications from './useNotifications.js';
import useNotificationReadState from './useNotificationReadState.js';

/**
 * useVisualViewport — tracks the iOS/Android virtual keyboard height.
 *
 * On iOS Safari, the layout viewport does NOT shrink when the keyboard opens.
 * The visualViewport API reports the actually-visible rectangle. The difference
 * between window.innerHeight and visualViewport.height (offset by scrollY) is
 * exactly the keyboard height. We return that value so callers can push the
 * composer above the keyboard without touching the message list.
 *
 * Returns 0 on desktop / browsers without the API.
 */
function useVisualViewport() {
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      // Keyboard height = distance from bottom of visual viewport to bottom of layout viewport.
      // We clamp to ≥0 to guard against floating-point noise.
      const gap = Math.max(0, window.innerHeight - (vv.offsetTop + vv.height));
      setOffset(gap);
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    update();
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);
  return offset;
}

/**
 * ChatPanel — input + message list + SSE streaming from /api/chat.
 *
 * Each user message creates a user bubble; the assistant's reply streams as
 * text deltas appended to a single bubble. On `event: done` the bubble is
 * marked complete; on `event: error` it switches to an error style.
 *
 * Iteration 1: text only. No tool_use chips, no markdown rendering, no
 * thread switcher (single hardcoded thread per page mount).
 */
export default function ChatPanel({ sessionId, onFileSelect, initialMessage, onInitialMessageConsumed, resetNonce = 0 }) {
  // sessionId is required by Phase 2 backend, but we tolerate undefined for
  // a brief render between ChatPane mount and the sessions fetch returning —
  // we hold off on history fetch / send() until it's set.
  const historyUrl = sessionId
    ? `/api/chat/history?sessionId=${encodeURIComponent(sessionId)}`
    : '/api/chat/history';
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [attachments, setAttachments] = useState([]);
  // Active + recently-finished tool chips for the in-flight turn. Cleared on
  // new turn / done. Each: { id, name, status: 'running'|'done'|'error', error? }
  const [chips, setChips] = useState([]);
  const [isDragging, setIsDragging]   = useState(false);
  // Lazy-load state for older history pages.
  const [hasMore, setHasMore]         = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Initial-page-load spinner. True from mount until first /api/chat/history
  // returns. Prevents the EmptyState flash when switching between sessions
  // (ChatPanel remounts with key={sessionId}, messages start empty until the
  // fetch resolves a moment later).
  const [historyLoading, setHistoryLoading] = useState(true);
  // iOS keyboard offset — keeps the composer above the virtual keyboard.
  const keyboardOffset = useVisualViewport();

  const listRef = useRef(null);
  const abortRef = useRef(null);
  const fileInputRef = useRef(null);
  const chipFadeTimers = useRef(new Map());
  // Tracks the oldest message ts in `messages` so the "load older" call
  // can ask for the next page strictly older than that.
  const oldestTsRef = useRef(null);

  const mapEntry = (m, i, prefix = 'h') => ({
    role: m.role,
    text: m.text,
    kind: m.kind || null,
    attachments: m.attachments || null,
    // History doesn't persist inline images yet — they're stream-only for now.
    // Future: chatHistory.js could store image refs as on-disk paths.
    images: m.images || [],
    id: `${prefix}-${i}-${m.ts}`,
    ts: m.ts,
    state: 'done',
  });

  // Initial page load. Fetches the most-recent slice; older pages arrive via
  // the scroll-up handler below.
  useEffect(() => {
    if (!sessionId) return;
    setHistoryLoading(true);
    let cancelled = false;
    fetch(historyUrl)
      .then(r => r.ok ? r.json() : { messages: [], hasMore: false })
      .then(data => {
        if (cancelled) return;
        const restored = (data.messages || []).map((m, i) => mapEntry(m, i, 'h'));
        // Race-protection: if WelcomeScreen's auto-send already added bubbles
        // before this fetch returned, don't clobber them with empty history.
        setMessages(prev => prev.length > 0 ? prev : restored);
        setHasMore(!!data.hasMore);
        if (restored.length) oldestTsRef.current = restored[0].ts;
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setHistoryLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId, historyUrl]);

  const loadOlder = useCallback(async () => {
    if (loadingMore || !hasMore || !oldestTsRef.current) return;
    setLoadingMore(true);
    const before = oldestTsRef.current;
    try {
      const sidQuery = sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : '';
      const r = await fetch(`/api/chat/history?before=${encodeURIComponent(before)}${sidQuery}`);
      if (!r.ok) return;
      const data = await r.json();
      const older = (data.messages || []).map((m, i) => mapEntry(m, i, `o-${before}`));
      if (older.length) {
        oldestTsRef.current = older[0].ts;
        // Preserve the user's scroll position by remembering where the top
        // currently sits, prepending, then re-applying the offset.
        const el = listRef.current;
        const prevScrollHeight = el?.scrollHeight ?? 0;
        const prevScrollTop    = el?.scrollTop ?? 0;
        setMessages(prev => [...older, ...prev]);
        // Restore on next paint so the user stays anchored to the same line.
        requestAnimationFrame(() => {
          if (!listRef.current) return;
          listRef.current.scrollTop = prevScrollTop + (listRef.current.scrollHeight - prevScrollHeight);
        });
      }
      setHasMore(!!data.hasMore);
    } catch {} finally {
      setLoadingMore(false);
    }
  }, [hasMore, loadingMore, sessionId]);

  // Track whether the user is pinned to the bottom of the thread. Updated on
  // every scroll; read by the autoscroll effect so streaming follows the
  // bottom when the user is there, but never yanks them when they've scrolled
  // up to read history.
  const atBottomRef = useRef(true);
  // Trigger loadOlder when the user scrolls within ~80px of the top.
  const onListScroll = useCallback((e) => {
    const el = e.currentTarget;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (el.scrollTop <= 80) loadOlder();
  }, [loadOlder]);

  // After a successful "Reset chat" (resetNonce bumped from ChatPane), the
  // server appended a topic-boundary marker. Re-fetch the first page so the
  // separator shows up immediately. No remount, scroll position resets to
  // bottom because the lastId changed.
  useEffect(() => {
    if (resetNonce === 0) return;
    let cancelled = false;
    fetch(historyUrl)
      .then(r => r.ok ? r.json() : { messages: [], hasMore: false })
      .then(data => {
        if (cancelled) return;
        const restored = (data.messages || []).map((m, i) => mapEntry(m, i, `r${resetNonce}`));
        setMessages(restored);
        setHasMore(!!data.hasMore);
        oldestTsRef.current = restored.length ? restored[0].ts : null;
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [resetNonce, historyUrl]);

  // Auto-scroll behaviour:
  //   - The user just sent a message (new user turn) → always jump to bottom.
  //   - Otherwise (assistant streaming growth, a new assistant bubble, older
  //     pages prepended) → follow the bottom ONLY if the user was already
  //     pinned there. If they scrolled up to read history, leave them put.
  // The old version keyed solely on "last id changed", which (a) yanked a
  // history reader to the bottom on every new turn and (b) did NOT follow a
  // long streaming reply (the assistant bubble's id is stable as text
  // appends), so long replies scrolled off-screen.
  const lastIdRef = useRef(null);
  useEffect(() => {
    const el = listRef.current;
    const last = messages[messages.length - 1];
    if (!last) { lastIdRef.current = null; return; }
    const isNewTurn = last.id !== lastIdRef.current;
    lastIdRef.current = last.id;
    if (!el) return;
    const userJustSent = isNewTurn && last.role === 'user';
    if (userJustSent) atBottomRef.current = true;
    if (userJustSent || atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  // When the iOS keyboard opens (keyboardOffset > 0), scroll the message list
  // to the bottom so the latest reply stays visible above the composer.
  useEffect(() => {
    if (keyboardOffset > 0 && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [keyboardOffset]);

  // send accepts:
  //   send()                          — read from input + attachments state (button click)
  //   send(text)                      — forced message text, no files (auto-send: text only)
  //   send(text, files)               — forced message text + File[] (auto-send w/ attachments)
  const send = useCallback(async (forcedMsg, forcedFiles) => {
    const explicit = typeof forcedMsg === 'string' ? forcedMsg : undefined;
    const message = (explicit !== undefined ? explicit : input).trim();
    if (!message) return;
    if (!sessionId) return;   // ChatPane hasn't resolved a session yet

    // Interrupt + auto-relay: if a response is in flight, mark its assistant
    // bubble as 'interrupted' (preserves the partial text — fixes the bug
    // where mid-stream sends made the previous reply disappear) and abort
    // the SSE reader. Then send the new POST with `interrupt: true` so the
    // server gracefully terminates the in-flight claude process, persists
    // the partial to history with the same 'interrupted' state, and spawns
    // a fresh turn with full context.
    const wasInterrupting = busy;
    if (busy) {
      interruptOrDropLastAssistant();
      abortRef.current?.abort();
    }

    const filesToSend = explicit !== undefined
      ? (Array.isArray(forcedFiles) ? forcedFiles : [])
      : attachments;
    // Snapshot file metadata for the optimistic bubble — File objects can't be
    // serialised so we keep just what we'll display.
    const attachmentsMeta = filesToSend.map(f => ({ name: f.name, size: f.size }));

    if (explicit === undefined) {
      setInput('');
      setAttachments([]);
    }
    setBusy(true);
    // Fresh turn → drop any leftover chips from the previous one.
    chipFadeTimers.current.forEach(t => clearTimeout(t));
    chipFadeTimers.current.clear();
    setChips([]);

    setMessages(prev => [
      ...prev,
      { role: 'user',      text: message, attachments: attachmentsMeta, id: Date.now() + '-u' },
      { role: 'assistant', text: '', images: [], content: [], id: Date.now() + '-a', state: 'streaming' },
    ]);

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      // Multipart when there are files — otherwise JSON, which is cheaper to
      // parse on the server. The browser sets the multipart Content-Type
      // (with boundary) automatically when body is FormData.
      let body, headers;
      if (filesToSend.length > 0) {
        const fd = new FormData();
        fd.append('message', message);
        fd.append('sessionId', sessionId);
        if (wasInterrupting) fd.append('interrupt', 'true');
        for (const f of filesToSend) fd.append('files', f, f.name);
        body    = fd;
        headers = { Accept: 'text/event-stream' };
      } else {
        body    = JSON.stringify({
          message,
          sessionId,
          ...(wasInterrupting ? { interrupt: true } : {}),
        });
        headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
      }

      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers,
        body,
        signal: abort.signal,
      });

      if (!resp.ok) {
        const errBody = await resp.json().catch(() => ({ error: resp.statusText }));
        markLastAssistant({
          state: 'error',
          errorKind:   'http',
          errorStatus: resp.status,
          errorDetail: errBody.error || resp.statusText,
        });
        return;
      }

      const reader  = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const chunks = buf.split('\n\n');
        buf = chunks.pop();
        for (const chunk of chunks) {
          const { event, data } = parseSseChunk(chunk);
          if (data == null) continue;
          if (event === 'message')         appendToLastAssistant(data);
          else if (event === 'image')      appendImageToLastAssistant(data);
          else if (event === 'tool_start') addChip(data);
          else if (event === 'tool_end')   completeChip(data);
          else if (event === 'done')       markLastAssistant({ state: 'done' });
          else if (event === 'error')      markLastAssistant({ state: 'error', errorKind: 'stream', errorDetail: data.error });
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        // Interrupt-and-relay path: the bubble we aborted was already marked
        // 'interrupted' before abortRef.abort() fired (see top of send()),
        // so we leave its text intact and the new turn appends a fresh
        // assistant bubble of its own. Nothing to do here.
      } else {
        markLastAssistant({ state: 'error', errorKind: 'network', errorDetail: err.message });
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [input, attachments, busy, sessionId]);

  // Always-current ref so auto-send can call the latest send() without stale closure.
  const sendRef = useRef(send);
  useEffect(() => { sendRef.current = send; });

  // Auto-send initialMessage once (from WelcomeScreen).
  //
  // NO setTimeout / cleanup here on purpose: React.StrictMode in dev runs
  // effects setup → cleanup → setup, and a cleanup that clears a timer would
  // kill the queued send before it fires. initialSentRef (a useRef, preserved
  // across StrictMode's double-invocation) guarantees we only send once.
  // Calling send() synchronously is safe — it just queues state updates and
  // fires the fetch.
  // Tracks the last initialMessage we already consumed — guards against
  // React.StrictMode double-invocation while still allowing a SECOND prefill
  // (e.g. user opens Integrations → asks the bot → modal closes → re-opens
  // for a different integration).
  const initialSentRef = useRef(null);
  useEffect(() => {
    if (!initialMessage || initialSentRef.current === initialMessage) return;
    initialSentRef.current = initialMessage;
    // initialMessage may be:
    //   - a plain string (legacy autosend from WelcomeScreen)
    //   - { text, files } from welcome screen with attachments → autosend
    //   - { text, fill: true } from Integrations "Ask bot" → drop in composer
    //     so the user can review/refine before sending
    if (typeof initialMessage === 'string') {
      sendRef.current?.(initialMessage);
    } else if (initialMessage?.fill) {
      setInput(initialMessage.text || '');
    } else if (initialMessage && typeof initialMessage.text === 'string') {
      sendRef.current?.(initialMessage.text, initialMessage.files || []);
    }
    onInitialMessageConsumed?.();
  }, [initialMessage]);

  function addChip({ id, name }) {
    setChips(prev => prev.some(c => c.id === id)
      ? prev
      : [...prev, { id, name, status: 'running' }]);
  }

  function completeChip({ id, ok, error }) {
    setChips(prev => prev.map(c => c.id === id
      ? { ...c, status: ok ? 'done' : 'error', error: error || null }
      : c));
    // Fade out the chip a moment after it finishes — keeps the row clean
    // while the assistant continues writing.
    const t = setTimeout(() => {
      setChips(prev => prev.filter(c => c.id !== id));
      chipFadeTimers.current.delete(id);
    }, 1500);
    chipFadeTimers.current.set(id, t);
  }

  // Clear all pending chip fades on unmount / thread switch.
  useEffect(() => {
    return () => {
      chipFadeTimers.current.forEach(t => clearTimeout(t));
      chipFadeTimers.current.clear();
    };
  }, []);

  function appendToLastAssistant(delta) {
    setMessages(prev => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last?.role !== 'assistant') return prev;
      // Maintain ordered content array so images interleave correctly.
      const content = [...(last.content || [])];
      const lastBlock = content[content.length - 1];
      if (lastBlock?.type === 'text') {
        content[content.length - 1] = { ...lastBlock, text: lastBlock.text + delta };
      } else {
        content.push({ type: 'text', text: delta });
      }
      next[next.length - 1] = { ...last, text: last.text + delta, content };
      return next;
    });
  }

  // Append a single image (from a tool result, e.g. Playwright screenshot)
  // to the assistant's bubble. Validates shape and bails out silently if the
  // server emitted something we can't render — never throws inside the SSE
  // parser loop or the whole stream dies.
  function appendImageToLastAssistant(payload) {
    if (!payload || typeof payload.mediaType !== 'string' || typeof payload.data !== 'string') return;
    if (!/^image\/(png|jpeg|gif|webp)$/.test(payload.mediaType)) return;
    setMessages(prev => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last?.role !== 'assistant') return prev;
      const content = [...(last.content || [])];
      content.push({ type: 'image', mediaType: payload.mediaType, data: payload.data });
      next[next.length - 1] = {
        ...last,
        images: [...(last.images || []), { mediaType: payload.mediaType, data: payload.data }],
        content,
      };
      return next;
    });
  }

  function markLastAssistant(patch) {
    setMessages(prev => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last?.role === 'assistant') {
        next[next.length - 1] = { ...last, ...patch };
      }
      return next;
    });
  }

  // Interrupt the in-flight assistant bubble. If it already has text, mark it
  // 'interrupted' so the partial stays visible. If it's an empty stub (claude
  // hadn't sent any deltas yet), drop it from the message list entirely —
  // showing a vacuous "Stopped" pill for a never-started turn is just noise.
  function interruptOrDropLastAssistant() {
    setMessages(prev => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last?.role !== 'assistant') return prev;
      if (!last.text || last.text.length === 0) {
        next.pop();
      } else {
        next[next.length - 1] = { ...last, state: 'interrupted' };
      }
      return next;
    });
  }

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const stop = () => {
    // Mark the in-flight assistant bubble as interrupted so its partial text
    // stays visible (Phase 4), OR drop it entirely if it was an empty stub
    // (showing "Stopped" for a never-started turn is just noise). Then fire
    // the server-side stop so claude gets SIGTERM'd + the partial persists.
    if (busy) interruptOrDropLastAssistant();
    if (sessionId) {
      fetch(`/api/chat/sessions/${encodeURIComponent(sessionId)}/stop`, { method: 'POST' })
        .catch(() => { /* best-effort */ });
    }
    abortRef.current?.abort();
  };

  const handleAttachmentClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileSelect = (e) => {
    const files = Array.from(e.currentTarget.files || []);
    setAttachments(prev => [...prev, ...files]);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const onDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const onDragEnter = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const onDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Only clear if we're actually leaving the container, not just entering a child
    if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget)) {
      setIsDragging(false);
    }
  };

  const onDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length > 0) {
      setAttachments(prev => [...prev, ...files]);
    }
  };

  const isEmpty = messages.length === 0;

  return (
    <div 
      className="flex h-full min-h-0 flex-col relative"
      style={{
        // On iOS Safari the layout viewport does not shrink when the keyboard
        // opens. We compensate by shrinking *this* container by exactly the
        // keyboard height. Only the composer (at the bottom) moves up; the
        // message list stays put because it fills the remaining flex space.
        paddingBottom: keyboardOffset > 0 ? `${keyboardOffset}px` : undefined,
        transition: keyboardOffset > 0 ? 'padding-bottom 0ms' : 'padding-bottom 220ms ease-out',
      }}
      onDragOver={onDragOver}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Drag and Drop Overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/40 backdrop-blur-[2px] pointer-events-none">
          <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-foreground/20 bg-card/90 p-8 shadow-2xl transition-all animate-in zoom-in-95 duration-200">
             <div className="size-12 rounded-full bg-foreground/5 flex items-center justify-center">
               <Paperclip className="size-6 text-foreground/40" strokeWidth={1.75} />
             </div>
             <span className="text-[15px] font-medium text-foreground/70">Drop files to attach</span>
          </div>
        </div>
      )}
      {historyLoading && isEmpty ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground/55" strokeWidth={1.75} />
        </div>
      ) : isEmpty ? (
        <EmptyState />
      ) : (
        <div ref={listRef} className="scrollbar-hidden flex-1 overflow-y-auto" onScroll={onListScroll}>
          <div className="mx-auto flex max-w-2xl flex-col gap-3.5 px-5 py-5">
            {hasMore && (
              <div className="flex justify-center pt-1 pb-3 text-[11px] text-muted-foreground/55">
                {loadingMore ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Loader2 className="size-3 animate-spin" strokeWidth={2} />
                    Loading older messages…
                  </span>
                ) : (
                  <button type="button" onClick={loadOlder} className="hover:text-foreground/80">
                    Load older messages
                  </button>
                )}
              </div>
            )}
            {messages.map((m, i) => {
              const dayLabel = dayDividerLabel(m.ts, messages[i - 1]?.ts);
              const dividerEl = dayLabel ? (
                <div key={`day-${m.id}`} className="flex items-center justify-center py-3">
                  <span className="text-[10.5px] font-medium uppercase tracking-[0.1em] text-muted-foreground/50">
                    {dayLabel}
                  </span>
                </div>
              ) : null;
              if (m.role === 'system' && m.kind === 'reset') {
                return (
                  <Fragment key={m.id}>
                    {dividerEl}
                    <div className="flex items-center gap-3 py-2 text-[11px] uppercase tracking-[0.12em] text-muted-foreground/55">
                      <div className="h-px flex-1 bg-border/55" />
                      <span>{m.text || 'New topic'}</span>
                      <div className="h-px flex-1 bg-border/55" />
                    </div>
                  </Fragment>
                );
              }
              const isLastAssistant = m.role === 'assistant' && i === messages.length - 1;
              const isEmptyStreaming = isLastAssistant && m.state === 'streaming' && !m.text;
              // Chips render inline with the Thinking indicator while empty-streaming;
              // once text starts flowing, they drop to a row below the bubble.
              const showChipsBelow = isLastAssistant && !isEmptyStreaming && chips.length > 0;
              // Retry resends the user message that preceded a failed assistant
              // turn — drops the error bubble + the original prompt, then re-sends.
              const canRetry = isLastAssistant && m.state === 'error' && !busy;
              const onRetry = canRetry
                ? () => {
                    const prior = messages[i - 1];
                    if (prior?.role !== 'user' || !prior.text) return;
                    setMessages(prev => prev.slice(0, prev.length - 2));
                    sendRef.current?.(prior.text);
                  }
                : undefined;
              return (
                <Fragment key={m.id}>
                  {dividerEl}
                  <div className={cn(showChipsBelow && 'flex flex-col items-start gap-1.5')}>
                    <ChatBubble
                      message={m}
                      chips={isEmptyStreaming ? chips : null}
                      hasActiveChips={isLastAssistant && chips.length > 0}
                      onRetry={onRetry}
                      onFileSelect={onFileSelect}
                    />
                    {showChipsBelow && (
                      <div className="px-1">
                        <ToolChipRow chips={chips} />
                      </div>
                    )}
                  </div>
                </Fragment>
              );
            })}
          </div>
        </div>
      )}

      <UnreadOtherSessionsBanner currentSessionId={sessionId} />

      <Composer
        value={input}
        onChange={setInput}
        onSend={send}
        onStop={stop}
        onKeyDown={onKeyDown}
        busy={busy}
        attachments={attachments}
        onRemoveAttachment={(index) => setAttachments(prev => prev.filter((_, i) => i !== index))}
        onAttachmentClick={handleAttachmentClick}
        onFileSelect={handleFileSelect}
        fileInputRef={fileInputRef}
      />
    </div>
  );
}

/**
 * ChatBubble — user messages animate in from the right as a subtle white pill;
 * assistant messages appear directly on the warm surface (no card/border) so
 * the conversation reads like typewritten prose.
 */
function ChatBubble({ message, chips, hasActiveChips, onRetry, onFileSelect }) {
  const isUser      = message.role === 'user';
  const isError     = message.state === 'error';
  const isInterrupted = message.state === 'interrupted';
  // Legacy 'aborted' state always had empty text (text was cleared on AbortError);
  // 'interrupted' (new, Phase 4) preserves the partial text so the user sees what
  // the assistant had said before being cut off.
  const isAborted   = message.state === 'aborted' || (isInterrupted && !message.text);
  const isStreaming = message.state === 'streaming' && !message.text;

  if (isUser) {
    return (
      <div className="flex w-full justify-end">
        <div
          className={cn(
            'chat-bubble max-w-[82%] break-words text-[14px] leading-[1.55]',
            'rounded-[16px] px-4 py-2.5',
            'bg-card/80 border border-border/60 text-foreground/88',
            'shadow-[0_1px_3px_rgba(0,0,0,0.05)]',
            '[&>*:first-child]:!mt-0 [&>*:last-child]:!mb-0',
          )}
        >
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              ...MD_COMPONENTS,
              // User-pasted text can reference workspace files too — keep the
              // file: → FileChip behaviour; everything else (paragraphs,
              // lists, code, external links) comes from the shared set.
              a: ({ href, children }) =>
                href?.startsWith('file:')
                  ? <FileChip path={href.slice(5)} onSelect={onFileSelect} />
                  : MD_COMPONENTS.a({ href, children }),
            }}
          >
            {message.text}
          </ReactMarkdown>
          {message.attachments && message.attachments.length > 0 && (
            <UserAttachments attachments={message.attachments} />
          )}
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex w-full justify-start">
        <div className="chat-bubble max-w-[92%] break-words">
          <ErrorBubble message={message} onRetry={onRetry} />
        </div>
      </div>
    );
  }

  if (isAborted) {
    return (
      <div className="flex w-full justify-start">
        <div className="chat-bubble flex items-center gap-1.5 text-[12.5px] italic text-muted-foreground/75">
          <span className="inline-block size-1 rounded-full bg-muted-foreground/45" />
          Stopped
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full justify-start">
      <div
        className={cn(
          'chat-bubble max-w-[92%] break-words text-[14px] leading-[1.65]',
          'text-foreground/85',
        )}
      >
        {isStreaming ? (
          <ThinkingIndicator chips={chips} />
        ) : (
          <>
            <AssistantBody text={message.text} images={message.images} content={message.content} onFileSelect={onFileSelect} />
            {/* Blinking dot signals "still typing". Suppress when a tool chip
                is showing below the bubble — the chip's own spinner already
                conveys "work in progress" and the dot becomes redundant. */}
            {message.state === 'streaming' && !hasActiveChips && (
              <span className="ml-1 inline-block size-2 rounded-full bg-foreground/55 align-middle animate-[cursor-blink_0.9s_steps(1)_infinite]" />
            )}
            {/* Interrupted-with-text marker — Phase 4 preserves the partial. */}
            {isInterrupted && message.text && (
              <span className="ml-2 inline-flex items-center gap-1 text-[11px] italic text-muted-foreground/70 align-baseline">
                <span className="inline-block size-1 rounded-full bg-muted-foreground/45" />
                interrupted
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// Detects a trailing `Sources:` / `Źródła:` block and pulls each non-empty
// line below it into a list of citation strings. Returns the body without
// that section so it can be rendered separately as styled pills.
const SOURCES_HEADER = /\n\s*(?:sources?|źródła?|źródla?|references?)\s*:\s*\n([\s\S]*?)\s*$/i;

// Each source is parsed into { label, href }. Recognises:
//   [Title](https://...)         — markdown link
//   Title - https://...          — title separated from URL
//   Title (https://...)          — URL in parens
//   https://...                  — bare URL (label = hostname)
//   Plain text                   — no link, just label
const MD_LINK_RE = /^\[([^\]]+)\]\(([^)\s]+)\)\s*$/;
const URL_RE     = /(https?:\/\/[^\s)>\]]+)/;
// Only http(s) and mailto: are allowed as link hrefs. Everything else
// (javascript:, vbscript:, data:, file:, …) is dropped — defense in depth
// even though modern browsers already block javascript: top-level nav.
const SAFE_URL_RE = /^(?:https?:|mailto:)/i;

function parseSource(line) {
  const md = line.match(MD_LINK_RE);
  if (md) {
    const href = SAFE_URL_RE.test(md[2]) ? md[2] : null;
    return { label: md[1].trim(), href };
  }
  const urlMatch = line.match(URL_RE);
  if (urlMatch) {
    const href  = urlMatch[1];
    const label = line.replace(urlMatch[0], '').replace(/[\s\-–—()[\]·,]+$/, '').replace(/^[\s\-–—()[\]·,]+/, '').trim();
    if (label) return { label, href };
    try { return { label: new URL(href).hostname.replace(/^www\./, ''), href }; }
    catch { return { label: href, href }; }
  }
  return { label: line, href: null };
}

function splitSources(text) {
  if (!text) return { body: '', sources: [] };
  const match = text.match(SOURCES_HEADER);
  if (!match) return { body: text, sources: [] };
  const sources = match[1]
    .split('\n')
    .map(s => s.replace(/^[-*•\d.)\s]+/, '').trim())
    .filter(Boolean)
    .map(parseSource);
  if (!sources.length) return { body: text, sources: [] };
  return { body: text.slice(0, match.index).trimEnd(), sources };
}

const MD_COMPONENTS = {
  // Paragraph gap (mb-3 ≈ 12px) must EXCEED the intra-paragraph line height
  // (leading-[1.65] × 14px ≈ 23px feels denser, but the gap reads as a real
  // break only above ~12px). With the old mb-2 (8px) paragraph breaks looked
  // tighter than line breaks, so multi-paragraph replies "ran together" /
  // appeared to overlap. last:mb-0 keeps the bubble bottom flush.
  p: ({ children }) => <div className="mb-3 last:mb-0">{children}</div>,
  br: () => <br />,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  // Lists had no overrides → UA defaults (oversized indent, no spacing). Give
  // them controlled indent + per-item breathing room. [&>div]:m-0 neutralises
  // the paragraph-div margin inside loose-list items so list spacing stays
  // even instead of inheriting the mb-3 above.
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="leading-[1.6] [&>div]:mb-0">{children}</li>,
  pre: ({ children }) => (
    <pre className="bg-background border border-border/30 rounded p-3 my-2 overflow-x-auto text-[12px] font-mono text-foreground whitespace-pre-wrap break-words">
      {children}
    </pre>
  ),
  code: ({ inline, children }) =>
    inline ? (
      <code className="bg-secondary/60 px-1 py-0.5 rounded text-[12px] font-mono text-foreground">{children}</code>
    ) : (
      <code className="text-foreground">{children}</code>
    ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-baseline gap-0.5 rounded bg-foreground/[0.04] px-1 py-px font-mono text-[12px] text-foreground/75 hover:bg-foreground/[0.08] hover:text-foreground transition-colors"
    >
      <span>{children}</span>
      <ArrowUpRight className="self-center size-3 shrink-0 opacity-60" strokeWidth={1.75} />
    </a>
  ),
};

function FileChip({ path, onSelect }) {
  const name = path.split('/').filter(Boolean).pop();
  const relPath = path.startsWith('/home/coder/project/') ? path.slice(20) : path;
  
  // Heuristic: if it has a dot in the last part of the path, it's likely a file.
  // Exceptions like .claude are handled fine since clicking a dir or file both work.
  const isFolder = !name?.includes('.') || relPath.endsWith('/');
  const Icon = isFolder ? Folder : FileText;
  
  return (
    <button
      type="button"
      onClick={() => onSelect?.({ path: relPath, type: isFolder ? 'dir' : 'file' })}
      className="mx-0.5 inline-flex items-center gap-1 rounded-md border border-border/40 bg-foreground/[0.03] px-1.5 py-0.5 text-[12.5px] font-medium text-foreground/80 transition-colors hover:bg-foreground/[0.08] hover:text-foreground group"
    >
      <Icon className="size-3 text-muted-foreground/60 group-hover:text-foreground/70" strokeWidth={2} />
      <span>{name}</span>
    </button>
  );
}

function TextBlock({ text, onFileSelect, withSources = false }) {
  const { body, sources } = withSources ? splitSources(text) : { body: text, sources: [] };
  const processedBody = body.replace(
    /\/home\/coder\/project\/([a-zA-Z0-9._\-\/]+[a-zA-Z0-9_\-\/])/g,
    (match, relPath) => `[${relPath.split('/').filter(Boolean).pop()}](file:${match})`
  );
  const components = {
    ...MD_COMPONENTS,
    a: ({ href, children }) => {
      if (href?.startsWith('file:')) return <FileChip path={href.slice(5)} onSelect={onFileSelect} />;
      return MD_COMPONENTS.a({ href, children });
    },
  };
  return (
    <>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {processedBody}
      </ReactMarkdown>
      {sources.length > 0 && (
        <div className="mt-2 flex flex-col gap-1">
          <div className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/55">Sources</div>
          <div className="flex flex-wrap gap-1.5">
            {sources.map((s, i) => {
              const inner = (
                <>
                  <Globe className="size-3 shrink-0 opacity-55" strokeWidth={1.75} />
                  <span className="truncate">{s.label}</span>
                  {s.href && <ArrowUpRight className="size-3 shrink-0 opacity-50" strokeWidth={1.75} />}
                </>
              );
              const cls = 'inline-flex max-w-full items-center gap-2 rounded-md border border-border/50 bg-foreground/[0.03] px-2.5 py-1 font-mono text-[11.5px] text-foreground/70';
              return s.href ? (
                <a key={i} href={s.href} target="_blank" rel="noopener noreferrer" className={cn(cls, 'transition-colors hover:bg-foreground/[0.07] hover:text-foreground')}>{inner}</a>
              ) : (
                <span key={i} className={cls}>{inner}</span>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

function ImageBlock({ img }) {
  return (
    <a
      href={`data:${img.mediaType};base64,${img.data}`}
      target="_blank"
      rel="noopener noreferrer"
      className="block overflow-hidden rounded-md border border-border/50 mt-2"
    >
      <img
        src={`data:${img.mediaType};base64,${img.data}`}
        alt="Tool result"
        loading="lazy"
        className="block max-h-[420px] w-auto max-w-full"
      />
    </a>
  );
}

function AssistantBody({ text, images, content, onFileSelect }) {
  // Ordered content: interleave text and images in arrival order.
  // Falls back to legacy layout (text then images) for history messages
  // that pre-date the content array.
  if (Array.isArray(content) && content.length > 0) {
    return (
      <>
        {content.map((block, i) => {
          if (block.type === 'text') {
            // Apply sources extraction only to the last text block
            const isLast = !content.slice(i + 1).some(b => b.type === 'text');
            return <TextBlock key={i} text={block.text} onFileSelect={onFileSelect} withSources={isLast} />;
          }
          if (block.type === 'image') {
            return <ImageBlock key={i} img={block} />;
          }
          return null;
        })}
      </>
    );
  }

  // Legacy fallback: text first, then all images at the bottom.
  const { body, sources } = splitSources(text);
  const processedBody = body.replace(
    /\/home\/coder\/project\/([a-zA-Z0-9._\-\/]+[a-zA-Z0-9_\-\/])/g,
    (match, relPath) => `[${relPath.split('/').filter(Boolean).pop()}](file:${match})`
  );
  const components = {
    ...MD_COMPONENTS,
    a: ({ href, children }) => {
      if (href?.startsWith('file:')) return <FileChip path={href.slice(5)} onSelect={onFileSelect} />;
      return MD_COMPONENTS.a({ href, children });
    },
  };
  return (
    <>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {processedBody}
      </ReactMarkdown>
      {Array.isArray(images) && images.length > 0 && (
        <div className="mt-2 flex flex-col gap-2">
          {images.map((img, i) => <ImageBlock key={i} img={img} />)}
        </div>
      )}
      {sources.length > 0 && (
        <div className="mt-2 flex flex-col gap-1">
          <div className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/55">Sources</div>
          <div className="flex flex-wrap gap-1.5">
            {sources.map((s, i) => {
              const inner = (
                <>
                  <Globe className="size-3 shrink-0 opacity-55" strokeWidth={1.75} />
                  <span className="truncate">{s.label}</span>
                  {s.href && <ArrowUpRight className="size-3 shrink-0 opacity-50" strokeWidth={1.75} />}
                </>
              );
              const cls = 'inline-flex max-w-full items-center gap-2 rounded-md border border-border/50 bg-foreground/[0.03] px-2.5 py-1 font-mono text-[11.5px] text-foreground/70';
              return s.href ? (
                <a key={i} href={s.href} target="_blank" rel="noopener noreferrer" className={cn(cls, 'transition-colors hover:bg-foreground/[0.07] hover:text-foreground')}>{inner}</a>
              ) : (
                <span key={i} className={cls}>{inner}</span>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

// Friendly product copy for the various ways a chat turn can fail.
function friendlyError({ errorKind, errorStatus, errorDetail }) {
  if (errorKind === 'network') {
    return {
      icon: WifiOff,
      title: "Couldn't reach the assistant",
      body:  'Check your internet connection and try again.',
      retryable: true,
    };
  }
  if (errorKind === 'http') {
    if (errorStatus === 401 || errorStatus === 403) {
      return {
        icon: AlertCircle,
        title: 'Not authorized',
        body:  'Your session may have expired. Refresh the page and try again.',
        retryable: false,
      };
    }
    if (errorStatus === 429) {
      return {
        icon: AlertCircle,
        title: 'Slow down a bit',
        body:  "You're sending messages too quickly. Wait a few seconds and try again.",
        retryable: true,
      };
    }
    if (errorStatus >= 500) {
      return {
        icon: AlertCircle,
        title: 'Something went wrong on our end',
        body:  "We hit an unexpected error. Try again in a moment — if it keeps happening, the service may be temporarily down.",
        retryable: true,
      };
    }
    return {
      icon: AlertCircle,
      title: "Couldn't send your message",
      body:  errorDetail || 'Please try again.',
      retryable: true,
    };
  }
  if (errorKind === 'stream') {
    return {
      icon: AlertCircle,
      title: 'The reply was interrupted',
      body:  errorDetail
        ? `The assistant stopped mid-reply (${errorDetail}). Try again.`
        : 'The assistant stopped mid-reply. Try again.',
      retryable: true,
    };
  }
  return {
    icon: AlertCircle,
    title: 'Something went wrong',
    body:  errorDetail || 'Please try again.',
    retryable: true,
  };
}

function ErrorBubble({ message, onRetry }) {
  const { icon: Icon, title, body, retryable } = friendlyError(message);
  return (
    <div className="rounded-lg border border-destructive/25 bg-destructive/[0.04] px-3.5 py-2.5">
      <div className="flex items-start gap-2.5">
        <Icon className="mt-px size-3.5 shrink-0 text-destructive/85" strokeWidth={1.75} />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-foreground/90">{title}</div>
          {body && <div className="mt-0.5 text-[12.5px] text-muted-foreground/85">{body}</div>}
        </div>
      </div>
      {retryable && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background px-2.5 py-1 text-[12px] font-medium text-foreground/80 transition-colors hover:bg-muted/40 hover:text-foreground"
        >
          <RotateCcw className="size-3" strokeWidth={2} />
          Try again
        </button>
      )}
    </div>
  );
}

function UserAttachments({ attachments }) {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5 border-t border-border/40 pt-2">
      {attachments.map((a, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1.5 rounded-md bg-muted/50 px-2 py-0.5 text-[11.5px] text-foreground/75"
        >
          <Paperclip className="size-3 shrink-0 opacity-65" strokeWidth={1.75} />
          <span className="max-w-[200px] truncate">{a.name}</span>
          {typeof a.size === 'number' && (
            <span className="text-muted-foreground/60">{formatBytes(a.size)}</span>
          )}
        </span>
      ))}
    </div>
  );
}

function formatBytes(n) {
  if (n < 1024)        return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Messenger-style date divider. Returns a label string when this message
 * crosses into a new calendar day vs. the previous one (or is the very
 * first), or null when it's the same day.
 *
 *   "Today", "Yesterday", weekday name within the last 7 days, otherwise
 *   "5 March", "12 March 2025" (omits year when it's the current year).
 */
function dayDividerLabel(currentTs, prevTs) {
  if (!currentTs) return null;
  const cur = new Date(currentTs);
  if (Number.isNaN(cur.getTime())) return null;
  if (prevTs) {
    const prev = new Date(prevTs);
    if (!Number.isNaN(prev.getTime()) && sameDay(cur, prev)) return null;
  }
  return formatDayLabel(cur);
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
      && a.getMonth()    === b.getMonth()
      && a.getDate()     === b.getDate();
}

function formatDayLabel(d) {
  const now = new Date();
  if (sameDay(d, now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(d, yesterday)) return 'Yesterday';
  const diffDays = Math.floor((now - d) / 86400000);
  if (diffDays >= 0 && diffDays < 7) {
    return d.toLocaleDateString(undefined, { weekday: 'long' });
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
  }
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

function ThinkingIndicator({ chips }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className="shimmer-text text-[13px] font-medium">Thinking</span>
      {chips && chips.length > 0 && (
        <div className="flex items-center">
          <ToolChipRow chips={chips} />
        </div>
      )}
    </div>
  );
}

const GREETINGS = [
  "Good morning! What's on the agenda for today?",
  "Hello there! Ready to get some work done?",
  "Hi! How can I help you crush your tasks today?",
  "Welcome back! What are we focusing on today?",
  "Greetings! Need help with anything specific today?",
  "Hey! Let's make today productive. What's up?",
  "Good to see you! What's the plan for today?",
  "Hi! Ready to tackle today's challenges?",
  "Hello! Let's get things moving. What do you need?",
  "Welcome! What's our top priority right now?",
  "Hey there! How can I assist you with your projects today?",
  "Let's build something great today. Where do we start?",
];

function EmptyState() {
  const [greeting, setGreeting] = useState('');

  useEffect(() => {
    setGreeting(GREETINGS[Math.floor(Math.random() * GREETINGS.length)]);
  }, []);

  if (!greeting) return null;

  return (
    <div className="flex flex-1 flex-col items-start justify-center px-10 pb-12">
      <div className="relative z-10 mb-3.5 flex flex-col items-start">
        <div className="relative rounded-[20px] border border-border/50 bg-card px-5 py-3.5 shadow-[0_2px_12px_rgba(0,0,0,0.03)] text-left max-w-[280px]">
          <h3 className="text-[13.5px] font-medium text-foreground/90 leading-relaxed">
            {greeting}
          </h3>
          <div className="absolute -bottom-[6px] left-9 size-3 rotate-45 border-b border-r border-border/50 bg-card rounded-br-[2px]" />
        </div>
      </div>
      
      <SpinningAvatar className="size-[72px] opacity-90 z-0 mb-8 ml-2" />
    </div>
  );
}

/**
 * UnreadOtherSessionsBanner — slim notice that sits above the input area
 * when there's an unread notification in a session that ISN'T the one
 * currently open. Click jumps to the most recent unread session and marks
 * its notifications as read. Echoes the "you have an unread thread"
 * affordance Claude Code surfaces at the bottom of its CLI.
 */
function UnreadOtherSessionsBanner({ currentSessionId }) {
  const { notifications } = useNotifications();
  const { isRead } = useNotificationReadState();
  const otherUnread = notifications.filter(
    (n) => !isRead(n.id) && n.meta?.session_id && n.meta.session_id !== currentSessionId,
  );
  if (!otherUnread.length) return null;

  // Newest-first so the click jumps to the freshest pending session.
  const sorted = [...otherUnread].sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  const head = sorted[0];
  const count = sorted.length;
  const label = count === 1
    ? `New message in another thread${head.title ? ` — ${head.title}` : ''}`
    : `${count} new messages in other threads`;

  return (
    <div className="px-4 pt-0 pb-2">
      <button
        type="button"
        onClick={() => {
          window.dispatchEvent(new CustomEvent('ide:chat-select-session', {
            detail: { sessionId: head.meta.session_id },
          }));
        }}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-left',
          'text-[12.5px] text-foreground/85 transition-colors hover:bg-muted',
        )}
      >
        <span className="size-1.5 shrink-0 rounded-full bg-red-500" aria-hidden />
        <span className="truncate flex-1">{label}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground/70">Open ▸</span>
      </button>
    </div>
  );
}

/**
 * Composer — textarea + send button as one visual unit. Textarea on top,
 * action row at the bottom-right. Focus ring uses the warm amber accent.
 */
function Composer({ value, onChange, onSend, onStop, onKeyDown, busy, attachments, onRemoveAttachment, onAttachmentClick, onFileSelect, fileInputRef }) {
  const canSend = value.trim().length > 0;
  return (
    <div className="px-4 pb-4 pt-0">
      <div
        className={cn(
          'flex flex-col rounded-lg border border-border/50 bg-card/60',
          'transition-all duration-150',
          'focus-within:border-border/80 focus-within:bg-card/80',
        )}
      >
        {/* Textarea section */}
        <textarea
          value={value}
          onChange={e => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => {
            // Force the layout viewport to remain at (0,0). This prevents
            // iOS Safari from shifting the entire page upward to show the
            // focused element, which would push the TopBar out of view.
            // Our useVisualViewport + paddingBottom logic handles the 
            // keyboard space internally.
            setTimeout(() => window.scrollTo(0, 0), 0);
          }}
          placeholder="Ask anything"
          rows={1}
          className={cn(
            'field-sizing-content w-full resize-none bg-transparent',
            'px-3 py-2.5 leading-[1.5]',
            // Desktop matches message-bubble text-[14px]. Mobile stays at 16px
            // because iOS Safari zooms the viewport on focus when font-size
            // < 16px (it checks the computed font-size, not the visual size).
            'text-[16px] md:text-[14px]',
            'placeholder:text-muted-foreground/45',
            'outline-none',
          )}
          style={{ maxHeight: '140px' }}
        />

        {/* Footer bar: attach + chips on left, send on right */}
        <div className="flex items-center gap-2 border-t border-border/30 px-3 py-2">
          <button
            type="button"
            onClick={onAttachmentClick}
            title="Add attachment"
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12px]',
              'transition-colors duration-150',
              'text-muted-foreground/65 hover:bg-muted/30 hover:text-foreground/75',
            )}
          >
            <Paperclip className="size-3.5" strokeWidth={1.75} />
            Attach
          </button>

          {attachments.length > 0 && (
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
              {attachments.map((file, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 rounded bg-muted/50 px-1.5 py-0.5 text-[11px] text-foreground/75"
                >
                  <Paperclip className="size-3 shrink-0 opacity-65" strokeWidth={1.75} />
                  <span className="max-w-[140px] truncate">{file.name}</span>
                  <button
                    type="button"
                    onClick={() => onRemoveAttachment(i)}
                    className="ml-0.5 text-muted-foreground/60 hover:text-foreground"
                    aria-label={`Remove ${file.name}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          <button
            type="button"
            onClick={canSend ? onSend : busy ? onStop : undefined}
            disabled={!canSend && !busy}
            aria-label={canSend ? 'Send' : 'Stop'}
            className={cn(
              'ml-auto flex shrink-0 size-7 items-center justify-center rounded-md',
              'transition-all duration-150',
              (canSend || busy)
                ? 'bg-foreground text-background hover:opacity-85 active:scale-90'
                : 'cursor-not-allowed bg-muted/40 text-muted-foreground/35',
            )}
          >
            {busy && !canSend ? (
              <Square className="size-3 fill-current" />
            ) : (
              <ArrowUp className="size-3.5" strokeWidth={2.25} />
            )}
          </button>
        </div>
      </div>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        onChange={onFileSelect}
        className="hidden"
      />
    </div>
  );
}

// Parse one SSE chunk (`event: …\n` followed by `data: …` lines).
// Returns { event, data } where data is JSON-decoded if possible, else string.
function parseSseChunk(chunk) {
  const lines = chunk.split('\n');
  let event = 'message';
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith('event: ')) event = line.slice(7).trim();
    else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
  }
  if (!dataLines.length) return { event, data: null };
  const raw = dataLines.join('\n');
  try { return { event, data: JSON.parse(raw) }; }
  catch { return { event, data: raw }; }
}
