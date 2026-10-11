#!/usr/bin/env python3
"""下载禁漫（JM / 18comic）本子并合并成一个 PDF。

这个脚本是插件 `scripts` 面上的一个「哑」工具：插件进程用 Python 把它拉起来，
通过 **stdout 上的 JSON Lines** 与它对话，其余输出（jmcomic 自己的日志）全部走
stderr，由插件转发进 journal。

协议（每行一个 JSON 对象）：

    {"event":"meta",   "kind":"album"|"chapter", "id":"…", "title":"…", …}
    {"event":"result", "ok":true,  "pdf":"/abs/path.pdf", "pages":N, …}
    {"event":"result", "ok":false, "error":"…"}

`meta` 先发（几秒内就知道这本叫什么、几话、多少页），插件可以立刻回一句
「开始下载《…》」；`result` 是最终结果，进程随后退出（成功 0 / 失败 1）。

为什么用现成的 jmcomic 而不是自己写 HTTP 客户端：禁漫的接口带 APP 版本协商
（版本落后会回 `Not legal.api`）、响应 AES 加密、按 id 分段打乱图片（scramble），
还要在 Cloudflare 后面换域名 —— 这些 jmcomic 都已经处理好了，且会自己更新域名表。

依赖（装在插件工作目录下的 venv 里，见 README）：

    python3 -m venv .venv && .venv/bin/pip install jmcomic img2pdf

@module qq-bridge/scripts/jm_download
"""
from __future__ import annotations

import argparse
import contextlib
import json
import os
import re
import shutil
import sys

# 文件名里不能出现的字符（Windows 与 POSIX 取并集，再加控制字符）。
UNSAFE_NAME = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
# 图片扩展名：只有这些能直接交给 img2pdf，其余先转成 JPEG。
JPEG_SUFFIXES = {'.jpg', '.jpeg'}
# 单张图的 Pillow 重编码质量（只用于 gif / png 这类 img2pdf 不认的格式）。
RECODE_QUALITY = 92


def emit(event: str, **fields) -> None:
    """往 stdout 写一行协议 JSON（立刻 flush，插件是流式读的）。"""
    print(json.dumps({'event': event, **fields}, ensure_ascii=False), flush=True)


def fail(message: str) -> 'NoReturn':  # type: ignore[name-defined]  # noqa: F821
    """报告失败并退出（调用方负责把异常转成一句人话）。"""
    emit('result', ok=False, error=message)
    sys.exit(1)


def short_error(error: BaseException) -> str:
    """把异常压成一行可读文本（去掉 jmcomic 日志里那种多行堆栈）。"""
    text = f'{type(error).__name__}: {error}' if str(error) else type(error).__name__
    return ' '.join(text.split())[:400]


def safe_name(raw: str, fallback: str) -> str:
    """把本子名清成安全的文件名（不含路径分隔符，长度可控）。"""
    name = UNSAFE_NAME.sub('_', str(raw or '')).strip().strip('.')
    name = re.sub(r'\s+', ' ', name)
    return (name[:80].strip() or fallback)


def natural_key(path: str):
    """按文件名里的数字排序：`9.jpg` 要排在 `10.jpg` 前面。"""
    return [int(part) if part.isdigit() else part for part in re.split(r'(\d+)', os.path.basename(path))]


def list_images(directory: str) -> list:
    """列出一个章节目录下的图片，按文件名里的数字自然排序。"""
    try:
        names = os.listdir(directory)
    except OSError:
        return []
    files = [os.path.join(directory, name) for name in names]
    files = [path for path in files if os.path.isfile(path) and not os.path.basename(path).startswith('.')]
    return sorted(files, key=natural_key)


def to_jpeg(path: str) -> str:
    """把 img2pdf 不认的格式（gif / webp / …）转成 JPEG，返回可用的路径。"""
    if os.path.splitext(path)[1].lower() in JPEG_SUFFIXES:
        return path
    from PIL import Image

    target = f'{os.path.splitext(path)[0]}.img2pdf.jpg'
    with Image.open(path) as image:
        # PDF 里没有调色板/透明度的位置：统一成 RGB 再存。
        image.convert('RGB').save(target, 'JPEG', quality=RECODE_QUALITY)
    return target


def build_pdf(paths: list, pdf_path: str) -> int:
    """把一批图片按给定顺序写成一个 PDF，返回页数。"""
    import img2pdf

    usable = []
    for path in paths:
        try:
            usable.append(to_jpeg(path))
        except Exception:  # 单张图坏了不该毁掉整本
            with contextlib.suppress(Exception):
                print(f'[jm] skip unreadable image: {path}', file=sys.stderr)
    if not usable:
        raise RuntimeError('没有可用的图片（下载全部失败？）')
    with open(pdf_path, 'wb') as handle:
        handle.write(img2pdf.convert(usable))
    return len(usable)


def build_option(jmcomic, work_dir: str, timeout: float):
    """组装 jmcomic 的下载选项：下载到 work_dir、解码打乱、统一转 JPEG、不走代理。"""
    return jmcomic.JmOption.construct({
        # 目录规则只用 Bd（工作目录）+ Pid（章节 id）：不依赖本子名，路径可预测。
        'dir_rule': {'base_dir': work_dir, 'rule': 'Bd_Pid'},
        'download': {
            # decode=true：把禁漫按 id 竖切打乱的图还原；suffix=.jpg：webp 等统一转 JPEG。
            'image': {'decode': True, 'suffix': '.jpg'},
            'threading': {'image': 8, 'photo': 4},
        },
        'client': {
            'impl': 'api',
            'postman': {'type': 'curl_cffi', 'meta_data': {'timeout': timeout, 'proxies': None}},
        },
    })


def probe(client, jm_id: str, kind: str):
    """确定这次要下「整本」还是「某一话」，并返回对应实体。

    `auto` 的判据是**本子 id 与章节 id 的关系**：禁漫里一个本子的 id 通常就是它
    第一话的 id，所以

      * `/chapter?id=X` 给出的 `album_id == X` → X 就是这本本子 → 整本（多话时）；
      * `album_id != X` → X 只是这本本子里的一话 → 只下这一话。

    这样「贴本子车号」和「贴某一话的车号 / 链接」都能得到符合直觉的结果。
    """
    if kind == 'album':
        return 'album', client.get_album_detail(jm_id)
    if kind == 'chapter':
        return 'chapter', client.get_photo_detail(jm_id, fetch_album=True)
    photo = client.get_photo_detail(jm_id, fetch_album=True)
    if str(getattr(photo, 'album_id', '')) != str(jm_id):
        return 'chapter', photo
    album = client.get_album_detail(photo.album_id)
    # 单话本子（series_id == 0）走章节路径也一样，但整本路径会顺带带上章节列表。
    if len(album) > 1:
        return 'album', album
    return 'chapter', photo


def entity_meta(kind: str, entity) -> dict:
    """把实体整理成给插件看的元信息（标题 / 话数 / 页数 / 作者）。"""
    if kind == 'album':
        chapters = len(entity)
        pages = int(getattr(entity, 'page_count', 0) or 0)
    else:
        chapters = 1
        pages = len(entity)
    return {
        'kind': kind,
        'id': str(entity.album_id if kind == 'album' else entity.photo_id),
        'title': str(getattr(entity, 'name', '') or ''),
        'author': str(getattr(entity, 'author', '') or ''),
        'chapters': chapters,
        'pages': pages,
        'scramble_id': str(getattr(entity, 'scramble_id', '') or ''),
    }


def collect_images(option, kind: str, entity) -> list:
    """按话的顺序收集落盘的图片路径（本子：逐话拼接；单话：那一话）。"""
    photos = list(entity) if kind == 'album' else [entity]
    paths = []
    for photo in photos:
        directory = option.decide_image_save_dir(photo)
        found = list_images(directory)
        if not found:
            print(f'[jm] no images for photo {getattr(photo, "photo_id", "?")} in {directory}', file=sys.stderr)
        paths.extend(found)
    return paths


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description='下载禁漫本子并合并成 PDF')
    parser.add_argument('--id', required=True, help='本子 id 或章节 id')
    parser.add_argument('--kind', default='auto', choices=['auto', 'album', 'chapter'])
    parser.add_argument('--work', required=True, help='图片下载目录（结束后删除）')
    parser.add_argument('--out', required=True, help='PDF 输出目录')
    parser.add_argument('--name', default='', help='PDF 文件名（不含扩展名）')
    parser.add_argument('--max-chapters', type=int, default=0, help='整本下载的话数上限；0 = 不限制')
    parser.add_argument('--max-pages', type=int, default=0, help='总页数上限；0 = 不限制')
    parser.add_argument('--timeout', type=float, default=30.0, help='单次 HTTP 请求超时（秒）')
    args = parser.parse_args(argv)

    try:
        import jmcomic
    except ImportError as error:
        fail(f'缺少 python 依赖 jmcomic（{error}）；请在插件工作目录执行：'
             'python3 -m venv .venv && .venv/bin/pip install jmcomic img2pdf')

    try:
        jm_id = str(args.id).strip()
        if not jm_id.isdigit():
            fail(f'不是合法的禁漫 id：{args.id}')
        os.makedirs(args.work, exist_ok=True)
        os.makedirs(args.out, exist_ok=True)
        option = build_option(jmcomic, args.work, args.timeout)
        client = option.new_jm_client()

        # 1) 探测：确定整本/单话，并立刻把标题发给插件（它先回一句「开始下载」）。
        kind, entity = probe(client, jm_id, args.kind)
        meta = entity_meta(kind, entity)
        emit('meta', **meta)

        # 2) 护栏：整本可能大得离谱（几百话），由插件配置决定放不放行。
        if args.max_chapters > 0 and meta['chapters'] > args.max_chapters:
            fail(f'这本有 {meta["chapters"]} 话，超过上限 {args.max_chapters}；'
                 f'请指定单话，或调大 jmMaxChapters')
        if args.max_pages > 0 and meta['pages'] > args.max_pages:
            fail(f'这本有 {meta["pages"]} 页，超过上限 {args.max_pages}；'
                 f'请指定单话，或调大 jmMaxPages')

        # 3) 下载。jmcomic 的日志全部改道 stderr：stdout 只留给协议 JSON。
        #    返回的是 `DownloadResult(detail, downloader)`，取出 detail 用于收集图片。
        with contextlib.redirect_stdout(sys.stderr):
            result = jmcomic.download_album(jm_id, option) if kind == 'album' else jmcomic.download_photo(jm_id, option)
        downloaded = getattr(result, 'detail', result)
        if downloaded is not None:
            entity = downloaded

        # 4) 合并 PDF（失败时 jmcomic 会抛 PartialDownloadFailedException，
        #    这里不拦：宁可明确报错，也不要悄悄给一个缺页的 PDF）。
        paths = collect_images(option, kind, entity)
        name = safe_name(args.name or meta['title'], f'jm{jm_id}')
        pdf_path = os.path.join(args.out, f'{name}.pdf')
        pages = build_pdf(paths, pdf_path)
        size = os.path.getsize(pdf_path)
        emit('result', ok=True, pdf=pdf_path, pages=pages, bytes=size,
             title=meta['title'], kind=kind, chapters=meta['chapters'])
        return 0
    except SystemExit:
        raise
    except BaseException as error:  # noqa: BLE001 —— 任何失败都要变成一行 JSON
        fail(short_error(error))
    finally:
        # 图片是中间产物：无论成败都清掉，只留下 PDF。
        shutil.rmtree(args.work, ignore_errors=True)
    return 1


if __name__ == '__main__':
    sys.exit(main())
