"""
Генератор 3D-ассетов для «Пятнашек».

Строит:
  * костяшки tile_1 … tile_24 — скруглённый брусок с настоящей гравировкой цифры
    (boolean DIFFERENCE, стенки и дно гравировки получают материал «tile_ink»);
  * рамки frame_3 / frame_4 / frame_5 — бортик (rim), цоколь (base) и бархатное дно (floor).

Запуск (из корня проекта):
  blender -b --factory-startup -P blender/build_puzzle.py -- public/models/puzzle.glb [путь_к_шрифту]

Система координат Blender: Z вверх, игровое поле в плоскости XY.
glTF-экспорт переводит в Y-up (Three.js): (x, y, z) -> (x, z, -y).
"""
import bpy
import bmesh
import math
import os
import sys

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = os.path.abspath(argv[0] if argv else "puzzle.glb")
FONT = argv[1] if len(argv) > 1 else r"C:\Windows\Fonts\BOOKOSB.TTF"

# ---------------------------------------------------------------- параметры
TILE_W = 0.962       # ширина костяшки (шаг сетки = 1.0)
TILE_H = 0.30        # толщина
TILE_R = 0.095       # радиус скругления рёбер
TILE_SEG = 7         # сегменты фаски
ENGRAVE = 0.03       # глубина гравировки
DIGIT_H = 0.40       # высота цифр
MAX_TEXT_W = 0.70    # максимальная ширина числа
MAX_TILE = 24
SIZES = (3, 4, 5)

CLEAR = 0.03         # зазор между костяшками и стенкой
RIM_W = 0.40         # ширина бортика
RIM_TOP = 0.37
RIM_BOTTOM = -0.08   # нижняя фаска спрятана в цоколе
RIM_BEVEL = 0.05
INNER_R = 0.06
OUTER_R = 0.30
BASE_STEP = 0.07
BASE_TOP = 0.0
BASE_BOTTOM = -0.16
BASE_BEVEL = 0.035


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def material(name, color, rough, metal=0.0):
    m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:
        pass
    bsdf = None
    if m.node_tree:
        bsdf = next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (*color, 1.0)
        bsdf.inputs["Roughness"].default_value = rough
        bsdf.inputs["Metallic"].default_value = metal
    m.diffuse_color = (*color, 1.0)
    return m


def link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


def evaluated_mesh(obj, name):
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(obj.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
    me.name = name
    return me


def finish_normals(obj, sharp_deg=31.0):
    """Гладкое затенение + острые рёбра по углу + Weighted Normal (плоские грани остаются плоскими)."""
    me = obj.data
    try:
        me.shade_smooth()
    except AttributeError:
        for p in me.polygons:
            p.use_smooth = True
    try:
        me.set_sharp_from_angle(angle=math.radians(sharp_deg))
    except AttributeError:
        me.use_auto_smooth = True
        me.auto_smooth_angle = math.radians(sharp_deg)
    wn = obj.modifiers.new("wn", "WEIGHTED_NORMAL")
    wn.mode = "FACE_AREA"
    wn.weight = 50
    wn.keep_sharp = True
    wn.thresh = 0.01
    new_me = evaluated_mesh(obj, me.name)
    obj.modifiers.clear()
    old = obj.data
    obj.data = new_me
    bpy.data.meshes.remove(old)


# ---------------------------------------------------------------- костяшки
def rounded_box(name, sx, sy, sz, r, seg, mats):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=(sx, sy, sz), verts=bm.verts)
    bmesh.ops.translate(bm, vec=(0, 0, sz / 2), verts=bm.verts)
    bmesh.ops.bevel(
        bm, geom=list(bm.verts) + list(bm.edges), offset=r, offset_type="OFFSET",
        segments=seg, profile=0.5, affect="EDGES", clamp_overlap=True,
    )
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(m)
    return me


def text_mesh(s, font):
    cu = bpy.data.curves.new("txt_" + s, "FONT")
    cu.body = s
    cu.font = font
    cu.size = 1.0
    cu.align_x = "CENTER"
    cu.align_y = "CENTER"
    cu.extrude = 0.5
    cu.resolution_u = 10
    ob = link(bpy.data.objects.new("txt_" + s, cu))
    me = evaluated_mesh(ob, "txtmesh_" + s)
    bpy.data.objects.remove(ob)
    bpy.data.curves.remove(cu)
    return me


def bbox(me):
    xs = [v.co.x for v in me.vertices]
    ys = [v.co.y for v in me.vertices]
    return min(xs), max(xs), min(ys), max(ys)


def build_tiles(body, ink, font):
    ref = text_mesh("0123456789", font)
    x0, x1, y0, y1 = bbox(ref)
    base_k = DIGIT_H / (y1 - y0)
    bpy.data.meshes.remove(ref)

    tiles = []
    for n in range(1, MAX_TILE + 1):
        s = str(n)
        tme = text_mesh(s, font)
        x0, x1, y0, y1 = bbox(tme)
        k = base_k
        if (x1 - x0) * k > MAX_TEXT_W:
            k = MAX_TEXT_W / (x1 - x0)
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        z_lo, z_hi = TILE_H - ENGRAVE, TILE_H + 0.12
        for v in tme.vertices:
            v.co.x = (v.co.x - cx) * k
            v.co.y = (v.co.y - cy) * k
            v.co.z = z_lo + (v.co.z + 0.5) * (z_hi - z_lo)
        tme.materials.clear()
        tme.materials.append(ink)

        tile_me = rounded_box(f"tile_{n}", TILE_W, TILE_W, TILE_H, TILE_R, TILE_SEG, [body, ink])
        tile = link(bpy.data.objects.new(f"tile_{n}", tile_me))
        cutter = link(bpy.data.objects.new("cutter", tme))
        cutter.hide_render = True

        mod = tile.modifiers.new("engrave", "BOOLEAN")
        mod.operation = "DIFFERENCE"
        mod.solver = "EXACT"
        mod.object = cutter
        try:
            mod.material_mode = "TRANSFER"
        except Exception:
            pass
        new_me = evaluated_mesh(tile, f"tile_{n}")
        tile.modifiers.clear()
        tile.data = new_me
        bpy.data.meshes.remove(tile_me)
        bpy.data.objects.remove(cutter)
        bpy.data.meshes.remove(tme)

        finish_normals(tile)
        tile["number"] = n
        tiles.append(tile)
        print(f"  tile {n:2d}: {len(tile.data.vertices)} verts, {len(tile.data.polygons)} faces")
    return tiles


# ---------------------------------------------------------------- рамки
def rrect(w, h, r, seg=12):
    pts = []
    corners = [(w / 2 - r, h / 2 - r, 0), (-w / 2 + r, h / 2 - r, 90),
               (-w / 2 + r, -h / 2 + r, 180), (w / 2 - r, -h / 2 + r, 270)]
    for cx, cy, a0 in corners:
        for i in range(seg + 1):
            a = math.radians(a0 + 90 * i / seg)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def slab(name, loops, z_bottom, z_top, bevel, mat, bevel_res=5):
    """Плоский контур (с дырами) -> экструзия со скруглёнными кромками через Curve bevel."""
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "2D"
    cu.fill_mode = "BOTH"
    for pts in loops:
        sp = cu.splines.new("POLY")
        sp.points.add(len(pts) - 1)
        for p, (x, y) in zip(sp.points, pts):
            p.co = (x, y, 0.0, 1.0)
        sp.use_cyclic_u = True
        sp.use_smooth = True
    cu.bevel_depth = bevel
    cu.bevel_resolution = bevel_res
    cu.extrude = (z_top - z_bottom) / 2 - bevel
    ob = link(bpy.data.objects.new(name + "_tmp", cu))
    ob.location.z = (z_top + z_bottom) / 2
    me = evaluated_mesh(ob, name)
    bpy.data.objects.remove(ob)
    bpy.data.curves.remove(cu)
    for v in me.vertices:
        v.co.z += (z_top + z_bottom) / 2
    me.materials.clear()
    me.materials.append(mat)
    obj = link(bpy.data.objects.new(name, me))
    finish_normals(obj, 40.0)
    return obj


def build_frame(n, wood, floor_mat):
    inner = n * 1.0 + CLEAR
    outer = inner + 2 * RIM_W
    base = outer + 2 * BASE_STEP
    b = RIM_BEVEL

    root = link(bpy.data.objects.new(f"frame_{n}", None))

    rim = slab(
        f"frame_{n}_rim",
        [rrect(outer - 2 * b, outer - 2 * b, OUTER_R - b), rrect(inner + 2 * b, inner + 2 * b, INNER_R + b)],
        RIM_BOTTOM, RIM_TOP, b, wood,
    )
    plinth = slab(
        f"frame_{n}_base",
        [rrect(base - 2 * BASE_BEVEL, base - 2 * BASE_BEVEL, OUTER_R + BASE_STEP - BASE_BEVEL)],
        BASE_BOTTOM, BASE_TOP, BASE_BEVEL, wood, 4,
    )

    # бархатное дно колодца: тонкая пластина, края спрятаны под бортик
    f = inner + 0.06
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=f / 2)
    bmesh.ops.translate(bm, vec=(0, 0, BASE_TOP + 0.0015), verts=bm.verts)
    fme = bpy.data.meshes.new(f"frame_{n}_floor")
    bm.to_mesh(fme)
    bm.free()
    fme.materials.append(floor_mat)
    floor = link(bpy.data.objects.new(f"frame_{n}_floor", fme))

    for o in (rim, plinth, floor):
        o.parent = root
    root["inner"] = inner
    root["outer"] = base
    print(f"  frame {n}: rim {len(rim.data.vertices)} verts, base {len(plinth.data.vertices)} verts")
    return root


# ---------------------------------------------------------------- main
def main():
    reset()
    font = bpy.data.fonts.load(FONT)
    body = material("tile_body", (0.92, 0.87, 0.76), 0.3)
    ink = material("tile_ink", (0.25, 0.05, 0.05), 0.5)
    wood = material("frame_wood", (0.20, 0.11, 0.06), 0.4)
    floor_mat = material("frame_floor", (0.03, 0.05, 0.04), 0.9)

    print("Building tiles…")
    build_tiles(body, ink, font)
    print("Building frames…")
    for n in SIZES:
        build_frame(n, wood, floor_mat)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    kw = dict(
        filepath=OUT, export_format="GLB", export_yup=True, export_apply=True,
        export_texcoords=False, export_normals=True, export_materials="EXPORT",
        export_cameras=False, export_lights=False, export_extras=True,
    )
    try:
        bpy.ops.export_scene.gltf(**kw)
    except TypeError as e:
        print("exporter arg fallback:", e)
        bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB")
    print(f"Saved {OUT} ({os.path.getsize(OUT) / 1024:.0f} KB)")


main()
