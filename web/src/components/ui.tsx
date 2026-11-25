import type { ButtonHTMLAttributes, PropsWithChildren } from 'react';
import { LoaderCircle } from 'lucide-react';

export function Panel({ children, className = '' }: PropsWithChildren<{ className?: string }>) {
  return <section className={`glass-panel ${className}`}>{children}</section>;
}

export function Button({
  children, className = '', loading = false, ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) {
  return (
    <button className={`button ${className}`} disabled={props.disabled || loading} {...props}>
      {loading && <LoaderCircle size={16} className="spin" />}{children}
    </button>
  );
}

export function PageTitle({ eyebrow, title, description, action }: {
  eyebrow: string; title: string; description?: string; action?: React.ReactNode
}) {
  return <div className="page-title"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>
    {description && <p>{description}</p>}</div>{action && <div className="page-action">{action}</div>}</div>;
}

export function EmptyState({ children }: PropsWithChildren) {
  return <div className="empty-state">{children}</div>;
}

export function ErrorMessage({ children }: PropsWithChildren) {
  return <div className="error-message" role="alert">{children}</div>;
}

export function LoadingState() {
  return <div className="loading-state"><LoaderCircle className="spin" /> Memuat data...</div>;
}
