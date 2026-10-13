import type { UseQueryResult } from '@tanstack/react-query';
import { CircleAlert, Inbox, LoaderCircle, X } from 'lucide-react';
import {
  type ButtonHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  useEffect,
  useRef,
  useState,
} from 'react';
import { ApiError } from '../lib/api';

export const cx = (...parts: (string | false | null | undefined)[]): string =>
  parts.filter(Boolean).join(' ');

/**
 * A region that may scroll. When its content actually overflows it becomes a keyboard stop with
 * a name, so someone not using a mouse can reach what is below the fold; when it fits, it stays
 * out of the tab order.
 */
export function ScrollArea({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollable, setScrollable] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const check = () =>
      setScrollable(
        element.scrollHeight > element.clientHeight + 1 ||
          element.scrollWidth > element.clientWidth + 1,
      );
    check();
    const observer = new ResizeObserver(check);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      className={className}
      {...(scrollable ? { tabIndex: 0, role: 'region', 'aria-label': label } : {})}
    >
      {children}
    </div>
  );
}

export function Card({
  title,
  subtitle,
  actions,
  children,
  className,
  flush,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** No inner padding: for tables that run edge to edge. */
  flush?: boolean;
}) {
  return (
    <section className={cx('min-w-0 rounded-xl border border-line bg-surface', className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 px-5 pt-4 pb-3">
          <div className="min-w-0">
            {title && <h2 className="text-[15px] font-semibold text-ink">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-[13px] text-ink-2">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={flush ? '' : cx('px-5 pb-5', !title && !actions && 'pt-5')}>{children}</div>
    </section>
  );
}

export type Tone = 'neutral' | 'good' | 'warning' | 'serious' | 'critical' | 'accent';

const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-ink',
  good: 'text-good-ink',
  warning: 'text-warning-ink',
  serious: 'text-serious-ink',
  critical: 'text-critical-ink',
  accent: 'text-accent-ink',
};

/** A headline number. The figure stays in ink; tone is carried by the icon and the hint. */
export function Stat({
  label,
  value,
  hint,
  icon,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  tone?: Tone;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-surface px-5 py-4">
      <div className="flex items-center justify-between gap-2 text-[13px] text-ink-2">
        <span>{label}</span>
        {icon && <span className={TONE_TEXT[tone]}>{icon}</span>}
      </div>
      <div className="mt-1.5 text-[28px] leading-8 font-semibold tracking-tight text-ink">
        {value}
      </div>
      {hint && (
        <div
          className={cx('mt-1 text-[13px]', tone === 'neutral' ? 'text-ink-2' : TONE_TEXT[tone])}
        >
          {hint}
        </div>
      )}
    </div>
  );
}

const BADGE: Record<Tone | 'info', string> = {
  neutral: 'bg-surface-2 text-ink-2',
  info: 'bg-info-wash text-info-ink',
  good: 'bg-good-wash text-good-ink',
  warning: 'bg-warning-wash text-warning-ink',
  serious: 'bg-serious-wash text-serious-ink',
  critical: 'bg-critical-wash text-critical-ink',
  accent: 'bg-accent-wash text-accent-ink',
};

export function Badge({
  tone = 'neutral',
  icon,
  children,
  title,
}: {
  tone?: Tone | 'info';
  icon?: ReactNode;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cx(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] font-medium whitespace-nowrap',
        BADGE[tone],
      )}
    >
      {icon}
      {children}
    </span>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
const BUTTON: Record<ButtonVariant, string> = {
  primary: 'bg-ink text-surface hover:opacity-85',
  secondary: 'border border-line-2 bg-surface text-ink hover:bg-surface-2',
  ghost: 'text-ink-2 hover:bg-surface-2 hover:text-ink',
  danger: 'bg-critical text-white hover:opacity-90',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  busy,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || busy}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-7 px-2.5 text-[12.5px]' : 'h-9 px-3.5 text-[13.5px]',
        BUTTON[variant],
        className,
      )}
    >
      {busy && <LoaderCircle size={14} className="animate-spin" />}
      {children}
    </button>
  );
}

export const inputClass =
  'h-9 rounded-lg border border-line-2 bg-surface px-3 text-[13.5px] text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none';

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={cx(inputClass, 'pr-8', className)}>
      {children}
    </select>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: ReactNode }[];
  label: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="inline-flex max-w-full overflow-x-auto rounded-lg border border-line bg-surface-2 p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          onClick={() => onChange(option.value)}
          className={cx(
            'h-7 shrink-0 rounded-md px-3 text-[13px] font-medium whitespace-nowrap transition-colors',
            value === option.value ? 'bg-surface text-ink shadow-sm' : 'text-ink-2 hover:text-ink',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[22px] leading-7 font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-[14px] text-ink-2">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-ink-2" role="status">
      <LoaderCircle size={18} className="animate-spin" />
      {label}
    </div>
  );
}

export function Empty({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 px-6 py-12 text-center">
      <Inbox size={22} className="text-ink-3" />
      <div className="mt-1 font-medium text-ink">{title}</div>
      {hint && <div className="max-w-md text-[13px] text-ink-2">{hint}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const api = error instanceof ApiError ? error : null;
  const title =
    api?.status === 403
      ? 'You do not have access to this'
      : api?.status === 404
        ? 'Not found'
        : 'Something went wrong';
  return (
    <div
      className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center"
      role="alert"
    >
      <CircleAlert size={22} className="text-critical-ink" />
      <div className="font-medium text-ink">{title}</div>
      <div className="max-w-md text-[13px] text-ink-2">
        {error instanceof Error ? error.message : 'Unknown error'}
      </div>
      {api?.problem?.requestId && (
        <div className="font-mono text-[11px] text-ink-3">request {api.problem.requestId}</div>
      )}
      {onRetry && api?.status !== 403 && api?.status !== 404 && (
        <Button size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

/** Renders `children` once the query has data; otherwise the loading or error state. */
export function QueryBoundary<T>({
  query,
  children,
}: {
  query: UseQueryResult<T>;
  children: (data: T) => ReactNode;
}) {
  if (query.data !== undefined) return <>{children(query.data)}</>;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  return <Loading />;
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click is a convenience; Escape and the close button are the accessible paths
    <div
      role="presentation"
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[10vh]"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cx(
          'w-full rounded-xl border border-line bg-surface shadow-xl',
          wide ? 'max-w-2xl' : 'max-w-md',
        )}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-ink-2 hover:bg-surface-2"
          >
            <X size={16} />
          </button>
        </header>
        <div className="px-5 py-4">{children}</div>
        {footer && (
          <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}

export const th =
  'px-3 py-2 text-left text-[12px] font-medium tracking-wide text-ink-3 uppercase whitespace-nowrap';
export const td = 'px-3 py-2.5 align-middle text-[13.5px]';
export const thNum = `${th} text-right`;
export const tdNum = `${td} tnum text-right`;

export function TableShell({ children }: { children: ReactNode }) {
  return (
    <ScrollArea label="Table" className="relative overflow-x-auto">
      <table className="w-full border-collapse [&_tbody_tr]:border-t [&_tbody_tr]:border-line [&_thead_th]:first:pl-5 [&_tr_td]:first:pl-5 [&_tr_td]:last:pr-5 [&_tr_th]:last:pr-5">
        {children}
      </table>
    </ScrollArea>
  );
}

export function Pager({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  return (
    <div className="flex items-center justify-between border-t border-line px-5 py-2.5 text-[13px] text-ink-2">
      <span className="tnum">
        {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total.toLocaleString()}
      </span>
      <div className="flex gap-2">
        <Button size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <Button size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </div>
    </div>
  );
}

/** Explains what a figure means, right where it is shown. */
export function Note({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'warning' | 'accent';
}) {
  return (
    <div
      className={cx(
        'rounded-lg px-3.5 py-2.5 text-[13px]',
        tone === 'warning'
          ? 'bg-warning-wash text-warning-ink'
          : tone === 'accent'
            ? 'bg-accent-wash text-accent-ink'
            : 'bg-surface-2 text-ink-2',
      )}
    >
      {children}
    </div>
  );
}
