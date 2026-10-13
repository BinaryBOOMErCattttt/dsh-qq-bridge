/**
 * 测试用的图片 fixture（真编码的字节，不是随手拼的）。
 *
 * 为什么要真字节：复读判定「是不是同一张画面」只能靠真的解码器，而不同编码
 * （baseline / progressive JPEG、真彩 / 灰度 / 调色板 / 16bit / 带透明 PNG、GIF、动图）
 * 走的是不同的解码路径。这里只有两件事要成立：**同一张画面的任何两种编码指纹一致**、
 * 不同画面必须分得开。
 *
 * 图案是 128×128、8 像素一格的四档灰度马赛克（A 用种子 1，B 用种子 2；`caption` 是把 A
 * 最上面 5 行换成高对比的交替块，模拟「同一套画风只换了文字」）。生成方式（一次性，不在
 * 仓库里）：用 Pillow 画好三种图案，再分别 `save(format=...)` 出各种编码 ——
 * `quality=85`／`progressive=True`／双重 `quality=40 → 75` 重新编码／`convert('P')` 存 GIF、
 * 两张帧存动图／`convert('L')`、`convert('P')`、`convert('RGBA')` 存 PNG／
 * `I;16` 存 16bit PNG／`convert('CMYK')` 存 CMYK JPEG；换图案时重跑一遍、把新的 base64
 * 粘回来即可（`test/perceptual.test.mjs` 里的平面断言也要跟着改那三个灰度值）。
 */

/** 同一张画面 A：PNG（真彩，无透明） */
export const PIC_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAACoklEQVR4nO3dwW3CQBgF4ThyEZRAKZRBCZRCGZRAKZRBCTSw' +
  '7/Ck3xof5js6wTEZWdrFa7Pd7/e/lff7vdz+fD6X2x+Px3L75/NZbp+S/m46/nQ81+u1+v2k3c9/tXeNMwDMADADwAwAMwDM' +
  'ALD9drtVL0jj7jQ/SOPiKWl8nY6z1b7f9ng8A2AGgBkAZgCYAWAGgBkAtrcvSPOGtH3q+kGaT6T9pONJ+0nHmfbT/t203TMA' +
  'ZgCYAWAGgBkAZgCYAWDxekA7jk7a9TlJe5yt9v22x5P+D54BMAPADAAzAMwAMAPADADbvt/v8gftOvejP2dvpXF3O29Ix5/2' +
  'n3g94KQMADMAzAAwA8AMADMAbG/Hs0n7OXj7+2n+0R5/GtcnU8ef5kmeATADwAwAMwDMADADwAwAi/cHtJ/7T91vnKTxdbuf' +
  'dl3T0dc/PANgBoAZAGYAmAFgBoAZABbnAVPr4pP2Ptv2OaZT64KSdrzvPOCkDAAzAMwAMAPADAAzAGy7XC7VC9rxbzseb+cH' +
  '7XM92/lEOx9q1zV5BsAMADMAzAAwA8AMADMALD4vKI1n23H91Pi9Xf8z9bn/1P79/oCTMgDMADADwAwAMwDMALB4PWBqPD51' +
  'X277+X67PZn6XgSfG3pSBoAZAGYAmAFgBoAZALa33387Nf6deh5n+31k7fWMtC5o6n15BsAMADMAzAAwA8AMADMALF4PaNe9' +
  'TN0fcPR9A1Pzg3bek3gGwAwAMwDMADADwAwAMwBsbB7QOnr/raPvN/b+gJMyAMwAMAPADAAzAMwAsLH7A9rn7LfrkZKp6wFT' +
  'zwVq74fwDIAZAGYAmAFgBoAZAGYA2PZ6vZY/mFpXM3VfcbufpJ0HJO31jPS+PANgBoAZAGYAmAFgBoAZAPYDMWwaKLsy820A' +
  'AAAASUVORK5CYII=',
  'base64',
);

/** 同一张画面 A：baseline JPEG（另一份字节） */
export const PIC_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEY' +
  'Gh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4e' +
  'Hh4eHh4eHh4eHh4eHh7/wAARCACAAIADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAA' +
  'AgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6' +
  'Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG' +
  'x8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREA' +
  'AgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5' +
  'OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPE' +
  'xcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDjK8Mr7mrwygD3OvhmivuagD3OivymooA/' +
  'VmivymooA9zrwyv1Zr4ZoA+5q/Kav1Zr8pqAP1Zor4Zr7moA/Kav1Zor4ZoA9zrwyvuaigD4Zr7mr8pq/VmgDwyvhmvc6+5q' +
  'ACvymr9Wa+GaACvc6KKAPhmvuavhmv1ZoAK+Ga8Mr3OgD3Oivc68MoA9zr8pq+5q+GaAP1Zr8pq/VmvhmgD3Ovc6+Ga+5qAP' +
  'hmivDK/VmgD4ZrwyvuavDKACivuaigArwyivc6APDK9zrwyvhmgD7mr3OvDK+GaACvc6K9zoA8Mor3OvhmgAr7mrwyigDwyi' +
  'vuavDKAPDKK+5qKAPc6/Kav1ZrwygArwyvuaigD8pqK9zrwygD7mr3OvhmvuagDwyvc6K+GaACvc69zr4ZoA8Mr7mr4Zr9Wa' +
  'APhmvuavDK9zoA/Kavc68Mr7moA+Ga/VmvhmigDwyvuavc6+GaAPDKK+5q+GaAPuaivDK+5qAPhmvuavhmvuagDwyvDK8Mr9' +
  'WaAPymor7mr3OgD4Zr7mr8pq+5qAPDK8Mr9Wa8MoA+Ga9zrwyvc6ACvc68MooAK9zrwyvc6APc6+Ga9zooAK+Ga+5qKAPc68' +
  'Mor4ZoA/Vmvhmvc68MoA8Mor9Wa+GaAPDK+5qK+GaACv1ZorwygD4Zr9Wa/KaigD3Oivc6+GaAPuavhmiigD9Wa/Kav1Zr8p' +
  'qAPc68Mor3OgD3OivDK+5qAP/9k=',
  'base64',
);

/** 同一张画面 A：progressive JPEG（DC 精修那条路） */
export const PIC_JPEG_PROGRESSIVE = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEY' +
  'Gh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4e' +
  'Hh4eHh4eHh4eHh4eHh7/wgARCACAAIADASIAAhEBAxEB/8QAGAAAAwEBAAAAAAAAAAAAAAAAAAYHCAX/xAAUAQEAAAAAAAAA' +
  'AAAAAAAAAAAA/9oADAMBAAIQAxAAAAHio1zRR6hhcx5MphqwymDyjashhc8p6symasIZczKerCGD0i3MIZc8p6sEaGPNzDKe' +
  'rIYD0BDLnDNWBDEZ5HoeUYecp3OGGrMp6shg9PMMuZDBG1YQxGuaKBcwEYeRGeUaGFzeUaGA8j0Io9QwLmigjFzRRGLmDzlP' +
  'ViMCLcwymPKMXN5hlzEZ5IYD08wwRrnDNWEMuaM8mU3lGuZDNWQwEa5vMMEYucMLmItzIZc4ZcxGRUbVhlMubyQy55TuYio2' +
  'rEYhjyjPIPSKA9Ir0PMMegIZcweUYhhqyGPSKIxqyGCNcyGBqwRiGasymDyPUMLnDANWZT1ZlMeUYeR6EW5n/8QAFBABAAAA' +
  'AAAAAAAAAAAAAAAAgP/aAAgBAQABBQIAf//EABQRAQAAAAAAAAAAAAAAAAAAAGD/2gAIAQMBAT8BAf/EABQRAQAAAAAAAAAA' +
  'AAAAAAAAAGD/2gAIAQIBAT8BAf/EABQQAQAAAAAAAAAAAAAAAAAAAID/2gAIAQEABj8CAH//xAAUEAEAAAAAAAAAAAAAAAAA' +
  'AACA/9oACAEBAAE/IQB//9oADAMBAAIAAwAAABCQDDCyjxxzQyyATQiCxzSTyRBBjAwQChwhxywTRBwwAzxQTChSyjACDQwB' +
  'hDACiQz/xAAUEQEAAAAAAAAAAAAAAAAAAABg/9oACAEDAQE/EAH/xAAUEQEAAAAAAAAAAAAAAAAAAABg/9oACAECAQE/EAH/' +
  'xAAUEAEAAAAAAAAAAAAAAAAAAACA/9oACAEBAAE/EAB//9k=',
  'base64',
);

/** 同一张画面 A：两次重新编码的 JPEG（字节完全不同） */
export const PIC_JPEG_RECODE = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcp' +
  'LDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy' +
  'MjIyMjIyMjIyMjIyMjL/wAARCACAAIADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAA' +
  'AgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6' +
  'Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG' +
  'x8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREA' +
  'AgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5' +
  'OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPE' +
  'xcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDn682r6RrzegD0ivm6ivpGgD0miviWigD7' +
  'aor4looA9Jrzavtqvm6gD6Rr4lr7ar4loA+2qK+bq+kaAPiWvtqivm6gD0ivN6+kaKAPm6vpGviWvtqgDzavm6vSa+kaACvi' +
  'Wvtqvm6gAr0iiigD5ur6Rr5ur7aoAK+bq82r0mgD0iivSa82oA9Jr4lr6Rr5uoA+2q+Ja+2q+bqAPSK9Jr5ur6RoA+bqK82r' +
  '7aoA+bq82r6RrzegAor6RooAK82or0mgDzavSa82r5uoA+ka9Jrzavm6gAr0mivSKAPN6K9Ir5uoAK+ka83ooA82or6Rrzeg' +
  'DzaivpGigD0mviWvtqvNqACvN6+kaKAPiWivSa82oA+ka9Jr5ur6RoA82r0mivm6gAr0ivSa+bqAPNq+ka+bq+2qAPm6vpGv' +
  'Nq9JoA+Ja9JrzavpGgD5ur7ar5uooA82r6Rr0mvm6gDzaivpGvm6gD6RorzevpGgD5ur6Rr5ur6RoA82rzevNq+2qAPiWivp' +
  'GvSaAPm6vpGviWvpGgDzevNq+2q82oA+bq9JrzavSaACvSK83ooAK9IrzevSKAPSa+bq9IooAK+bq+kaKAPSa82or5uoA+2q' +
  '+bq9IrzegDzaivtqvm6gDzavpGivm6gAr7aorzagD5ur7ar4looA9Jor0ivm6gD6Rr5uoooA+2q+Ja+2q+JaAPSa82or0mgD' +
  '0iivN6+kaAP/2Q==',
  'base64',
);

/** 同一张画面 A：调色板 GIF */
export const PIC_GIF = Buffer.from(
  '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' +
  'meysFa5TjQEBADs=',
  'base64',
);

/** 同一张画面 A 打头、B 收尾的动图（只该看第一帧） */
export const PIC_GIF_ANIM = Buffer.from(
  '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' +
  'NBvAoIE27LZtbUmCKY7rCggAOw==',
  'base64',
);

/** 同一张画面 A：8bit 灰度 PNG */
export const PIC_GRAY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAAAAADmVT4XAAABpUlEQVR4nO2bwW3DMAxF5cJDdISMkjE6gkbRGB3Bo2SMjtBD' +
  '+A30AT8+Fczh/wsjmlIeCEimZHv7Gk8dZVfZWfYxXktx6q/4m+lP/8fF+P+uAAQgAPsdjll2lb2N19J8nuY6x2N8ewYCEIAA' +
  '7HTcYVfZWZb3e/nv8C/4GSfbnoEABCAAO+cl7/+s9yX2ozge4zVuewYCEIAAbD/1g/v2q/s6dSBOWrg+ENeegQAEIAA756fE' +
  '+zbbD7Slhbbrr3WmPQMBCEAAzvMB1gHu/FA6jJ/7iqv6oj0DAQhAAM51wO3jpQk/nzO6fcFAXM4JAxCAtwPYPuFYZd2+YJq2' +
  '+nF94PrCfUV7BgIQgADsnJ+c926+qz0Q5+Tqi/YMBCAAATjrgVV2ImCh7fYDtJJ7DyHPDQMQgLcB2Pl+30LbzfuBOD4/4PsD' +
  'bpz2DAQgAAE46wHW7e584OqcwK0HE36pPQMBCEAA7DpAXV2nZtlV1n3H1J6BAAQgAPZ8wH03qOuSqwfccwL9j9SegQAEIADb' +
  'd/2YZVnXz/FXy/glrgOSe9+4PQMBCEAAfgGaF165f2fs6wAAAABJRU5ErkJggg==',
  'base64',
);

/** 同一张画面 A：调色板 PNG */
export const PIC_PALETTE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAIAAAACAAgMAAAC+UIlYAAAADFBMVEXw8PCoqKhgYGAYGBiT2Q5gAAAA+ElEQVR4nOXWMW7F' +
  'MAwD0OciV5QOKR/SHaIftFM3w2i02dBAERTFUUIqw10lDMvAMnz5o/5HwzVR0uqPoei/oY4AuYMHmGZrYinTkqYyzSNAbmgY' +
  '3PoviXLrY1imFEeA3MPDMh4FQJhIwXv0cAWYwhSGQNLvdQTIPf5w7wCFUFg8GjkB5B4eltk8TCF7L8hX+eRyTxx9IUoKafWe' +
  'nAByT34IYTYDRatBa+QEkHv0cE9/e2MK0Zci1avuZvVGZOfKIZ4s9RoervW4Y/xiYih1CMg9e/HTDz71ccu3+cPobM18UnXI' +
  'Q0Du4CGU0fkpO1kPi07XJ4Dc0PANw/VnV0wQ0MkAAAAASUVORK5CYII=',
  'base64',
);

/** 同一张画面 A：RGBA PNG */
export const PIC_ALPHA_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAACyUlEQVR4nO3dUY3CQBhFYbqpCCQgBRmVgBRkIAEpyMDBroO5' +
  'Dzd/ms0532tDaclJk5kO7XYcx+9l4f1+rzZfns/ncvvj8Vhu/3w+y+3T0vGl80/Hf7vdqs8n7f5/qm/Xv2cAcAYAZwBwBgBn' +
  'AHAGALff7/dqB2kcneYJ0jh2Whonp/Nrtb9fe/xeAeAMAM4A4AwAzgDgDADOAOD2dgdpHiFtn15PkOYZ0v7T8af9p/NL+2+P' +
  'L233CgBnAHAGAGcAcAYAZwBwBgAX1wO04+CkXXeftOfXan+/9vjT7+sVAM4A4AwAzgDgDADOAOAMAG77fr/L5wO0/z8/+355' +
  'K42j23mEdP7p+xPXA2jJAOAMAM4A4AwAzgDgDABub8eZSXu/uv18mqdozz+N45Pp80/zMF4B4AwAzgDgDADOAOAMAM4A4OLz' +
  'Adr7/dPPIUzSOLndf/u/iLPXU3gFgDMAOAOAMwA4A4AzADgDgIvzANP/X0/a5+S17z2c/l9A0o7znQfQkgHAGQCcAcAZAJwB' +
  'wBkA3Ha9XpfPB0jacWo7zm7nCdr39rXzDO08S/u/CK8AcAYAZwBwBgBnAHAGAGcAcPF9AWmc2Y7jp8fp7br/6fv909+fzt8r' +
  'AJwBwBkAnAHAGQCcAcAZAFxcDzA9zp5+zl57P7/dnqRxfvv7+95ALRkAnAHAGQCcAcAZAJwBwO1p3fj0/fjpcXySjq9930Aa' +
  '56f/BUz/Pl4B4AwAzgDgDADOAOAMAM4A4OJ6gHZd+vTzAc5+fsD0PEE7j5J4BYAzADgDgDMAOAOAMwA4A4Abnwdonf39rbOf' +
  'Q+jzAbRkAHAGAGcAcAYAZwBwBgAX3xs4fb88rYs/+zmA7fkl088n8L2BWjIAOAOAMwA4A4AzADgDgNter9dyPcD0uvjp5wy2' +
  '+0/aeY6kXQ+Rfh+vAHAGAGcAcAYAZwBwBgBnAHB/0nghVH8tTaAAAAAASUVORK5CYII=',
  'base64',
);

/** 同一张画面 A：16bit 灰度 PNG */
export const PIC_16BIT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAIAAAACAEAAAAAC2xeJUAAACaklEQVR4nO2dwY3CMBREySpFUAKlUAYlUAplUAKlUAYl7Nlj' +
  'idEohyfhebewTvw0svQdx8lut9tp4PUajx+P8fh+H4/f79Mh9Hrav17/csn6d+3/vp/++zQAWoCmAdACNA2AFqDZr9fvDbRO' +
  '67xA62yK1mXtz+H83PWXHwENgBagaQC0AE0DoAVodtdA5wl6nK4X6LxB2+v1tb32p+3d9fR4+RHQAGgBmgZAC9A0AFqAZloP' +
  'cHVYcev4iuvP4fzc9dV3+RHQAGgBmgZAC9A0AFqAZvt8xh/c8/Sj9+cOrdNunqD96/lK1wOEBkAL0DQAWoCmAdACNLurm4q7' +
  'v3Z/13mF61/rvJL2r/OY5UdAA6AFaBoALUDTAGgBmml/gLv/T/cVKlqXXXv3XOLoesXyI6AB0AI0DYAWoGkAtADNNA9In7cr' +
  'bp+eey8xfS6guLrfeYDQAGgBmgZAC9A0AFqAZjufvzdwddXVbTcvcO/9uXmDm7e45xLLj4AGQAvQNABagKYB0AI00/sCWjdd' +
  'nU/runsOkN7/p+f3+wFCA6AFaBoALUDTAGgBmmk9IK3b6T4+d7/vjpX0ewZ9b1BoALQATQOgBWgaAC1As7vv7aV1NX2Pz313' +
  'yK1H6HOB1Gf5EdAAaAGaBkAL0DQAWoBmWg9w6+rp/oCj+wXSeYGbpyjLj4AGQAvQNABagKYB0AI08TzAcfR8x9F9hd0fIDQA' +
  'WoCmAdACNA2AFqCJ9wek//8v3ReY9pe+l6gsPwIaAC1A0wBoAZoGQAvQbM/n+EO6Lp/uI0y/M+zmAUr6HeLlR0ADoAVoGgAt' +
  'QNMAaAGafz5gvGkUmz//AAAAAElFTkSuQmCC',
  'base64',
);

/** 同一张画面 A：WebP（解码器故意不支持） */
export const PIC_WEBP = Buffer.from(
  'UklGRqwBAABXRUJQVlA4IKABAADQFgCdASqAAIAAPm0mi0WkIYQQIANiWkGcGbH+AP1y5xQ9+AfAF6q/z36AP4B+AF+HWA/g' +
  'H4AfrN/XPMB/APwA/QDoAP4B+AH63/zjb/9n/zQH4B/APwAE2AfwD8AP2A/P3v8AT5uItZKhTuwwmcj5vO02VjKXecc/ycHI' +
  'yov9bfN6Yvx1O8L/oUywqTRTzTRtM8JztVn6sg5BIDFbXzPcuxr3fmh7BX+gR46NWTq2z8/5pOOCIBKQIzXa67P+gAD+7V25' +
  'MCalhw/Ol96/X7z4gHi+vHxi9pZNLlcaYouQD4+pVxChEeQgxx+sU7UZzEbxhv+Rde3ZnvY3hf+GQkHLO+DbaDDJzkT4txyB' +
  'gWKyI4V2gI8KJydBuiwqSQ4CiYRP3frsty6UsJ+C8GK0OGNl7OXdjMjiIZ8qYfJ67Utqbn01FI4PFiWYk6dSGS0ilO/yoHUB' +
  '///+VfqZVwsFmp6AphGER7f//tWv5NpOdUwALGBjvBXq0JfY7OPTZ8e/UWnGlLDmKws/hGLVhJ2obQn7+A1++6cbaKhjHtYX' +
  '3AAAAA==',
  'base64',
);

/** 同一张画面 A：CMYK（4 分量）JPEG（故意不支持） */
export const PIC_CMYK_JPEG = Buffer.from(
  '/9j/7gAOQWRvYmUAZAAAAAAA/9sAQwAFAwQEBAMFBAQEBQUFBgcMCAcHBwcPCwsJDBEPEhIRDxERExYcFxMUGhURERghGBod' +
  'HR8fHxMXIiQiHiQcHh8e/8AAFAgAQABABEMRAE0RAFkRAEsRAP/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//E' +
  'ALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2' +
  'Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrC' +
  'w8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/aAA4EQwBNAFkASwAAPwDjPit8P9p01v7VzjzD/qP93/ar' +
  'jPit8P8AadNb+1c48w/6j/d/2q4z4rfD/adNb+1c48w/6j/d/wBqvsuhQfjhg7ToP9g89PtHn+Z/3ztx5fv19qFB+OGDtOg/' +
  '2Dz0+0ef5n/fO3Hl+/X2oUH44YO06D/YPPT7R5/mf987ceX79faiu6/4a/aMBD8PT8vy5Oq4zj/tlXdf8NftGAh+Hp+X5cnV' +
  'cZx/2yruv+Gv2jAQ/D0/L8uTquM4/wC2VFKf2v2JCN8PGTf8uTqnr/2ypT+1+xIRvh4yb/lydU9f+2VKf2v2JCN8PGTf8uTq' +
  'nr/2yorC+PfwhGjSaFIviAXP2hpWwLXG3BQ/3j61hfHv4QjRpNCkXxALn7Q0rYFrjbgof7x9awvj38IRo0mhSL4gFz9oaVsC' +
  '1xtwUP8AePrRW3+3yQw8DFCH2/a87ef+eFbf7fJDDwMUIfb9rzt5/wCeFbf7fJDDwMUIfb9rzt5/54UV7j8KvH//AAnMGoI+' +
  'lf2b9jSNQWn3794b/ZGMbf1r3H4VeP8A/hOYNQR9K/s37GkagtPv37w3+yMY2/rXuPwq8f8A/Ccwagj6V/Zv2NI1Baffv3hv' +
  '9kYxt/WivLPCugf8M4PdsLr/AISj/hIip4T7L9n8nPu+7Pm+2Md815Z4V0D/AIZwe7YXX/CUf8JEVPCfZfs/k5933Z832xjv' +
  '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',
  'base64',
);

/** 64×64 的 JPEG：1/8 缩略图撑不起 16×16 指纹 */
export const PIC_TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcp' +
  'LDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy' +
  'MjIyMjIyMjIyMjIyMjL/wAARCABAAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAA' +
  'AgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6' +
  'Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG' +
  'x8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREA' +
  'AgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5' +
  'OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPE' +
  'xcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDwmiiigAooooAKKKKACiiigAooooAKKKKA' +
  'CiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigD//2Q==',
  'base64',
);

/** 32×32 纯色 PNG：没有可辨认的画面 */
export const PIC_FLAT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAK0lEQVR4nO3NQQEAAATAQATRP4pYSvC7BdjldMdn9XoHAAAA' +
  'AAAAAAAAhy3gBQFE4naZuwAAAABJRU5ErkJggg==',
  'base64',
);

/** 另一种颜色的纯色 PNG（防止「纯色图互相算同一张」） */
export const FLAT_PNG_OTHER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAK0lEQVR4nO3NQQEAAATAQATRP4pYSvC7BdhlT8dn9XoHAAAA' +
  'AAAAAAAAhy3fWwFE4TGPmAAAAABJRU5ErkJggg==',
  'base64',
);

/** 另一张画面 B：PNG */
export const OTHER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAACnUlEQVR4nO3dwW3CQBgF4ThyEZRAKZRBCZRCGZRAKZRBCTSw' +
  '7/Ck3xof5jsSYpyMLK3tXbNdLpe/Cc/nc/n6+/1evn673artp+2020/72X5u2n56/+PxWL7+X+2NxhkAZgCYAWAGgBkAZgDY' +
  'ls4D0ni5Hf+24/00Xp7S7mf79yZpOx4BMAPADAAzAMwAMAPADADb7vf78gdT181babyczg/a/Wy3M3U/wPOAkzIAzAAwA8AM' +
  'ADMAzACw7fv9Ln9w9PX9qXH00dfr2/lI7fmERwDMADADwAwAMwDMADADwPbr9br8QRrPpvdPjaOT9j7B0esSkvT/+Xw+y9c9' +
  'AmAGgBkAZgCYAWAGgBkAFtcHJEfPF5qaX3S0qf+DRwDMADADwAwAMwDMADADwOL6gCSNZ9P17vb+Qfu5SRqnT60zSPvf3l/x' +
  'CIAZAGYAmAFgBoAZAGYA2N7O/5kaL7fj9GRqO+28o/T+dD7k/YCTMgDMADADwAwAMwDMALB96vp4u2526j5Bqx3vJ+06AM8D' +
  'TsoAMAPADAAzAMwAMAPA9qn5+FP3Fdrr7+3+TH3/VzsvyHXCJ2UAmAFgBoAZAGYAmAFg8bmh7XN4kqnnerbbT6a+DyCN69vP' +
  '9QiAGQBmAJgBYAaAGQBmANje/kI73z9J182TNO5uz1faeTvp9an1Ex4BMAPADAAzAMwAMAPADADbXq9X9Qtp3N0+Lyhpv4dr' +
  '6vlF7fX9pD0v8QiAGQBmAJgBYAaAGQBmABi2TrgdL7fbmbpen7TrBnxu6EkZAGYAmAFgBoAZAGYAWD0vKJl63ufU9wYnU+t7' +
  'p55r5BEAMwDMADADwAwAMwDMALD4PWLtOPfo532263unzkvaz23nQXkEwAwAMwDMADADwAwAMwDsB8KFEf1805/iAAAAAElF' +
  'TkSuQmCC',
  'base64',
);

/** 另一张画面 B：JPEG */
export const OTHER_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEY' +
  'Gh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4e' +
  'Hh4eHh4eHh4eHh4eHh7/wAARCACAAIADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAA' +
  'AgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6' +
  'Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG' +
  'x8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREA' +
  'AgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5' +
  'OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPE' +
  'xcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5Zoor7moA+Ga+5q9zrwygDwyvc69zooA8' +
  'MrwyiigDwyvc6KKAPuaivymr3OgD3Ovc68MrwygD3Ovhmvc69zoA8Mr7morwygD3OvDK9zooA8Morwyvc6APc6+GaK9zoA9z' +
  'oorwygDwyvuavDK9zoA8Mr3OvDK8MoA9zr3OivDKAPhmvuavhmigAr3Ovc6KAPhmivc6KAPDK+5q+GaKAPc68MoooA9zr3Ov' +
  'hmigD3OivDK+5qAPhmv1ZrwyvDKACivuavymoAK/VmvDK9zoA/Kavc6K+5qAPhmvDK9zrwygAr7mor4ZoAK+5q+Ga/VmgDwy' +
  'vc6+Ga+5qAPymr7mr3OvDKAPDK9zr4Zr3OgD3OivDK+5qACvymor7moA8Mrwyivc6APc6+Ga+5qKAPDKK+5q8MoA8Mrwyivc' +
  '6APuavhmvDK/VmgAr4Zr7mr4ZoA8Mor3OvuagD4Zrwyv1Zr8pqACiiv1ZoA+GaKK8MoAK9zr7mrwygD4Zr9Wa/KaigD9Wa8M' +
  'oooAKK+Ga+5qAPhmv1Zr8pq+5qAPhmivuavhmgD7mrwyivuagD8pq/VmvhmvDKACv1Zrwyvc6ACiivhmgArwyvuavc6APymr' +
  '7mrwyvc6APhmivuavc6APymr7mr3OigAr4Zr7mrwygD4Zor9Wa+GaAPuavymr3OvuagArwyivc6APDK9zr8pqKAP/9k=',
  'base64',
);

/** 画面 A 但换掉上面几行「文字」：复读判定必须把它和 A 分开 */
export const CAPTION_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAACU0lEQVR4nO3d0W3CQBQF0ThyES6BUijHpVCGS6AUykkDez+u' +
  '9MiQaM6nY0FgtNIu9sJ2fK3dw/Gn54+e/x2O65cYAGYAmAFgBoAZAGYA2P5X5sv/9XxHAMwAMAPADAAzAMwAMAPANq8HsOc7' +
  'AmAGgBkAZgCYAWAGgBkA5vUA+HxHAMwAMAPADAAzAMwAMAPAvB4An+8IgBkAZgCYAWAGgBkAZgDYdl3X8g/neS6Pv16v6vzk' +
  '8Xgsj99ut+p5n8/1zDsdT8+bpMe539cz+3R+en8cATADwAwAMwDMADADwAwA29Mf0rw7zdPTvDhp1w3t/DpJ/3/Svg9pnZHe' +
  'H0cAzAAwA8AMADMAzAAwA8DiOqCd70+tA9rP2dO8u/0cv9XO910HfCgDwAwAMwDMADADwAwA244j7RBYa+e/7Xy8XR+k89v1' +
  'QXufUvt603UFRwDMADADwAwAMwDMADADwPZ2PtvO66fm7+39P1Of+089vvsDPpQBYAaAGQBmAJgBYAaAxesBU/PxqX257ef7' +
  '7fEkzffb9yc9ryMAZgCYAWAGgBkAZgCYAWB7+/0/U/Pfdl6ftN9r1F7PSPcFTb0uRwDMADADwAwAMwDMADADwOL1gPa+l6n9' +
  'Ae/eNzC1PmjXPYkjAGYAmAFgBoAZAGYAmAFgY+uA1rsfv/Xu/cbuD/hQBoAZAGYAmAFgBoAZADa2P6D9nv2p3yObuh4w9b1A' +
  '7X4IRwDMADADwAwAMwDMADADwMZ+T3jqd76m9icn7Togaa9npNflCIAZAGYAmAFgBoAZAGYA2A8JYvErTlK0agAAAABJRU5E' +
  'rkJggg==',
  'base64',
);

/**
 * 一个**真的**隔行（Adam7）PNG 头。
 *
 * 只写了签名 + IHDR（interlace=1）+ 一段随便的 IDAT + IEND：插件按契约在 IHDR 处
 * 就放弃，不会去解压，所以这里不需要真的排好 Adam7 的扫描行。Pillow 不肯写隔行 PNG，
 * 但这条「不认识就不猜」的路径值得被钉住 —— 隔行 PNG 走字节相同的判定。
 */
export const PIC_INTERLACED_PNG = (() => {
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length, 0);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([head, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(128, 0);
  ihdr.writeUInt32BE(128, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[12] = 1; // interlace = Adam7
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])),
    chunk('IEND', Buffer.alloc(0)),
  ]);
})();
