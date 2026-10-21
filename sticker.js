/**
 * 表情包目录：列文件、把「裸名字 / 写错扩展名」补成真路径、存图、改名，以及三条写边界。
 *
 * 从 `index.js` 的 `apply()` 闭包里搬出来（第二批）。搬的时候保持函数名与注释不变，
 * `index.js` 只装配出别名，调用点一个都没动。三个边界仍然在函数里收口：
 *   - 只能碰 `stickerRoot` 之内，文件名由纯函数 `stickerFileName` 洗成单层名字；
 *   - 存图先过 `loadOutgoingImage`（魔数 + 大小 + cwd 越界），张数受 `stickerMaxFiles` 限制；
 *   - 改名只给已经收藏的文件换名字，目录写失败会回滚文件改名。
 *
 * **不 import `index.js`**。`memory` 只用来追加 / 搬 `STICKERS.md` 的目录行；记忆关掉时
 * 存图/改名仍然可用，只是少更新一份目录。
 *
 * @module @qqbot/dsh-plugin-qq/sticker
 */
import { readdirSync } from 'node:fs';
import { mkdir, rename, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { insideDirectory, loadOutgoingImage } from './image.js';
import { writeBytesAtomic } from './filestore.js';
import { errorText, localDate, stickerFileName } from './util.js';

/** 渠道提示里最多列多少个表情包文件名。 */
const STICKER_PROMPT_MAX = 40;

/**
 * 建一份表情包目录的读写器。
 *
 * @param deps - 依赖表：
 *   - `settings` / `cwd` / `report`：目录配置、越界基准、日志；
 *   - `memory`：只用于 `appendSticker` / `renameSticker` / `catalog`；
 *   - `imageMaxBytes`：存图前的字节上限（与出站图片共用）；
 *   - `imageAllowed` / `allowTools` / `canReadImages`：三个白名单口径与「能不能看图」；
 *   - `loadOutgoingImage` 等叶子能力直接 import，不走 deps。
 * @returns 见文件末尾的返回对象；`index.js` 会把每个字段解构成同名函数。
 */
export function createStickerStore(deps) {
  const { settings, cwd, report, memory, imageMaxBytes, imageAllowed, allowTools, canReadImages } = deps;

  const stickerMaxFiles = settings.stickerMaxFiles;
  const stickerRoot = settings.stickerDir.trim().length > 0 ? resolve(cwd, settings.stickerDir.trim()) : undefined;
  const stickerInside = stickerRoot !== undefined && insideDirectory(resolve(cwd), stickerRoot);
  if (stickerRoot !== undefined && !stickerInside) {
    report('warn', `stickerDir "${settings.stickerDir.trim()}" resolves outside cwd (${cwd}); the sticker pack will not be advertised`);
  }
  /** 表情包目录的展示路径（相对 cwd、正斜杠），就是模型该写进 qq_send_image 的那种写法。 */
  const stickerLabel = stickerInside ? relative(resolve(cwd), stickerRoot).split(sep).join('/') : undefined;

  /**
   * 表情包目录里认得出来的图片文件名（**不带**目录前缀）；目录不存在/不可用时为空。
   *
   * 用同步 readdir 而不是 async：`SystemPrompt.section()` 的 text provider 是**同步**
   * 求值的（每次装配提示词都要重新算，群聊上下文正是靠这个才不过期），而这里读的是一个
   * 一层、几十个文件的小目录 —— 一次 readdir 的代价远小于为它引入缓存与失效逻辑。
   * 只认 PNG/JPEG/WebP/GIF（发送侧也只认这四种，列个 README.md 出来只会让模型去撞一次错）。
   */
  function stickerFiles() {
    if (stickerRoot === undefined || !stickerInside) return [];
    try {
      return readdirSync(stickerRoot, { withFileTypes: true })
        .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && /\.(png|jpe?g|gif|webp)$/i.test(entry.name))
        .map((entry) => entry.name);
    } catch {
      return []; // 还没建 / 被删了 / 没权限：当作「没有表情包」，不影响其余提示词。
    }
  }

  /**
   * 表情包目录里认得出来的图片路径（相对 cwd，带目录前缀），供渠道提示列候选。
   * @returns 形如 `['.qq-stickers/笑死.gif', …]` 的数组，最多 `STICKER_PROMPT_MAX` 个。
   */
  function stickerNames() {
    if (stickerLabel === undefined) return [];
    return stickerFiles()
      .sort()
      .slice(0, STICKER_PROMPT_MAX)
      .map((name) => `${stickerLabel}/${name}`);
  }

  /**
   * 表情包目录这一轮要不要给；要给就返回那几行，否则空数组。
   *
   * 为什么不在系统提示里：目录随 `qq_save_sticker` / `qq_rename_sticker` / 手动删图变化，
   * 而系统提示只要变一个字，DSH 就会把整段人设 + 表达契约 + 硬性规则当**新的 system
   * 消息再追加一份**（2026-10-21 群名那 6 个字的真实事故，见 `channelPrompt` 的注释）。
   * 它又必须让模型看得见，所以跟着「本轮情境」走：本会话第一次给一次、目录变了补一次，
   * 其余轮次一个字都不发。
   *
   * 账记在会话记录的 `stickerCatalog` 上：换代（`/reset`、静默换轮）之后重开一本。
   * 目录优先用 STICKERS.md 的「名字（含义）→ 路径」（模型看含义就能判断该不该发，看裸
   * 文件名只能猜）；没有目录文件（旧部署 / 记忆关掉）时退回裸文件名。
   *
   * @param conversation - 目标会话。
   * @returns 要拼进「本轮情境」的那几行。
   */
  function stickerCatalogLines(conversation) {
    if (stickerLabel === undefined || !imageAllowed()) return [];
    const catalog = memory.enabled ? memory.catalog() : { stickers: [], catalog: false };
    const names = stickerNames();
    const entries = catalog.stickers.length > 0 ? catalog.stickers : names;
    const key = entries.join('\u0000');
    const generation = conversation.sessionGeneration ?? 0;
    const ledger = conversation.stickerCatalog;
    if (ledger !== undefined && ledger.generation === generation && ledger.key === key) return [];
    conversation.stickerCatalog = { generation, key };
    const readHint = canReadImages() ? '，目录里没有的再 read_image 看一眼' : '';
    if (catalog.stickers.length > 0) {
      return [
        `- 你自己的表情包（名字（含义）→ 完整路径；想发哪张就把箭头后面的路径**原样**抄进标记里，别自己拼或改扩展名）${readHint}：${entries.join('、')}`,
      ];
    }
    if (names.length > 0) {
      return [
        `- 你自己的表情包在 ${stickerLabel}/ 里：${names.join('、')}。文件名通常就是它的意思${readHint}；想发哪张就把它的路径写进标记里。`,
      ];
    }
    return [`- 你自己的表情包目录 ${stickerLabel}/ 目前是空的，没有现成的表情包可挑（别人刚发的图要先 qq_save_sticker 存下来才能发）。`];
  }

  /**
   * 把「一个表情包文件名」补成真路径（裸名字、以及写错扩展名的目录路径）。
   *
   * 模型很可能不写全 `.qq-stickers/笑死.png` 而只写 `笑死` / `笑死.png`，也可能把扩展名
   * 猜错（目录里 .jpg 比 .gif 多，真实事故：`敲盆.gif` 被写成 `敲盆.jpg`）。这两种都会让
   * `loadOutgoingImage` 按 cwd 相对路径去找时落空、只能回一句「表情包没发出去」。所以：
   * 裸文件名先在表情包目录里找（精确 → 忽略扩展名）；带 `stickerLabel/` 前缀的路径如果是
   * 已知文件名写错了扩展名，也换回真实的那一个。
   *
   * 只碰**收藏目录里的文件名**：`.qq-media/xxx.jpg`、URL 之类的写法原样交出去，绝不改写。
   *
   * @param source - 标记或工具参数里给的来源。
   * @returns 能认出来就是相对 cwd 的路径，否则原样返回。
   */
  function resolveStickerSource(source) {
    const raw = String(source ?? '').trim();
    if (raw.length === 0 || stickerLabel === undefined) return raw;
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;
    if (raw.startsWith(`${stickerLabel}/`)) {
      const name = raw.slice(stickerLabel.length + 1);
      // 收藏目录只有一层：带子目录的写法不猜，交给发送侧照常报错。
      if (name.length === 0 || /[/\\]/.test(name)) return raw;
      const repaired = findStickerByName(name);
      return repaired === undefined ? raw : `${stickerLabel}/${repaired}`;
    }
    if (/[/\\]/.test(raw)) return raw;
    const repaired = findStickerByName(raw);
    return repaired === undefined ? raw : `${stickerLabel}/${repaired}`;
  }

  /**
   * 在表情包目录里按名字找文件：先精确匹配，再忽略扩展名匹配。
   *
   * 同名不同扩展名的文件可能同时存在（`.gif` 和 `.jpg`），排序后取第一个，保证同样的输入
   * 永远得到同一个结果 —— 别让「发哪张」随 readdir 的顺序漂移。
   *
   * @param name - 文件名（可带扩展名，也可只有名字）。
   * @returns 目录里真实存在的文件名；认不出来时 undefined。
   */
  function findStickerByName(name) {
    const files = stickerFiles().sort();
    const exact = files.find((file) => file === name);
    if (exact !== undefined) return exact;
    const stem = name.replace(/\.[^.]+$/, '');
    return files.find((file) => file.replace(/\.[^.]+$/, '') === stem);
  }

  /**
   * 发表情时**只认收藏目录里的文件**（`[[图片: …]]` 这一条路）。
   *
   * 三条理由，都对应真实事故或明确的设计边界：
   *   1. `.qq-media/<内容哈希>` 是入站图的 LRU 缓存（默认 200 张），迟早被淘汰。模型把
   *      它写进正文时，**当时看着像真的**、发的时候早没了，用户收到的是一句「没发出去」
   *      —— 它还会接着编下一个哈希（真发生过）。
   *   2. 任意 cwd 路径（`README.md`、别人的截图、`/etc/...`）不该借「发表情」发出去：
   *      QQ 消息是不可信输入，模型可能被群里的人指使去发本地文件。
   *   3. 想发「别人刚发的那张」有正当入口：先 `qq_save_sticker` 收藏（带名字与含义），
   *      它才进得了这个目录 —— 这同时也让那张图以后还能再被选中。
   *
   * 裸文件名先按 `resolveStickerSource` 补全（模型常写 `笑死` 而不是全路径）。
   * @param source - 标记里给的来源。
   * @returns 收藏目录内的绝对路径。
   * @throws 目录不可用 / 不在收藏目录 / 文件不存在时抛错（message 是给人看的一句话）。
   */
  function stickerSendSource(source) {
    const raw = resolveStickerSource(source);
    if (stickerRoot === undefined || !stickerInside || stickerLabel === undefined) {
      throw new Error(`stickerDir is not usable (${settings.stickerDir.trim() || '(empty)'}): it must be a directory inside ${cwd}`);
    }
    const target = resolve(cwd, raw);
    if (!insideDirectory(stickerRoot, target)) {
      throw new Error(`${stickerLabel}/ 里没有「${raw}」：表情包只能从收藏目录里发（别人刚发的图要先 qq_save_sticker 存下来）`);
    }
    return target;
  }

  /**
   * 这个来源是不是收藏目录里的表情包 —— 决定出站 image 段带不带 `sub_type: 1`
   * （见 `imageSegment` 的注释）。
   *
   * 只认「能确定落在 stickerRoot 里的本地路径」，宁可不标也不乱标：
   *   - URL / `file://` 一律按普通图片发（远端是什么无从判断）；
   *   - `.qq-media/<哈希>` 这类缓存图照旧发成普通图片（它可能是截图或照片）；
   *   - 裸文件名先按 `resolveStickerSource` 补成 `.qq-stickers/笑死.gif` 再判。
   *
   * @param source - 标记或工具参数里的来源。
   * @returns 确认是收藏目录里的文件时 true。
   */
  function isStickerFile(source) {
    if (stickerRoot === undefined || !stickerInside) return false;
    const raw = resolveStickerSource(source);
    // 只挡「带协议的来源」。别写成 `/^[a-z][a-z0-9+.-]*:/`：那会把 Windows 的 `C:\…`
    // 当成协议名（收藏目录就在 C 盘时，绝对路径的表情会被误判成普通图片）。
    if (raw.length === 0 || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^file:/i.test(raw)) return false;
    return insideDirectory(stickerRoot, resolve(cwd, raw));
  }

  /** 记下「这一轮想发的图没发出去」，给下一轮提示词用（见 `channelPrompt`）。 */
  function noteStickerFailure(conversation, source, reason) {
    conversation.stickerFailure = { path: String(source ?? '').slice(0, 120), reason: String(reason ?? '').slice(0, 160), at: Date.now() };
  }

  /**
   * 把「一张图」固化进表情包目录：`qq_save_sticker` 的全部实现。
   *
   * 为什么需要它（实测缺口）：QQ 会话按设计没有 write / edit / bash —— 那三样在不可信
   * 输入面上太危险 —— 于是群里那句最自然的「存一下这个表情」模型**永远做不到**。真实
   * 发生过的样子是：它 `read_image` 看完、`glob .qq-stickers/**` 发现是空的，只能把含义
   * 追加进 `COGNITION.md`，key 还是 `.qq-media/<内容哈希>` 这个 LRU 缓存路径，然后回一句
   * 「存好了」。那条记忆迟早指向一个被淘汰掉的文件，群里收到的就是「（表情包没发出去）」。
   *
   * 所以这里开一条**窄**通道，把边界全部收在函数里：
   *   - 只写 `stickerRoot` 之内，文件名由纯函数 `stickerFileName` 洗成单层名字；
   *   - 字节先过 `loadOutgoingImage`（魔数判格式 + 大小上限 + 必须在 cwd 内），
   *     所以「`.txt` 改名成 `.png`」和越界路径都进不来；
   *   - 张数到 `stickerMaxFiles` 就拒绝 —— 群里谁都能让它一直存，磁盘不该被这么撑大；
   *   - 同名**不覆盖**：覆盖等于让群里任何一个人用一句「存一下」把现有表情换掉。
   *
   * 存完之后还会往 `STICKERS.md` 补一行「名字｜画面｜含义｜场景｜路径｜日期｜置信」：
   * 不写这一行的话，下一次提示词里它又只是一串文件名，模型还得 `read_image` 猜含义。
   * 目录写失败**不回滚图片**（图已经落盘，缺一行目录比丢图好）—— 只记一条 warn。
   *
   * @param options.source - 图片来源（`.qq-media/…` 相对路径 / cwd 内绝对路径 / http(s) 链接）。
   * @param options.name - 模型起的中文名（可带扩展名，最终以真实格式为准）。
   * @param options.meaning - 一句话含义（可空；空则写进「未收藏」待办区）。
   * @param options.scene - 适用场景（可空）。
   * @returns `{ path, bytes, format, source, catalog? }`：`catalog` 是目录那一行的结果说明。
   */
  async function saveSticker({ source, name, meaning, scene } = {}) {
    if (stickerRoot === undefined || !stickerInside || stickerLabel === undefined) {
      throw new Error(`the sticker directory is not usable (${settings.stickerDir.trim() || '(empty)'}): it must be a directory inside ${cwd}`);
    }
    const existing = stickerFiles();
    if (stickerMaxFiles > 0 && existing.length >= stickerMaxFiles) {
      throw new Error(`the sticker directory already holds ${existing.length} images (stickerMaxFiles: ${stickerMaxFiles}); ask the operator to clean it up or raise the limit`);
    }
    // 先取字节、先校验，再动目录：失败时不会在表情包目录里留下半个文件。
    const image = await loadOutgoingImage({ source, cwd, maxBytes: imageMaxBytes });
    const fileName = stickerFileName(name, image.format);
    if (fileName === undefined) {
      throw new Error(`"${String(name ?? '').slice(0, 40)}" is not a usable sticker name: pass a short file name such as "委屈" (the extension comes from the image itself)`);
    }
    // `existing` 只列认得出来的图片；再多一次 stat 是为了挡住「同名但扩展名不同 / 是个目录」
    // 这类列不出来的占位，免得 rename 覆盖掉用户自己放的东西。
    const target = join(stickerRoot, fileName);
    const occupied = existing.includes(fileName) || (await stat(target).catch(() => undefined)) !== undefined;
    if (occupied) {
      throw new Error(`${stickerLabel}/${fileName} already exists: pick another name (or read that sticker first and ask the operator if it should be replaced)`);
    }
    await mkdir(stickerRoot, { recursive: true });
    await writeBytesAtomic(target, image.bytes);
    const path = `${stickerLabel}/${fileName}`;
    report('info', `sticker saved: ${path} (${image.bytes.length} bytes, from ${image.label})`);
    // 目录那一步是**尽力而为**：图片已经存好了，不能让一次目录写入失败把「存表情」变成失败。
    let catalog;
    if (memory.enabled) {
      try {
        const written = await memory.appendSticker({
          name: fileName.replace(/\.[^.]+$/, ''),
          meaning: String(meaning ?? '').trim(),
          scene: String(scene ?? '').trim(),
          path,
          date: localDate(),
        });
        if (written.ok) {
          catalog = `added to ${memory.label}/STICKERS.md (${written.section})`;
        } else {
          catalog = `not written to STICKERS.md: ${written.reason}`;
          report('warn', `could not add ${path} to the sticker catalogue: ${written.reason}`);
        }
      } catch (error) {
        catalog = `not written to STICKERS.md: ${errorText(error)}`;
        report('warn', `could not add ${path} to the sticker catalogue: ${errorText(error)}`);
      }
    }
    return { path, bytes: image.bytes.length, format: image.format, source: image.label, catalog };
  }

  /**
   * 给一张已收藏的表情**改名**：`qq_rename_sticker` 的全部实现。
   *
   * 为什么需要它（真实事故，就是它促成了这个工具）：模型想改一张表情的名字 / 含义时，
   * 手上只有「用新名字再存一遍」这一条路 —— 于是 `.qq-stickers/` 里多出一张**同画面、
   * 不同名**的图，`STICKERS.md` 里旧名字那条还留着，以后两张都会被挑中，删除又做不到。
   * 改名必须是「同一个文件换个名字，目录里那一条跟着搬」，不是「再存一张」。
   *
   * 边界（与 `saveSticker` 同一套路，只是方向反过来）：
   *   - 只认 `stickerRoot` 里**已经存在**的那张（`findStickerByName` 的解析规则与发表情一致：
   *     裸名字、写错扩展名都找得回来）；
   *   - 新名字走同一个纯函数 `stickerFileName` 清洗，扩展名**沿用旧文件的真格式**（不重新嗅：
   *     这里没有新字节，换扩展名只会让「名字写着 .png、里面是 GIF」）；
   *   - 目标名已被占用就拒绝 —— 与「同名不覆盖」同一条理由，别让群里任何一个人一句
   *     「改个名」把别人的表情挤掉；
   *   - 目录那一步失败时**把文件改回去**：改名的价值就在于「文件与目录一致」，只改一半
   *     比不改更糟（目录指着一个不存在的路径，发出去就是「表情包没发出去」）。
   *
   * @param options.from - 现在的名字（文件名，可带扩展名）。
   * @param options.to - 想改成的新名字（扩展名由旧文件决定）。
   * @param options.meaning - 可选：顺手改含义（不给就沿用目录里原来的）。
   * @param options.scene - 可选：顺手改适用场景。
   * @param options.look - 可选：顺手改画面描述。
   * @returns `{ path, previous, bytes, renamed, catalog? }`：`catalog` 是目录那一步的结果说明。
   */
  async function renameSticker({ from, to, meaning, scene, look } = {}) {
    if (stickerRoot === undefined || !stickerInside || stickerLabel === undefined) {
      throw new Error(`the sticker directory is not usable (${settings.stickerDir.trim() || '(empty)'}): it must be a directory inside ${cwd}`);
    }
    const wanted = String(from ?? '').trim();
    const found = findStickerByName(wanted);
    if (found === undefined) {
      const names = stickerFiles().sort().slice(0, 20);
      throw new Error(
        `${stickerLabel}/ 里没有「${wanted}」：只能给已经收藏的表情改名${names.length > 0 ? `（现有：${names.join('、')}）` : '（目录是空的，先 qq_save_sticker 收藏）'}`,
      );
    }
    const extension = found.replace(/^.*\./, '').toLowerCase();
    const target = stickerFileName(to, extension);
    if (target === undefined) {
      throw new Error(`"${String(to ?? '').slice(0, 40)}" is not a usable sticker name: pass a short file name such as "委屈" (the extension stays "${extension}")`);
    }
    const previous = `${stickerLabel}/${found}`;
    const path = `${stickerLabel}/${target}`;
    if (target === found) {
      // 名字没变：不算错，也不搬文件（只把现有大小回显出来）。
      const size = (await stat(join(stickerRoot, found)).catch(() => undefined))?.size;
      return { path, previous, bytes: size, renamed: false };
    }
    // 先查占用再改名：`existing` 只列认得出来的图片，多一次 stat 挡住隐藏文件 / 目录。
    const targetPath = join(stickerRoot, target);
    const sourcePath = join(stickerRoot, found);
    if ((await stat(targetPath).catch(() => undefined)) !== undefined) {
      throw new Error(`${path} already exists: pick another name`);
    }
    const size = (await stat(sourcePath)).size;
    await rename(sourcePath, targetPath);
    let catalog;
    if (memory.enabled) {
      let written;
      try {
        written = await memory.renameSticker({
          from: found.replace(/\.[^.]+$/, ''),
          to: target.replace(/\.[^.]+$/, ''),
          path,
          meaning: String(meaning ?? '').trim() || undefined,
          scene: String(scene ?? '').trim() || undefined,
          look: String(look ?? '').trim() || undefined,
        });
      } catch (error) {
        // 目录写失败就把文件改回去：只改一半的改名，比不改更糟（见函数头）。
        await rename(targetPath, sourcePath).catch(() => {});
        throw error instanceof Error ? error : new Error(errorText(error));
      }
      if (!written.ok) {
        await rename(targetPath, sourcePath).catch(() => {});
        throw new Error(`could not update STICKERS.md: ${written.reason}`);
      }
      catalog = `updated ${memory.label}/STICKERS.md (${written.section})`;
    }
    report('info', `sticker renamed: ${previous} → ${path} (${size} bytes)`);
    return { path, previous, bytes: size, renamed: true, catalog };
  }

  /**
   * 这个 Agent 能不能把图**存**进表情包目录（`qq_save_sticker`）。
   *
   * 三层：发图总开关开着（存下来的唯一用途就是以后发出去，所以它不该在一个发不了图的
   * 会话里冒出来）、表情包目录可用（没配 / 配到 cwd 外时只能记 warn 并停用）、
   * `qq_save_sticker` 自己那一格白名单。
   */
  function stickerSaveAllowed() {
    return imageAllowed()
      && stickerRoot !== undefined && stickerInside
      && (allowTools.length === 0 || allowTools.includes('qq_save_sticker'));
  }

  /**
   * 这个 Agent 能不能给已收藏的表情改名（`qq_rename_sticker`）。
   *
   * 与 `stickerSaveAllowed` 同一套路，只是白名单那一格换成它自己的名字：改名动的是
   * 目录里**已有的**文件（不引入新字节），所以它能单独放开 —— 只读部署里「模型存不了
   * 新图、但能整理已有名字」是合理的。
   */
  function stickerRenameAllowed() {
    return imageAllowed()
      && stickerRoot !== undefined && stickerInside
      && (allowTools.length === 0 || allowTools.includes('qq_rename_sticker'));
  }

  return {
    maxFiles: stickerMaxFiles,
    root: stickerRoot,
    inside: stickerInside,
    label: stickerLabel,
    files: stickerFiles,
    names: stickerNames,
    catalogLines: stickerCatalogLines,
    resolveSource: resolveStickerSource,
    sendSource: stickerSendSource,
    isFile: isStickerFile,
    noteFailure: noteStickerFailure,
    save: saveSticker,
    rename: renameSticker,
    saveAllowed: stickerSaveAllowed,
    renameAllowed: stickerRenameAllowed,
  };
}
