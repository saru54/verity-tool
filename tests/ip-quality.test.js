import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensureIpQuality, normalizeIpQualityConfig, passesThreshold } from '../src/core/ip-quality.js';
import { normalizeConfig } from '../src/core/config.js';

test('ipQuality config normalizes with defaults and validation', () => {
  const defaults = normalizeIpQualityConfig(undefined);
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.threshold, 80);
  assert.equal(defaults.maxRetries, 5);
  assert.equal(defaults.requireResidential, true);
  assert.deepEqual(defaults.fallbackCountries, ['ca', 'de', 'gb', 'fr', 'au']);

  const custom = normalizeIpQualityConfig({
    enabled: false, threshold: 55, maxRetries: 2, requireResidential: false,
    fallbackCountries: ['US', 'gb', 'nl'],
  });
  assert.equal(custom.enabled, false);
  assert.equal(custom.threshold, 55);
  assert.equal(custom.maxRetries, 2);
  assert.equal(custom.requireResidential, false);
  assert.deepEqual(custom.fallbackCountries, ['us', 'gb', 'nl'], 'country codes lowercased');

  assert.throws(() => normalizeIpQualityConfig({ threshold: 150 }), { code: 'INVALID_CONFIG' });
  assert.throws(() => normalizeIpQualityConfig({ maxRetries: -1 }), { code: 'INVALID_CONFIG' });
  assert.throws(() => normalizeIpQualityConfig({ fallbackCountries: ['too-long-country'] }), { code: 'INVALID_CONFIG' });
  assert.throws(() => normalizeIpQualityConfig({ bogus: true }), { code: 'INVALID_CONFIG' });
});

test('ipQuality section is accepted by full config normalization', async () => {
  const raw = {
    app: 'sheerid',
    url: 'https://services.sheerid.com/verify/aaaaaaaaaaaaaaaaaaaaaaaa/?verificationId=bbbbbbbbbbbbbbbbbbbbbbbb',
    ipQuality: { enabled: true, threshold: 80, maxRetries: 3, requireResidential: false, fallbackCountries: ['gb', 'ca'] },
  };
  const config = await normalizeConfig(raw, {});
  assert.ok(config.ipQuality);
  assert.equal(config.ipQuality.threshold, 80);
  assert.equal(config.ipQuality.maxRetries, 3);
  assert.deepEqual(config.ipQuality.fallbackCountries, ['gb', 'ca']);
});

test('disabled ipQuality is skipped by workflow wiring (no network)', async () => {
  // ensureIpQuality short-circuits when disabled — verified via the skip branch
  // by calling it with a config that has ipQuality.enabled=false and no dataimpulse.
  const initialProxy = Object.freeze({ server: 'http://127.0.0.1:9', username: '', password: '' });
  const skipped = await ensureIpQuality({ ipQuality: { enabled: false } }, initialProxy, { log() {} });
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.proxy, initialProxy);

  const noDataImpulse = await ensureIpQuality({ ipQuality: { enabled: true } }, initialProxy, { log() {} });
  assert.equal(noDataImpulse.skipped, true, 'no dataimpulse section skips too');
});

test('passesThreshold enforces score, residential requirement, proxyFlags < 6 and abuseFlags <= 3', () => {
  const opts = { threshold: 80, requireResidential: true, maxProxyFlags: 5, maxAbuseFlags: 3 };
  assert.equal(passesThreshold({ purityScore: 93, proxyFlags: 2, abuseFlags: 0, ipType: 'residential' }, opts), true);
  assert.equal(passesThreshold({ purityScore: 93, proxyFlags: 6, abuseFlags: 0, ipType: 'residential' }, opts), false);
  assert.equal(passesThreshold({ purityScore: 93, proxyFlags: 1, abuseFlags: 4, ipType: 'residential' }, opts), false);
  assert.equal(passesThreshold({ purityScore: 93, proxyFlags: 0, abuseFlags: 0, ipType: 'datacenter' }, opts), false);
  assert.equal(passesThreshold({ purityScore: 79, proxyFlags: 0, abuseFlags: 0, ipType: 'residential' }, opts), false);
  assert.equal(passesThreshold({ purityScore: 80, proxyFlags: 0, abuseFlags: 0, ipType: 'residential' }, opts), true);
});

test('ensureIpQuality checks availability before browser score, handles null initialProxy, and dedupes fallback countries', async () => {
  const di = { host: 'gw.dataimpulse.com', port: 10000, username: 'user', password: 'pw' };
  const events = [];
  let scoreCalls = 0;
  let availabilityCalls = 0;

  const config = {
    dataimpulse: di,
    browser: { headless: true },
    data: { country: 'Canada' },
    ipQuality: {
      enabled: true,
      threshold: 70,
      maxRetries: 5,
      requireResidential: true,
      maxProxyFlags: 5,
      maxAbuseFlags: 3,
      fallbackCountries: ['ca', 'de', 'gb'],
    },
  };

  const result = await ensureIpQuality(config, null, {
    log: (event, data) => events.push({ event, ...data }),
    checkAvailability: async () => {
      availabilityCalls++;
      if (availabilityCalls === 1) throw new Error('PROXY_UNAVAILABLE');
      return { ok: true, status: 200 };
    },
    checkScore: async () => {
      scoreCalls++;
      // Fail retries 1-3 (same country 'ca'), pass on retry-4 ('de', skipping duplicate 'ca').
      if (scoreCalls <= 3) return { purityScore: 40, grade: 'D', ipType: 'residential', proxyFlags: 1, abuseFlags: 0, ip: '1.1.1.1' };
      return { purityScore: 92, grade: 'A+', ipType: 'residential', proxyFlags: 1, abuseFlags: 0, ip: '2.2.2.2' };
    },
  });

  assert.equal(availabilityCalls, 5);
  assert.equal(scoreCalls, 4, 'initial unavailable proxy skipped browser check');
  assert.equal(result.country, 'de', 'fallback skipped duplicate primary country ca');
  assert.match(result.proxy.username, /^user__cr\.de;sessid\./);
  assert.doesNotMatch(result.proxy.username, /;state\./);
  assert.equal(events.filter(e => e.event === 'ip_quality_attempt' && e.country === 'ca').length, 4);
});

test('ensureIpQuality stops immediately when aborted', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    ensureIpQuality(
      {
        dataimpulse: { host: 'gw.dataimpulse.com', port: 10000, username: 'u', password: 'p' },
        data: { countryCode: 'US' },
        ipQuality: { enabled: true, threshold: 70, maxRetries: 5, requireResidential: true, fallbackCountries: ['ca'] },
      },
      null,
      {
        signal: controller.signal,
        checkAvailability: async () => {
          calls++;
          controller.abort(new Error('aborted by test'));
          throw new Error('aborted by test');
        },
        checkScore: async () => { throw new Error('should not run'); },
      },
    ),
    /aborted by test/,
  );
  assert.equal(calls, 1);
});


test('ensureIpQuality defaults to NodeMaven when both providers are configured and switches to DataImpulse when requested', async () => {
  const nm = { host: 'gate.nodemaven.com', port: 8080, username: 'nmuser', password: 'pw', filter: 'medium', ipv4Only: true };
  const di = { host: 'gw.dataimpulse.com', port: 10000, username: 'diuser', password: 'pw' };
  const passCheck = {
    checkAvailability: async () => ({ ok: true, status: 200 }),
    checkScore: async () => ({ purityScore: 95, grade: 'A+', ipType: 'residential', proxyFlags: 1, abuseFlags: 0, ip: '3.3.3.3' }),
  };

  const defaultResult = await ensureIpQuality({
    nodemaven: nm,
    dataimpulse: di,
    data: { countryCode: 'GB' },
    ipQuality: { enabled: true, threshold: 75, maxRetries: 2, requireResidential: true, fallbackCountries: ['de'] },
  }, null, passCheck);
  assert.equal(defaultResult.provider, 'nodemaven');
  assert.equal(defaultResult.proxy.server, 'http://gate.nodemaven.com:8080');
  assert.match(defaultResult.proxy.username, /^nmuser-country-gb-ipv4-true-sid-[a-z0-9]+-filter-medium$/);

  const diResult = await ensureIpQuality({
    proxyProvider: 'dataimpulse',
    nodemaven: nm,
    dataimpulse: di,
    data: { countryCode: 'CA' },
    ipQuality: { enabled: true, threshold: 75, maxRetries: 2, requireResidential: true, fallbackCountries: ['de'] },
  }, null, passCheck);
  assert.equal(diResult.provider, 'dataimpulse');
  assert.equal(diResult.proxy.server, 'http://gw.dataimpulse.com:10000');
  assert.match(diResult.proxy.username, /^diuser__cr\.ca;sessid\.[a-z0-9]+$/);
});
