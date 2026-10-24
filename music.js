/**
 * 点歌：搜网易云，回「歌名 - 歌手 + 链接」。
 *
 * 为什么只做「搜到 + 发链接」：OneBot v11 没有「播放音频」的通用 action，发 `record`
 * 段也只是把一段音频当语音发出去（版权 / 体积 / TTS 全是另一摊事）。群里点歌的真实
 * 需求大多是「帮我找到那首」，一条能点开的链接就够。
 *
 * 接口是网易云的公开搜索页（不需要 key）；不同网络环境下可能被拦，所以失败时只报
 * 人话，不重试、不偷偷换源。
 *
 * @module @qqbot/dsh-plugin-qq/music
 */

/**
 * @param {string} keyword - 歌名 / 歌手 / 歌词片段。
 * @param {{ fetchImpl?: Function, timeoutMs?: number }} [options]
 * @returns {Promise<{ name: string, artists: string, id: string, url: string }>}
 */
export async function searchSong(keyword, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const query = String(keyword ?? '').trim();
  if (query.length === 0) throw new Error('要搜什么歌？例如：点歌 稻香');
  const url = `https://music.163.com/api/search/get/web?s=${encodeURIComponent(query)}&type=1&limit=1&offset=0`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        referer: 'https://music.163.com/',
        accept: 'application/json',
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const song = Array.isArray(body?.result?.songs) ? body.result.songs[0] : undefined;
    if (song === undefined) throw new Error(`没搜到「${query}」`);
    const artists = Array.isArray(song.artists)
      ? song.artists.map((artist) => String(artist?.name ?? '')).filter((name) => name.length > 0).join(' / ')
      : String(song.artists ?? '');
    return {
      name: String(song.name ?? query),
      artists: artists || '未知歌手',
      id: String(song.id ?? ''),
      url: `https://music.163.com/song?id=${String(song.id ?? '')}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 点歌结果的一行排版。 */
export function renderSong(song) {
  return `🎵 ${song.name} — ${song.artists}\n${song.url}`;
}
