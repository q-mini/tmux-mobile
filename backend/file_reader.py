"""Bounded, read-only filesystem worker; also streamed to the selected SSH host."""
import base64
import hashlib
import io
import json
import mimetypes
import os
from pathlib import Path
import posixpath
import re
import stat
import struct
import sys
import fcntl
import secrets
import shutil
import subprocess
import time
import zipfile
import zlib
import xml.etree.ElementTree as ET

PAGE = 150
SCAN_LIMIT = 20000
TEXT_LIMIT = 256 * 1024
MEDIA_LIMIT = 12 * 1024 * 1024
DOWNLOAD_LIMIT = 32 * 1024 * 1024
MEDIA = {'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'application/pdf'}


def office_preview(content, suffix):
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        entries = archive.infolist()
        if len(entries) > 5000 or sum(e.file_size for e in entries) > 64 * 1024 * 1024:
            raise ValueError('문서 내용이 너무 커서 미리보기할 수 없어요.')
        def xml(name):
            if archive.getinfo(name).file_size > 12 * 1024 * 1024:
                raise ValueError('문서의 한 부분이 너무 커서 미리보기할 수 없어요.')
            return ET.fromstring(archive.read(name))
        tag = lambda element: element.tag.rsplit('}', 1)[-1]
        text = lambda element: ''.join(n.text or '' for n in element.iter() if tag(n) == 't')
        if suffix in {'.xlsx', '.xlsm', '.xltx'}:
            ns = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
            names = archive.namelist()
            strings = [text(n) for n in xml('xl/sharedStrings.xml')] if 'xl/sharedStrings.xml' in names else []
            relationships = {n.attrib['Id']: n.attrib['Target'] for n in xml('xl/_rels/workbook.xml.rels')}
            sheets = []
            for sheet in xml('xl/workbook.xml').findall('s:sheets/s:sheet', ns)[:30]:
                identifier = sheet.attrib.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')
                name = relationships.get(identifier, '')
                name = name.lstrip('/') if name.startswith('/') else 'xl/' + name
                root = xml(name)
                rows, row_numbers, max_col = [], [], 0
                source = root.findall('s:sheetData/s:row', ns)
                for row in source[:1000]:
                    cells = []
                    for cell in row.findall('s:c', ns):
                        reference = cell.attrib.get('r', 'A1'); column = 0
                        for letter in reference:
                            if not letter.isalpha():break
                            column = column * 26 + ord(letter.upper()) - 64
                        if not 1 <= column <= 64:continue
                        while len(cells) < column:cells.append('')
                        value = cell.find('s:v', ns); formula = cell.find('s:f', ns)
                        value = value.text if value is not None else None
                        if cell.attrib.get('t') == 's':value = strings[int(value)] if value is not None and int(value) < len(strings) else ''
                        elif cell.attrib.get('t') == 'inlineStr':value = text(cell)
                        elif value is None and formula is not None:value = '=' + (formula.text or '')
                        cells[column-1] = value or ''
                    max_col = max(max_col, len(cells));rows.append(cells);row_numbers.append(row.attrib.get('r', str(len(rows))))
                sheets.append({'name': sheet.attrib.get('name', 'Sheet'), 'rows': rows, 'row_numbers': row_numbers,
                               'columns': max_col, 'truncated': len(source) > 1000})
            return {'sheets': sheets}
        if suffix == '.docx':
            root = xml('word/document.xml')
            body = next(n for n in root if tag(n) == 'body')
            blocks = []
            for item in body:
                if tag(item) == 'p':blocks.append({'text': text(item)})
                elif tag(item) == 'tbl':
                    blocks.append({'rows': [[text(cell) for cell in row if tag(cell) == 'tc'] for row in item if tag(row) == 'tr']})
            return {'blocks': blocks[:5000], 'truncated_document': len(blocks) > 5000}
        if suffix == '.pptx':return slides_preview(archive, xml)
        sections = sorted(name for name in archive.namelist() if name.startswith('Contents/section') and name.endswith('.xml'))
        blocks = []
        for name in sections:
            root = xml(name)
            # Text paragraphs retain Korean text; table rows remain separate cells.
            def visit(node):
                kind = tag(node)
                if kind == 'tbl':
                    blocks.append({'rows': [[text(c) for c in row if tag(c) == 'tc'] for row in node if tag(row) == 'tr']})
                elif kind == 'p' and not any(tag(n) == 'tbl' for n in node.iter()):blocks.append({'text': text(node)})
                else:
                    for child in node:visit(child)
            visit(root)
        return {'blocks': blocks[:5000], 'truncated_document': len(blocks) > 5000}


P = '{http://schemas.openxmlformats.org/presentationml/2006/main}'
A = '{http://schemas.openxmlformats.org/drawingml/2006/main}'
R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
SLIDE_IMAGES = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
                '.bmp': 'image/bmp', '.webp': 'image/webp', '.svg': 'image/svg+xml'}


def slides_preview(archive, xml):
    """Lay out PowerPoint slides as positioned text, images, tables and lines."""
    names, parts, links = set(archive.namelist()), {}, {}
    def part(name):
        if name not in parts:parts[name] = xml(name) if name in names else None
        return parts[name]
    def relations(name):
        if name not in links:
            folder, base = posixpath.split(name); path = posixpath.join(folder, '_rels', base + '.rels'); links[name] = {}
            for item in (part(path) if path in names else []):
                target = item.get('Target', '')
                if item.get('TargetMode') == 'External' or not target:continue
                target = target[1:] if target.startswith('/') else posixpath.normpath(posixpath.join(folder, target))
                links[name][item.get('Id')] = (target, item.get('Type', '').rsplit('/', 1)[-1])
        return links[name]
    related = lambda name, kind: next((t for t, k in relations(name).values() if k == kind), None)
    number = lambda value, default=0: int(value) if value and re.fullmatch(r'-?\d+', value) else default
    presentation = part('ppt/presentation.xml'); size = presentation.find(P+'sldSz')
    width, height = (number(size.get('cx'), 12192000), number(size.get('cy'), 6858000)) if size is not None else (12192000, 6858000)
    scheme = {}
    def color(node):
        for child in (node if node is not None else []):
            kind = child.tag.rsplit('}', 1)[-1]
            value = child.get('val') if kind == 'srgbClr' else child.get('lastClr') if kind == 'sysClr' else \
                scheme.get({'tx1': 'dk1', 'bg1': 'lt1', 'tx2': 'dk2', 'bg2': 'lt2'}.get(child.get('val'), child.get('val'))) if kind == 'schemeClr' else None
            if not value or not re.fullmatch(r'[0-9A-Fa-f]{6}', value):continue
            modify, offset = child.find(A+'lumMod'), child.find(A+'lumOff')
            if modify is not None or offset is not None:
                import colorsys
                hue, light, saturation = colorsys.rgb_to_hls(*(int(value[i:i+2], 16) / 255 for i in (0, 2, 4)))
                light = min(1, max(0, light * number(modify.get('val') if modify is not None else '', 100000) / 100000 + number(offset.get('val') if offset is not None else '') / 100000))
                value = ''.join('%02X' % round(c * 255) for c in colorsys.hls_to_rgb(hue, light, saturation))
            return '#' + value.upper()
        return None
    def fill(properties, style, reference='fillRef'):
        for child in (properties if properties is not None else []):
            kind = child.tag.rsplit('}', 1)[-1]
            if kind == 'noFill':return None
            if kind == 'solidFill':return color(child)
            if kind == 'gradFill':return color(child.find(A+'gsLst/'+A+'gs'))
        node = style.find(P+reference) if style is not None else None
        return color(node) if node is not None and number(node.get('idx')) > 0 else None
    def placeholder(shape):
        node = shape.find('./*/'+P+'nvPr/'+P+'ph')
        return None if node is None else (node.get('idx'), node.get('type', 'body' if node.get('idx') else 'obj'))
    def inherited(key, sources):
        found, normal = [], lambda kind: {'ctrTitle': 'title', 'subTitle': 'body', 'obj': 'body'}.get(kind, kind)
        for name in sources:
            tree = part(name)
            for shape in (tree.iter(P+'sp') if tree is not None else []):
                other = placeholder(shape)
                if other and ((key[0] and other[0] == key[0]) or normal(other[1]) == normal(key[1])):found.append(shape);break
        return found
    def styles(level, sources, read):
        for source in sources:
            node = source.find(A+'lvl%dpPr' % level) if source is not None else None
            value = read(node) if node is not None else None
            if value is not None:return value
        return None
    def bullet(node):
        if node.find(A+'buNone') is not None:return ''
        if node.find(A+'buAutoNum') is not None:return '#'
        character, typeface = node.find(A+'buChar'), node.find(A+'buFont')
        if character is None:return None
        value = character.get('char', '•')
        if typeface is not None and typeface.get('typeface', '').lower().startswith('wingdings'):
            # Symbol-font bullets have no Unicode meaning; use the glyphs they draw.
            value = {'§': '▪', 'Ø': '➢', 'ü': '✓', 'l': '●', 'n': '■', 'q': '❑', 'v': '❖', 'ð': '⇨', 'à': '→', 'Ü': '➔'}.get(value, '•')
        return value
    def shapes(tree):
        for shape in tree:
            if shape.tag.endswith('}AlternateContent'):
                # Equations and newer objects keep a picture of themselves as the fallback.
                fallback = next((n for n in shape if n.tag.endswith('}Fallback')), None)
                for child in (shapes(fallback) if fallback is not None else []):yield child
            else:yield shape
    def picture(item, blip, source, media):
        target = relations(source).get(blip.get(R+'embed')) if blip is not None else None
        path = target[0] if target else ''; mime = SLIDE_IMAGES.get(posixpath.splitext(path)[1].lower())
        if mime and path in names and (path in media or sum(len(v['data']) for v in media.values()) < 16 * 1024 * 1024):
            media.setdefault(path, {'type': mime, 'data': base64.b64encode(archive.read(path)).decode()})
            return dict(item, kind='image', media=path)
        return dict(item, kind='missing', label=posixpath.splitext(path)[1].lstrip('.').upper() or 'Image')
    def outline(properties):
        custom = properties.find(A+'custGeom') if properties is not None else None
        commands = []
        for path in (custom.iter(A+'path') if custom is not None else []):
            w, h = max(1, number(path.get('w'), 1)), max(1, number(path.get('h'), 1))
            for step in path:
                name = step.tag.rsplit('}', 1)[-1]
                points = ['%g,%g' % (round(number(n.get('x')) * 1000 / w, 1), round(number(n.get('y')) * 1000 / h, 1)) for n in step.iter(A+'pt')]
                letter = {'moveTo': 'M', 'lnTo': 'L', 'cubicBezTo': 'C', 'quadBezTo': 'Q'}.get(name)
                if letter and points:commands.append(letter + ' '.join(points))
                elif name == 'close':commands.append('Z')
        return ' '.join(commands)[:20000] or None
    def walk(tree, source, transform, items, media, inherit, placeholders=True, slide_number=1):
        for shape in shapes(tree):
            kind = shape.tag.rsplit('}', 1)[-1]
            if kind not in {'sp', 'pic', 'grpSp', 'graphicFrame', 'cxnSp'} or len(items) >= 500:continue
            key = placeholder(shape)
            if key and not placeholders:continue
            chain = inherit(key) if key else []
            properties = shape.find(P+('grpSpPr' if kind == 'grpSp' else 'spPr'))
            frame = shape.find(P+'xfrm') if kind == 'graphicFrame' else properties.find(A+'xfrm') if properties is not None else None
            for other in chain:
                if frame is None:frame = other.find(P+'spPr/'+A+'xfrm')
            if frame is None or frame.find(A+'off') is None or frame.find(A+'ext') is None:continue
            ox, oy, sx, sy = transform
            off, ext = frame.find(A+'off'), frame.find(A+'ext')
            x, y, w, h = number(off.get('x')), number(off.get('y')), number(ext.get('cx')), number(ext.get('cy'))
            if kind == 'grpSp':
                child_off, child_ext = frame.find(A+'chOff'), frame.find(A+'chExt')
                cx, cy = (number(child_off.get('x')), number(child_off.get('y'))) if child_off is not None else (x, y)
                kx, ky = ((w / number(child_ext.get('cx'), w or 1) if number(child_ext.get('cx')) else 1), (h / number(child_ext.get('cy'), h or 1) if number(child_ext.get('cy')) else 1)) if child_ext is not None else (1, 1)
                walk(shape, source, (ox + sx * (x - cx * kx), oy + sy * (y - cy * ky), sx * kx, sy * ky), items, media, inherit, placeholders, slide_number)
                continue
            item = {'x': round((ox + sx * x) / width, 5), 'y': round((oy + sy * y) / height, 5),
                    'w': round(sx * w / width, 5), 'h': round(sy * h / height, 5), 'rotate': number(frame.get('rot')) / 60000}
            style = shape.find(P+'style')
            geometry = properties.find(A+'prstGeom') if properties is not None else None
            line = properties.find(A+'ln') if properties is not None else None
            stroke = None if line is not None and line.find(A+'noFill') is not None else fill(line, style, 'lnRef')
            dash = line is not None and line.find(A+'prstDash') is not None and line.find(A+'prstDash').get('val', 'solid') != 'solid'
            prst = geometry.get('prst', '') if geometry is not None else ''
            if kind == 'cxnSp' or prst in {'line', 'straightConnector1'}:
                items.append(dict(item, kind='line', color=stroke or '#000000', width=max(.5, number(line.get('w') if line is not None else '', 9525) / 12700),
                                  dash=dash, route='elbow' if prst.startswith('bentConnector') else 'curve' if prst.startswith('curvedConnector') else 'straight',
                                  flip_x=frame.get('flipH') == '1', flip_y=frame.get('flipV') == '1'));continue
            if kind == 'pic':items.append(picture(item, shape.find('.//'+A+'blip'), source, media));continue
            if properties is not None and properties.find(A+'blipFill/'+A+'blip') is not None:
                items.append(picture(item, properties.find(A+'blipFill/'+A+'blip'), source, media))
            if kind == 'graphicFrame':
                table = shape.find('.//'+A+'tbl')
                if table is None:
                    content = shape.find('.//'+A+'graphicData'); uri = content.get('uri', '') if content is not None else ''
                    items.append(dict(item, kind='missing', label='Chart' if 'chart' in uri else 'Diagram' if 'diagram' in uri else 'Object'));continue
                rows, merges, size = [], [], None
                for r, row in enumerate(table.findall(A+'tr')):
                    cells = []
                    for c, cell in enumerate(row.findall(A+'tc')):
                        covered = cell.get('hMerge') == '1' or cell.get('vMerge') == '1'
                        cells.append('' if covered else '\n'.join(''.join(n.text or '' for n in p.iter(A+'t')) for p in cell.iter(A+'p')))
                        if number(cell.get('gridSpan'), 1) > 1 or number(cell.get('rowSpan'), 1) > 1:merges.append([r, c, number(cell.get('rowSpan'), 1), number(cell.get('gridSpan'), 1)])
                        run = cell.find('.//'+A+'rPr[@sz]')
                        if size is None and run is not None:size = number(run.get('sz')) / 100
                    rows.append(cells)
                items.append(dict(item, kind='table', rows=rows, merges=merges, size=size or 12));continue
            body = shape.find(P+'txBody')
            text_style = 'title' if key and key[1] in {'title', 'ctrTitle'} else 'body' if key and key[1] in {'body', 'obj', 'subTitle'} else 'other'
            sources = [body.find(A+'lstStyle') if body is not None else None] + [s.find(P+'txBody/'+A+'lstStyle') for s in chain] + [inherit(None, text_style)]
            settings = [body.find(A+'bodyPr') if body is not None else None] + [s.find(P+'txBody/'+A+'bodyPr') for s in chain]
            setting = lambda name, default: next((s.get(name) for s in settings if s is not None and s.get(name) is not None), default)
            autofit = body.find(A+'bodyPr/'+A+'normAutofit') if body is not None else None
            scale = number(autofit.get('fontScale') if autofit is not None else '', 100000) / 100000
            font = style.find(P+'fontRef') if style is not None else None
            paragraphs, counters = [], {}
            for paragraph in (body.findall(A+'p') if body is not None else []):
                settings_node = paragraph.find(A+'pPr'); level = number(settings_node.get('lvl') if settings_node is not None else '') + 1
                def read(getter, node=settings_node, level=level):
                    value = getter(node) if node is not None else None
                    return value if value is not None else styles(level, sources, getter)
                defaults = lambda n: n.find(A+'defRPr')
                base_size = read(lambda n: number(defaults(n).get('sz')) / 100 if defaults(n) is not None and defaults(n).get('sz') else None) or (44 if text_style == 'title' else 18)
                base_color = read(lambda n: color(defaults(n).find(A+'solidFill')) if defaults(n) is not None else None) or (color(font) if font is not None else None)
                base_bold = read(lambda n: defaults(n).get('b') == '1' if defaults(n) is not None and defaults(n).get('b') else None)
                mark = read(bullet) or ''
                if mark == '#':counters[level] = counters.get(level, 0) + 1;mark = str(counters[level]) + '.'
                else:counters.pop(level, None)
                runs = []
                for run in paragraph:
                    run_kind = run.tag.rsplit('}', 1)[-1]
                    if run_kind == 'br':runs.append({'text': '\n', 'size': round(base_size * scale, 2)});continue
                    if run_kind not in {'r', 'fld'}:continue
                    value = ''.join(n.text or '' for n in run.iter(A+'t'))
                    if run_kind == 'fld' and run.get('type') == 'slidenum':value = str(slide_number)
                    options = run.find(A+'rPr'); options = options if options is not None else ET.Element('rPr')
                    runs.append({'text': value, 'size': round((number(options.get('sz')) / 100 or base_size) * scale, 2),
                                 'bold': options.get('b') == '1' if options.get('b') else bool(base_bold), 'italic': options.get('i') == '1',
                                 'underline': options.get('u', 'none') != 'none', 'color': color(options.find(A+'solidFill')) or base_color})
                align = read(lambda n: n.get('algn'))
                paragraphs.append({'runs': runs, 'level': level - 1, 'align': {'ctr': 'center', 'r': 'right', 'just': 'justify'}.get(align, 'left'),
                                   'bullet': mark if any(r['text'].strip() for r in runs) else '', 'size': round(base_size * scale, 2)})
            background = fill(properties, style)
            if not any(r['text'].strip() for p in paragraphs for r in p['runs']) and not background and not stroke:continue
            inset = lambda name, default: round(number(setting(name, ''), default) / width, 5)
            items.append(dict(item, kind='text', paragraphs=paragraphs, fill=background, line=stroke, dash=dash, path=outline(properties),
                              shape={'ellipse': 'ellipse', 'roundRect': 'round'}.get(prst, 'rect'),
                              anchor={'ctr': 'center', 'b': 'end'}.get(setting('anchor', 't'), 'start'),
                              inset=[inset('tIns', 45720), inset('rIns', 91440), inset('bIns', 45720), inset('lIns', 91440)]))
    slides, media = [], {}
    first_master = related('ppt/presentation.xml', 'slideMaster')
    theme = part(related(first_master, 'theme')) if first_master and related(first_master, 'theme') else None
    for node in (theme.find('.//'+A+'clrScheme') if theme is not None and theme.find('.//'+A+'clrScheme') is not None else []):
        value = node.find(A+'srgbClr'); system = node.find(A+'sysClr')
        scheme[node.tag.rsplit('}', 1)[-1]] = value.get('val') if value is not None else system.get('lastClr') if system is not None else None
    references = presentation.findall(P+'sldIdLst/'+P+'sldId')
    for index, reference in enumerate(references[:300]):
        name = relations('ppt/presentation.xml').get(reference.get(R+'id'), (None,))[0]
        slide = part(name) if name else None
        if slide is None:continue
        layout = related(name, 'slideLayout'); master = related(layout, 'slideMaster') if layout else None
        def inherit(key, text_style=None, layout=layout, master=master):
            if text_style:
                styles_node = part(master).find(P+'txStyles') if master and part(master) is not None else None
                return styles_node.find(P+text_style+'Style') if styles_node is not None else None
            return inherited(key, [n for n in (layout, master) if n])
        items, background = [], None
        for owner in (name, layout, master):
            root = part(owner) if owner else None
            node = root.find(P+'cSld/'+P+'bg') if root is not None else None
            if node is not None:
                background = fill(node.find(P+'bgPr'), None) or color(node.find(P+'bgRef'))
                if background:break
        for owner in (master, layout):
            root = part(owner) if owner else None
            tree = root.find(P+'cSld/'+P+'spTree') if root is not None else None
            if tree is not None and slide.get('showMasterSp') != '0' and (owner != master or not layout or part(layout).get('showMasterSp') != '0'):
                walk(tree, owner, (0, 0, 1, 1), items, media, inherit, placeholders=False, slide_number=index + 1)
        walk(slide.find(P+'cSld/'+P+'spTree'), name, (0, 0, 1, 1), items, media, inherit, slide_number=index + 1)
        slides.append({'items': items, 'background': background or '#' + (scheme.get('lt1') or 'FFFFFF').upper(), 'hidden': slide.get('show') == '0'})
    return {'slides': slides, 'width': width, 'height': height, 'images': media, 'text_color': '#' + (scheme.get('dk1') or '000000').upper(),
            'truncated_document': len(references) > 300}


def compound_streams(content):
    """Read named streams from an OLE compound file, the container of .hwp documents."""
    if content[:8] != b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1':raise ValueError('한글 문서 형식을 읽을 수 없어요.')
    sector, small = 1 << struct.unpack_from('<H', content, 30)[0], 1 << struct.unpack_from('<H', content, 32)[0]
    fat_sectors, directory_start = struct.unpack_from('<II', content, 44)
    cutoff, minifat_start, minifat_sectors, difat_start, difat_sectors = struct.unpack_from('<IIIII', content, 56)
    if sector not in {512, 4096} or small != 64:raise ValueError('한글 문서 형식을 읽을 수 없어요.')
    def at(index):
        start = (index + 1) * sector
        if start + sector > len(content):raise ValueError('한글 문서 일부가 손상되었어요.')
        return content[start:start + sector]
    difat = list(struct.unpack_from('<109I', content, 76))
    for _ in range(min(difat_sectors, len(content) // sector)):
        values = struct.unpack('<%dI' % (sector // 4), at(difat_start));difat.extend(values[:-1]);difat_start = values[-1]
    fat = []
    for index in difat[:fat_sectors]:fat.extend(struct.unpack('<%dI' % (sector // 4), at(index)))
    def chain(start, table):
        result = []
        while start < 0xFFFFFFFA:
            if start >= len(table) or len(result) > len(table):raise ValueError('한글 문서 일부가 손상되었어요.')
            result.append(start);start = table[start]
        return result
    read = lambda start: b''.join(at(index) for index in chain(start, fat))
    directory, entries = read(directory_start), []
    for offset in range(0, len(directory) - 127, 128):
        length = struct.unpack_from('<H', directory, offset + 64)[0]
        entries.append((directory[offset:offset + max(0, min(64, length) - 2)].decode('utf-16-le', 'replace'), directory[offset + 66])
                       + struct.unpack_from('<III', directory, offset + 68) + struct.unpack_from('<II', directory, offset + 116))
    if not entries:raise ValueError('한글 문서 형식을 읽을 수 없어요.')
    mini_stream = read(entries[0][5])[:entries[0][6]] if entries[0][5] < 0xFFFFFFFA else b''
    minifat = []
    if minifat_sectors:
        data = read(minifat_start);minifat = list(struct.unpack('<%dI' % (len(data) // 4), data))
    paths, pending, seen = {}, [(entries[0][4], '')], set()
    while pending:
        index, prefix = pending.pop()
        if index >= len(entries) or index in seen:continue
        seen.add(index);name, kind, left, right, child, start, size = entries[index]
        pending += [(left, prefix), (right, prefix)]
        if kind == 1:pending.append((child, prefix + name + '/'))
        elif kind == 2:paths[prefix + name] = (start, size)
    def stream(name):
        start, size = paths[name]
        if size < cutoff:return b''.join(mini_stream[i * small:(i + 1) * small] for i in chain(start, minifat))[:size]
        return read(start)[:size]
    return stream


def hwp_text(data):
    units, text, index = struct.unpack('<%dH' % (len(data) // 2), data[:len(data) // 2 * 2]), [], 0
    while index < len(units):
        code = units[index]
        if code >= 32:text.append(code);index += 1
        elif code in {0, 10, 13, 24, 25, 26, 27, 28, 29, 30, 31}:
            # One-unit controls: line break, paragraph end, hyphen and fixed spaces.
            text.extend({10: [10], 24: [45], 30: [32], 31: [32]}.get(code, []));index += 1
        else:
            # Inline and extended controls (tables, pictures, fields) occupy eight units.
            if code == 9:text.append(9)
            index += 8
    return struct.pack('<%dH' % len(text), *text).decode('utf-16-le', 'replace')


def hwp_preview(content):
    stream = compound_streams(content)
    try:header = stream('FileHeader')
    except KeyError:raise ValueError('한글 문서 형식을 읽을 수 없어요.')
    if not header.startswith(b'HWP Document File') or len(header) < 40:raise ValueError('한글 문서 형식을 읽을 수 없어요.')
    flags = struct.unpack_from('<I', header, 36)[0]
    if flags & 2:raise ValueError('암호가 걸린 한글 문서는 미리보기할 수 없어요.')
    if flags & 4:raise ValueError('배포용 한글 문서는 미리보기할 수 없어요. 원본을 다운로드해 확인해 주세요.')
    blocks, tables, budget = [], [], 64 * 1024 * 1024
    def close(table):
        grid = [[''] * table['cols'] for _ in range(table['rows'])]; merges = []
        for (row, column, rows, columns), lines in table['cells'].items():
            if row < table['rows'] and column < table['cols']:
                grid[row][column] = '\n'.join(lines)
                if rows > 1 or columns > 1:merges.append([row, column, rows, columns])
        parent = tables[-1] if tables else None
        caption = [line for line in table['caption'] if line.strip()]
        if parent and parent['cell'] is not None:parent['cell'].extend([' | '.join(v for v in row if v) for row in grid] + caption)
        else:blocks.extend([{'rows': grid, 'merges': merges}] + [{'text': line} for line in caption])
    for number in range(256):
        try:data = stream('BodyText/Section%d' % number)
        except KeyError:break
        if flags & 1:
            inflater = zlib.decompressobj(-15);data = inflater.decompress(data, budget)
            if inflater.unconsumed_tail:raise ValueError('문서 내용이 너무 커서 미리보기할 수 없어요.')
        budget -= len(data);offset = 0
        while offset + 4 <= len(data) and len(blocks) <= 5000:
            value = struct.unpack_from('<I', data, offset)[0];offset += 4
            tag, level, size = value & 0x3FF, (value >> 10) & 0x3FF, value >> 20
            if size == 0xFFF:size = struct.unpack_from('<I', data, offset)[0];offset += 4
            body = data[offset:offset + size];offset += size
            while tables and level <= tables[-1]['level']:close(tables.pop())
            table = tables[-1] if tables else None
            if tag == 71 and body[:4] == b' lbt':
                tables.append({'level': level, 'rows': 0, 'cols': 0, 'cells': {}, 'cell': None, 'caption': []})
            elif table and tag == 77 and level == table['level'] + 1 and len(body) >= 8:
                table['rows'], table['cols'] = struct.unpack_from('<HH', body, 4)
                table['rows'], table['cols'] = min(table['rows'], 1000), min(table['cols'], 256);table['cell'] = None
            elif table and tag == 72 and level == table['level'] + 1 and not table['rows']:
                # A list before the table record is its caption.
                table['cell'] = table['caption']
            elif table and tag == 72 and level == table['level'] + 1 and len(body) >= 16:
                column, row, columns, rows = struct.unpack_from('<HHHH', body, 8)
                table['cell'] = table['cells'].setdefault((row, column, rows, columns), [])
            elif tag == 66:
                if table and table['cell'] is not None:table['cell'].append('')
                elif not table:blocks.append({'text': ''})
            elif tag == 67:
                if table and table['cell'] is not None:
                    if table['cell']:table['cell'][-1] = hwp_text(body)
                elif not table and blocks and 'text' in blocks[-1]:blocks[-1]['text'] = hwp_text(body)
                elif not table:blocks.append({'text': hwp_text(body)})
        while tables:close(tables.pop())
    return {'blocks': blocks[:5000], 'truncated_document': len(blocks) > 5000}


def directory_archive(target):
    buffer = io.BytesIO(); total = count = 0
    with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_STORED) as archive:
        for root, directories, names in os.walk(target, followlinks=False):
            directories[:] = [name for name in directories if not (Path(root)/name).is_symlink()]
            count += len(directories) + len(names)
            if count > 5000:raise ValueError('폴더 다운로드는 항목 5,000개까지 지원해요.')
            relative = Path(root).relative_to(target.parent)
            archive.writestr(str(relative) + '/', b'')
            for name in names:
                file = Path(root)/name
                if file.is_symlink() or not file.is_file():continue
                descriptor=os.open(file,os.O_RDONLY|os.O_NONBLOCK|getattr(os,'O_NOFOLLOW',0))
                with os.fdopen(descriptor,'rb') as stream:
                    info=os.fstat(stream.fileno())
                    if not stat.S_ISREG(info.st_mode):raise ValueError('일반 파일만 다운로드할 수 있어요.')
                    if total+info.st_size>DOWNLOAD_LIMIT:raise ValueError('폴더 다운로드는 원본 합계 32 MB까지 지원해요.')
                    data=stream.read(DOWNLOAD_LIMIT-total+1)
                total+=len(data)
                if len(data) + buffer.tell() > DOWNLOAD_LIMIT:raise ValueError('폴더가 너무 커서 다운로드할 수 없어요.')
                archive.writestr(str(relative/name), data)
    return buffer.getvalue()


def trash_settings(value=None):
    config = Path.home()/'.local/share/tmux-mobile/settings.json'
    default = Path.home()/'.local/share/tmux-mobile/trash'
    try:saved = json.loads(config.read_text())
    except (OSError, ValueError):saved = {}
    if value is not None:
        raw = value.get('trash_root')
        if not isinstance(raw, str) or not raw.strip() or len(raw) > 4096 or any(ord(c) < 32 for c in raw):
            raise ValueError('휴지통 폴더의 절대 경로를 입력해 주세요.')
        target = Path(raw.strip()).expanduser()
        if not target.is_absolute():raise ValueError('휴지통 폴더의 절대 경로를 입력해 주세요.')
        target = target.resolve();target.mkdir(parents=True, exist_ok=True)
        probe = target/('.q-write-'+secrets.token_hex(8))
        try:probe.touch(exist_ok=False)
        finally:probe.unlink(missing_ok=True)
        old = [saved.get('trash_root', str(default)), *saved.get('previous_trash_roots', []), str(default)]
        saved.update(trash_root=str(target), previous_trash_roots=list(dict.fromkeys(p for p in old if p != str(target))))
        config.parent.mkdir(parents=True, exist_ok=True)
        temporary = config.with_name('.settings-'+secrets.token_hex(8)+'.tmp')
        try:
            temporary.write_text(json.dumps(saved, ensure_ascii=False));temporary.chmod(0o600);temporary.replace(config)
        finally:temporary.unlink(missing_ok=True)
    return {'trash_root': saved.get('trash_root', str(default)), 'previous_trash_roots': saved.get('previous_trash_roots', []),
            'default_trash_root': str(default), 'retention_days': 7, 'server': __import__('socket').gethostname()}


def trash_entries():
    settings = trash_settings()
    for root in dict.fromkeys(Path(path).resolve() for path in [settings['trash_root'], *settings['previous_trash_roots']]):
        for entry in root.glob('*/web/tmux/files/tmux-*'):
            if entry.is_symlink() or any(p.is_symlink() for p in entry.parents if root in p.parents):
                continue
            try:
                meta = json.loads((entry/'trash.json').read_text())
                if meta.get('app') == 'tmux' and meta.get('schema') == 1 and os.path.lexists(entry/'payload'):
                    yield entry, meta
            except (OSError, ValueError):continue


def protected_target(raw):
    if not isinstance(raw, str) or not raw or '\0' in raw or len(raw) > 4096:
        raise ValueError('삭제할 파일이나 폴더를 선택해 주세요.')
    value = Path(os.path.abspath(Path(raw).expanduser()))
    # Resolve the parent, never the final symlink: deleting a link must not delete its target.
    target = value.parent.resolve(strict=True)/value.name
    home = Path.home().resolve()
    if target == home or target in home.parents or target == Path('/'):
        raise ValueError('서버 홈이나 상위 시스템 폴더는 삭제할 수 없어요.')
    settings = trash_settings()
    for root in [settings['trash_root'], *settings['previous_trash_roots']]:
        trash = Path(root).resolve()
        if target == trash or target in trash.parents or trash in target.parents:
            raise ValueError('휴지통 안의 항목은 휴지통 메뉴에서 관리해 주세요.')
    if not os.path.lexists(target):raise FileNotFoundError(target)
    return target


def mutate(options):
    action = options.get('action')
    # One lock shared by settings changes and tmux file mutations on this account.
    directory = Path.home()/'.local/share/tmux-mobile';directory.mkdir(parents=True, exist_ok=True)
    with (directory/'.web-trash.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if action == 'settings':return trash_settings()
        if action == 'settings-save':return trash_settings(options)
        if action == 'trash-list':
            items = []
            for entry, meta in trash_entries():
                items.append({**meta, 'id': entry.name, 'expired': time.time() > meta['expires']})
            return {'items': sorted(items, key=lambda m:m['deleted_at'], reverse=True)[:1000]}
        if action in {'restore', 'purge'}:
            identifier = options.get('id', '')
            if not isinstance(identifier, str) or not __import__('re').fullmatch(r'tmux-[0-9a-f]{32}', identifier):raise ValueError('휴지통 항목을 선택해 주세요.')
            for entry, meta in trash_entries():
                if entry.name != identifier:continue
                if action == 'restore':
                    if time.time() > meta['expires']:raise ValueError('보관 기간 7일이 지나 복원할 수 없어요.')
                    target = Path(meta['original'])
                    if os.path.lexists(target):raise ValueError('원래 위치에 같은 이름이 있어 복원하지 않았어요.')
                    target.parent.mkdir(parents=True, exist_ok=True);shutil.move(str(entry/'payload'), str(target))
                subprocess.run(['/bin/rm', '-rf', '--', str(entry)], check=True)
                return {'ok': True}
            raise ValueError('휴지통 항목을 찾을 수 없어요.')
        if action == 'save':
            target = Path(options.get('path', '')).expanduser().resolve(strict=True)
            text, expected = options.get('text'), options.get('etag')
            if not target.is_file() or not isinstance(text, str) or len(text.encode()) > TEXT_LIMIT or not isinstance(expected, str):raise ValueError('편집할 텍스트 파일을 확인해 주세요.')
            with target.open('rb') as stream:content = stream.read(TEXT_LIMIT+1);info = os.fstat(stream.fileno())
            if len(content) > TEXT_LIMIT or hashlib.sha256(content).hexdigest() != expected:
                return {'error': '다른 곳에서 파일이 변경됐어요. 원본을 다시 열고 수정해 주세요.', 'status': 409}
            # Textareas normalize newlines. Retain an existing BOM and CRLF format.
            if b'\r\n' in content and b'\n' not in content.replace(b'\r\n',b''):
                text=text.replace('\r\n','\n').replace('\n','\r\n')
            data = (b'\xef\xbb\xbf' if content.startswith(b'\xef\xbb\xbf') else b'')+text.encode('utf-8')
            temporary = target.with_name('.q-edit-'+secrets.token_hex(12))
            try:
                with temporary.open('xb') as stream:stream.write(data);stream.flush();os.fchmod(stream.fileno(), stat.S_IMODE(info.st_mode))
                with target.open('rb') as stream:latest=stream.read(TEXT_LIMIT+1)
                if hashlib.sha256(latest).hexdigest() != expected:
                    return {'error': '저장 직전에 파일이 변경되어 덮어쓰지 않았어요.', 'status': 409}
                temporary.replace(target)
            finally:temporary.unlink(missing_ok=True)
            return {'ok': True, 'etag': hashlib.sha256(data).hexdigest()}
        if action not in {'trash', 'delete'}:raise ValueError('파일 작업을 확인해 주세요.')
        target = protected_target(options.get('path'))
        if action == 'delete':
            subprocess.run(['/bin/rm', '-rf', '--', str(target)], check=True)
            return {'ok': True}
        root = Path(trash_settings()['trash_root'])
        identifier = 'tmux-'+secrets.token_hex(16)
        entry = root/time.strftime('%Y%m%d')/'web/tmux/files'/identifier
        entry.mkdir(parents=True, mode=0o700)
        meta = {'schema': 1, 'app': 'tmux', 'original': str(target), 'name': target.name,
                'folder': target.is_dir() and not target.is_symlink(), 'deleted_at': time.time(), 'expires': time.time()+7*86400}
        try:
            (entry/'trash.json').write_text(json.dumps(meta, ensure_ascii=False));(entry/'trash.json').chmod(0o600)
            shutil.move(str(target), str(entry/'payload'))
        except BaseException:
            # Keep a partially copied payload available for recovery after an interrupted cross-device move.
            if not os.path.lexists(entry/'payload'):shutil.rmtree(entry)
            raise
        return {'ok': True, 'id': identifier}


def inspect_file(options):
    raw = options.get('path', '')
    if not isinstance(raw, str) or '\0' in raw or len(raw) > 4096:
        raise ValueError('파일 경로를 확인해 주세요.')
    home = Path.home()
    target = Path(raw).expanduser() if raw else home
    if not target.is_absolute():
        target = home / target
    target = target.resolve(strict=True)
    info = target.stat()
    result = {'path': str(target), 'parent': str(target.parent), 'home': str(home),
              'name': target.name or '/', 'bytes': info.st_size, 'mtime': info.st_mtime}
    mode = options.get('mode', 'list')
    if mode == 'download' and stat.S_ISDIR(info.st_mode):
        data = directory_archive(target)
        return dict(result, kind='file', name=target.name+'.zip', type='application/zip', data=base64.b64encode(data).decode())
    if stat.S_ISDIR(info.st_mode):
        if mode != 'list':
            raise ValueError('파일을 선택해 주세요.')
        offset = max(0, min(20000, int(options.get('offset', 0))))
        hidden = options.get('hidden', False)
        entries, count = [], 0
        with os.scandir(target) as stream:
            for entry in stream:
                if not hidden and entry.name.startswith('.'):
                    continue
                count += 1
                if count > SCAN_LIMIT:
                    break
                try:
                    folder = entry.is_dir()
                    if not folder and not entry.is_file():
                        continue
                    entries.append({'name': entry.name, 'path': str(target / entry.name),
                                    'folder': folder, 'link': entry.is_symlink()})
                except OSError:
                    continue
        entries.sort(key=lambda item: (not item['folder'], item['name'].casefold(), item['name']))
        page = entries[offset:offset + PAGE]
        for entry in page:
            if not entry['folder']:
                try:
                    entry['bytes'] = os.stat(entry['path']).st_size
                except OSError:
                    entry['bytes'] = None
        return dict(result, kind='directory', entries=page, offset=offset,
                    more=offset + PAGE < len(entries), capped=count > SCAN_LIMIT)
    if not stat.S_ISREG(info.st_mode):
        raise ValueError('일반 파일만 열 수 있어요.')
    mime = mimetypes.guess_type(target.name)[0] or 'application/octet-stream'
    suffix = target.suffix.lower()
    office = suffix in {'.docx', '.hwp', '.hwpx', '.pptx', '.xlsx', '.xlsm', '.xltx'}
    # Slide decks usually carry pictures, so they get the download-sized budget.
    limit = DOWNLOAD_LIMIT if mode == 'download' or suffix == '.pptx' else MEDIA_LIMIT if mime in MEDIA or office else TEXT_LIMIT
    if mode == 'download' and info.st_size > limit:
        raise ValueError('다운로드는 32 MB 이하 파일을 지원해요.')
    # Nonblocking + fstat avoid hanging on a file replaced by a FIFO/device.
    descriptor = os.open(target, os.O_RDONLY | os.O_NONBLOCK | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(descriptor, 'rb') as stream:
        current = os.fstat(stream.fileno())
        if not stat.S_ISREG(current.st_mode):
            raise ValueError('일반 파일만 열 수 있어요.')
        content = stream.read(limit + 1)
    truncated = len(content) > limit or current.st_size > limit
    content = content[:limit]
    result.update(kind='file', type=mime, bytes=current.st_size, truncated=truncated)
    if mode == 'download':
        if truncated:
            raise ValueError('다운로드 중 파일이 커졌어요. 32 MB 이하 파일을 선택해 주세요.')
        return dict(result, data=base64.b64encode(content).decode())
    if mime in MEDIA:
        return dict(result, data=base64.b64encode(content).decode() if not truncated else '', media=True)
    if office:
        if truncated:raise ValueError('슬라이드 미리보기는 32 MB 이하 파일을 지원해요.' if suffix == '.pptx' else '문서 미리보기는 12 MB 이하 파일을 지원해요.')
        try:return dict(result, document=True, **(hwp_preview(content) if suffix == '.hwp' else office_preview(content, suffix)))
        except (KeyError, IndexError, AttributeError, struct.error, zlib.error, zipfile.BadZipFile, ET.ParseError):raise ValueError('문서 형식을 읽을 수 없어요. 원본을 다운로드해 확인해 주세요.')
    try:
        # A preview boundary may split one UTF-8 character, never call that binary.
        text = content.decode('utf-8-sig', errors='replace')
        binary = b'\0' in content or text.count('\ufffd') > max(4, len(text) // 100)
    except UnicodeError:
        text, binary = '', True
    return dict(result, text='' if binary else text, binary=binary,
                etag=hashlib.sha256(content).hexdigest() if not truncated and not binary and '\ufffd' not in text else '')


def main():
    try:
        options = json.load(sys.stdin)
        result = mutate(options) if options.get('action') else inspect_file(options)
    except FileNotFoundError:
        result = {'error': '파일이나 폴더를 찾을 수 없어요.', 'status': 404}
    except PermissionError:
        result = {'error': '이 경로를 읽을 권한이 없어요.', 'status': 403}
    except (OSError, ValueError, TypeError) as error:
        result = {'error': str(error) if isinstance(error, ValueError) else '파일을 읽을 수 없어요.', 'status': 400}
    json.dump(result, sys.stdout, ensure_ascii=True)


if __name__ == '__main__':
    main()
