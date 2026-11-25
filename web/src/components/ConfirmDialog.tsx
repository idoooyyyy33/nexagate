import { useEffect, useRef } from 'react';
import { Button } from './ui';

export function ConfirmDialog({ title, children, onCancel, onConfirm, busy = false }: {
  title: string; children: React.ReactNode; onCancel: () => void; onConfirm: () => void; busy?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return <div className="dialog-scrim" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onCancel();
  }}>
    <div className="dialog glass-panel" role="alertdialog" aria-modal="true" aria-labelledby="dialog-title" tabIndex={-1} ref={ref}>
      <h2 id="dialog-title">{title}</h2><div className="dialog-body">{children}</div>
      <div className="dialog-actions"><Button className="button-quiet" onClick={onCancel} disabled={busy}>Batal</Button>
        <Button className="button-primary" onClick={onConfirm} loading={busy}>Konfirmasi</Button></div>
    </div>
  </div>;
}
