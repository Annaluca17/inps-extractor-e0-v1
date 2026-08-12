'use client';
import type { ReactNode } from 'react';

export function formatNumber(n: number | null, decimals = 2): string {
  if (n == null) return '—';
  return n.toLocaleString('it-IT', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function formatInt(n: number): string {
  return n.toLocaleString('it-IT');
}

export function Card({ title, right, children, className = '' }: {
  title?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`bg-white rounded-xl shadow ${className}`}>
      {(title || right) && (
        <header className="flex flex-wrap gap-2 justify-between items-center px-4 py-3 border-b border-gray-100">
          <h2 className="font-semibold text-gray-800">{title}</h2>
          {right}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Kpi({ label, value, hint, tone = 'blue' }: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'blue' | 'green' | 'amber' | 'gray';
}) {
  const tones = {
    blue: 'bg-blue-50 border-blue-200 text-blue-900',
    green: 'bg-green-50 border-green-200 text-green-900',
    amber: 'bg-amber-50 border-amber-200 text-amber-900',
    gray: 'bg-gray-50 border-gray-200 text-gray-800',
  } as const;
  return (
    <div className={`rounded-xl border px-4 py-3 ${tones[tone]}`}>
      <p className="text-xs uppercase tracking-wide opacity-70">{label}</p>
      <p className="text-2xl font-bold tabular-nums leading-tight mt-1">{value}</p>
      {hint && <p className="text-xs opacity-70 mt-1">{hint}</p>}
    </div>
  );
}

export function Chip({ active, onClick, children, title }: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`px-3 py-1 rounded-full border text-sm transition-colors ${
        active
          ? 'bg-blue-600 text-white border-blue-600'
          : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
      }`}
    >
      {children}
    </button>
  );
}

export function ResetChip({ onClick, children = 'Reset' }: { onClick: () => void; children?: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-3 py-1 rounded-full border text-sm bg-gray-100 text-gray-600 border-gray-300 hover:bg-gray-200"
    >
      {children}
    </button>
  );
}

export function Bar({ value, max, tone = 'blue' }: { value: number; max: number; tone?: 'blue' | 'green' }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const color = tone === 'green' ? 'bg-green-500' : 'bg-blue-500';
  return (
    <div className="h-2 w-full rounded-full bg-gray-100 overflow-hidden" title={`${pct.toFixed(1)}%`}>
      <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Alert({ tone, title, children }: {
  tone: 'error' | 'warning' | 'info';
  title: string;
  children?: ReactNode;
}) {
  const tones = {
    error: 'bg-red-50 border-red-300 text-red-800',
    warning: 'bg-yellow-50 border-yellow-300 text-yellow-800',
    info: 'bg-blue-50 border-blue-200 text-blue-800',
  } as const;
  return (
    <div className={`border rounded-lg p-4 ${tones[tone]}`}>
      <p className="font-semibold">{title}</p>
      {children && <div className="text-sm mt-1 space-y-1">{children}</div>}
    </div>
  );
}
