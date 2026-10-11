import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_HEALTH_CHECK_DAYS,
  HEALTH_CHECK_OPTIONS,
  describeHealthCheck,
  healthCheckDays,
  healthCheckDue,
  healthCheckDueAt,
  healthCheckHint,
  keysDueForCheck,
  mnemonicMatches,
  normaliseMnemonic,
  recordHealthCheck,
  setHealthCheckDays,
} from '../src/lib/keyHealth';

const DAY = 24 * 60 * 60 * 1000;
const ADDED = Date.UTC(2025, 0, 1);

describe('key health checks', () => {
  it('falls due a year after the key was added by default', () => {
    const key = { createdAt: ADDED };
    assert.equal(healthCheckDays(key), DEFAULT_HEALTH_CHECK_DAYS);
    assert.equal(healthCheckDueAt(key), ADDED + 365 * DAY);
    assert.equal(healthCheckDue(key, ADDED + 364 * DAY), false);
    assert.equal(healthCheckDue(key, ADDED + 365 * DAY), true);
    assert.equal(healthCheckDue(key, ADDED + 10 * 365 * DAY), true, 'an old key stays due until checked');
  });

  it('restarts the clock from the last passed check', () => {
    const key = { createdAt: ADDED, lastHealthCheckAt: ADDED + 300 * DAY };
    assert.equal(healthCheckDueAt(key), ADDED + 665 * DAY);
    assert.equal(healthCheckDue(key, ADDED + 400 * DAY), false);
    // A check recorded before the key existed (clock skew) cannot pull the date earlier.
    assert.equal(healthCheckDueAt({ createdAt: ADDED, lastHealthCheckAt: ADDED - 500 * DAY }), ADDED + 365 * DAY);
  });

  it('honours a custom interval and lets reminders be turned off', () => {
    assert.equal(healthCheckDueAt({ createdAt: ADDED, healthCheckDays: 90 }), ADDED + 90 * DAY);
    assert.equal(healthCheckDueAt({ createdAt: ADDED, healthCheckDays: 0 }), null);
    assert.equal(healthCheckDue({ createdAt: ADDED, healthCheckDays: 0 }, ADDED + 50 * 365 * DAY), false);
    // Garbage in the record falls back to the default rather than never reminding.
    assert.equal(healthCheckDays({ createdAt: ADDED, healthCheckDays: -3 }), DEFAULT_HEALTH_CHECK_DAYS);
    assert.equal(healthCheckDays({ createdAt: ADDED, healthCheckDays: NaN }), DEFAULT_HEALTH_CHECK_DAYS);
  });

  it('lists only the keys that are due', () => {
    const now = ADDED + 400 * DAY;
    const keys = [
      { id: 'old', createdAt: ADDED },
      { id: 'fresh', createdAt: now - DAY },
      { id: 'checked', createdAt: ADDED, lastHealthCheckAt: now - 10 * DAY },
      { id: 'off', createdAt: ADDED, healthCheckDays: 0 },
      { id: 'quarterly', createdAt: now - 100 * DAY, healthCheckDays: 90 },
    ];
    assert.deepEqual(keysDueForCheck(keys, now).map((k) => k.id), ['old', 'quarterly']);
  });

  it('produces patches and validates the interval', () => {
    assert.deepEqual(recordHealthCheck(123), { lastHealthCheckAt: 123 });
    assert.deepEqual(setHealthCheckDays(180), { healthCheckDays: 180 });
    assert.deepEqual(setHealthCheckDays(0), { healthCheckDays: 0 });
    assert.throws(() => setHealthCheckDays(-1), /whole number of days/);
    assert.throws(() => setHealthCheckDays(1.5), /whole number of days/);
    assert.ok(HEALTH_CHECK_OPTIONS.some((o) => o.days === DEFAULT_HEALTH_CHECK_DAYS), 'the default is one of the choices');
    assert.ok(HEALTH_CHECK_OPTIONS.some((o) => o.days === 0), 'off is one of the choices');
  });

  it('describes the state in plain words', () => {
    const now = ADDED + 400 * DAY;
    assert.match(describeHealthCheck({ createdAt: ADDED }, now), /^Check due — never checked since it was added on /);
    assert.match(describeHealthCheck({ createdAt: ADDED, lastHealthCheckAt: ADDED + 20 * DAY }, now), /^Check due — last checked /);
    assert.match(describeHealthCheck({ createdAt: ADDED, lastHealthCheckAt: now - DAY }, now), /^Checked .* · next due /);
    assert.match(describeHealthCheck({ createdAt: now - DAY }, now), /^Never checked · due /);
    assert.equal(describeHealthCheck({ createdAt: ADDED, healthCheckDays: 0 }, now), 'Reminders are off.');
  });

  it('explains the check per key type', () => {
    assert.match(healthCheckHint({ type: 'local' }), /written backup/);
    assert.match(healthCheckHint({ type: 'imported', source: 'tapsigner' }), /Tap the card/);
    for (const source of ['ledger', 'trezor', 'bitbox02'] as const) {
      assert.match(healthCheckHint({ type: 'imported', source }), /Plug the device in/);
    }
    assert.match(healthCheckHint({ type: 'imported' }), /Read the public key from the device/);
  });

  it('compares a typed phrase loosely but exactly', () => {
    const stored = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    assert.equal(normaliseMnemonic('  Abandon\nabandon  ABOUT '), 'abandon abandon about');
    assert.equal(mnemonicMatches(`  ${stored.toUpperCase().replace(/ /g, '\n')} `, stored), true);
    assert.equal(mnemonicMatches(stored.replace('about', 'above'), stored), false);
    assert.equal(mnemonicMatches(stored + ' extra', stored), false);
    assert.equal(mnemonicMatches('', stored), false);
    assert.equal(mnemonicMatches('   ', ''), false, 'an empty phrase never matches');
  });
});
