import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AssignOwnerRequestSchema,
  ClientMessageSchema,
  LoginRequestSchema,
  ReportListQuerySchema,
  TelemetryEventSchema,
  UpdateAlertRuleRequestSchema,
} from '../src/index.js';

describe('request schemas', () => {
  it('normalises email addresses before they reach a handler', () => {
    assert.equal(
      LoginRequestSchema.parse({ email: '  Admin@Company.COM ', password: 'x' }).email,
      'admin@company.com',
    );
    assert.equal(
      AssignOwnerRequestSchema.parse({ ownerEmail: 'User_7@company.com' }).ownerEmail,
      'user_7@company.com',
    );
    assert.equal(
      LoginRequestSchema.safeParse({ email: 'not-an-email', password: 'x' }).success,
      false,
    );
  });

  it('applies list defaults and bounds the page size', () => {
    assert.deepEqual(ReportListQuerySchema.parse({}), {
      page: 1,
      pageSize: 50,
      sort: 'reportId',
      order: 'asc',
    });
    assert.equal(ReportListQuerySchema.parse({ pageSize: '25' }).pageSize, 25);
    assert.equal(ReportListQuerySchema.safeParse({ pageSize: '5000' }).success, false);
    assert.equal(ReportListQuerySchema.safeParse({ sort: 'password_hash' }).success, false);
  });

  it('requires a telemetry event to carry at least one measurement', () => {
    assert.equal(TelemetryEventSchema.safeParse({ reportId: 'RPT_203' }).success, false);
    assert.equal(
      TelemetryEventSchema.safeParse({ reportId: 'RPT_203', loadTimeSec: 16.2 }).success,
      true,
    );
    assert.equal(
      TelemetryEventSchema.safeParse({ reportId: 'RPT_203', refreshStatus: 'EXPLODED' }).success,
      false,
    );
    assert.equal(
      TelemetryEventSchema.safeParse({ reportId: "RPT_203'; DROP TABLE", loadTimeSec: 1 }).success,
      false,
    );
  });

  it('accepts negative credits so they can be flagged rather than silently refused', () => {
    assert.equal(
      TelemetryEventSchema.safeParse({ reportId: 'RPT_203', creditsConsumed: -7.88 }).success,
      true,
    );
  });

  it('rejects alert thresholds that do not increase', () => {
    assert.equal(
      UpdateAlertRuleRequestSchema.safeParse({ warningThreshold: 30, highThreshold: 20 }).success,
      false,
    );
    assert.equal(
      UpdateAlertRuleRequestSchema.safeParse({
        warningThreshold: 10,
        highThreshold: 20,
        criticalThreshold: 30,
      }).success,
      true,
    );
  });

  it('only admits known WebSocket client messages', () => {
    assert.equal(ClientMessageSchema.safeParse({ type: 'ping' }).success, true);
    assert.equal(
      ClientMessageSchema.safeParse({ type: 'subscribe', topics: ['alerts'] }).success,
      true,
    );
    assert.equal(
      ClientMessageSchema.safeParse({ type: 'subscribe', topics: ['everything'] }).success,
      false,
    );
    assert.equal(ClientMessageSchema.safeParse({ type: 'subscribe', topics: [] }).success, false);
    assert.equal(ClientMessageSchema.safeParse({ type: 'ack', alertId: 'x' }).success, false);
  });
});
