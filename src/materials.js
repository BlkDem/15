import * as THREE from 'three';

/*
 * «Твёрдые» процедурные материалы: текстура вычисляется в 3D по объектным координатам
 * (как настоящая древесина/камень — кольца видны и на торцах, никаких швов на фасках).
 * Основа — MeshPhysicalMaterial, в который через onBeforeCompile подмешивается
 * цвет, шероховатость и микрорельеф (bump по производным).
 */

const KIND = { wood: 1, ivory: 2, marble: 3, felt: 4, plain: 5 };

const NOISE = /* glsl */ `
vec3 sn_mod289(vec3 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 sn_mod289(vec4 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 sn_permute(vec4 x){ return sn_mod289(((x * 34.0) + 1.0) * x); }
vec4 sn_taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v){
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = sn_mod289(i);
  vec4 p = sn_permute(sn_permute(sn_permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = sn_taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`;

const SOLID = /* glsl */ `
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uColC;
uniform float uFreq;
uniform float uRoughBase;
uniform float uRoughVar;
uniform float uBump;
uniform float uBrushed;
uniform float uColorVar;
uniform float uMiter;
uniform float uAOMode;
uniform vec4 uAOParams; // x: n/2, y: внутренняя полуширина рамки, z: внешняя полуширина, w: радиус угла
varying vec3 vSolidPos;
varying vec3 vLocalPos;
varying vec3 vLocalNormal;

struct Solid { vec3 color; float rough; float height; };

/*
 * Процедурная «запечённая» окклюзия: геометрия известна заранее, поэтому затенение
 * пазов, дна колодца, стенок рамки и контактная тень на столе считаются аналитически.
 */
float solidAO(vec3 p, vec3 n){
  if (uAOMode < 0.5) return 1.0;
  if (uAOMode < 1.5) {
    // костяшка: бока и нижняя фаска утоплены в соседей
    float h = clamp(p.y / 0.30, 0.0, 1.0);
    float side = 0.1 + 0.9 * pow(smoothstep(0.0, 1.0, h), 1.7);
    return mix(side, 1.0, smoothstep(0.35, 0.97, n.y));
  }
  if (uAOMode < 2.5) {
    // дно колодца: темнее у границ клеток (там стоят костяшки и стенки)
    vec2 u = p.xz + uAOParams.x;
    vec2 d = abs(u - floor(u + 0.5));
    float m = min(d.x, d.y);
    float wall = uAOParams.y - max(abs(p.x), abs(p.z));
    m = min(m, max(wall, 0.0));
    return mix(0.18, 1.0, smoothstep(0.0, 0.42, m));
  }
  if (uAOMode < 3.5) {
    // рамка: внутренние стенки у дна + цоколь у стола
    float r = max(abs(p.x), abs(p.z));
    float inner = step(r, uAOParams.y + 0.07);
    float aoIn = mix(0.22, 1.0, smoothstep(0.0, 0.36, p.y));
    float aoOut = mix(0.45, 1.0, smoothstep(-0.16, -0.02, p.y));
    return mix(aoOut, aoIn, inner);
  }
  // стол: мягкая контактная тень вокруг рамки (SDF скруглённого квадрата)
  vec2 q = abs(p.xz) - (uAOParams.z - uAOParams.w);
  float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uAOParams.w;
  float a = smoothstep(-0.05, 1.1, sd);
  return mix(0.28, 1.0, sqrt(a));
}

// гасим детали, которые мельче пикселя (против мерцания)
float solidAA(float fw, float freq){ return 1.0 - smoothstep(0.18, 0.55, fw * freq); }

Solid solidSample(vec3 p){
  Solid s;
  float fw = length(fwidth(p));
#if SOLID_KIND == 1
  // ---------- древесина: ось ствола вдоль X, годичные кольца в плоскости YZ
  vec3 q = p;
  float seam = 0.0;
  if (uMiter > 0.5) {
    // рамка «на ус»: у боковых планок волокна идут вдоль Z, стык по диагонали
    seam = 1.0 - smoothstep(0.0, 0.004 + fw * 1.5, abs(abs(q.x) - abs(q.z)));
    if (abs(q.x) > abs(q.z)) q = vec3(q.z + 13.7, q.y + 0.31, -q.x + 2.9);
  }
  float warp = snoise(q * vec3(0.09, 0.7, 0.7)) * 0.32 + snoise(q * vec3(0.5, 2.6, 2.6)) * 0.05;
  float r = length(q.yz + vec2(3.1, 5.3)) + warp;
  float ring = fract(r * uFreq);
  float late = smoothstep(0.35, 0.92, ring) * (1.0 - smoothstep(0.955, 1.0, ring));
  late = late * late;
  float aFib = solidAA(fw, 28.0);
  float aPore = solidAA(fw, 95.0);
  float fib = snoise(q * vec3(0.9, 28.0, 28.0)) * aFib;
  float pores = smoothstep(0.35, 0.95, snoise(q * vec3(3.5, 95.0, 95.0))) * aPore * (1.0 - late * 0.6);
  float tone = snoise(q * vec3(0.22, 1.6, 1.6));
  float ray = smoothstep(0.82, 0.97, snoise(q * vec3(0.6, 1.2, 14.0))) * 0.5;
  vec3 col = mix(uColA, uColB, late * 0.88);
  col *= 1.0 + tone * uColorVar + fib * 0.06 + ray * 0.08;
  col = mix(col, uColC, pores * 0.55);
  col *= 1.0 - seam * 0.55;
  s.color = max(col, vec3(0.0));
  s.rough = uRoughBase + late * uRoughVar * 0.5 + pores * uRoughVar;
  s.height = -pores * 1.0 + fib * 0.25 - late * 0.15 - seam * 1.5;
#elif SOLID_KIND == 2
  // ---------- слоновая кость / смола: мягкие облака, тонкие волокна, едва заметная пыль
  vec3 q = p * uFreq;
  float n = snoise(q * 1.7) * 0.6 + snoise(q * 3.9) * 0.25 + snoise(q * 9.0) * 0.12;
  float lines = snoise(q * vec3(0.9, 6.5, 0.9) + snoise(q * 2.0) * 0.6);
  float aFine = solidAA(fw, 70.0);
  float fine = snoise(q * 70.0) * aFine;
  vec3 col = mix(uColA, uColB, smoothstep(-0.7, 0.9, n));
  col = mix(col, uColC, smoothstep(0.55, 1.0, lines) * 0.1);
  col *= 1.0 + fine * 0.012;
  s.color = col;
  s.rough = uRoughBase + (n * 0.5 + 0.5) * uRoughVar + fine * 0.02;
  s.height = fine * 0.15 + n * 0.05;
#elif SOLID_KIND == 3
  // ---------- мрамор (каррара): облачная серая дымка + редкие мягкие прожилки
  vec3 q = p * uFreq;
  float t = 0.0; float amp = 0.5; vec3 f = q * 0.7;
  for (int i = 0; i < 5; i++) { t += abs(snoise(f)) * amp; f *= 2.07; amp *= 0.5; }
  float a1 = (q.x * 0.9 + q.z * 0.55 + q.y * 0.3) * 1.7 + t * 3.2;
  float vein = pow(1.0 - abs(sin(a1)), 18.0);
  float halo = pow(1.0 - abs(sin(a1)), 4.0);
  float a2 = (q.z * 1.3 - q.x * 0.45) * 2.3 + t * 5.0 + 1.7;
  float vein2 = pow(1.0 - abs(sin(a2)), 60.0) * smoothstep(-0.2, 0.6, snoise(q * 0.5 + 3.0));
  float cloud = snoise(q * 0.45) * 0.5 + 0.5;
  float mottle = snoise(q * 2.6) * 0.5 + snoise(q * 7.0) * 0.25;
  vec3 col = mix(uColA, uColC, smoothstep(0.35, 0.95, cloud) * 0.55 + mottle * 0.06);
  col = mix(col, mix(uColC, uColB, 0.35), halo * 0.22);
  col = mix(col, uColB, clamp(vein * 0.8 + vein2 * 0.55, 0.0, 1.0));
  s.color = col;
  s.rough = uRoughBase + vein * uRoughVar;
  s.height = -vein * 0.1;
#elif SOLID_KIND == 4
  // ---------- войлок / бархат: высокочастотные волокна
  vec3 q = p * uFreq;
  float aF = solidAA(fw, uFreq * 60.0);
  float fib = (snoise(q * 60.0) * 0.6 + snoise(q * vec3(140.0, 30.0, 140.0)) * 0.4) * aF;
  float blot = snoise(q * 0.9) * 0.6 + snoise(q * 3.0) * 0.4;
  vec3 col = uColA * (1.0 + blot * uColorVar + fib * 0.12);
  s.color = col;
  s.rough = uRoughBase + fib * uRoughVar;
  s.height = fib;
#else
  // ---------- гладкий лак / металл: лёгкая неоднородность цвета и шероховатости (отпечатки, шлифовка)
  vec3 q = p * uFreq;
  float smudge = snoise(q * 1.3) * 0.6 + snoise(q * 4.1) * 0.4;
  float aB = solidAA(fw, 160.0);
  float brush = snoise(vec3(q.x * 0.6, q.y * 160.0, q.z * 160.0)) * aB;
  vec3 col = uColA * (1.0 + smudge * uColorVar + brush * uBrushed * 0.08);
  s.color = col;
  s.rough = uRoughBase + (smudge * 0.5 + 0.5) * uRoughVar + brush * uBrushed * 0.12;
  s.height = brush * uBrushed;
#endif
  return s;
}

vec3 solidPerturb(vec3 surfPos, vec3 surfNorm, vec2 dHdxy, float faceDir){
  vec3 sx = dFdx(surfPos);
  vec3 sy = dFdy(surfPos);
  vec3 r1 = cross(sy, surfNorm);
  vec3 r2 = cross(surfNorm, sx);
  float det = dot(sx, r1) * faceDir;
  vec3 grad = sign(det) * (dHdxy.x * r1 + dHdxy.y * r2);
  return normalize(abs(det) * surfNorm - grad);
}
`;

/** Общие для всех материалов параметры окклюзии (зависят от размера поля). */
export const AO_PARAMS = { value: new THREE.Vector4(2, 2.015, 2.55, 0.37) };

export function setBoardAO(n) {
  const inner = n + 0.03;
  const outer = inner + 0.8 + 0.14;
  AO_PARAMS.value.set(n / 2, inner / 2, outer / 2, 0.37);
}

const AO_MODE = { tileBody: 1, tileInk: 1, floor: 2, frame: 3, table: 4 };

/**
 * @param {keyof KIND} kind
 * @param {object} o
 */
export function solidMaterial(kind, o = {}) {
  const id = KIND[kind];
  const m = new THREE.MeshPhysicalMaterial(o.physical || {});
  const uniforms = {
    uMiter: { value: o.miter ? 1 : 0 },
    uAOMode: { value: AO_MODE[o.role] ?? 0 },
    uAOParams: AO_PARAMS,
    uColA: { value: new THREE.Color(o.a ?? '#ffffff') },
    uColB: { value: new THREE.Color(o.b ?? o.a ?? '#ffffff') },
    uColC: { value: new THREE.Color(o.c ?? o.b ?? o.a ?? '#ffffff') },
    uFreq: { value: o.freq ?? 1 },
    uRoughBase: { value: o.rough ?? 0.5 },
    uRoughVar: { value: o.roughVar ?? 0.1 },
    uBump: { value: o.bump ?? 0 },
    uBrushed: { value: o.brushed ?? 0 },
    uColorVar: { value: o.colorVar ?? 0.04 },
  };
  m.userData.solid = uniforms;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aSeed;\nvarying vec3 vSolidPos;\nvarying vec3 vLocalPos;\nvarying vec3 vLocalNormal;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          float sa = sin(aSeed.w), ca = cos(aSeed.w);
          vec3 lp = position;
          lp.xz = vec2(ca * lp.x - sa * lp.z, sa * lp.x + ca * lp.z);
          vSolidPos = lp + aSeed.xyz;
          vLocalPos = position;
          vLocalNormal = normal;
        }`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n#define SOLID_KIND ${id}\n${NOISE}\n${SOLID}`)
      .replace('#include <map_fragment>', '#include <map_fragment>\nSolid solid = solidSample(vSolidPos);\ndiffuseColor.rgb = solid.color;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp(solid.rough, 0.03, 1.0);')
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        if (uBump > 0.0) {
          vec2 dH = vec2(dFdx(solid.height), dFdy(solid.height)) * uBump;
          normal = solidPerturb(-vViewPosition, normal, dH, faceDirection);
        }`,
      )
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
        {
          float sao = solidAO(vLocalPos, normalize(vLocalNormal));
          reflectedLight.indirectDiffuse *= sao;
          reflectedLight.indirectSpecular *= sao * sao;
          float dao = mix(1.0, sao, 0.65);
          reflectedLight.directDiffuse *= dao;
          reflectedLight.directSpecular *= dao;
          #ifdef USE_CLEARCOAT
            clearcoatSpecularIndirect *= sao * sao;
            clearcoatSpecularDirect *= dao;
          #endif
          #ifdef USE_SHEEN
            sheenSpecularIndirect *= sao;
            sheenSpecularDirect *= dao;
          #endif
        }`,
      );
  };
  m.customProgramCacheKey = () => `solid-${id}`;
  m.name = o.name || kind;
  return m;
}

/** Добавляет геометрии атрибут aSeed (смещение и поворот 3D-текстуры). */
export function setSeed(geometry, x = 0, y = 0, z = 0, w = 0) {
  const count = geometry.attributes.position.count;
  const arr = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    arr[i * 4] = x;
    arr[i * 4 + 1] = y;
    arr[i * 4 + 2] = z;
    arr[i * 4 + 3] = w;
  }
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(arr, 4));
}

// --------------------------------------------------------------------------- темы

export const THEMES = [
  {
    id: 'ivory',
    name: 'Слоновая кость',
    hint: 'Орех, лак, бордовая гравировка',
    sound: 'ivory',
    swatch: { tile: '#efe3c8', ink: '#5a1418', frame: '#4a2a17' },
    ui: { accent: '#d8b27a' },
    make: () => ({
      tileBody: solidMaterial('ivory', {
        a: '#e6d7b9', b: '#ddcbaa', c: '#c9b38c', freq: 0.8, rough: 0.34, roughVar: 0.1, bump: 0.0012,
        physical: { clearcoat: 0.45, clearcoatRoughness: 0.12, sheen: 0.25, sheenColor: new THREE.Color('#fff4de'), sheenRoughness: 0.6, ior: 1.54 },
      }),
      tileInk: solidMaterial('plain', {
        a: '#470b10', freq: 2.0, rough: 0.38, roughVar: 0.12, colorVar: 0.08,
        physical: { clearcoat: 0.4, clearcoatRoughness: 0.25 },
      }),
      frame: solidMaterial('wood', {
        a: '#55331f', b: '#28140a', c: '#120703', freq: 9.0, rough: 0.4, roughVar: 0.18, colorVar: 0.13, bump: 0.003,
        physical: { clearcoat: 0.6, clearcoatRoughness: 0.2 },
      }),
      floor: solidMaterial('felt', {
        a: '#14281f', freq: 1.0, rough: 0.92, roughVar: 0.06, colorVar: 0.10, bump: 0.002,
        physical: { sheen: 1.0, sheenColor: new THREE.Color('#3b6b56'), sheenRoughness: 0.5 },
      }),
      table: solidMaterial('felt', {
        a: '#2a2420', freq: 0.6, rough: 0.95, roughVar: 0.05, colorVar: 0.16, bump: 0.0035,
        physical: { sheen: 0.8, sheenColor: new THREE.Color('#5d5047'), sheenRoughness: 0.55 },
      }),
    }),
  },
  {
    id: 'maple',
    name: 'Клён',
    hint: 'Светлый клён, выжженные цифры, венге',
    sound: 'wood',
    swatch: { tile: '#e2c28f', ink: '#2b1608', frame: '#24140b' },
    ui: { accent: '#e2be86' },
    make: () => ({
      tileBody: solidMaterial('wood', {
        a: '#e3c898', b: '#cfa26c', c: '#a47645', freq: 11.0, rough: 0.48, roughVar: 0.12, colorVar: 0.07, bump: 0.0025,
        physical: { clearcoat: 0.35, clearcoatRoughness: 0.3 },
      }),
      tileInk: solidMaterial('plain', {
        a: '#2a1307', freq: 3.0, rough: 0.82, roughVar: 0.12, colorVar: 0.25,
      }),
      frame: solidMaterial('wood', {
        a: '#45291a', b: '#140904', c: '#0a0402', freq: 13.0, rough: 0.42, roughVar: 0.2, colorVar: 0.1, bump: 0.003,
        physical: { clearcoat: 0.55, clearcoatRoughness: 0.22 },
      }),
      floor: solidMaterial('felt', {
        a: '#3a1714', freq: 1.0, rough: 0.92, roughVar: 0.06, colorVar: 0.10, bump: 0.002,
        physical: { sheen: 1.0, sheenColor: new THREE.Color('#7a3a30'), sheenRoughness: 0.5 },
      }),
      table: solidMaterial('felt', {
        a: '#22262b', freq: 0.6, rough: 0.95, roughVar: 0.05, colorVar: 0.14, bump: 0.0035,
        physical: { sheen: 0.8, sheenColor: new THREE.Color('#4c5560'), sheenRoughness: 0.55 },
      }),
    }),
  },
  {
    id: 'obsidian',
    name: 'Обсидиан',
    hint: 'Чёрный лак, золото, бронза',
    sound: 'glass',
    swatch: { tile: '#141417', ink: '#e0b35c', frame: '#5a4632' },
    ui: { accent: '#e0b35c' },
    make: () => ({
      tileBody: solidMaterial('plain', {
        a: '#0c0c0f', freq: 1.4, rough: 0.14, roughVar: 0.18, colorVar: 0.15,
        physical: { clearcoat: 1.0, clearcoatRoughness: 0.03, ior: 1.6 },
      }),
      tileInk: solidMaterial('plain', {
        a: '#e8b65c', freq: 3.0, rough: 0.22, roughVar: 0.14, colorVar: 0.06,
        physical: { metalness: 1.0 },
      }),
      frame: solidMaterial('plain', {
        a: '#5e4a35', freq: 1.0, rough: 0.32, roughVar: 0.05, colorVar: 0.025, brushed: 1.0, bump: 0.0005,
        physical: { metalness: 1.0 },
      }),
      floor: solidMaterial('felt', {
        a: '#0f0d0c', freq: 1.0, rough: 0.92, roughVar: 0.06, colorVar: 0.10, bump: 0.002,
        physical: { sheen: 1.0, sheenColor: new THREE.Color('#3a3026'), sheenRoughness: 0.5 },
      }),
      table: solidMaterial('felt', {
        a: '#141518', freq: 0.6, rough: 0.95, roughVar: 0.05, colorVar: 0.16, bump: 0.0035,
        physical: { sheen: 0.8, sheenColor: new THREE.Color('#3a3d44'), sheenRoughness: 0.55 },
      }),
    }),
  },
  {
    id: 'marble',
    name: 'Каррара',
    hint: 'Полированный мрамор, латунь',
    sound: 'stone',
    swatch: { tile: '#eeece7', ink: '#1b1b20', frame: '#c9a25a' },
    ui: { accent: '#d6b26a' },
    make: () => ({
      tileBody: solidMaterial('marble', {
        a: '#f2f0eb', b: '#77777a', c: '#cfcbc4', freq: 0.9, rough: 0.12, roughVar: 0.1,
        physical: { clearcoat: 0.55, clearcoatRoughness: 0.06, ior: 1.55 },
      }),
      tileInk: solidMaterial('plain', {
        a: '#17171b', freq: 2.0, rough: 0.42, roughVar: 0.1, colorVar: 0.1,
      }),
      frame: solidMaterial('plain', {
        a: '#c39a55', freq: 1.0, rough: 0.22, roughVar: 0.05, colorVar: 0.02, brushed: 0.5, bump: 0.0003,
        physical: { metalness: 1.0 },
      }),
      floor: solidMaterial('felt', {
        a: '#101b2e', freq: 1.0, rough: 0.92, roughVar: 0.06, colorVar: 0.10, bump: 0.002,
        physical: { sheen: 1.0, sheenColor: new THREE.Color('#33507a'), sheenRoughness: 0.5 },
      }),
      table: solidMaterial('felt', {
        a: '#1c1e23', freq: 0.6, rough: 0.95, roughVar: 0.05, colorVar: 0.16, bump: 0.0035,
        physical: { sheen: 0.8, sheenColor: new THREE.Color('#454a55'), sheenRoughness: 0.55 },
      }),
    }),
  },
];

const cache = new Map();
export function themeMaterials(id) {
  if (!cache.has(id)) {
    const t = THEMES.find((x) => x.id === id) || THEMES[0];
    const mats = t.make();
    for (const [role, m] of Object.entries(mats)) {
      m.userData.solid.uAOMode.value = AO_MODE[role] ?? 0;
      if (role === 'frame') m.userData.solid.uMiter.value = 1;
    }
    cache.set(id, mats);
  }
  return cache.get(id);
}

export function getTheme(id) {
  return THEMES.find((x) => x.id === id) || THEMES[0];
}
