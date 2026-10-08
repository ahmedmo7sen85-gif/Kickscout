'use client';

import Link from 'next/link';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

interface ToastItem { id: number; text: string; tone: 'info' | 'error' | 'success'; action?: { label: string; href: string } }
interface ToastApi { show: (text: string, opts?: { tone?: ToastItem['tone']; action?: ToastItem['action'] }) => void }

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const show = useCallback<ToastApi['show']>((text, opts) => {
    const id = next.current++;
    setItems((xs) => [...xs.slice(-2), { id, text, tone: opts?.tone ?? 'info', action: opts?.action }]);
    window.setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 4500);
  }, []);
  const api = useMemo(() => ({ show }), [show]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((x) => (
          <div key={x.id} className={`toast toast--${x.tone}`}>
            <span>{x.text}</span>
            {x.action ? <Link className="toast__action" href={x.action.href}>{x.action.label}</Link> : null}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const v = useContext(ToastContext);
  if (!v) throw new Error('useToast must be used inside ToastProvider');
  return v;
}
