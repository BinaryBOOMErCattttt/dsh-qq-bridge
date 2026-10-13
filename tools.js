/**
 * QQ 桥接的六个**宿主平面**工具。
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
import { parseJmRef } from './jm.js';

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
        description: 'The plain-text message body to send. Long text is split automatically.',
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
    async execute(args) {
      // 未连接时直接报错，而不是静默丢弃消息。
      if (!deps.client.connected) throw new Error(`QQ bridge is not connected to ${deps.endpoint}; start NapCat or check the endpoint.`);
      const targetType = args.target_type;
      const targetId = String(args.target_id).trim();
      const body = String(args.message ?? '').trim();
      if (targetId.length === 0) throw new Error('qq_send_message requires a non-empty target_id');
      if (body.length === 0) throw new Error('qq_send_message requires a non-empty message');
      const action = targetType === 'group' ? 'send_group_msg' : 'send_private_msg';
      const idKey = targetType === 'group' ? 'group_id' : 'user_id';
      // 这是 Agent 的显式动作（「就发这段」），所以只按协议上限分段：
      // 不做拆句、不加打字延迟 —— 拟人节奏只加在 QQ 会话的自动回复上。
      const parts = chunkText(body, deps.protocolLimit);
      for (const part of parts) await deps.client.call(action, { [idKey]: targetId, message: part });
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
      await deps.client.call(action, { [idKey]: id, message: [imageSegment(image.bytes)] });
      // 同 `qq_send_message`：我发进群的图也要算进回复指向的进度。
      deps.noteOwnMessage(type, id);
      deps.report('info', `→ ${type === 'group' ? '群' : '私聊'} ${id}: ${image.format} 图 ${image.bytes.length} bytes（来源 ${image.label}）`);
      return { target_type: type, target_id: id, bytes: image.bytes.length, format: image.format, source: image.label };
    },
  });
}

/**
 * 工具三：qq_list_conversations —— 列出在线群/好友，以及本 Harness 已处理过的
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
 * 工具四：qq_jm_pdf —— 下载禁漫（JM）本子/单话，合并成 PDF，并发到 QQ。
 *
 * 从 QQ 会话里调用时可以不填目标：调用它的那个 Agent 对应的会话就是收件人
 * （`exec.agent.id` → 会话 key）。Web UI 里的主会话调用时必须显式给目标。
 * @param {object} deps - 见 `registerQqTools` 的说明。
 */
function qqJmPdf(deps) {
  return defineTool({
    name: 'qq_jm_pdf',
    description:
      'Download a JM (18comic) album or chapter, merge every page into one PDF, and send that PDF to a QQ contact or group through the OneBot bridge. Accepts a bare JM id, "JM123456", or an 18comic album/photo URL. Called from inside a QQ conversation, the current conversation is the default recipient. Long: a whole multi-chapter album can take minutes, and the file upload itself is slow.',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'JM album id or chapter id (digits), "JM123456", or a full 18comic album/photo URL.',
      },
      kind: {
        type: 'string',
        enum: ['auto', 'album', 'chapter'],
        description: 'auto (default): the whole album when the id is an album id, otherwise just that chapter. album = every chapter merged into one PDF. chapter = only the chapter with this id.',
      },
      target_type: {
        type: 'string',
        enum: ['private', 'group'],
        description: 'Where to send the PDF. Defaults to the QQ conversation this tool was called from.',
      },
      target_id: {
        type: 'string',
        description: 'QQ number (private) or group number (group) to send the PDF to. Defaults to the current QQ conversation.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file_name: { type: 'string', required: true },
          path: { type: 'string', required: true },
          title: { type: 'string', required: true },
          pages: { type: 'integer', required: true },
          bytes: { type: 'integer', required: true },
          chapters: { type: 'integer', required: true },
          target_type: { type: 'string', required: true },
          target_id: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            `Downloaded ${value.title || value.file_name} (${value.chapters} chapter(s), ${value.pages} page(s), ${value.bytes} bytes) ` +
            `into ${value.path} and sent ${value.file_name} to ${value.target_type} ${value.target_id}.`,
        },
      ],
    },
    async execute(args, exec) {
      const ref = parseJmRef(args.id);
      if (ref === undefined) throw new Error(`qq_jm_pdf could not find a JM id in "${args.id}"`);
      const kind = args.kind ?? ref.kind;
      // 收件人：显式给的优先；否则是调用它的那个 QQ 会话。
      const { conversation, type: targetType, id: targetId } = deps.resolveTarget(args, exec, 'qq_jm_pdf');
      const job = await deps.downloadJm({ conversation, ref: { id: ref.id, kind } });
      const sent = await deps.sendJmFile(conversation, job);
      if (!sent.ok) throw new Error(`downloaded ${job.name} but could not send it to QQ: ${sent.error}`);
      return {
        file_name: job.name,
        path: job.path,
        title: job.title,
        pages: job.pages,
        bytes: job.bytes,
        chapters: job.chapters,
        target_type: targetType,
        target_id: String(targetId),
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
 * 工具六：qq_memory —— 读/追加/覆盖记忆文件（`MEMORY.md` / `COGNITION.md` / `INDEX.md`）。
 *
 * 写路径被限制在 memoryDir 之内（`memoryRelativePath`），单个文件也有字节上限：
 * 记忆的价值在「精炼且总是被读到」，一个无限增长的文件只会把提示词撑爆。
 * 读不设上限（要翻就翻个够），只按 `memorySearchHits` 限制搜索命中数。
 * @param {object} deps - 见 `registerQqTools` 的说明。
 */
function qqMemory(deps) {
  const memory = deps.memory;
  return defineTool({
    name: 'qq_memory',
    description:
      'Read, append to, search, or overwrite a long-term memory file for the QQ bridge. All paths live under the memory directory and are relative to it, for example "conversations/group-100000001/MEMORY.md" (one conversation\'s memory, "write"/"append" create it if missing), "COGNITION.md" (shared knowledge about memes, slang, emoji and sticker meanings), or "INDEX.md" (the short index that is injected into every QQ agent\'s prompt — keep it to a handful of lines). Paths outside the memory directory are rejected.',
    parameters: {
      action: {
        type: 'string',
        enum: ['read', 'append', 'write', 'search', 'list'],
        description: 'read = full file (with line numbers); append = add text at the end (the normal way to record something new); write = replace the whole file (only when reorganising); search = substring match with context lines; list = the files that already exist.',
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
      if (typeof args.text !== 'string' || args.text.trim().length === 0) throw new Error(`qq_memory: "text" is required for action "${args.action}"`);
      return memory.writeFile(path, args.text, args.action === 'append');
    },
  });
}

/**
 * 注册全部适用的 QQ 工具。两个记忆工具只在长期记忆可用时注册
 * （`deps.memory` 为 undefined 时跳过）—— 停用的功能不该留下一个「一调就报错」的工具。
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
 * @param {(source: string) => string} deps.resolveStickerSource - 把表情包文件名解析成路径。
 * @param {boolean} deps.imageSend - `imageSend`，关掉时发图工具直接报错。
 * @param {number} deps.imageMaxBytes - 出站图片字节上限。
 * @param {() => object} deps.resolveRoute - 当前生效的模型路由（`qq_list_conversations` 回显）。
 * @param {Map<string, object>} deps.conversations - 已处理过的会话表。
 * @param {(key: string, generation: number) => string} deps.sessionIdFor - 会话 key + 轮次 → Session id。
 * @param {(options: object) => Promise<object>} deps.downloadJm - 下载并合并成 PDF。
 * @param {(conversation: object, job: object) => Promise<object>} deps.sendJmFile - 把 PDF 交给 QQ。
 * @param {object} [deps.memory] - 长期记忆的读写接口；缺失 = 不注册那两个工具。
 */
export function registerQqTools(ctx, deps) {
  ctx.tools.register(qqSendMessage(deps));
  ctx.tools.register(qqSendImage(deps));
  ctx.tools.register(qqListConversations(deps));
  ctx.tools.register(qqJmPdf(deps));
  if (deps.memory !== undefined) {
    ctx.tools.register(qqTranscript(deps));
    ctx.tools.register(qqMemory(deps));
  }
}
