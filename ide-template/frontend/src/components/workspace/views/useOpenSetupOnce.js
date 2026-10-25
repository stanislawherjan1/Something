import { useEffect, useRef } from 'react';

// Arriving on a surface that is not connected opens its setup at once, once:
// closing the window leaves the page (with NotConnected) rather than reopening.
export default function useOpenSetupOnce({ ready, connected, open }) {
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !ready) return;
    done.current = true;
    if (!connected) open();
  }, [ready, connected, open]);
}
