import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogFooter,
  AlertDialogTitle, AlertDialogDescription,
  AlertDialogAction, AlertDialogCancel,
} from '@/components/ui/alert-dialog';

/**
 * DeleteConfirm — controlled AlertDialog for file/folder deletion.
 *
 *   target = { path, type: 'file'|'dir' } | null
 * Opening the dialog means target is non-null. Confirm fires onConfirm and
 * the parent is responsible for the actual DELETE call.
 */
export default function DeleteConfirm({ target, onCancel, onConfirm }) {
  const open = !!target;
  const isDir = target?.type === 'dir';
  return (
    <AlertDialog open={open} onOpenChange={(v) => { if (!v) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {isDir ? 'folder' : 'file'}?</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-mono text-foreground/85">{target?.path}</span>
            {' '}will be removed permanently.
            {isDir && ' All files and subfolders inside will be lost.'} This can't be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => onConfirm(target)}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
