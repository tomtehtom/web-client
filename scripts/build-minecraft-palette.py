"""Bake the installed vanilla 26.3 client models into an audited voxel palette.

Requires Pillow and numpy. Reads the client JAR; never changes the installation.
Default states: scripts/data/minecraft-26.3-defaults.json (misode/mcmeta,
26.3-summary, generated from the game's block report).
"""
import argparse
import hashlib
import io
import json
import math
import os
from functools import lru_cache
from pathlib import Path
from zipfile import ZipFile

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
FACES = ['west', 'east', 'down', 'up', 'north', 'south']
NORMALS = dict(zip(FACES, [(-1, 0, 0), (1, 0, 0), (0, -1, 0), (0, 1, 0), (0, 0, -1), (0, 0, 1)]))
MODEL_UV = {
    'west': ((0, 0, 1), (0, -1, 0)), 'east': ((0, 0, -1), (0, -1, 0)),
    'down': ((1, 0, 0), (0, 0, -1)), 'up': ((1, 0, 0), (0, 0, 1)),
    'north': ((-1, 0, 0), (0, -1, 0)), 'south': ((1, 0, 0), (0, -1, 0)),
}
PREVIEW_UV = {
    'west': ((0, 0, -1), (0, 1, 0)), 'east': ((0, 0, 1), (0, 1, 0)),
    'down': ((1, 0, 0), (0, 0, -1)), 'up': ((1, 0, 0), (0, 0, 1)),
    'north': ((-1, 0, 0), (0, 1, 0)), 'south': ((1, 0, 0), (0, 1, 0)),
}


def gravity(name):
    return name in {'sand', 'red_sand', 'gravel', 'suspicious_sand', 'suspicious_gravel',
                    'anvil', 'chipped_anvil', 'damaged_anvil', 'dragon_egg', 'scaffolding', 'pointed_dripstone'} or name.endswith('_concrete_powder')


def resource(value, folder):
    namespace, path = value.split(':', 1) if ':' in value else ('minecraft', value)
    return f'assets/{namespace}/{folder}/{path}'


def matches(when, state):
    if not when:
        return True
    if 'OR' in when:
        return any(matches(part, state) for part in when['OR'])
    if 'AND' in when:
        return all(matches(part, state) for part in when['AND'])
    return all(str(state.get(key)) in str(value).split('|') for key, value in when.items())


def rotation_matrix(x, y):
    x, y = math.radians(x), math.radians(y)
    # Blockstate rotations use clockwise quarter turns around the cube centre.
    rx = np.array([[1, 0, 0], [0, math.cos(x), math.sin(x)], [0, -math.sin(x), math.cos(x)]])
    ry = np.array([[math.cos(y), 0, -math.sin(y)], [0, 1, 0], [math.sin(y), 0, math.cos(y)]])
    return np.rint(ry @ rx).astype(int)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--jar', type=Path, default=Path(os.environ.get('APPDATA', '')) / '.minecraft/versions/26.3/26.3.jar')
    args = parser.parse_args()
    defaults_path = ROOT / 'scripts/data/minecraft-26.3-defaults.json'
    defaults = json.loads(defaults_path.read_text())
    jar = ZipFile(args.jar)
    version = json.loads(jar.read('version.json'))
    if version['id'] != '26.3':
        raise ValueError('This reference pipeline requires the vanilla 26.3 client JAR.')
    block_names = sorted(path[len('assets/minecraft/blockstates/'):-5] for path in jar.namelist()
                         if path.startswith('assets/minecraft/blockstates/') and path.endswith('.json'))
    if set(defaults) - set(block_names) or set(block_names) - set(defaults) - {'item_frame', 'glow_item_frame'}:
        raise ValueError('Client block definitions and the pinned default-state report differ.')
    # Item-frame render definitions are entity helpers, not registered blocks.
    block_names = sorted(defaults)

    @lru_cache(None)
    def model(name):
        if name.startswith('builtin/') or name.startswith('minecraft:builtin/'):
            return {'elements': [], 'textures': {}}
        data = json.loads(jar.read(resource(name, 'models') + '.json'))
        parent = model(data['parent']) if data.get('parent') else {}
        return {**parent, **data, 'textures': {**parent.get('textures', {}), **data.get('textures', {})}}

    @lru_cache(None)
    def texture(name):
        image = Image.open(io.BytesIO(jar.read(resource(name, 'textures') + '.png'))).convert('RGBA')
        # Static reference frame; never mix a vertical animation strip into a face.
        return image.crop((0, 0, image.width, image.width))

    def resolve_texture(value, textures):
        seen = set()
        if isinstance(value, dict):
            value = value['sprite']
        while value.startswith('#'):
            key = value[1:]
            if key in seen or key not in textures:
                raise ValueError(f'Unresolved texture {value}')
            seen.add(key)
            value = textures[key]
            if isinstance(value, dict):
                value = value['sprite']
        return value

    # A reproducible reference biome, not an attempt to reconstruct source-world biomes.
    tint_position = (int((1 - .8) * 255), int((1 - .8 * .4) * 255))
    tints = {kind: np.array(Image.open(io.BytesIO(jar.read(f'assets/minecraft/textures/colormap/{kind}.png'))).convert('RGB').getpixel(tint_position)) / 255
             for kind in ['grass', 'foliage']}

    def face_image(face, textures, name):
        image = texture(resolve_texture(face['texture'], textures))
        uv = face.get('uv', [0, 0, 16, 16])
        left, right = sorted([uv[0], uv[2]])
        top, bottom = sorted([uv[1], uv[3]])
        image = image.crop(tuple(round(value / 16 * image.width) for value in [left, top, right, bottom]))
        if uv[2] < uv[0]:
            image = image.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
        if uv[3] < uv[1]:
            image = image.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
        if face.get('rotation'):
            image = image.rotate(-face['rotation'], expand=True)
        if 'tintindex' in face:
            pixels = np.array(image)
            tint = tints['foliage' if 'leaves' in name else 'grass']
            if name.startswith('spruce_'):
                tint = np.array([97, 153, 97]) / 255
            elif name.startswith('birch_'):
                tint = np.array([128, 167, 85]) / 255
            pixels[:, :, :3] = np.rint(pixels[:, :, :3] * tint).astype(np.uint8)
            image = Image.fromarray(pixels)
        return image

    def bake(name):
        state = defaults[name][1]
        definition = json.loads(jar.read(f'assets/minecraft/blockstates/{name}.json'))
        selected = []
        for key, value in definition.get('variants', {}).items():
            when = dict(item.split('=', 1) for item in key.split(',')) if key else {}
            if matches(when, state):
                selected.append(value[0] if isinstance(value, list) else value)
                break
        for part in definition.get('multipart', []):
            if matches(part.get('when'), state):
                selected.append(part['apply'][0] if isinstance(part['apply'], list) else part['apply'])
        images = {face: Image.new('RGBA', (16, 16)) for face in FACES}
        depths = {face: np.full((16, 16), -np.inf) for face in FACES}
        occupied = np.zeros((16, 16, 16), dtype=bool)
        any_elements = False
        for selection in selected:
            resolved = model(selection['model'])
            matrix = rotation_matrix(selection.get('x', 0), selection.get('y', 0))
            for element in resolved.get('elements', []):
                if element.get('rotation', {}).get('angle', 0):
                    raise ValueError('Rotated non-cube model')
                any_elements = True
                low, high = np.array(element['from'], dtype=float), np.array(element['to'], dtype=float)
                corners = np.array([[x, y, z] for x in [low[0], high[0]] for y in [low[1], high[1]] for z in [low[2], high[2]]])
                corners = (corners - 8) @ matrix.T + 8
                lo, hi = corners.min(axis=0), corners.max(axis=0)
                if (lo < 0).any() or (hi > 16).any():
                    raise ValueError('Model extends outside a voxel')
                start, end = np.ceil(lo - .5).astype(int).clip(0, 16), np.ceil(hi - .5).astype(int).clip(0, 16)
                occupied[start[0]:end[0], start[1]:end[1], start[2]:end[2]] = True
                for face, info in element.get('faces', {}).items():
                    normal = matrix @ np.array(NORMALS[face])
                    world_face = next(key for key, value in NORMALS.items() if np.array_equal(normal, value))
                    axis = FACES.index(world_face) // 2
                    positive = FACES.index(world_face) % 2 == 1
                    basis_u, basis_v = [np.array(vector) for vector in PREVIEW_UV[world_face]]
                    u, v = int(np.abs(basis_u).argmax()), int(np.abs(basis_v).argmax())
                    x0, x1 = (int(start[u]), int(end[u])) if basis_u[u] > 0 else (16 - int(end[u]), 16 - int(start[u]))
                    y0, y1 = (int(start[v]), int(end[v])) if basis_v[v] > 0 else (16 - int(end[v]), 16 - int(start[v]))
                    if x1 <= x0 or y1 <= y0:
                        continue
                    if 'uv' not in info:
                        default_uv = {
                            'down': [low[0], 16-high[2], high[0], 16-low[2]],
                            'up': [low[0], low[2], high[0], high[2]],
                            'north': [16-high[0], 16-high[1], 16-low[0], 16-low[1]],
                            'south': [low[0], 16-high[1], high[0], 16-low[1]],
                            'west': [low[2], 16-high[1], high[2], 16-low[1]],
                            'east': [16-high[2], 16-high[1], 16-low[2], 16-low[1]],
                        }
                        info = {**info, 'uv': default_uv[face]}
                    image = face_image(info, resolved['textures'], name)
                    local_u, local_v = [matrix @ np.array(vector) for vector in MODEL_UV[face]]
                    orientation = np.array([[basis_u @ local_u, basis_u @ local_v], [basis_v @ local_u, basis_v @ local_v]])
                    pixels = np.asarray(image)
                    if orientation[0, 0] == 0:
                        pixels = pixels.transpose(1, 0, 2)
                    if orientation[0].sum() < 0:
                        pixels = pixels[:, ::-1]
                    if orientation[1].sum() < 0:
                        pixels = pixels[::-1]
                    image = Image.fromarray(pixels.copy()).resize((x1 - x0, y1 - y0), Image.Resampling.NEAREST)
                    depth = hi[axis] if positive else -lo[axis]
                    region = depths[world_face][y0:y1, x0:x1]
                    pixels = np.array(image)
                    visible = (depth >= region - 1e-8) & (pixels[:, :, 3] > 0)
                    pixels[~visible, 3] = 0
                    layer = Image.new('RGBA', (16, 16)); layer.paste(Image.fromarray(pixels), (x0, y0))
                    images[world_face] = Image.alpha_composite(images[world_face], layer)
                    region[visible] = depth
        # Shulker boxes are rendered by an entity renderer, not cube JSON models.
        # Bake the closed box from its vanilla lid/base cuboid UV layout.
        if name == 'shulker_box' or name.endswith('_shulker_box'):
            colour = name.removesuffix('_shulker_box')
            suffix = '' if name == 'shulker_box' else '_' + colour
            sheet = Image.open(io.BytesIO(jar.read(f'assets/minecraft/textures/entity/shulker/shulker{suffix}.png'))).convert('RGBA')
            images['up'] = sheet.crop((16, 0, 32, 16))
            images['down'] = sheet.crop((32, 28, 48, 44))
            for face, x in [('west', 0), ('north', 16), ('east', 32), ('south', 48)]:
                side = Image.new('RGBA', (16, 16)); side.paste(sheet.crop((x, 16, x + 16, 28)), (0, 0)); side.paste(sheet.crop((x, 48, x + 16, 52)), (0, 12)); images[face] = side
                images[face] = images[face].transpose(Image.Transpose.FLIP_TOP_BOTTOM)
                if face in ['west', 'east']:
                    images[face] = images[face].transpose(Image.Transpose.FLIP_LEFT_RIGHT)
            return images, True
        closed_shell = all(np.all(np.isclose(depths[face], 16 if FACES.index(face) % 2 else 0)) for face in FACES)
        return images, bool(any_elements and (occupied.all() or closed_shell))

    unique = {}
    details = {}
    blocks = []

    def add_image(image):
        key = 'voxelearth:face/' + hashlib.sha256(image.tobytes()).hexdigest()[:20]
        unique.setdefault(key, image)
        return key

    def average(images):
        pixels = np.concatenate([np.asarray(image, dtype=float).reshape(-1, 4) for image in images]) / 255
        alpha = pixels[:, 3]
        rgb = pixels[:, :3]
        linear = np.where(rgb <= .04045, rgb / 12.92, ((rgb + .055) / 1.055) ** 2.4)
        mean = (linear * alpha[:, None]).sum(axis=0) / max(alpha.sum(), 1e-12)
        encoded = np.clip(np.where(mean <= .0031308, mean * 12.92, 1.055 * mean ** (1 / 2.4) - .055), 0, 1)
        return dict(zip(['r', 'g', 'b'], encoded.tolist()))

    for name in block_names:
        try:
            faces, full_cube = bake(name)
            opaque = all(np.asarray(image)[:, :, 3].min() == 255 for image in faces.values())
            visible = all(np.asarray(image)[:, :, 3].max() > 0 for image in faces.values())
            reason = 'Falling or support-dependent block excluded' if gravity(name) else 'Default model is not a full cube' if not full_cube else 'No visible texture on every face' if not visible else None
            details['minecraft:' + name] = {'fullCube': full_cube, 'opaque': bool(opaque), 'supported': reason is None, **({'reason': reason} if reason else {})}
            if reason:
                continue
            keys = {face: add_image(image) for face, image in faces.items()}
            blocks.append({'name': 'minecraft:' + name, 'faces': keys,
                           'colours': {'balanced': average(list(faces.values())), 'top': average([faces['up']]),
                                       'sides': average([faces[face] for face in ['west', 'east', 'north', 'south']])}})
        except (KeyError, ValueError, StopIteration) as error:
            details['minecraft:' + name] = {'supported': False, 'fullCube': False, 'opaque': False, 'reason': str(error)}

    cells = math.ceil(math.sqrt(len(unique)))
    atlas = Image.new('RGBA', (cells * 20, cells * 20))
    textures = {}
    for index, (key, image) in enumerate(sorted(unique.items())):
        x, y = index % cells, index // cells
        # Edge padding avoids sampling the neighboring block's texture.
        padded = np.pad(np.asarray(image), ((2, 2), (2, 2), (0, 0)), mode='edge')
        atlas.paste(Image.fromarray(padded), (x * 20, y * 20))
        textures[key] = {'atlasColumn': x, 'atlasRow': y}
    for block in blocks:
        textures['minecraft:block/' + block['name'].split(':')[1]] = textures[block['faces']['north']]
    payload = {'formatVersion': 4, 'minecraftVersion': version['id'], 'dataVersion': version['world_version'],
               'atlasSize': cells, 'reference': {'biome': 'plains', 'temperature': .8, 'downfall': .4, 'animationFrame': 0,
               'averaging': 'alpha-weighted linear light', 'defaultStatesSource': 'https://github.com/misode/mcmeta/tree/26.3-summary/blocks'},
               'blocks': blocks, 'textures': textures}
    registry = {'minecraftVersion': version['id'], 'dataVersion': version['world_version'], 'blocks': ['minecraft:' + name for name in block_names], 'details': details}
    (ROOT / 'public/vanilla.atlas').write_text(json.dumps(payload, indent=2) + '\n')
    atlas.save(ROOT / 'public/vanilla.png')
    (ROOT / 'public/minecraft-block-registry.json').write_text(json.dumps(registry, indent=2) + '\n')
    (ROOT / 'src/minecraft-version.js').write_text(f"// Generated from the installed vanilla client version.json.\nexport const MINECRAFT_VERSION = '{version['id']}';\nexport const MINECRAFT_DATA_VERSION = {version['world_version']};\nexport const BLOCK_REGISTRY_COUNT = {len(block_names)};\n")
    opaque = [name for name, info in details.items() if info['supported'] and info['opaque']]
    report = {'minecraftVersion': version['id'], 'registryBlocks': len(block_names), 'supportedCubes': len(blocks),
              'opaqueNonGravityCubes': len(opaque), 'uniqueFaceTextures': len(unique),
              'opaqueBlocks': opaque, 'excluded': {name: info['reason'] for name, info in details.items() if not info['supported']}}
    (ROOT / 'public/minecraft-palette-audit.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({key: value for key, value in report.items() if key not in ['opaqueBlocks', 'excluded']}, indent=2))


if __name__ == '__main__':
    main()
