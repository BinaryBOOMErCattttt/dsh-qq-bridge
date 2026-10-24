/**
 * 天气指令的数据源：Open-Meteo（免费、不要 key）。
 *
 * 两步：城市名 → 经纬度（geocoding）→ 当天预报（forecast）。之所以不用 wttr.in：
 * 它的 JSON 字段名与中文支持在不同镜像上不一致，而 Open-Meteo 的 WMO 天气码是稳定的
 * 数字，映射成中文只在本文件里做一次。
 *
 * 网络请求全部注入 `fetchImpl`，测试里可以给一个假 fetch，不必真的联网。
 *
 * @module @qqbot/dsh-plugin-qq/weather
 */

/** WMO 天气码 → 中文。没列到的码统一按「多云」这类安全说法。 */
const WMO_TEXT = new Map([
  [0, '晴'],
  [1, '大致晴'],
  [2, '多云'],
  [3, '阴'],
  [45, '有雾'],
  [48, '有雾凇'],
  [51, '小毛毛雨'],
  [53, '毛毛雨'],
  [55, '大毛毛雨'],
  [56, '冻毛毛雨'],
  [57, '强冻毛毛雨'],
  [61, '小雨'],
  [63, '中雨'],
  [65, '大雨'],
  [66, '冻雨'],
  [67, '强冻雨'],
  [71, '小雪'],
  [73, '中雪'],
  [75, '大雪'],
  [77, '米雪'],
  [80, '小阵雨'],
  [81, '阵雨'],
  [82, '强阵雨'],
  [85, '小阵雪'],
  [86, '强阵雪'],
  [95, '雷阵雨'],
  [96, '雷阵雨伴小冰雹'],
  [99, '雷阵雨伴大冰雹'],
]);

/** 天气码 → 中文短语。 */
export function weatherText(code) {
  return WMO_TEXT.get(Number(code)) ?? '多云';
}

/** 发一个 GET 并解析 JSON；超时用 AbortController（Node 22 的全局 fetch 支持 signal）。 */
async function getJson(url, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'dsh-qq-bridge/weather' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 城市名 → `{ latitude, longitude, name, admin, country }`。
 * @param {string} city - 中文 / 英文城市名。
 * @param {{ fetchImpl?: Function, timeoutMs?: number }} [options]
 */
export async function geocodeCity(city, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const name = String(city ?? '').trim();
  if (name.length === 0) throw new Error('要带城市，例如：天气 杭州');
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=zh&format=json`;
  const body = await getJson(url, fetchImpl, timeoutMs);
  const hit = Array.isArray(body?.results) ? body.results[0] : undefined;
  if (hit === undefined) throw new Error(`找不到「${name}」这个城市，换个写法试试（例如「杭州」「Hangzhou」）`);
  return {
    latitude: Number(hit.latitude),
    longitude: Number(hit.longitude),
    name: String(hit.name ?? name),
    admin: String(hit.admin1 ?? ''),
    country: String(hit.country ?? ''),
  };
}

/**
 * 取某个坐标今天的天气。
 * @param {{ latitude: number, longitude: number }} point
 * @param {{ fetchImpl?: Function, timeoutMs?: number }} [options]
 */
export async function todayForecast(point, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const lat = Number(point?.latitude);
  const lon = Number(point?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('坐标不合法');
  const url = [
    'https://api.open-meteo.com/v1/forecast',
    `?latitude=${lat}&longitude=${lon}`,
    '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m',
    '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    '&timezone=auto&forecast_days=1',
  ].join('');
  return getJson(url, fetchImpl, timeoutMs);
}

/**
 * 把 geocode + forecast 拼成一句能直接发到 QQ 的中文播报。
 * @param {unknown} city - 用户给的城市。
 * @param {{ fetchImpl?: Function, timeoutMs?: number }} [options]
 * @returns {Promise<string>}
 */
export async function weatherReport(city, options = {}) {
  const point = await geocodeCity(city, options);
  const body = await todayForecast(point, options);
  const current = body?.current ?? {};
  const daily = body?.daily ?? {};
  const max = Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max[0] : undefined;
  const min = Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min[0] : undefined;
  const pop = Array.isArray(daily.precipitation_probability_max) ? daily.precipitation_probability_max[0] : undefined;
  const place = point.admin.length > 0 && point.admin !== point.name ? `${point.admin}${point.name}` : point.name;
  const parts = [`${place}：今天${weatherText(current.weather_code)}`];
  if (Number.isFinite(Number(min)) && Number.isFinite(Number(max))) {
    parts.push(`${Math.round(Number(min))}~${Math.round(Number(max))}℃`);
  }
  if (Number.isFinite(Number(current.temperature_2m))) {
    const feels = Number(current.apparent_temperature);
    parts.push(`现在 ${Math.round(Number(current.temperature_2m))}℃${Number.isFinite(feels) ? `（体感 ${Math.round(feels)}℃）` : ''}`);
  }
  if (Number.isFinite(Number(current.relative_humidity_2m))) parts.push(`湿度 ${Math.round(Number(current.relative_humidity_2m))}%`);
  if (Number.isFinite(Number(pop))) parts.push(`降水概率 ${Math.round(Number(pop))}%`);
  if (Number.isFinite(Number(current.wind_speed_10m))) parts.push(`风 ${Math.round(Number(current.wind_speed_10m))} km/h`);
  return `${parts.join('，')}。`;
}
