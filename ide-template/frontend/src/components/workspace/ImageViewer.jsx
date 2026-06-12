import { Image as ImageIcon } from 'lucide-react';
import EditorHeader from './EditorHeader.jsx';

/**
 * ImageViewer — used by EditorPane for image extensions. Renders the bytes
 * via /api/files/raw. The watcher bumps fileEventNonce on FS events; we
 * encode it into the URL so the browser refetches when the file changes.
 */
export default function ImageViewer({ path, fileEventNonce, sidebarOpen }) {
  const url = `/api/files/raw?path=${encodeURIComponent(path)}&v=${fileEventNonce ?? 0}`;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorHeader icon={ImageIcon} title={path} sidebarOpen={sidebarOpen} />
      <div className="flex flex-1 items-center justify-center overflow-auto bg-muted/30 p-6">
        <img
          src={url}
          alt={path}
          className="max-h-full max-w-full object-contain"
          onError={(e) => { e.currentTarget.style.display = 'none'; }}
        />
      </div>
    </div>
  );
}
