"""Turn real, disposable GUI screencasts into short tours and focused workflow GIFs."""
import bisect
from functools import lru_cache
import json
from pathlib import Path
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
WIDTH, HEIGHT, TOP, BOTTOM = 1200, 820, 48, 58
AREA = (WIDTH, HEIGHT - TOP - BOTTOM)
# Focused GIFs follow the guide's sections; scenes play in recording order.
GROUPS = {
    'setup': ['01', '02', '41', '05', '30'],
    'reader': ['30', '06'],
    'composer': ['07', '08', '26'],
    'commands': ['09', '19', '10'],
    'folders': ['18'],
    'workspaces': ['20', '21', '48', '36', '38'],
    'detach': ['37', '42'],
    'files': ['11', '12', '32', '13', '31'],
    'documents': ['46', '47'],
    'uploads': ['14', '15', '16', '27'],
    'trash': ['49', '16'],
    'images': ['17', '34', '43', '35'],
    'notifications': ['23', '39', '40', '44'],
    'appearance': ['22', '45', '24'],
    'settings': ['03', '49', '04', '24', '33'],
    'servers': ['28', '29'],
}
TOUR = ['02', '05', '30', '06', '07', '09', '18', '20', '21', '48', '11', '46', '47', '17', '22', '25']
# (frames per second, longest action in seconds before fast-forwarding, final hold in seconds)
PACE = {'workflow': (10, 6, 1.8), 'tour': (10, 3, 1.3), 'all-features': (8, 2.5, 1.1)}


def font(names, size):
    for name in names:
        try:return ImageFont.truetype(name, size)
        except OSError:continue
    return ImageFont.truetype(str(ROOT/'web/assets/fonts/CascadiaCode.ttf'), size)


def main():
    data = json.loads(Path(sys.argv[1]).read_text());scenes = data['scenes']
    casts = [([f['time'] for f in frames], [f['file'] for f in frames]) for frames in data['casts']]
    if not all(times for times, _ in casts):raise RuntimeError('A screencast produced no frames.')
    output = ROOT/'docs/demos';output.mkdir(exist_ok=True)
    title_font, step_font, caption_font, note_font = (font(['DejaVuSans-Bold.ttf', 'NotoSans-Bold.ttf'], 19), font(['DejaVuSans-Bold.ttf'], 13),
                                                      font(['DejaVuSans.ttf', 'NotoSans-Regular.ttf'], 16), font(['DejaVuSans.ttf'], 11))
    icon = Image.open(ROOT/'web/assets/icons/icon-192.png').convert('RGBA').resize((30, 30))

    @lru_cache(maxsize=48)
    def load(path):
        with Image.open(path) as image:return image.convert('RGB')

    def frame_at(cast, moment):
        times, files = casts[cast]
        return files[max(0, bisect.bisect_right(times, moment) - 1)]

    def content(path, focus=None, zoom=0.0):
        image = load(path)
        if focus and zoom:
            # Ease from the full frame into the dialog, keeping the output's aspect ratio.
            scale = image.width / focus['viewport']['width'];pad = 28 * scale
            left, top = focus['x'] * scale - pad, focus['y'] * scale - pad
            right, bottom = (focus['x'] + focus['width']) * scale + pad, (focus['y'] + focus['height']) * scale + pad
            aspect = AREA[0] / AREA[1];w, h = right - left, bottom - top
            if w / h < aspect:left, right = (left + right - h * aspect) / 2, (left + right + h * aspect) / 2
            else:top, bottom = (top + bottom - w / aspect) / 2, (top + bottom + w / aspect) / 2
            w, h = min(right - left, image.width), min(bottom - top, image.height)
            left, top = min(max(0, left), image.width - w), min(max(0, top), image.height - h)
            box = [a + (b - a) * zoom for a, b in zip((0, 0, image.width, image.height), (left, top, left + w, top + h))]
            image = image.crop(tuple(round(v) for v in box))
        ratio = min(AREA[0] / image.width, AREA[1] / image.height, 1.8)
        canvas = Image.new('RGB', AREA, '#0d1117')
        resized = image.resize((max(1, round(image.width * ratio)), max(1, round(image.height * ratio))), Image.Resampling.LANCZOS)
        canvas.paste(resized, ((AREA[0] - resized.width) // 2, (AREA[1] - resized.height) // 2))
        return canvas

    def clip(scene, fps, cap, hold):
        """Frames for one scene: its action at real speed (or fast-forwarded), then a hold."""
        start, end = scene['start'], scene['end'];length = max(0.0, end - start)
        count = max(1, round(min(length, cap) * fps));speed = length / cap if length > cap else 1
        frames = [(content(frame_at(scene['cast'], start + length * (i + 1) / count)), 1000 // fps, speed) for i in range(count)]
        focus = scene.get('focus');last = frame_at(scene['cast'], end)
        if focus and focus['width'] * focus['height'] < .6 * focus['viewport']['width'] * focus['viewport']['height']:
            # Zoom into the dialog or preview, hold, then zoom back out so the next scene fades from the full view.
            frames += [(content(last, focus, (k / 6) ** .5), 55, 1) for k in range(1, 6)]
            frames.append((content(last, focus, 1.0), round(hold * 1000), 1))
            frames += [(content(last, focus, 1 - k / 4), 45, 1) for k in range(1, 5)]
        else:frames.append((frames[-1][0], round(hold * 1000), 1))
        return frames

    def chrome(image, scene, step, total, speed):
        frame = Image.new('RGB', (WIDTH, HEIGHT), '#0d1117');frame.paste(image, (0, TOP))
        draw = ImageDraw.Draw(frame);draw.rectangle((0, 0, WIDTH, TOP - 1), fill='#161b22');frame.paste(icon, (12, 9), icon)
        label = 'STEP %d / %d' % (step, total) if total > 1 else 'GUIDE'
        draw.text((54, 16), label, font=step_font, fill='#58a6ff');offset = 54 + draw.textlength(label, font=step_font) + 14
        draw.text((offset, 13), scene['title'], font=title_font, fill='#f0f6fc')
        note = 'fast-forward x%.1f' % speed if speed > 1.05 else 'Real GUI · fictional demo data'
        draw.text((WIDTH - 14 - draw.textlength(note, font=note_font), 18), note, font=note_font, fill='#f0b72f' if speed > 1.05 else '#8b949e')
        draw.rectangle((0, TOP - 3, round(WIDTH * step / total), TOP - 1), fill='#2f81f7')
        draw.rectangle((0, HEIGHT - BOTTOM, WIDTH, HEIGHT), fill='#161b22')
        words, lines = scene.get('caption', '').split(), ['']
        for word in words:
            candidate = (lines[-1] + ' ' + word).strip()
            if draw.textlength(candidate, font=caption_font) > WIDTH - 40 and lines[-1]:lines.append(word)
            else:lines[-1] = candidate
        for index, line in enumerate(lines[:2]):
            draw.text((20, HEIGHT - BOTTOM + (19 if len(lines) == 1 else 9 + index * 21)), line, font=caption_font, fill='#c9d1d9')
        return frame

    def save(name, keys, pace):
        fps, cap, hold = PACE[pace];selected = [s for s in scenes if s['file'][:2] in keys] if keys else scenes
        frames, previous = [], None
        for step, scene in enumerate(selected, 1):
            parts = clip(scene, fps, cap, hold)
            if previous is not None:
                # A short cross-fade replaces the hard cut between scenes.
                frames += [(chrome(Image.blend(previous, parts[0][0], alpha), scene, step, len(selected), 1), 60) for alpha in (.35, .7)]
            frames += [(chrome(image, scene, step, len(selected), speed), duration) for image, duration, speed in parts]
            previous = parts[-1][0]
        montage = Image.new('RGB', (WIDTH, HEIGHT * min(6, len(frames))))
        for index, (image, _) in enumerate(frames[::max(1, len(frames) // 6)][:6]):montage.paste(image, (0, HEIGHT * index))
        palette = montage.quantize(colors=255, method=Image.Quantize.MEDIANCUT)
        images = [image.quantize(palette=palette, dither=Image.Dither.NONE) for image, _ in frames]
        target = output/(name + '.gif')
        images[0].save(target, save_all=True, append_images=images[1:], duration=[d for _, d in frames], loop=0, optimize=False, disposal=1)
        with Image.open(target) as animation:assert animation.is_animated and animation.size == (WIDTH, HEIGHT)
        print('Saved %s: %d scenes, %.1f s, %.2f MB' % (target.relative_to(ROOT), len(selected), sum(d for _, d in frames) / 1000, target.stat().st_size / 1e6), flush=True)

    written = {'all-features', 'tour', *GROUPS}
    for stale in output.glob('*.gif'):
        if stale.stem not in written:stale.unlink()
    save('tour', TOUR, 'tour')
    for name, keys in GROUPS.items():save(name, keys, 'workflow')
    save('all-features', None, 'all-features')
    (output/'manifest.json').write_text(json.dumps({'source': 'Real GUI screencast excerpts; fictional data only.', 'overview': 'all-features.gif', 'tour': 'tour.gif',
                                                    'scenes': [s['file'] for s in scenes], 'workflows': {name + '.gif': keys for name, keys in GROUPS.items()},
                                                    'size': [WIDTH, HEIGHT]}, indent=2) + '\n')
    print('PASS tour, complete overview and %d workflow GIFs from real GUI screencasts.' % len(GROUPS), flush=True)


if __name__ == '__main__':main()
