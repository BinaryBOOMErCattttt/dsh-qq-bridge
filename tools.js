/**
 * QQ 桥接的**宿主平面**工具。
 *
 * 它们从 `index.js` 的闭包里搬出来，是为了把「工具声明」这件纯排版的事与「运行时
 * 状态与策略」分开：六份 `defineTool` 内联在闭包里时占了 500 多行、最深处缩进到 20 层，
 * 而它们本身没有任何策略 —— 每一份都只是「校验参数 → 调一个函数 → 拼人可读的 render」。
 *
 * **依赖全部显式传进来**（`deps`），模块自己不持有任何状态、不 import `index.js`
 * （那会形成环）。这样做的另一个好处是：这份文件里能一眼看出「工具到底能碰什么」，
 * 而不用去闭包里翻 29 张 Map 谁被谁改了。
 *
 * 六个工具都注册在宿主平面上，因此**任何** Agent 都能用（包括 Web UI 里的主会话）；
 * 从 QQ 会话里调用时可以省略目标，默认发回调用它的那个会话（见 `resolveTarget`）。
 *
 * @module @qqbot/dsh-plugin-qq/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { chunkText } from './onebot.js';
import { imageSegment, loadOutgoingImage } from './image.js';
import { hasMentionMarker, mentionSegments } from './mention.js';
import { repeatLabel } from './reminders.js';
import { localMinute } from './util.js';

/**
 * 工具一：qq_send_message —— 主动向某个 QQ 号或群号发文本（超长自动分段）。
 * 面向所有 Harness Agent 全局可用，包括 Web UI 里的主会话。
 * @param {object} deps - 见 `registerQqTools` 的说明。
 */
function qqSendMessage(deps) {
  return defineTool({
    name: 'qq_send_message',
    description:
      'Send a text message through the connected QQ (OneBot) account to one QQ contact or group. Requires the QQ bridge plugin to be connected; use qq_list_conversations first when the target id is unknown.',
    parameters: {
      target_type: {
        type: 'string',
        enum: ['private', 'group'],
        required: true,
        description: 'Whether the target id is a QQ number (private) or a group number (group).',
      },
      target_id: {
        type: 'string',
        required: true,
        description: 'The QQ number for private targets, or the group number for group targets.',
      },
      message: {
        type: 'string',
        required: true,
        description: 'The plain-text message body to send. Long text is split automatically. A person in the target group can be @-mentioned by writing [[@their nickname]] (the nickname as it appears in the conversation), a true at-segment is then sent. Never write a bare QQ number as text.',
      },
    },
    // 输出结构：回显目标与实际发送的段数，便于模型确认「发了几条」。
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target_type: { type: 'string', required: true },
          target_id: { type: 'string', required: true },
          parts: { type: 'integer', required: true },
        },
      },
      // render 决定这条工具结果如何呈现给调用它的 Agent（人可读的摘要）。
      render: (_args, value) => [
        { type: 'text', text: `Sent ${value.parts} QQ message part(s) to ${value.target_type} ${value.target_id}.` },
      ],
    },
    async execute(args, exec) {
      // 未连接时直接报错，而不是静默丢弃消息。
      if (!deps.client.connected) throw new Error(`QQ bridge is not connected to ${deps.endpoint}; start NapCat or check the endpoint.`);
      const targetType = args.target_type;
      const targetId = String(args.target_id).trim();
      const body = String(args.message ?? '').trim();
      if (targetId.length === 0) throw new Error('qq_send_message requires a non-empty target_id');
      if (body.length === 0) throw new Error('qq_send_message requires a non-empty message');
      const action = targetType === 'group' ? 'send_group_msg' : 'send_private_msg';
      const idKey = targetType === 'group' ? 'group_id' : 'user_id';
      // 目标会话记录（拿它上面那份「谁可以被 @」的名单）：显式给的目标可能还没聊过，
      // 这时 `resolveTarget` 给的是一个临时的空壳（名单为空），@ 会退化成「不 @ 任何人」。
      const { conversation } = deps.resolveTarget(args, exec, 'qq_send_message');
      const mentionsFor = deps.mentionResolver(conversation);
      // 这是 Agent 的显式动作（「就发这段」），所以只按协议上限分段：
      // 不做拆句、不加打字延迟 —— 拟人节奏只加在 QQ 会话的自动回复上。
      const parts = chunkText(body, deps.protocolLimit);
      for (const part of parts) {
        // 没有 `[[@昵称]]` 的那几段仍然发纯字符串（与旧行为逐字节一致）；有标记的才走段解析。
        await deps.client.call(action, { [idKey]: targetId, message: hasMentionMarker(part) ? mentionSegments(part, mentionsFor) : part });
      }
      // 发进群里的工具消息也是「我自己说的话」，回复指向的进度要跟着走（见 `noteOwnMessage`）。
      deps.noteOwnMessage(targetType, targetId);
      return { target_type: targetType, target_id: targetId, parts: parts.length };
    },
  });
}

/**
 * 工具二：qq_send_image —— 主动往 QQ 发一张图 / 一个表情包。
 *
 * 传输走 OneBot image 段的 `base64://`（见 `image.js` 里的取舍说明）：NapCat 在
 * 容器里，本地路径它读不到，而 base64 不依赖任何网络可达性假设。
 *
 * 从 QQ 会话里调用可以不给目标（默认发回当前会话）—— 「回一张表情包」不该先让
 * 模型去查自己在哪个群。
 * @param {object} deps - 见 `registerQqTools` 的说明。
 */
function qqSendImage(deps) {
  return defineTool({
    name: 'qq_send_image',
    description:
      'Send one image (a picture or a meme/sticker, PNG/JPEG/WebP/GIF) through the connected QQ (OneBot) account to one QQ contact or group. The image source is either a path inside the working directory (such as a sticker under the sticker directory, or a picture the conversation already downloaded into the media cache) or an http(s) image URL. Called from inside a QQ conversation, the current conversation is the default recipient.',
    parameters: {
      image: {
        type: 'string',
        required: true,
        description: 'The image to send: a path relative to the working directory (e.g. ".qq-stickers/笑死.gif" or ".qq-media/ab12….jpg"), an absolute path inside the working directory, an http(s) image URL, or just the file name of a sticker from the sticker directory (with or without its extension).',
      },
      target_type: {
        type: 'string',
        enum: ['private', 'group'],
        description: 'Where to send the image. Defaults to the QQ conversation this tool was called from.',
      },
      target_id: {
        type: 'string',
        description: 'QQ number (private) or group number (group) to send the image to. Defaults to the current QQ conversation.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target_type: { type: 'string', required: true },
          target_id: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          format: { type: 'string', required: true },
          source: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `Sent a ${value.format} image (${value.bytes} bytes) from ${value.source} to ${value.target_type} ${value.target_id}.`,
        },
      ],
    },
    async execute(args, exec) {
      if (!deps.imageSend) throw new Error('sending images is disabled (qq-bridge config imageSend: false)');
      if (!deps.client.connected) throw new Error(`QQ bridge is not connected to ${deps.endpoint}; start NapCat or check the endpoint.`);
      const { type, id } = deps.resolveTarget(args, exec, 'qq_send_image');
      // 先取字节、先校验：任一步失败都在发消息之前报错，不会给 QQ 留下半张图。
      const image = await loadOutgoingImage({ source: deps.resolveStickerSource(args.image), cwd: deps.cwd, maxBytes: deps.imageMaxBytes });
      const action = type === 'group' ? 'send_group_msg' : 'send_private_msg';
      const idKey = type === 'group' ? 'group_id' : 'user_id';
      // 收藏目录里的表情按「大表情」发（`sub_type: 1`），其它来源（`.qq-media` 截图、
      // 任意 URL、工作目录里的照片）照旧是普通图片 —— 见 `imageSegment` 的注释。
      const sticker = deps.isStickerFile?.(args.image) === true;
      await deps.client.call(action, { [idKey]: id, message: [imageSegment(image.bytes, { sticker })] });
      // 同 `qq_send_message`：我发进群的图也要算进回复指向的进度。
      deps.noteOwnMessage(type, id);
      deps.report('info', `→ ${type === 'group' ? '群' : '私聊'} ${id}: ${image.format} 图 ${image.bytes.length} bytes（来源 ${image.label}）`);
      return { target_type: type, target_id: id, bytes: image.bytes.length, format: image.format, source: image.label };
    },
  });
}

/**
 * 工具三：qq_save_sticker —— 把一张图固化进表情包目录，成为「以后随手能挑」的表情。
 *
 * 和 qq_send_image 是两件事：那个是**发出去**（一次性动作），这个是**留下来**（改磁盘）。
 * 存在的理由只有一个：QQ 会话按设计没有 write / edit / bash，所以群里那句「存一下这个
 * 表情」模型自己做不到 —— 实测它会把含义记进 COGNITION.md、key 写成 `.qq-media/<哈希>`
 * 这个会被淘汰的缓存路径，然后回一句「存好了」（见 index.js 的 `saveSticker`）。
 *
 * 写边界全部在 `deps.saveSticker` 里（单层文件名 + 只写 stickerDir + 不覆盖同名 +
 * 张数上限），这里只管参数、报错和 render。
 * @param {object} deps - 见 `registerQqTools` 的说明。
 */
function qqSaveSticker(deps) {
  return defineTool({
    name: 'qq_save_sticker',
    description:
      'Save one image (PNG/JPEG/WebP/GIF) into the QQ sticker directory so it becomes a reusable sticker you can send later — typically a meme someone just posted and asked you to keep, or a picture the conversation downloaded into the media cache. Pass "meaning" (and optionally "scene") and the sticker catalogue STICKERS.md gets a matching row, so in every later prompt you see "名字（含义）" instead of a bare file name. The bytes are validated (magic number, size limit, must be inside the working directory) and the name is sanitized; the extension comes from the image itself. Returns the sticker path to use with qq_send_image or the [[图片: …]] marker. An existing name is refused (never overwritten).',
    parameters: {
      source: {
        type: 'string',
        required: true,
        description: 'The image to keep: a path relative to the working directory (usually the ".qq-media/…" path this conversation gave you), an absolute path inside the working directory, or an http(s) image URL.',
      },
      name: {
        type: 'string',
        required: true,
        description: 'The sticker file name, without the extension — a short, meaningful name saying what it means ("委屈", "笑死", "摸摸头"). This name is what you will see in every prompt from now on, so it is worth getting right.',
      },
      meaning: {
        type: 'string',
        description: 'One short sentence saying what the sticker means emotionally ("委屈、求安慰", "笑到不行、没眼看"). Written into STICKERS.md next to the name; without it the row goes to the "未收藏" (to-do) section instead, because a catalogue entry you cannot judge is useless.',
      },
      scene: {
        type: 'string',
        description: 'Optional: when to use it ("对方凶我 / 我装可怜时"). Also written into STICKERS.md.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          format: { type: 'string', required: true },
          source: { type: 'string', required: true },
          catalog: { type: 'string' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: [
            `Saved ${value.source} as ${value.path} (${value.format}, ${value.bytes} bytes). Send it back with [[图片: ${value.path}]].`,
            value.catalog === undefined
              ? 'No sticker catalogue was updated (long-term memory is off, or the catalogue write failed) — the file itself is saved.'
              : `Sticker catalogue: ${value.catalog}`,
          ].join('\n'),
        },
      ],
    },
    async execute(args) {
      if (deps.saveSticker === undefined) throw new Error('saving stickers is not available (the sticker directory is disabled, imageSend is off, or qq_save_sticker is not in allowTools)');
      return deps.saveSticker({ source: args.source, name: args.name, meaning: args.meaning, scene: args.scene });
    },
  });
}

/**
 * 工具：qq_poke —— 戳一戳（双击头像）。
 *
 * 为什么单独给一个工具而不是塞进 qq_send_message：戳一戳是 OneBot 的独立动作
 * （`send_poke`，个别实现叫 `group_poke` / `friend_poke`），没有正文；它表达的是
 * 「我叫你一下」而不是「我说一句话」，混进文本工具会让模型以为要多写点什么。
 *
 * 安全：`target_id` / `user_id` 都是显式参数，**不接受**「最近跟我说话的人」这种推断
 * —— 戳错了是冒犯，不像发错一句话那么好解释。
 * @param {object} deps - 见 `registerQqTools` 的说明。
 */
function qqPoke(deps) {
  return defineTool({
    name: 'qq_poke',
    description:
      'Poke somebody through QQ (the double-tap "戳一戳"). In a private chat this nudges that contact; in a group you must say which member to poke. Use it to get attention, not to say anything — if you have words, send a message instead.',
    parameters: {
      target_type: {
        type: 'string',
        enum: ['private', 'group'],
        required: true,
        description: 'private = a QQ contact; group = a group (then user_id is the member to poke).',
      },
      target_id: {
        type: 'string',
        required: true,
        description: 'The QQ number for private targets, or the group number for group targets.',
      },
      user_id: {
        type: 'string',
        description: 'Required for group targets: the QQ number of the member to poke.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target_type: { type: 'string', required: true },
          target_id: { type: 'string', required: true },
          user_id: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `Poked ${value.user_id} in ${value.target_type} ${value.target_id}.` },
      ],
    },
    async execute(args) {
      if (deps.poke === undefined) throw new Error('poking is not available in this deployment');
      if (!deps.client.connected) throw new Error(`QQ bridge is not connected to ${deps.endpoint}; start NapCat or check the endpoint.`);
      const type = args.target_type === 'group' ? 'group' : 'private';
      const id = String(args.target_id ?? '').trim();
      if (id.length === 0) throw new Error('qq_poke needs target_id');
      const userId = type === 'group' ? String(args.user_id ?? '').trim() : id;
      if (userId.length === 0) throw new Error('qq_poke needs user_id when poking a group member');
      const ok = await deps.poke(type, id, userId);
      if (!ok) throw new Error(`qq_poke could not poke ${userId} (the OneBot implementation rejected every poke action)`);
      deps.report('info', `→ ${type === 'group' ? '群' : '私聊'} ${id}: 戳了 ${userId}`);
      return { target_type: type, target_id: id, user_id: userId };
    },
  });
}

/**
 * 工具四：qq_list_conversations —— 列出在线群/好友，以及本 Harness 已处理过的
 * QQ 会话及其 Session id，同时附带当前生效的模型路由（便于排查 MISSING_CREDENTIAL
 * 之类的模型问题）。
 * @param {object} deps - 见 `registerQqTools` 的说明。
 */
function qqListConversations(deps) {
  return defineTool({
    name: 'qq_list_conversations',
    description:
      'List QQ contacts reachable through the connected OneBot account: the live group and friend lists, plus every QQ conversation this Harness has already handled and its Session id.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          connected: { type: 'boolean', required: true },
          self_id: { type: 'string' },
          groups: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
              },
            },
          },
          friends: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
              },
            },
          },
          sessions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                conversation: { type: 'string', required: true },
                type: { type: 'string', required: true },
                name: { type: 'string', required: true },
                session_id: { type: 'string', required: true },
                session_round: { type: 'number', required: true },
              },
            },
          },
          route: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              provider: { type: 'string', required: true },
              model: { type: 'string', required: true },
              source: { type: 'string', required: true },
              error: { type: 'string', required: true },
            },
          },
        },
      },
      render: (_args, value) => {
        const lines = [`QQ bridge connected: ${value.connected}${value.self_id ? ` (account ${value.self_id})` : ''}`];
        lines.push(`QQ session model: ${value.route.model || '(none)'} via ${value.route.provider || '(none)'} [${value.route.source}]`);
        if (value.route.error.length > 0) lines.push(`Route warning: ${value.route.error}`);
        if (value.groups.length > 0) lines.push('', 'Groups:', ...value.groups.map((g) => `  ${g.id} ${g.name}`));
        if (value.friends.length > 0) lines.push('', 'Friends:', ...value.friends.map((f) => `  ${f.id} ${f.name}`));
        if (value.sessions.length > 0) {
          // 轮次只在 /reset 过之后才标出来：没 reset 过的会话保持原来的输出形状。
          lines.push('', 'Handled conversations:', ...value.sessions.map((s) => `  ${s.conversation} (${s.name}) → session ${s.session_id}${s.session_round > 0 ? ` (round ${s.session_round})` : ''}`));
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute() {
      const groups = [];
      const friends = [];
      // 未连接时这两项为空数组（而不是报错），其余信息照常返回，方便定位问题。
      if (deps.client.connected) {
        try {
          for (const group of (await deps.client.call('get_group_list')) ?? []) {
            groups.push({ id: String(group.group_id), name: String(group.group_name ?? '') });
          }
        } catch (error) {
          deps.report('warn', `get_group_list failed: ${error?.message ?? error}`);
        }
        try {
          for (const friend of (await deps.client.call('get_friend_list')) ?? []) {
            friends.push({ id: String(friend.user_id), name: String(friend.nickname ?? '') });
          }
        } catch (error) {
          deps.report('warn', `get_friend_list failed: ${error?.message ?? error}`);
        }
      }
      const chosen = deps.resolveRoute();
      return {
        connected: deps.client.connected,
        self_id: deps.client.selfId,
        groups,
        friends,
        route: { provider: chosen.provider, model: chosen.model, source: chosen.source, error: chosen.error },
        // sessions 来自已处理过的会话表；session_id 现场派生，因此与 QQ 号一一对应
        // 且稳定 —— 同一个会话每 /reset 一次换一个新 id（旧的留在磁盘上当存档）。
        sessions: [...deps.conversations.values()].map((conversation) => ({
          conversation: conversation.key,
          type: conversation.type,
          name: conversation.name || conversation.senderName,
          session_id: deps.sessionIdFor(conversation.key, conversation.sessionGeneration ?? 0),
          session_round: conversation.sessionGeneration ?? 0,
        })),
      };
    },
  });
}

/**
 * 工具五：qq_transcript —— 查某个 QQ 会话的聊天记录（长期记忆的原料）。
 *
 * 这是「想不起来就去查」的那条路：`ambientMessages` 只喂最近十来条，一旦真需要
 * 「上周三讨论的那个链接是什么」就必须能翻到更早的记录，而不是靠模型编。
 * @param {object} deps - 见 `registerQqTools` 的说明。
 */
function qqTranscript(deps) {
  const memory = deps.memory;
  return defineTool({
    name: 'qq_transcript',
    description:
      'Read the recorded chat transcript of a QQ conversation (long-term memory raw material). Use it when you need details of what was said earlier — who said what, when, and what was shared — instead of guessing from the short recent-message context. Actions: "list" (which conversations have records, with message counts and the newest time), "read" (messages, oldest first, optionally limited to a date range), "search" (substring match across the records).',
    parameters: {
      action: {
        type: 'string',
        enum: ['list', 'read', 'search'],
        description: 'list = the conversations on disk with counts; read = messages of one conversation; search = find a keyword across a conversation\'s records.',
      },
      conversation: {
        type: 'string',
        description: 'Conversation key such as "group:100000001" or "private:100000002". Defaults to the QQ conversation this tool was called from. Not needed for "list".',
      },
      query: {
        type: 'string',
        description: 'The text to look for (action: search). Matched case-insensitively as a substring of the message text, sender name, or date.',
      },
      date: {
        type: 'string',
        description: 'Local date to read, "YYYY-MM-DD" (action: read). Defaults to today.',
      },
      since: {
        type: 'string',
        description: 'Earliest date to include, "YYYY-MM-DD" (action: read). Use with until.',
      },
      until: {
        type: 'string',
        description: 'Latest date to include, "YYYY-MM-DD" (action: read).',
      },
      limit: {
        type: 'integer',
        description: 'Maximum messages/hits to return (default 200 for read, memorySearchHits for search).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          conversation: { type: 'string' },
          lines: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                conversation: { type: 'string' },
                name: { type: 'string' },
                date: { type: 'string' },
                messages: { type: 'integer' },
                last_at: { type: 'string' },
                last_text: { type: 'string' },
                at: { type: 'string' },
                time: { type: 'string' },
                user: { type: 'string' },
                text: { type: 'string' },
                kind: { type: 'string' },
                addressed: { type: 'boolean' },
                command: { type: 'string' },
                media: { type: 'boolean' },
              },
            },
          },
          returned: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const head = value.action === 'list'
          ? `${value.lines.length} conversation(s) with recorded transcripts.`
          : `${value.returned} line(s)${value.truncated ? ' (truncated)' : ''}${value.conversation !== undefined ? ` for ${value.conversation}` : ''}.`;
        return [{ type: 'text', text: [head, value.note ?? '', ...value.lines.map((line) => memory.describeLine(line))].filter((part) => part.length > 0).join('\n') }];
      },
    },
    async execute(args, exec) {
      if (args.action === 'list') return memory.listTranscripts();
      const target = memory.resolveConversation(args, exec, 'qq_transcript');
      if (args.action === 'search') {
        if (typeof args.query !== 'string' || args.query.trim().length === 0) throw new Error('qq_transcript: "query" is required for action "search"');
        return memory.searchTranscript(target, args);
      }
      return memory.readTranscript(target, args);
    },
  });
}

/**
 * 工具六：qq_memory —— 读 / 追加 / 覆盖 / 逐条写入记忆文件（`MEMORY.md` / `COGNITION.md` /
 * `STICKERS.md` / `INDEX.md`）。
 *
 * 写路径被限制在 memoryDir 之内（`memoryRelativePath`），单个文件也有字节上限：
 * 记忆的价值在「精炼且总是被读到」，一个无限增长的文件只会把提示词撑爆。
 * 读不设上限（要翻就翻个够），只按 `memorySearchHits` 限制搜索命中数。
 *
 * `upsert` / `remove` 是给两个**结构化**文件用的（认知库与表情包目录）：模型只给字段，
 * 生成的 markdown 由纯函数负责（格式、分节、去重都在那边），这样它既写不坏格式，
 * 也不会因为「整份重写」丢行 —— 那两件事都真实发生过。
 * @param {object} deps - 见 `registerQqTools` 的说明。
 */
function qqMemory(deps) {
  const memory = deps.memory;
  return defineTool({
    name: 'qq_memory',
    description:
      'Read, append to, search, or overwrite a long-term memory file for the QQ bridge. All paths live under the memory directory and are relative to it, for example "conversations/group-100000001/MEMORY.md" (one conversation\'s memory, "write"/"append" create it if missing), "COGNITION.md" (language memes / slang / homophones — never file paths), "STICKERS.md" (the sticker catalogue: name, meaning, scene and the saved file path), or "INDEX.md" (the short index that is injected into every QQ agent\'s prompt — keep it to a handful of lines). Prefer "upsert" (one row at a time) over "write" for COGNITION.md and STICKERS.md: "write" replaces the whole file and is only for reorganising. Paths outside the memory directory are rejected.',
    parameters: {
      action: {
        type: 'string',
        enum: ['read', 'append', 'write', 'search', 'list', 'upsert', 'remove'],
        description: 'read = full file (with line numbers); append = add text at the end (normal for MEMORY.md / INDEX.md); write = replace the whole file (reorganising only); search = substring match with context lines; list = the files that already exist; upsert = add or replace ONE row in COGNITION.md / STICKERS.md by name; remove = delete one row by name.',
      },
      path: {
        type: 'string',
        description: 'Memory-relative file path, e.g. "conversations/group-100000001/MEMORY.md", "COGNITION.md", "INDEX.md". For read/write/append it defaults to this conversation\'s MEMORY.md when a conversation is known.',
      },
      conversation: {
        type: 'string',
        description: 'Conversation key such as "group:100000001". Defaults to the QQ conversation this tool was called from; the digest session must pass it.',
      },
      text: {
        type: 'string',
        description: 'The markdown to append or write (action: append / write).',
      },
      query: {
        type: 'string',
        description: 'The text to look for (action: search).',
      },
      limit: {
        type: 'integer',
        description: 'Maximum hits to return (action: search; default memorySearchHits).',
      },
      name: {
        type: 'string',
        description: 'One row to upsert/remove: the word or phrase itself for COGNITION.md (e.g. "蚌埠住了"), the sticker name for STICKERS.md (e.g. "无语"). Matching is exact after trimming.',
      },
      meaning: {
        type: 'string',
        description: 'One sentence: what it means (COGNITION.md) or what mood the sticker expresses (STICKERS.md). A row without a meaning is not injected into the prompt, so it is required for upsert.',
      },
      usage: {
        type: 'string',
        description: 'COGNITION.md only: when/how to use it.',
      },
      scene: {
        type: 'string',
        description: 'STICKERS.md only: when to send this sticker (e.g. "有人发离谱东西时").',
      },
      look: {
        type: 'string',
        description: 'STICKERS.md only: one line describing the picture (what is in it).',
      },
      image: {
        type: 'string',
        description: 'STICKERS.md only: the saved file path inside the sticker directory, e.g. ".qq-stickers/无语.gif". Never a ".qq-media/..." path — save it with qq_save_sticker first.',
      },
      type: {
        type: 'string',
        description: 'COGNITION.md only: category used to place the row — 缩写 / 谐音 / 专名 / 其它 (专名 = game, character, player, work names).',
      },
      variants: {
        type: 'string',
        description: 'COGNITION.md only: alternative spellings, separated by "/" — they are written into the same row.',
      },
      source: {
        type: 'string',
        description: 'COGNITION.md only: where it was learned (group / site), optional.',
      },
      date: {
        type: 'string',
        description: 'First-seen date, YYYY-MM-DD (optional; used by the hot list ordering).',
      },
      confidence: {
        type: 'string',
        enum: ['确认', '存疑'],
        description: '确认 = someone explained it or it kept meaning the same thing; 存疑 = your own guess (存疑 rows never enter the per-turn hot list).',
      },
      force: {
        type: 'boolean',
        description: 'Action "write" only: allow a rewrite that keeps less than 90% of the current rows (the guard exists because a full rewrite silently drops rows).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          path: { type: 'string' },
          bytes: { type: 'integer' },
          lines_total: { type: 'integer' },
          returned: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          files: { type: 'array', items: { type: 'string' } },
          text: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.action === 'list') {
          return [{ type: 'text', text: `memory files:\n${(value.files ?? []).join('\n') || '(none yet)'}` }];
        }
        const head = `${value.action} ${value.path ?? ''} (${value.bytes ?? 0} bytes)${value.truncated ? ', truncated' : ''}`;
        return [{ type: 'text', text: [head, value.note ?? '', value.text ?? ''].filter((part) => part.length > 0).join('\n') }];
      },
    },
    async execute(args, exec) {
      if (args.action === 'list') return memory.listFiles();
      const path = memory.resolvePath(args, 'qq_memory', exec);
      if (args.action === 'read') return memory.readFile(path);
      if (args.action === 'search') {
        if (typeof args.query !== 'string' || args.query.trim().length === 0) throw new Error('qq_memory: "query" is required for action "search"');
        return memory.searchFile(path, args.query, args.limit);
      }
      if (args.action === 'upsert') {
        const name = String(args.name ?? '').trim();
        if (name.length === 0) throw new Error('qq_memory: "name" is required for action "upsert"');
        if (String(args.meaning ?? '').trim().length === 0) throw new Error('qq_memory: "meaning" is required for action "upsert" (a row without a meaning is never injected)');
        return memory.upsertEntry(path, { ...args, name, date: String(args.date ?? '').trim() || undefined });
      }
      if (args.action === 'remove') {
        const name = String(args.name ?? '').trim();
        if (name.length === 0) throw new Error('qq_memory: "name" is required for action "remove"');
        return memory.removeEntry(path, name);
      }
      if (typeof args.text !== 'string' || args.text.trim().length === 0) throw new Error(`qq_memory: "text" is required for action "${args.action}"`);
      return memory.writeFile(path, args.text, args.action === 'append', { force: args.force === true });
    },
  });
}

/**
 * 工具七：qq_remind_create —— 建一条到点的提醒。
 *
 * 时间由模型换算成**本地绝对时间**（渠道提示里每轮都会给出「现在是几点、周几」），
 * 插件只做严格校验。这样自然语言理解交给模型，日期算术交给 `Date`。
 *
 * `mode` 是精度/语气的取舍：`text` 一字不差、`agent` 让模型用自己的语气说、
 * `prompt` 到点做事。后两种都受 `reminderModes` 与受信者名单限制。
 * @param {object} deps - 见 `registerQqTools` 的说明。
 */
function qqRemindCreate(deps) {
  return defineTool({
    name: 'qq_remind_create',
    description:
      'Create a scheduled reminder: at the given local time the QQ bridge itself sends a message to this (or another) conversation, optionally @-mentioning people. Use this whenever someone asks to be reminded later or asks for a message at a future time — do not just say "ok, I will remember" in the reply. Modes: "text" sends the text verbatim; "agent" lets the model phrase the same thing in its own voice (falls back to the text on model failure); "prompt" lets the model perform the instruction with tools (trusted callers only).',
    parameters: {
      text: {
        type: 'string',
        description: 'The reminder body for mode text/agent, or a short label for mode prompt. Plain text; [[image: ...]] and [[@name]] markers are NOT interpreted — the message is sent exactly as written.',
      },
      prompt: {
        type: 'string',
        description: 'Mode "prompt" only: the instruction the model should carry out at that time (e.g. "summarize today in this group").',
      },
      mode: {
        type: 'string',
        enum: ['text', 'agent', 'prompt'],
        description: 'How to deliver: text = verbatim (default); agent = let the model phrase it in its own voice; prompt = let the model perform the instruction. agent/prompt may be disabled by the deployment.',
      },
      at: {
        type: 'string',
        description: 'Absolute local time, formatted YYYY-MM-DDTHH:MM (e.g. 2026-08-21T08:00). Required for repeating reminders. Use the current local time shown in the channel prompt to compute it.',
      },
      in_minutes: {
        type: 'integer',
        description: 'Relative delay in minutes (>= 1), for short reminders. Exactly one of at / in_minutes is required.',
      },
      repeat: {
        type: 'string',
        enum: ['none', 'daily', 'weekdays', 'weekly', 'monthly'],
        description: 'Repeat pattern (default none). daily = every day at the HH:MM of "at"; weekdays = Monday-Friday; weekly = same weekday; monthly = same day of month (clamped to month end). Repeating requires "at".',
      },
      mention: {
        type: 'array',
        items: { type: 'string' },
        description: 'Who to @ when it fires: a display name from this conversation, "me" for the creator, or "all" for @everyone (group only, deployment-gated). Omit to @ the creator in groups; private reminders never @ anyone.',
      },
      allow_skip: {
        type: 'boolean',
        description: 'Mode "prompt" only: allow the model to send nothing when it judges there is nothing to report (default true). Set false together with fallback_text to guarantee a message.',
      },
      fallback_text: {
        type: 'string',
        description: 'Text to send if the agent turn fails, times out, or (when allow_skip is false) returns SKIP. Defaults to "text" for agent mode; required for prompt mode when allow_skip is false.',
      },
      target_type: {
        type: 'string',
        enum: ['private', 'group'],
        description: 'Where to send. Defaults to the QQ conversation this tool was called from; an explicit target is only allowed for trusted callers.',
      },
      target_id: {
        type: 'string',
        description: 'QQ number (private) or group number (group). Defaults to the current QQ conversation.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          mode: { type: 'string', required: true },
          at: { type: 'string', required: true },
          repeat: { type: 'string', required: true },
          mentions: { type: 'array', items: { type: 'string' }, required: true },
          text: { type: 'string', required: true },
          duplicate: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            `${value.duplicate ? 'Already scheduled' : 'Scheduled'} ${value.id}: ${value.mode} reminder at ${value.at} (${value.repeat})` +
            `${value.mentions.length > 0 ? ` mentioning ${value.mentions.join(', ')}` : ''}: ${value.text}`,
        },
      ],
    },
    async execute(args, exec) {
      if (deps.reminders === undefined) throw new Error('scheduled reminders are disabled (reminder is false or the reminder file is outside cwd)');
      const prepared = deps.reminderPrepare(args, exec, 'qq_remind_create');
      const { task, duplicate } = await deps.reminders.create({
        key: prepared.key,
        type: prepared.type,
        targetId: prepared.targetId,
        callerId: prepared.callerId,
        callerName: prepared.callerName,
        operator: prepared.operator,
        trusted: prepared.trusted,
        canMentionOthers: prepared.canMentionOthers,
        canAll: prepared.canAll,
        mentions: prepared.mentions,
        mode: args.mode ?? 'text',
        text: args.text,
        prompt: args.prompt,
        fallbackText: args.fallback_text,
        allowSkip: args.allow_skip,
        at: args.at,
        inMinutes: args.in_minutes,
        repeat: args.repeat ?? 'none',
      });
      return {
        id: task.id,
        mode: task.mode,
        at: localMinute(task.dueAt),
        repeat: repeatLabel(task.repeat),
        mentions: task.mentions.map((entry) => entry.name),
        text: task.mode === 'prompt' ? task.prompt : task.text,
        duplicate,
      };
    },
  });
}

/**
 * 工具八：qq_remind_list —— 看这个会话 / 自己 / 全部待发与最近的提醒。
 * @param {object} deps - 见 `registerQqTools` 的说明。
 */
function qqRemindList(deps) {
  return defineTool({
    name: 'qq_remind_list',
    description:
      'List scheduled reminders. scope "conversation" (default) lists this QQ conversation, "mine" lists the reminders created by the caller, "all" lists every conversation (operator only). Returns pending and recently finished tasks.',
    parameters: {
      scope: {
        type: 'string',
        enum: ['conversation', 'mine', 'all'],
        description: 'Which reminders to list. Defaults to the current conversation.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tasks: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                mode: { type: 'string', required: true },
                at: { type: 'string', required: true },
                repeat: { type: 'string', required: true },
                mentions: { type: 'array', items: { type: 'string' }, required: true },
                text: { type: 'string', required: true },
                status: { type: 'string', required: true },
                created_by: { type: 'string', required: true },
                fire_count: { type: 'integer', required: true },
                error: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            value.tasks.length === 0
              ? 'No scheduled reminders.'
              : value.tasks
                  .map((task) => `${task.id} [${task.status}] ${task.at} (${task.repeat}) ${task.mode}: ${task.text}${task.error ? ` — ${task.error}` : ''}`)
                  .join('\n'),
        },
      ],
    },
    async execute(args, exec) {
      if (deps.reminders === undefined) throw new Error('scheduled reminders are disabled (reminder is false or the reminder file is outside cwd)');
      const viewer = deps.reminderViewer(exec);
      return {
        tasks: deps.reminders.list({
          key: viewer.key,
          creatorId: viewer.callerId,
          scope: args.scope ?? 'conversation',
          operator: viewer.operator,
        }),
      };
    },
  });
}

/**
 * 工具九：qq_remind_cancel —— 取消一条还没发的提醒（创建者本人或操作员）。
 * @param {object} deps - 见 `registerQqTools` 的说明。
 */
function qqRemindCancel(deps) {
  return defineTool({
    name: 'qq_remind_cancel',
    description: 'Cancel one scheduled reminder by its id. Only the person who created it (or the operator) can cancel it.',
    parameters: {
      id: { type: 'string', required: true, description: 'The reminder id, as returned by qq_remind_create / qq_remind_list.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          status: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Reminder ${value.id} is now ${value.status}.` }],
    },
    async execute(args, exec) {
      if (deps.reminders === undefined) throw new Error('scheduled reminders are disabled (reminder is false or the reminder file is outside cwd)');
      const viewer = deps.reminderViewer(exec);
      const task = await deps.reminders.cancel(args.id, { id: viewer.callerId, operator: viewer.operator });
      return { id: task.id, status: task.status };
    },
  });
}

/**
 * 注册全部适用的 QQ 工具。两个可选的工具族只在对应能力可用时注册：记忆工具要
 * `deps.memory`（长期记忆停用时是 undefined），`qq_save_sticker` 要 `deps.saveSticker`
 * （表情包目录不可用、或白名单没放开时是 undefined）—— 停用的功能不该留下一个
 * 「一调就报错」的工具。
 *
 * @param {object} ctx - 插件上下文，只用它的 `tools` 服务。
 * @param {object} deps - 全部依赖显式传入，本模块不持有状态：
 * @param {object} deps.client - OneBot 客户端（`connected` / `selfId` / `call`）。
 * @param {string} deps.cwd - Agent 工作目录，也是发图时校验越界的根。
 * @param {string} deps.endpoint - 未连接时报错信息里显示的地址。
 * @param {(level: string, message: string) => void} deps.report - 同时写 logger 与 stderr 的日志。
 * @param {number} deps.protocolLimit - 协议单条上限（工具只按它切分，不加拟人节奏）。
 * @param {(type: string, id: string) => void} deps.noteOwnMessage - 记「我自己发了一条」。
 * @param {(args: object, exec: object, toolName: string) => object} deps.resolveTarget - 解析收件人。
 * @param {(conversation: object) => (name: string) => string | undefined} deps.mentionResolver -
 *   把 `[[@昵称]]` 里的昵称解析成 QQ 号（名单挂在会话记录上）。
 * @param {(source: string) => string} deps.resolveStickerSource - 把表情包文件名解析成路径。
 * @param {(source: string) => boolean} [deps.isStickerFile] -
 *   判断来源是不是收藏目录里的表情包：是的话出站 image 段带 `sub_type: 1`（QQ 的大表情），
 *   否则按普通图片发。缺失时一律当普通图片（测试桩里可以不传）。
 * @param {(options: object) => Promise<object>} [deps.saveSticker] -
 *   把一张图存进表情包目录（校验 + 清洗文件名 + 张数上限 + 往 STICKERS.md 补一行）；
 *   缺失 = 不注册 qq_save_sticker。
 * @param {boolean} deps.imageSend - `imageSend`，关掉时发图工具直接报错。
 * @param {number} deps.imageMaxBytes - 出站图片字节上限。
 * @param {() => object} deps.resolveRoute - 当前生效的模型路由（`qq_list_conversations` 回显）。
 * @param {Map<string, object>} deps.conversations - 已处理过的会话表。
 * @param {(key: string, generation: number) => string} deps.sessionIdFor - 会话 key + 轮次 → Session id。
 * @param {object} [deps.memory] - 长期记忆的读写接口；缺失 = 不注册那两个工具。
 * @param {object} [deps.reminders] - 定时提醒子系统（`createReminders` 的返回值）；
 *   缺失 = 不注册那三个工具。
 * @param {(args: object, exec: object, toolName: string) => object} [deps.reminderPrepare] -
 *   解析提醒的目标、创建者与 @ 名单（会话状态在 index.js 里）。
 * @param {(exec: object) => object} [deps.reminderViewer] - 解析「谁在调这个工具」。
 */
export function registerQqTools(ctx, deps) {
  ctx.tools.register(qqSendMessage(deps));
  ctx.tools.register(qqSendImage(deps));
  // 表情包目录不可用（没配 / 配到 cwd 外）或白名单里没有它时整个跳过：留一个必然报错的
  // 工具，只会让模型浪费一次调用去撞墙。
  if (deps.saveSticker !== undefined) ctx.tools.register(qqSaveSticker(deps));
  ctx.tools.register(qqPoke(deps));
  ctx.tools.register(qqListConversations(deps));
  if (deps.memory !== undefined) {
    ctx.tools.register(qqTranscript(deps));
    ctx.tools.register(qqMemory(deps));
  }
  if (deps.reminders !== undefined) {
    ctx.tools.register(qqRemindCreate(deps));
    ctx.tools.register(qqRemindList(deps));
    ctx.tools.register(qqRemindCancel(deps));
  }
}
