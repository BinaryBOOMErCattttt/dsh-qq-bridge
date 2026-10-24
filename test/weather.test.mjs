/**
 * `weather.js` 的单元测试：城市解析、天气码、播报拼接。
 *
 * 用假 fetch，不联网。真实接口的形状来自 Open-Meteo 文档（geocoding → forecast）。
 *
 * 运行：node --test test/weather.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { geocodeCity, todayForecast, weatherReport, weatherText } from '../weather.js';

/** 一个按 URL 分流的假 fetch。 */
function fakeFetch(overrides = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (url.includes('geocoding-api')) {
      if (overrides.geo !== undefined) return overrides.geo;
      return {
        ok: true,
        json: async () => ({
          results: [{ latitude: 30.25, longitude: 120.17, name: '杭州', admin1: '浙江', country: '中国' }],
        }),
      };
    }
    if (overrides.forecast !== undefined) return overrides.forecast;
    return {
      ok: true,
      json: async () => ({
        current: {
          temperature_2m: 20.4,
          apparent_temperature: 19.2,
          relative_humidity_2m: 71,
          weather_code: 61,
          wind_speed_10m: 8.3,
        },
        daily: { temperature_2m_max: [25.2], temperature_2m_min: [17.1], precipitation_probability_max: [60] },
      }),
    };
  };
  impl.calls = calls;
  return impl;
}

test('weatherText：WMO 码映射，未知码退回「多云」', () => {
  assert.equal(weatherText(0), '晴');
  assert.equal(weatherText(61), '小雨');
  assert.equal(weatherText(95), '雷阵雨');
  assert.equal(weatherText(12345), '多云');
});

test('geocodeCity：中文城市 → 经纬度；找不到时报人话', async () => {
  const fetchImpl = fakeFetch();
  const point = await geocodeCity('杭州', { fetchImpl });
  assert.deepEqual(point, { latitude: 30.25, longitude: 120.17, name: '杭州', admin: '浙江', country: '中国' });
  assert.ok(fetchImpl.calls[0].includes('name=%E6%9D%AD%E5%B7%9E'));

  await assert.rejects(() => geocodeCity('', { fetchImpl }), /要带城市/);
  await assert.rejects(
    () => geocodeCity('不存在的城市', { fetchImpl: fakeFetch({ geo: { ok: true, json: async () => ({ results: [] }) } }) }),
    /找不到/,
  );
});

test('todayForecast：坐标不合法直接拒绝', async () => {
  await assert.rejects(() => todayForecast({ latitude: 'x', longitude: 1 }, { fetchImpl: fakeFetch() }), /坐标/);
});

test('weatherReport：拼成一句可发的中文播报', async () => {
  const line = await weatherReport('杭州', { fetchImpl: fakeFetch() });
  assert.match(line, /浙江杭州：今天小雨/);
  assert.match(line, /17~25℃/);
  assert.match(line, /现在 20℃（体感 19℃）/);
  assert.match(line, /湿度 71%/);
  assert.match(line, /降水概率 60%/);
  assert.match(line, /风 8 km\/h/);
});
