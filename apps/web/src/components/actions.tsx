import type {
  Alert,
  InjectIncidentRequest,
  OrphanQueue,
  OwnerAssignment,
  TelemetryIngestResponse,
} from '@picc/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellOff, Check, Zap } from 'lucide-react';
import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { api } from '../lib/api';
import { useRealtime } from '../realtime/RealtimeProvider';
import { Button, inputClass, Modal, Note, Select } from './ui';

/** Acknowledge / snooze, shown only when the role and the alert's state allow it. */
export function AlertActions({ alert }: { alert: Alert }) {
  const { can } = useAuth();
  const { pushToast } = useRealtime();
  const queryClient = useQueryClient();
  const done = () => {
    void queryClient.invalidateQueries({ queryKey: ['alerts'] });
    void queryClient.invalidateQueries({ queryKey: ['report'] });
    void queryClient.invalidateQueries({ queryKey: ['overview'] });
  };
  const failed = (error: Error) =>
    pushToast({ tone: 'critical', title: 'Action failed', body: error.message });
  const ack = useMutation({
    mutationFn: () => api.post<Alert>(`/alerts/${alert.id}/ack`, {}),
    onSuccess: done,
    onError: failed,
  });
  const snooze = useMutation({
    mutationFn: () => api.post<Alert>(`/alerts/${alert.id}/snooze`, { minutes: 60 }),
    onSuccess: done,
    onError: failed,
  });
  if (alert.status === 'resolved') return null;
  return (
    <span className="inline-flex gap-1.5">
      {can('alerts:ack') && alert.status === 'firing' && (
        <Button size="sm" busy={ack.isPending} onClick={() => ack.mutate()}>
          <Check size={13} /> Acknowledge
        </Button>
      )}
      {can('alerts:snooze') && !alert.snoozedUntil && (
        <Button
          size="sm"
          variant="ghost"
          busy={snooze.isPending}
          onClick={() => snooze.mutate()}
          title="Silence notifications for one hour"
        >
          <BellOff size={13} />
          <span className="sr-only">Snooze for one hour</span>
        </Button>
      )}
    </span>
  );
}

export function AssignOwnerDialog({
  reportId,
  reportName,
  suggestedOwner,
  onClose,
}: {
  reportId: string;
  reportName: string;
  suggestedOwner?: string | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useRealtime();
  const queue = useQuery({
    queryKey: ['orphans'],
    queryFn: () => api.get<OrphanQueue>('/orphans'),
  });
  const owners = queue.data?.assignableOwners ?? [];
  const [ownerEmail, setOwnerEmail] = useState(suggestedOwner ?? '');
  const [note, setNote] = useState('');
  const chosen = ownerEmail || suggestedOwner || owners[0]?.email || '';

  const assign = useMutation({
    mutationFn: () =>
      api.post<OwnerAssignment>(`/reports/${reportId}/owner`, {
        ownerEmail: chosen,
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    onSuccess: (assignment) => {
      for (const key of ['orphans', 'reports', 'report', 'overview', 'alerts', 'costs', 'audit'])
        void queryClient.invalidateQueries({ queryKey: [key] });
      pushToast({
        tone: 'good',
        title: 'Owner assigned',
        body: `${reportName} now belongs to ${assignment.ownerEmail}. Its open alerts were re-routed.`,
      });
      onClose();
    },
  });

  return (
    <Modal
      title={`Assign an owner to ${reportName}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            busy={assign.isPending}
            disabled={!chosen}
            onClick={() => assign.mutate()}
          >
            Assign owner
          </Button>
        </>
      }
    >
      <div className="space-y-3.5">
        <div>
          <label htmlFor="owner" className="block text-[13px] font-medium">
            Owner
          </label>
          <Select
            id="owner"
            value={chosen}
            onChange={(e) => setOwnerEmail(e.target.value)}
            className="mt-1 w-full"
          >
            {owners.map((owner) => (
              <option key={owner.email} value={owner.email}>
                {owner.email} · owns {owner.reportsOwned}
                {owner.email === suggestedOwner ? ' · suggested' : ''}
              </option>
            ))}
          </Select>
          {suggestedOwner && (
            <p className="mt-1.5 text-[12.5px] text-ink-2">
              Suggested: <span className="font-medium text-ink">{suggestedOwner}</span>, the last
              named owner in this report's history.
            </p>
          )}
        </div>
        <div>
          <label htmlFor="note" className="block text-[13px] font-medium">
            Note <span className="font-normal text-ink-3">(optional, kept in the audit log)</span>
          </label>
          <input
            id="note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            className={`${inputClass} mt-1 w-full`}
            placeholder="Why this person"
          />
        </div>
        <Note>
          The change is audited, broadcast to connected users, and the report's open alerts stop
          escalating to admins.
        </Note>
        {assign.isError && (
          <div
            role="alert"
            className="rounded-lg bg-critical-wash px-3 py-2 text-[13px] text-critical-ink"
          >
            {assign.error.message}
          </div>
        )}
      </div>
    </Modal>
  );
}

const INCIDENTS: { kind: InjectIncidentRequest['kind']; label: string }[] = [
  { kind: 'latency_spike', label: 'Latency spike (42 s)' },
  { kind: 'refresh_failure', label: 'Refresh failure' },
  { kind: 'refresh_timeout', label: 'Refresh timeout' },
  { kind: 'recovery', label: 'Recovery' },
];

/** Sends one synthetic observation through the real telemetry pipeline. */
export function IncidentButtons({ reportId, compact }: { reportId: string; compact?: boolean }) {
  const { pushToast } = useRealtime();
  const inject = useMutation({
    mutationFn: (kind: InjectIncidentRequest['kind']) =>
      api.post<TelemetryIngestResponse>('/admin/incidents', { reportId, kind }),
    onError: (error: Error) =>
      pushToast({ tone: 'critical', title: 'Injection failed', body: error.message }),
  });
  return (
    <div className="flex flex-wrap gap-2">
      {INCIDENTS.map((incident) => (
        <Button
          key={incident.kind}
          size={compact ? 'sm' : 'md'}
          disabled={inject.isPending}
          onClick={() => inject.mutate(incident.kind)}
        >
          {incident.kind !== 'recovery' && <Zap size={13} />}
          {incident.label}
        </Button>
      ))}
    </div>
  );
}
