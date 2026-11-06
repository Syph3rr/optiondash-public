// Run with: node --test "tests/frontend/*.test.cjs"
const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../../modules/analyser/web/controls.js');

const utc = (mo, d, h, min = 0) => Date.UTC(2026, mo - 1, d, h, min);

test('New York wall time converts across the DST change', () => {
  // EDT is UTC-4 until 1 Nov 2026, EST is UTC-5 after it
  assert.equal(c.nyToMs('2026-10-30', 9 * 60 + 30), utc(10, 30, 13, 30));
  assert.equal(c.nyToMs('2026-11-03', 9 * 60 + 30), utc(11, 3, 14, 30));
  assert.equal(c.nyToMs('2026-11-01', 30), utc(11, 1, 4, 30));
  assert.equal(c.nyToMs('2026-11-01', 12 * 60), utc(11, 1, 17));
});

test('nyParts reads the New York day, not the UTC or local day', () => {
  assert.deepEqual(c.nyParts(utc(11, 3, 5)), { day: '2026-11-03', minutes: 0 });
  assert.deepEqual(c.nyParts(utc(11, 3, 4, 59)), { day: '2026-11-02', minutes: 23 * 60 + 59 });
});

test('dayList covers every New York day from start to end', () => {
  // 03:00Z on 2 Nov is still 22:00 on 1 Nov in New York
  assert.deepEqual(c.dayList(utc(11, 2, 3), utc(11, 3, 21)),
    ['2026-11-01', '2026-11-02', '2026-11-03']);
  assert.deepEqual(c.dayList(utc(11, 3, 15), utc(11, 3, 16)), ['2026-11-03']);
});

test('dayWindow limits the time slider to the reachable part of the day', () => {
  const now = utc(11, 3, 14, 37);   // 09:37 NY, snaps down to 09:30
  const end = utc(11, 5, 21);       // 16:00 NY
  assert.deepEqual(c.dayWindow('2026-11-03', now, end), { min: 570, max: 1425 });
  assert.deepEqual(c.dayWindow('2026-11-04', now, end), { min: 0, max: 1425 });
  assert.deepEqual(c.dayWindow('2026-11-05', now, end), { min: 0, max: 960 });
});

test('clamp keeps a selection inside now..end', () => {
  assert.equal(c.clamp(5, 10, 20), 10);
  assert.equal(c.clamp(25, 10, 20), 20);
  assert.equal(c.clamp(15, 10, 20), 15);
});

test('nextExpiry cycles through leg expiries', () => {
  assert.equal(c.nextExpiry(0, [10, 30]), 10);
  assert.equal(c.nextExpiry(10, [10, 30]), 30);
  assert.equal(c.nextExpiry(30, [10, 30]), 10);
  assert.equal(c.nextExpiry(5, []), null);
});

test('snap rounds to the step, stays in bounds and rejects junk', () => {
  assert.equal(c.snap(3.27, 0.1, -20, 20), 3.3);
  assert.equal(c.snap(-2.26, 0.5, -20, 20), -2.5);
  assert.equal(c.snap(25, 0.1, -20, 20), 20);
  assert.equal(c.snap(-25, 0.1, -20, 20), -20);
  assert.equal(c.snap(NaN, 0.1, -20, 20), null);
  assert.equal(c.snap('', 0.1, -20, 20), null);
});

test('wheelDir maps scrolling up to an increase', () => {
  assert.equal(c.wheelDir(-120), 1);
  assert.equal(c.wheelDir(120), -1);
  assert.equal(c.wheelDir(0), 0);
});

test('labels show New York and the viewer time for the same instant', () => {
  assert.deepEqual(c.labels(utc(11, 2, 14, 30), 'Australia/Melbourne'),
    { ny: 'Mon 2 Nov 09:30 ET', local: 'Tue 3 Nov 01:30' });
});

test('an expiry pin stays exactly on the expiry however much time passes', () => {
  const sel = { tSel: null, tPin: 1 };
  assert.equal(c.selectionDays(sel, [10, 30], utc(11, 2, 3)), 30);
  assert.equal(c.selectionDays(sel, [10, 30], utc(11, 2, 3) + 600000), 30);
});

test('selectionDays reads a timestamp as time from now and treats none as now', () => {
  const now = utc(11, 2, 3);
  assert.equal(c.selectionDays({ tSel: now + c.DAY_MS * 2.5, tPin: null }, [], now), 2.5);
  assert.equal(c.selectionDays({ tSel: null, tPin: null }, [], now), 0);
  assert.equal(c.selectionDays({ tSel: now - 1000, tPin: null }, [], now), 0);
});

test('the step base is the stored selection, not the clock plus a stale reply', () => {
  const now = utc(11, 2, 3), sel = now + c.DAY_MS;
  assert.equal(c.selectionMs({ tSel: sel, tPin: null }, [], now + 600000, 30), sel);
  assert.equal(c.selectionMs({ tSel: null, tPin: null }, [], now, 30), now);
  assert.equal(c.selectionMs({ tSel: null, tPin: 0 }, [2], now, 30), now + 2 * c.DAY_MS);
});

test('normaliseSelection drops past times and pins that no longer exist', () => {
  const now = utc(11, 2, 3);
  assert.deepEqual(c.normaliseSelection({ tSel: now - 1, tPin: null }, [10], 10, now), { tSel: null, tPin: null });
  assert.deepEqual(c.normaliseSelection({ tSel: null, tPin: 3 }, [10], 10, now), { tSel: null, tPin: null });
});

test('normaliseSelection clamps a time beyond the last expiry and keeps a valid one', () => {
  const now = utc(11, 2, 3);
  assert.deepEqual(c.normaliseSelection({ tSel: now + 20 * c.DAY_MS, tPin: null }, [10], 10, now),
    { tSel: now + 10 * c.DAY_MS, tPin: null });
  assert.deepEqual(c.normaliseSelection({ tSel: now + c.DAY_MS, tPin: null }, [10], 10, now),
    { tSel: now + c.DAY_MS, tPin: null });
  assert.deepEqual(c.normaliseSelection({ tSel: null, tPin: 0 }, [10], 10, now), { tSel: null, tPin: 0 });
});

test('stepMs moves to the next 15-minute slot from off-grid and on-grid times', () => {
  assert.equal(c.stepMs(utc(11, 3, 18, 7), 1), utc(11, 3, 18, 15));
  assert.equal(c.stepMs(utc(11, 3, 18, 7), -1), utc(11, 3, 18, 0));
  assert.equal(c.stepMs(utc(11, 3, 18, 15), 1), utc(11, 3, 18, 30));
});

test('stepMs crosses midnight in both directions', () => {
  assert.equal(c.stepMs(utc(11, 3, 4, 45), 1), utc(11, 3, 5));    // 23:45 to 00:00 NY
  assert.equal(c.stepMs(utc(11, 3, 5), -1), utc(11, 3, 4, 45));
});

test('stepMs gets past the spring-forward gap', () => {
  // 8 Mar 2026: 01:45 EST is 06:45Z, and the next instant slot is 03:00 EDT, 07:00Z
  assert.equal(c.stepMs(Date.UTC(2026, 2, 8, 6, 45), 1), Date.UTC(2026, 2, 8, 7));
});

test('stepMs moves through the repeated hour when clocks go back', () => {
  // 1 Nov 2026: second 01:15 is 06:15Z (EST); first 01:30 is 05:30Z (EDT) and must not be chosen
  assert.equal(c.stepMs(utc(11, 1, 6, 15), 1), utc(11, 1, 6, 30));
  // 02:00 EST is 07:00Z; stepping back lands in the second 01:45, 06:45Z
  assert.equal(c.stepMs(utc(11, 1, 7), -1), utc(11, 1, 6, 45));
});

test('option legs default to a multiplier of 100 under every model', () => {
  for (const model of ['european', 'american', 'futures']) {
    assert.equal(c.defaultMultiplier('call', model), 100);
    assert.equal(c.defaultMultiplier('put', model), 100);
  }
});

test('stock and future legs keep their own defaults', () => {
  assert.equal(c.defaultMultiplier('stock', 'european'), 1);
  assert.equal(c.defaultMultiplier('stock', 'american'), 1);
  assert.equal(c.defaultMultiplier('stock', 'futures'), 50);
});

test('changing a leg kind resets the multiplier only when crossing option and stock', () => {
  assert.equal(c.multiplierOnKindChange('stock', 'call', 50, 'futures'), 100);
  assert.equal(c.multiplierOnKindChange('stock', 'put', 1, 'european'), 100);
  assert.equal(c.multiplierOnKindChange('call', 'stock', 100, 'european'), 1);
  assert.equal(c.multiplierOnKindChange('call', 'put', 25, 'european'), 25);
});

test('DTE shows 2 decimals, or 4 under a day, without padding', () => {
  const cases = [
    [29.2045165, '29.2'], [29.2345165, '29.23'], [30, '30'], [1, '1'], [1.005, '1'],
    [0.25, '0.25'], [0.123456, '0.1235'], [0.99996, '1'], [0, '0'],
  ];
  cases.forEach(([dte, shown]) => assert.equal(c.dteText(dte), shown, String(dte)));
});

const MIN = 1 / 1440;

test('aheadText says how far ahead in whole units, with no fractional days', () => {
  const cases = [
    [0, 'now'], [0.5 * MIN, 'now'], [-1, 'now'], [NaN, 'now'],
    [MIN, 'in 1 min'], [2 * MIN, 'in 2 min'], [45 * MIN, 'in 45 min'], [59.6 * MIN, 'in 1 hr'],
    [60 * MIN, 'in 1 hr'], [62 * MIN, 'in 1 hr'], [63 * MIN, 'in 1 hr 5 min'],
    [315 * MIN, 'in 5 hrs 15 min'], [(9 * 60 + 50) * MIN, 'in 9 hrs 50 min'],
    [(9 * 60 + 58) * MIN, 'in 10 hrs'], [(10 * 60 + 20) * MIN, 'in 10 hrs'],
    [0.5, 'in 12 hrs'], [(23 * 60 + 58) * MIN, 'in 1 day'], [1, 'in 1 day'],
    [1 + 1 / 24, 'in 1 day 1 hr'], [2, 'in 2 days'], [3 + 22 / 24, 'in 3 days 22 hrs'],
    [3 + (23 * 60 + 40) * MIN, 'in 4 days'], [4.2, 'in 4 days 5 hrs'],
  ];
  cases.forEach(([days, text]) => assert.equal(c.aheadText(days), text, String(days)));
});

test('whenParts names a future instant in New York, how far ahead, and the viewer day only when it differs', () => {
  const now = utc(11, 2, 17);       // Mon 2 Nov 12:00 ET, Tue 04:00 in Sydney
  const fri = utc(11, 6, 15);       // Fri 6 Nov 10:00 ET, Sat 02:00 in Sydney
  assert.deepEqual(c.whenParts((fri - now) / c.DAY_MS, now, 'Australia/Sydney'), {
    short: 'Fri 6 Nov, 10:00 ET',
    main: 'Fri 6 Nov, 10:00 ET · in 3 days 22 hrs',
    local: 'Sat 02:00 your time',
  });
  const sameDay = c.whenParts((utc(11, 6, 21) - now) / c.DAY_MS, now, 'Europe/London');
  assert.equal(sameDay.local, '21:00 your time');
});

test('whenParts calls the present now and leaves the viewer time out on New York time', () => {
  const now = utc(11, 2, 15, 23);   // Mon 2 Nov 10:23 ET
  assert.deepEqual(c.whenParts(0, now, 'Australia/Sydney'),
    { short: 'now', main: 'Now · Mon 2 Nov, 10:23 ET', local: 'Tue 02:23 your time' });
  assert.equal(c.whenParts(2, now, 'America/New_York').local, '');
  assert.equal(c.whenParts(2, now, 'America/Toronto').local, '');
});

test('whenParts follows the clock change: 09:30 ET is 14:30Z after 1 Nov', () => {
  const now = utc(10, 30, 13, 30);  // Fri 30 Oct 09:30 EDT
  const after = c.nyToMs('2026-11-03', 9 * 60 + 30);
  const w = c.whenParts((after - now) / c.DAY_MS, now, 'UTC');
  assert.equal(w.main, 'Tue 3 Nov, 09:30 ET · in 4 days 1 hr');
  assert.equal(w.local, '14:30 your time');
});

test('September reads Sep, like every other three-letter month', () => {
  const K2 = require('../../modules/analyser/web/controls.js');
  const sep = Date.parse('2026-09-18T13:00:00Z');
  assert.match(K2.whenParts(0.5, sep, 'America/New_York').short, / 18 Sep, /);
});
