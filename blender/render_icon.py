"""
Рендер иконки приложения в Cycles: костяшка «15» на ореховой доске.

  blender -b --factory-startup -P blender/render_icon.py -- public/models/puzzle.glb out.png [size] [samples]
"""
import bpy
import math
import os
import sys

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
GLB = os.path.abspath(argv[0] if argv else "public/models/puzzle.glb")
OUT = os.path.abspath(argv[1] if len(argv) > 1 else "icon_render.png")
SIZE = int(argv[2]) if len(argv) > 2 else 1024
SAMPLES = int(argv[3]) if len(argv) > 3 else 160
NUMBERS = [int(x) for x in argv[4].split(",")] if len(argv) > 4 else [15]

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
bpy.ops.import_scene.gltf(filepath=GLB)


def nodes_mat(name):
    m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:
        pass
    nt = m.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    return m, nt, bsdf


def set_in(bsdf, name, value):
    if name in bsdf.inputs:
        bsdf.inputs[name].default_value = value


# --- материалы
ivory, nt, b = nodes_mat("ivory")
set_in(b, "Base Color", (0.86, 0.78, 0.62, 1))
set_in(b, "Roughness", 0.26)
set_in(b, "Coat Weight", 0.6)
set_in(b, "Coat Roughness", 0.08)
set_in(b, "Subsurface Weight", 0.25)
set_in(b, "Subsurface Radius", (0.9, 0.6, 0.4))
set_in(b, "Subsurface Scale", 0.02)
noise = nt.nodes.new("ShaderNodeTexNoise")
noise.inputs["Scale"].default_value = 6.0
ramp = nt.nodes.new("ShaderNodeValToRGB")
ramp.color_ramp.elements[0].color = (0.80, 0.71, 0.55, 1)
ramp.color_ramp.elements[1].color = (0.89, 0.82, 0.67, 1)
nt.links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
nt.links.new(ramp.outputs["Color"], b.inputs["Base Color"])

ink, nt, b = nodes_mat("ink")
set_in(b, "Base Color", (0.16, 0.012, 0.018, 1))
set_in(b, "Roughness", 0.42)

wood, nt, b = nodes_mat("walnut")
wave = nt.nodes.new("ShaderNodeTexWave")
wave.wave_type = "RINGS"
wave.inputs["Scale"].default_value = 1.1
wave.inputs["Distortion"].default_value = 4.0
wave.inputs["Detail"].default_value = 4.0
wave.inputs["Detail Scale"].default_value = 0.8
mapping = nt.nodes.new("ShaderNodeMapping")
mapping.inputs["Scale"].default_value = (0.12, 1.6, 1.0)
mapping.inputs["Location"].default_value = (3.0, 1.0, 0.0)
coord = nt.nodes.new("ShaderNodeTexCoord")
nt.links.new(coord.outputs["Object"], mapping.inputs["Vector"])
nt.links.new(mapping.outputs["Vector"], wave.inputs["Vector"])
wr = nt.nodes.new("ShaderNodeValToRGB")
wr.color_ramp.elements[0].color = (0.05, 0.022, 0.011, 1)
wr.color_ramp.elements[1].color = (0.12, 0.055, 0.026, 1)
nt.links.new(wave.outputs["Fac"], wr.inputs["Fac"])
nt.links.new(wr.outputs["Color"], b.inputs["Base Color"])
set_in(b, "Roughness", 0.32)
set_in(b, "Coat Weight", 0.5)
set_in(b, "Coat Roughness", 0.12)

# --- объекты: оставляем нужные костяшки, остальное удаляем
keep = {f"tile_{n}" for n in NUMBERS}
for ob in list(bpy.data.objects):
    if ob.name not in keep:
        bpy.data.objects.remove(ob, do_unlink=True)

tiles = [bpy.data.objects[f"tile_{n}"] for n in NUMBERS]
for i, t in enumerate(tiles):
    t.rotation_mode = "XYZ"
    t.rotation_euler = (math.radians(90), 0, 0)  # glTF Y-up -> Blender Z-up уже учтён импортом
    for slot in t.material_slots:
        slot.material = ink if "ink" in slot.material.name else ivory
    for p in t.data.polygons:
        p.use_smooth = True

if len(tiles) == 1:
    tiles[0].rotation_euler = (0, 0, math.radians(-14))
    tiles[0].location = (0, 0, 0)
else:
    # раскладка для превью: в ряд
    for i, t in enumerate(tiles):
        t.rotation_euler = (0, 0, 0)
        t.location = ((i % 5) * 1.0 - 2.0, -(i // 5) * 1.0 + 1.0, 0)

felt, nt, b = nodes_mat("felt")
fn = nt.nodes.new("ShaderNodeTexNoise")
fn.inputs["Scale"].default_value = 9.0
fn.inputs["Detail"].default_value = 8.0
fr = nt.nodes.new("ShaderNodeValToRGB")
fr.color_ramp.elements[0].color = (0.022, 0.015, 0.011, 1)
fr.color_ramp.elements[1].color = (0.04, 0.028, 0.02, 1)
nt.links.new(fn.outputs["Fac"], fr.inputs["Fac"])
nt.links.new(fr.outputs["Color"], b.inputs["Base Color"])
set_in(b, "Roughness", 0.85)
set_in(b, "Sheen Weight", 0.6)
set_in(b, "Sheen Tint", (0.45, 0.36, 0.3, 1))

bpy.ops.mesh.primitive_plane_add(size=30, location=(0, 0, 0))
plane = bpy.context.active_object
plane.data.materials.append(felt if len(NUMBERS) == 1 else wood)

# --- свет
def area(name, loc, rot, size, power, color=(1, 1, 1)):
    ld = bpy.data.lights.new(name, "AREA")
    ld.shape = "DISK"
    ld.size = size
    ld.energy = power
    ld.color = color
    ob = bpy.data.objects.new(name, ld)
    scene.collection.objects.link(ob)
    ob.location = loc
    ob.rotation_euler = rot
    return ob

def look_at(ob, target):
    from mathutils import Vector
    d = Vector(target) - ob.location
    ob.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()

key = area("key", (-2.6, 2.4, 4.2), (0, 0, 0), 3.0, 420, (1.0, 0.93, 0.84))
look_at(key, (0, 0, 0))
rim = area("rim", (3.2, 3.0, 1.6), (0, 0, 0), 2.0, 160, (0.80, 0.88, 1.0))
look_at(rim, (0, 0, 0.2))
fill = area("fill", (1.5, -4.0, 3.0), (0, 0, 0), 4.0, 60)
look_at(fill, (0, 0, 0))

world = bpy.data.worlds.new("w")
scene.world = world
try:
    world.use_nodes = True
except Exception:
    pass
bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
bg.inputs["Color"].default_value = (0.012, 0.010, 0.009, 1)

# --- камера
cam_d = bpy.data.cameras.new("cam")
cam = bpy.data.objects.new("cam", cam_d)
scene.collection.objects.link(cam)
scene.camera = cam
if len(tiles) == 1:
    cam.location = (0.0, -1.32, 2.0)
    look_at(cam, (0, 0.02, 0.12))
    cam_d.lens = 50
    cam_d.dof.use_dof = True
    cam_d.dof.focus_object = tiles[0]
    cam_d.dof.aperture_fstop = 2.2
else:
    cam.location = (0.0, -3.2, 6.5)
    look_at(cam, (0, 0.2, 0))
    cam_d.lens = 50

scene.render.engine = "CYCLES"
scene.cycles.samples = SAMPLES
scene.cycles.use_denoising = True
scene.render.resolution_x = SIZE
scene.render.resolution_y = SIZE if len(tiles) == 1 else int(SIZE * 0.75)
scene.render.film_transparent = False
scene.render.image_settings.file_format = "PNG"
try:
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
except Exception:
    pass
scene.render.filepath = OUT
bpy.ops.render.render(write_still=True)
print("Rendered", OUT)
