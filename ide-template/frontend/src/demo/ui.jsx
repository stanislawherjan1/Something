// The demo's one control: in the user menu, in place of Sign out, look at the
// workspace as the other person (the founder, or Mara from the team). It shows
// what stays private. Renders nothing outside the demo build.

import { Users } from 'lucide-react';
import { IS_DEMO, getViewer, setViewer } from './flags.js';

export function DemoViewAsItem({ onDone }) {
  if (!IS_DEMO) return null;
  const other = getViewer() === 'admin' ? 'member' : 'admin';
  return (
    <button
      onClick={() => { onDone?.(); setViewer(other); window.location.reload(); }}
      className="menu-item"
    >
      <Users className="size-4 shrink-0 text-muted-foreground/65" strokeWidth={1.75} />
      {other === 'member' ? 'View as Mara, from the team' : 'View as Nora, the founder'}
    </button>
  );
}
