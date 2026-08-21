# rig_catfish_blender.py
# Programmatic rig for the catfish model when Blender's "Automatic Weights" fails
# (bone-heat can't solve meshes with holes / overlapping shells like this one).
#
# Usage: open your .blend with the catfish mesh + metarig armature, then either
#   blender catfish.blend --background --python tools/rig_catfish_blender.py
# or paste into Blender's Scripting tab and Run. Select nothing; it finds
# objects by type. Creates: distance-based vertex weights, armature modifier,
# and three actions: "swim" (loop), "bite" (one-shot), "flicker" (loop).
#
# Same algorithm as the pipeline that produced catfish_rigged.glb:
#   per-vertex distance to bone segments -> (mult/(d+eps))^3 falloff,
#   top-6, 3 Laplacian smoothing passes over mesh edges, top-4, normalize.

import bpy, math
from mathutils import Vector, Quaternion

EPS = 0.008
POWER = 3.0
SMOOTH_ITERS = 3

def mult_for(name):
    if name.startswith('spine'):        return 2.4
    if name == 'face':                  return 1.7
    if name == 'jaw':                   return 1.3
    if name.startswith('chin'):         return 1.1
    if name.startswith('shoulder'):     return 1.3
    if name.startswith('forehead.L.0'): return 0.9   # lantern stalk
    if name.startswith('eye'):          return 0.8
    return 0.85                                        # whiskers / face detail

# ---------- find objects ----------
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
mesh = next(o for o in bpy.data.objects if o.type == 'MESH')
me = mesh.data

# ---------- bone segments in world space ----------
segs = []  # (name, head_world, tail_world, mult)
for b in arm.data.bones:
    if not b.use_deform:
        continue
    h = arm.matrix_world @ b.head_local
    t = arm.matrix_world @ b.tail_local
    segs.append((b.name, h, t, mult_for(b.name)))

def seg_dist(p, a, b):
    ab = b - a
    denom = ab.dot(ab)
    t = 0.0 if denom < 1e-12 else max(0.0, min(1.0, (p - a).dot(ab) / denom))
    return (p - (a + ab * t)).length

# ---------- raw weights ----------
mw = mesh.matrix_world
nb = len(segs)
weights = []  # per vertex: list of (bone_idx, w)
for v in me.vertices:
    p = mw @ v.co
    scored = []
    for bi, (name, h, t, m) in enumerate(segs):
        d = seg_dist(p, h, t)
        scored.append((bi, (m / (d + EPS)) ** POWER))
    scored.sort(key=lambda x: -x[1])
    top = scored[:6]
    s = sum(w for _, w in top)
    weights.append({bi: w / s for bi, w in top})

# ---------- Laplacian smoothing over edges ----------
nbrs = [[] for _ in me.vertices]
for e in me.edges:
    a, b = e.vertices
    nbrs[a].append(b); nbrs[b].append(a)
for _ in range(SMOOTH_ITERS):
    new = []
    for vi in range(len(me.vertices)):
        if not nbrs[vi]:
            new.append(weights[vi]); continue
        accum = {}
        for nj in nbrs[vi]:
            for bi, w in weights[nj].items():
                accum[bi] = accum.get(bi, 0.0) + w
        inv = 1.0 / len(nbrs[vi])
        merged = {}
        for bi, w in weights[vi].items():
            merged[bi] = merged.get(bi, 0.0) + 0.5 * w
        for bi, w in accum.items():
            merged[bi] = merged.get(bi, 0.0) + 0.5 * w * inv
        s = sum(merged.values())
        new.append({bi: w / s for bi, w in merged.items()})
    weights = new

# ---------- top-4, write vertex groups ----------
for vg in list(mesh.vertex_groups):
    mesh.vertex_groups.remove(vg)
groups = [mesh.vertex_groups.new(name=s[0]) for s in segs]
for vi, wmap in enumerate(weights):
    top = sorted(wmap.items(), key=lambda x: -x[1])[:4]
    s = sum(w for _, w in top)
    for bi, w in top:
        groups[bi].add([vi], w / s, 'REPLACE')

# ---------- armature modifier / parent ----------
mesh.parent = arm
for m in list(mesh.modifiers):
    if m.type == 'ARMATURE':
        mesh.modifiers.remove(m)
mod = mesh.modifiers.new('Armature', 'ARMATURE')
mod.object = arm
print('Weights done:', nb, 'bones,', len(me.vertices), 'verts')

# =====================================================================
# Animations: rotations authored as world-axis deltas composed onto rest
# =====================================================================
FPS = 24
bpy.context.scene.render.fps = FPS

def world_delta_quat(pb, axis_world, ang):
    """local pose quaternion producing a world-space rotation `ang` about axis_world"""
    qw = (arm.matrix_world @ pb.bone.matrix_local).to_quaternion()
    d = Quaternion(Vector(axis_world), ang)
    return qw.inverted() @ d @ qw

def key_rot(pb, frame, axis_world, ang):
    pb.rotation_mode = 'QUATERNION'
    pb.rotation_quaternion = world_delta_quat(pb, axis_world, ang)
    pb.keyframe_insert('rotation_quaternion', frame=frame)

def new_action(name):
    act = bpy.data.actions.new(name)
    arm.animation_data_create()
    arm.animation_data.action = act
    for pb in arm.pose.bones:
        pb.rotation_mode = 'QUATERNION'
        pb.rotation_quaternion = (1, 0, 0, 0)
        pb.scale = (1, 1, 1)
    return act

X, Y, Z = (1,0,0), (0,1,0), (0,0,1)
TWO_PI = 2 * math.pi
pose = arm.pose.bones

# ---------------- swim (2.4 s loop) ----------------
new_action('swim')
T = 2.4; nfr = int(T * FPS); w = TWO_PI / T
spine_amp = {'spine.001':0.26,'spine.002':0.17,'spine.003':0.10,
             'spine.004':0.065,'spine.005':0.05,'spine.006':0.04,'face':0.028}
whisker_chains = [['brow.T.L.001','brow.T.L.002','brow.T.L.003'],
                  ['brow.T.R.001','brow.T.R.002','brow.T.R.003'],
                  ['cheek.T.L','cheek.T.L.001','nose.L','nose.L.001'],
                  ['cheek.T.R','cheek.T.R.001','nose.R','nose.R.001'],
                  ['jaw.L','jaw.L.001'],['jaw.R','jaw.R.001']]
lantern = ['forehead.L.%03d' % n for n in range(6, 18)]
for f in range(nfr + 1):
    t = f / FPS
    for nm, A in spine_amp.items():
        z = (arm.matrix_world @ pose[nm].bone.head_local).z
        key_rot(pose[nm], f, Y, A * math.sin(w*t - z*4.5))
    key_rot(pose['shoulder.L'], f, Z,  0.22 * math.sin(w*t + 0.9))
    key_rot(pose['shoulder.R'], f, Z, -0.22 * math.sin(w*t + 0.9))
    for chain in whisker_chains:
        for d, nm in enumerate(chain):
            key_rot(pose[nm], f, Y, 0.055 * math.sin(w*t + d*0.8 + 1.7))
    for d, nm in enumerate(['nose','nose.001','nose.002','nose.003']):
        key_rot(pose[nm], f, X, 0.06 * math.sin(w*t*1.5 + d*0.9))
    for d, nm in enumerate(lantern):
        key_rot(pose[nm], f, X, 0.03*math.sin(w*t*0.5 + d*0.45) + 0.012*math.sin(w*t + d*0.3))

# ---------------- bite (1.1 s one-shot) ----------------
new_action('bite')
kt = [0,0.12,0.22,0.34,0.42,0.5,0.62,0.8,1.1]
jaw_open   = [0,0.18,0.58,0.58,-0.07,0.05,0,0,0]
head_pitch = [0,-0.05,-0.10,-0.10,0.06,0.02,0,0,0]
flare      = [0,0.08,0.16,0.16,-0.03,0.02,0,0,0]
def interp(kt, kv, t):
    for i in range(1, len(kt)):
        if t <= kt[i]:
            f = (t - kt[i-1]) / (kt[i] - kt[i-1])
            return kv[i-1] + (kv[i] - kv[i-1]) * f
    return kv[-1]
for f in range(int(1.1 * FPS) + 1):
    t = f / FPS
    key_rot(pose['jaw'], f, X, interp(kt, jaw_open, t))
    for nm, s in [('face',1.0),('spine.006',0.6),('spine.005',0.4)]:
        key_rot(pose[nm], f, X, interp(kt, head_pitch, t) * s)
    for nm, s in [('brow.T.L.001',1),('brow.T.R.001',-1),('cheek.T.L',1),
                  ('cheek.T.R',-1),('jaw.L',1),('jaw.R',-1)]:
        key_rot(pose[nm], f, Z, interp(kt, flare, t) * s)

# ---------------- flicker (1.8 s loop) ----------------
new_action('flicker')
ft = [0,0.15,0.3,0.5,0.62,0.8,1.0,1.15,1.4,1.6,1.8]
fs = [1,1.22,0.9,1.32,1.0,1.14,0.82,1.25,0.95,1.1,1]
bulb = pose['forehead.L.017']
for tt, ss in zip(ft, fs):
    bulb.scale = (ss, ss, ss)
    bulb.keyframe_insert('scale', frame=tt * FPS)
fw = TWO_PI / 1.8
for f in range(int(1.8 * FPS) + 1):
    t = f / FPS
    for d, nm in enumerate(['forehead.L.014','forehead.L.015','forehead.L.016','forehead.L.017']):
        key_rot(pose[nm], f, Z, 0.018*math.sin(fw*t*7 + d*1.3) + 0.01*math.sin(fw*t*3 + d))

# push all actions to NLA so the glTF exporter picks them up
arm.animation_data.action = None
for act in ('swim','bite','flicker'):
    tr = arm.animation_data.nla_tracks.new()
    tr.name = act
    tr.strips.new(act, 1, bpy.data.actions[act])
print('Actions created: swim, bite, flicker. Export with glTF (Animation mode: NLA tracks).')
