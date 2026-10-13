import type { OwnerAssignment } from '@picc/contracts';
import type { Principal } from '../auth/principal.js';
import type { OwnerAssignmentRepository } from '../opsdb/repositories.js';
import type { WarehouseHandle } from '../warehouse/handle.js';

export interface EffectiveOwner {
  email: string | null;
  source: 'telemetry' | 'assigned' | null;
}

/**
 * Who owns a report right now.
 *
 * The portal's telemetry says who the owner was in the latest period; an assignment made in
 * the Command Centre overrides it. This is also the single place row-level security is
 * decided: REST handlers and the real-time gateway both ask `canSee`.
 */
export class OwnershipService {
  private readonly assigned = new Map<string, OwnerAssignment>();

  constructor(
    private readonly assignments: OwnerAssignmentRepository,
    private readonly warehouse: WarehouseHandle,
  ) {
    for (const assignment of assignments.all()) this.assigned.set(assignment.reportId, assignment);
  }

  /** Owner per report as of the latest period in the warehouse. Follows a refresh. */
  private get telemetryOwner(): Map<string, string | null> {
    return this.warehouse.derive(
      'ownership.telemetry',
      (s) => new Map(s.dim.map((report) => [report.report_id, report.owner_email])),
    );
  }

  exists(reportId: string): boolean {
    return this.telemetryOwner.has(reportId);
  }

  /** Every report in the catalogue. */
  reportIds(): string[] {
    return [...this.telemetryOwner.keys()];
  }

  ownerOf(reportId: string): EffectiveOwner {
    const assignment = this.assigned.get(reportId);
    if (assignment) return { email: assignment.ownerEmail, source: 'assigned' };
    const email = this.telemetryOwner.get(reportId) ?? null;
    return { email, source: email ? 'telemetry' : null };
  }

  isOrphaned(reportId: string): boolean {
    return this.ownerOf(reportId).email === null;
  }

  reportsOwnedBy(email: string): string[] {
    const owned: string[] = [];
    for (const reportId of this.telemetryOwner.keys()) {
      if (this.ownerOf(reportId).email === email) owned.push(reportId);
    }
    return owned;
  }

  /** `null` means unrestricted. */
  visibleReportIds(principal: Principal): string[] | null {
    return principal.scope === 'all' ? null : this.reportsOwnedBy(principal.email);
  }

  canSee(principal: Principal, reportId: string): boolean {
    if (!this.exists(reportId)) return false;
    return principal.scope === 'all' || this.ownerOf(reportId).email === principal.email;
  }

  assign(
    reportId: string,
    ownerEmail: string,
    assignedBy: string,
    at: string,
    note: string | null,
  ): OwnerAssignment {
    const assignment = this.assignments.insert({
      reportId,
      ownerEmail,
      previousOwnerEmail: this.ownerOf(reportId).email,
      assignedBy,
      assignedAt: at,
      note,
    });
    this.assigned.set(reportId, assignment);
    return assignment;
  }

  history(reportId: string): OwnerAssignment[] {
    return this.assignments.forReport(reportId);
  }
}
