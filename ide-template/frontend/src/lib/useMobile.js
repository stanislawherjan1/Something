import { useState, useEffect } from 'react';

export function useMobile(breakpoint = 768) {
  // Safe check for SSR/tests
  const getIsMobile = () => typeof window !== 'undefined' ? window.innerWidth <= breakpoint : false;
  
  const [isMobile, setIsMobile] = useState(getIsMobile);
  
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => setIsMobile(window.innerWidth <= breakpoint);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [breakpoint]);
  
  return isMobile;
}
