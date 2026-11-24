"""Synthetic HWP and PowerPoint files for the GUI guide recording; no real documents."""
import struct
import zipfile
import zlib

NONE, END = 0xFFFFFFFF, 0xFFFFFFFE


def compound_file(streams):
    """Write a small version-3 OLE file whose streams all live in the mini stream."""
    entries, mini, minifat = [{'name': 'Root Entry', 'type': 5, 'children': []}], b'', []
    for path, data in streams.items():
        parent = entries[0]
        for folder in path.split('/')[:-1]:
            found = next((entries[i] for i in parent['children'] if entries[i]['name'] == folder), None)
            if found is None:
                entries.append({'name': folder, 'type': 1, 'children': []});parent['children'].append(len(entries) - 1);found = entries[-1]
            parent = found
        count = max(1, -(-len(data) // 64))
        entries.append({'name': path.split('/')[-1], 'type': 2, 'children': [], 'start': len(minifat), 'size': len(data)})
        parent['children'].append(len(entries) - 1)
        minifat += [len(minifat) + i + 1 for i in range(count - 1)] + [END];mini += data.ljust(count * 64, b'\0')
    directory_sectors, minifat_sectors, mini_sectors = -(-len(entries) // 4), -(-len(minifat) // 128), -(-len(mini) // 512)
    first_minifat, first_mini = 1 + directory_sectors, 1 + directory_sectors + minifat_sectors
    assert first_mini + mini_sectors <= 128, 'fixture is larger than one FAT sector'
    chain = lambda start, count: [start + i + 1 for i in range(count - 1)] + [END]
    fat = [0xFFFFFFFD] + chain(1, directory_sectors) + chain(first_minifat, minifat_sectors) + chain(first_mini, mini_sectors)
    fat += [NONE] * (128 - len(fat))
    # Siblings form a right-leaning chain, which readers accept as a tree.
    following = {a: b for entry in entries for a, b in zip(entry['children'], entry['children'][1:])}
    directory = b''
    for index, entry in enumerate(entries):
        children = entry['children'];child, right = children[0] if children else NONE, following.get(index, NONE)
        start, size = (first_mini, len(mini)) if entry['type'] == 5 else (entry.get('start', END), entry.get('size', 0))
        name = entry['name'].encode('utf-16-le')
        directory += struct.pack('<64sHBBIII16sI16sIII', name, len(name) + 2, entry['type'], 1, NONE, right, child, b'', 0, b'', start, size, 0)
    directory = directory.ljust(directory_sectors * 512, b'\0')
    header = struct.pack('<8s16sHHHHH6sIIIIIIIII', b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1', b'', 0x3E, 3, 0xFFFE, 9, 6, b'', 0, 1, 1, 0, 4096,
                         first_minifat, minifat_sectors, END, 0) + struct.pack('<109I', 0, *[NONE] * 108)
    return header + struct.pack('<128I', *fat) + directory + struct.pack('<%dI' % len(minifat), *minifat).ljust(minifat_sectors * 512, b'\xff') + mini.ljust(mini_sectors * 512, b'\0')


def hwp_document(blocks, flags=1):
    """Build an HWP 5 document from paragraphs (str) and tables (lists of rows)."""
    record = lambda tag, level, data: struct.pack('<I', tag | level << 10 | len(data) << 20) + data
    text = lambda value: (value + '\r').encode('utf-16-le')
    body = b''
    for block in blocks:
        if isinstance(block, str):
            body += record(66, 0, bytes(22)) + record(67, 1, text(block));continue
        # The anchoring paragraph holds an eight-unit table control character.
        body += record(66, 0, bytes(22)) + record(67, 1, struct.pack('<8H', 11, 0x626c, 0x2074, 0, 0, 0, 0, 11) + text(''))
        body += record(71, 1, b' lbt' + bytes(40)) + record(77, 2, struct.pack('<IHH', 0, len(block), len(block[0])) + bytes(10))
        for row, values in enumerate(block):
            for column, value in enumerate(values):
                body += record(72, 2, struct.pack('<HHIHHHH', 1, 0, 0, column, row, 1, 1) + bytes(20))
                body += record(66, 2, bytes(22)) + record(67, 3, text(value))
    if flags & 1:
        compressor = zlib.compressobj(9, zlib.DEFLATED, -15);body = compressor.compress(body) + compressor.flush()
    header = b'HWP Document File'.ljust(32, b'\0') + struct.pack('<II', 0x05000300, flags) + bytes(216)
    return compound_file({'FileHeader': header, 'BodyText/Section0': body})


def slide_deck(path, slides, picture=b''):
    """Write a 16:9 deck; each slide is a dict with title, bullets, table, picture, arrow and chart (category -> value)."""
    p, a, r = ('http://schemas.openxmlformats.org/presentationml/2006/main', 'http://schemas.openxmlformats.org/drawingml/2006/main',
               'http://schemas.openxmlformats.org/officeDocument/2006/relationships')
    namespaces = 'xmlns:p="%s" xmlns:a="%s" xmlns:r="%s"' % (p, a, r)
    frame = lambda x, y, w, h: '<a:xfrm><a:off x="%d" y="%d"/><a:ext cx="%d" cy="%d"/></a:xfrm>' % (x, y, w, h)
    run = lambda value, size: '<a:r><a:rPr lang="en-US" sz="%d"/><a:t>%s</a:t></a:r>' % (size, value)
    title = lambda value: '<a:r><a:rPr lang="en-US" sz="3200" b="1"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>%s</a:t></a:r>' % value
    relationship = lambda key, kind, target: '<Relationship Id="%s" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/%s" Target="%s"/>' % (key, kind, target)
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
        identifiers = ''.join('<p:sldId id="%d" r:id="rId%d"/>' % (256 + i, i + 1) for i in range(len(slides)))
        archive.writestr('ppt/presentation.xml', '<p:presentation %s><p:sldIdLst>%s</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>' % (namespaces, identifiers))
        archive.writestr('ppt/_rels/presentation.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">%s</Relationships>'
                         % ''.join(relationship('rId%d' % (i + 1), 'slide', 'slides/slide%d.xml' % (i + 1)) for i in range(len(slides))))
        if picture:archive.writestr('ppt/media/image1.png', picture)
        for index, slide in enumerate(slides, 1):
            shapes = ('<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>%s<a:prstGeom prst="rect"/>'
                      '<a:solidFill><a:srgbClr val="1F3A5F"/></a:solidFill></p:spPr><p:txBody><a:bodyPr anchor="ctr"/><a:p>%s</a:p></p:txBody></p:sp>'
                      % (frame(0, 0, 12192000, 1100000), title(slide['title'])))
            if slide.get('bullets'):
                paragraphs = ''.join('<a:p><a:pPr><a:buChar char="•"/></a:pPr>%s</a:p>' % run(value, 2000) for value in slide['bullets'])
                shapes += '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>%s</p:spPr><p:txBody><a:bodyPr/>%s</p:txBody></p:sp>' % (frame(500000, 1400000, 5400000, 2600000), paragraphs)
            if slide.get('table'):
                rows = ''.join('<a:tr h="400000">%s</a:tr>' % ''.join('<a:tc><a:txBody><a:bodyPr/><a:p>%s</a:p></a:txBody></a:tc>' % run(value, 1600) for value in values) for values in slide['table'])
                shapes += ('<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>'
                           '<p:xfrm><a:off x="500000" y="4300000"/><a:ext cx="5400000" cy="1600000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">'
                           '<a:tbl>%s</a:tbl></a:graphicData></a:graphic></p:graphicFrame>' % rows)
            if slide.get('picture') and picture:
                # The group's child coordinates are half scale, checking group transforms.
                shapes += ('<p:grpSp><p:nvGrpSpPr><p:cNvPr id="5" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="6400000" y="1400000"/>'
                           '<a:ext cx="5200000" cy="3600000"/><a:chOff x="0" y="0"/><a:chExt cx="2600000" cy="1800000"/></a:xfrm></p:grpSpPr>'
                           '<p:pic><p:nvPicPr><p:cNvPr id="6" name="Chart"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"/></p:blipFill>'
                           '<p:spPr>%s</p:spPr></p:pic></p:grpSp>' % frame(0, 0, 2600000, 1800000))
            if slide.get('arrow'):
                # A horizontal connector has a zero-height frame.
                shapes += ('<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="7" name="Arrow"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr>%s<a:prstGeom prst="line"/>'
                           '<a:ln w="25400"><a:solidFill><a:srgbClr val="C00000"/></a:solidFill><a:tailEnd type="triangle" w="lg" len="lg"/></a:ln></p:spPr></p:cxnSp>' % frame(500000, 6200000, 3000000, 0))
            links = [relationship('rId1', 'image', '../media/image1.png')] if slide.get('picture') and picture else []
            if slide.get('chart'):
                c = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
                cache = lambda values: '<c:ptCount val="%d"/>%s' % (len(values), ''.join('<c:pt idx="%d"><c:v>%s</c:v></c:pt>' % (i, v) for i, v in enumerate(values)))
                shapes += ('<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="8" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>'
                           '<p:xfrm><a:off x="6400000" y="1400000"/><a:ext cx="5200000" cy="3600000"/></p:xfrm><a:graphic><a:graphicData uri="%s">'
                           '<c:chart xmlns:c="%s" r:id="rId2"/></a:graphicData></a:graphic></p:graphicFrame>' % (c, c))
                archive.writestr('ppt/charts/chart%d.xml' % index, '<c:chartSpace xmlns:c="%s" xmlns:a="%s"><c:chart><c:plotArea><c:barChart><c:barDir val="col"/>'
                                 '<c:ser><c:tx><c:strRef><c:strCache>%s</c:strCache></c:strRef></c:tx><c:spPr><a:solidFill><a:srgbClr val="1F3864"/></a:solidFill></c:spPr>'
                                 '<c:dLbls><c:numFmt formatCode="0.0"/><c:showVal val="1"/></c:dLbls><c:cat><c:strRef><c:strCache>%s</c:strCache></c:strRef></c:cat>'
                                 '<c:val><c:numRef><c:numCache>%s</c:numCache></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>'
                                 % (c, a, cache(['WNS']), cache(list(slide['chart'])), cache(list(slide['chart'].values()))))
                links.append(relationship('rId2', 'chart', '../charts/chart%d.xml' % index))
            archive.writestr('ppt/slides/slide%d.xml' % index, '<p:sld %s><p:cSld><p:spTree>%s</p:spTree></p:cSld></p:sld>' % (namespaces, shapes))
            if links:
                archive.writestr('ppt/slides/_rels/slide%d.xml.rels' % index, '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">%s</Relationships>' % ''.join(links))
