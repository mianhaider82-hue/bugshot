/** Tiny shared UI primitives – kept dependency-free on purpose. */

import type { ReactNode } from 'react';
import type { ReportStatus, Severity } from '../types';

export function Badge({ severity }: { severity: Severity }): JSX.Element {
  return <span className={`badge ${severity.toLowerCase()}`}>{severity}</span>;
}

export function StatusBadge({ status }: { status: ReportStatus }): JSX.Element {
  const label =
    status === 'submitted'
      ? 'Submitted'
      : status === 'draft'
        ? 'Draft'
        : status === 'failed'
          ? 'Failed (saved locally)'
          : 'Ready';
  return <span className={`badge ${status}`}>{label}</span>;
}

export function Spinner(): JSX.Element {
  return <span className="spinner" aria-label="loading" />;
}

export function Busy({ message }: { message: string }): JSX.Element {
  return (
    <div className="busy">
      <Spinner />
      {message}
    </div>
  );
}

export function ErrorNotice({ message }: { message: string | null }): JSX.Element | null {
  if (!message) return null;
  return <div className="notice error">{message}</div>;
}

export function Card({ title, children }: { title?: string; children: ReactNode }): JSX.Element {
  return (
    <div className="card">
      {title && <h3>{title}</h3>}
      {children}
    </div>
  );
}
