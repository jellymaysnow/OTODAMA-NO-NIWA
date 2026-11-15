/* GLSL sources. Classic script (no modules) so index.html also works from file:// */
window.AV = window.AV || {};

AV.shaders = {
  // Fullscreen quad
  vertex: `
        attribute vec2 a_position;
        varying vec2 v_uv;
        void main() {
          v_uv = a_position * 0.5 + 0.5;
          gl_Position = vec4(a_position, 0.0, 1.0);
        }
      `,

  // Step 1: simulation update (drops ink, spreads, ages and dissolves it)
  // state texture: R = pigment, G = wetness, B = mica / gold leaf (light flecks), A = rim buildup
  sim: `
        precision highp float;
        varying vec2 v_uv;

        uniform sampler2D u_prevState;
        uniform vec2 u_texelSize;
        uniform float u_aspect;
        uniform float u_time;
        uniform float u_clear;

        uniform vec4 u_drops[16];    // xy = uv pos, z = radius, w = pigment amount
        uniform vec3 u_dropMeta[16]; // x = wetness, y = random seed (0..1), z = kind
        // kinds: 0 drop (note attack) | 1 feed (held note, tinted water) | 2 bleed (soft attack, wet-in-wet)
        //        3 water (no pigment: pushes damp ink outward -> bloom / back-run) | 4 sprout (growing tendril)
        //        5 light (mica / gold flecks) | 6 salt (pale crystal stars in wet ink) | 7 lift (damp brush lifts pigment)

        float hash(vec2 p) {
          p = fract(p * vec2(127.1, 311.7));
          p += dot(p, p + 34.23);
          return fract(p.x * p.y);
        }

        float noise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
            mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
            u.y
          );
        }

        float fbm(vec2 p) {
          float v = 0.0;
          float a = 0.5;
          for (int i = 0; i < 4; i++) {
            v += a * noise(p);
            p = p * 2.03 + vec2(1.3, 4.7);
            a *= 0.5;
          }
          return v;
        }

        // 塩: salt crystals pull pigment toward themselves, leaving small pale star shapes in a wet wash.
        // Some cells (about 4 sim texels wide) hold a crystal; returns how strongly this point is bleached.
        float saltPattern(vec2 uv, float seed) {
          vec2 g = uv / u_texelSize / 4.0;
          vec2 c = floor(g);
          float best = 0.0;
          for (int dy = -1; dy <= 1; dy++) {
            for (int dx = -1; dx <= 1; dx++) {
              vec2 cc = c + vec2(float(dx), float(dy));
              float h = hash(cc + seed * 31.0);
              if (h < 0.5) continue;
              vec2 p = cc + vec2(hash(cc + 1.7), hash(cc + 4.3));
              vec2 d = g - p;
              float r = 0.35 + 0.55 * hash(cc + 9.1);
              float star = 1.0 + 0.4 * sin(atan(d.y, d.x) * 5.0 + h * 6.2831);
              best = max(best, 1.0 - smoothstep(0.0, r * star, length(d)));
            }
          }
          return best;
        }

        vec3 evalDrop(vec2 uv, vec4 drop, vec3 meta) {
          if (drop.w <= 0.001 && meta.x <= 0.001) return vec3(0.0);   // empty slot (water drops have no pigment)
          vec2 d = (uv - drop.xy) * vec2(u_aspect, 1.0);
          if (length(d) > drop.z * 2.2) return vec3(0.0);           // outside any footprint: skip the noise

          // Every drop gets its own random rotation + stretch, so no two footprints match
          float ang = meta.y * 6.2831;
          float c = cos(ang);
          float s = sin(ang);
          vec2 r = vec2(c * d.x + s * d.y, -s * d.x + c * d.y);
          r.x *= 0.78 + 0.55 * fract(meta.y * 7.13);
          float dist = length(r);

          // Irregular footprint grown from noise in drop-local space (random offset per drop)
          vec2 q = r / max(drop.z, 0.001);
          float n1 = fbm(q * 1.6 + meta.y * 37.0);
          float n2 = fbm(q * 4.1 - meta.y * 19.0);
          float warp = (n1 - 0.5) * 0.95 + (n2 - 0.5) * 0.38;

          float effectiveRadius = drop.z * max(0.35, 1.0 + warp);
          // A soft attack (bleed) has no core at all: a wide feathered wash instead of a drop
          bool soft = (meta.z > 1.5 && meta.z < 2.5) || meta.z > 6.5;   // bleed and lift have feathered edges
          float mask = 1.0 - smoothstep(soft ? 0.0 : effectiveRadius * 0.12, effectiveRadius, dist);
          mask = soft ? mask * mask : mask * mask * (3.0 - 2.0 * mask);

          return vec3(mask * drop.w, mask * meta.x, mask);
        }

        void main() {
          if (u_clear > 0.5) {
            gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
            return;
          }

          vec4 center = texture2D(u_prevState, v_uv);

          // Smooth organic paper capillary flow
          vec2 p = v_uv * vec2(u_aspect, 1.0) * 4.5;
          float n1 = fbm(p + vec2(u_time * 0.015, -u_time * 0.012));
          float n2 = fbm(p + vec2(5.2, 1.3) - vec2(u_time * 0.01, u_time * 0.014));
          vec2 flowDir = (vec2(n1, n2) - 0.5) * 2.2;

          // Uneven paper permeability: ink creeps further along some fibres than others
          float perm = 0.5 + 1.0 * fbm(v_uv * vec2(u_aspect, 1.0) * 13.0 + 3.7);

          vec2 dx = vec2(u_texelSize.x, 0.0);
          vec2 dy = vec2(0.0, u_texelSize.y);

          vec4 nL = texture2D(u_prevState, v_uv - dx + flowDir * u_texelSize * 0.55);
          vec4 nR = texture2D(u_prevState, v_uv + dx + flowDir * u_texelSize * 0.55);
          vec4 nT = texture2D(u_prevState, v_uv + dy + flowDir * u_texelSize * 0.55);
          vec4 nB = texture2D(u_prevState, v_uv - dy + flowDir * u_texelSize * 0.55);

          vec4 nTL = texture2D(u_prevState, v_uv - dx + dy);
          vec4 nTR = texture2D(u_prevState, v_uv + dx + dy);
          vec4 nBL = texture2D(u_prevState, v_uv - dx - dy);
          vec4 nBR = texture2D(u_prevState, v_uv + dx - dy);

          vec4 avgNeighbors = (nL + nR + nT + nB) * 0.175 + (nTL + nTR + nBL + nBR) * 0.075;

          // Spreading is driven only by how wet the paper still is (fed notes keep it wet longer).
          // Once the paper is dry the spread is exactly zero: dried ink stays put and never melts.
          float localWetness = max(center.g, avgNeighbors.g);
          float wetSpread = mix(0.0, 0.58, smoothstep(0.05, 0.70, localWetness)) * perm;
          float spreadRate = clamp(wetSpread, 0.0, 0.72);

          float diffusedPigment = mix(center.r, avgNeighbors.r, spreadRate);
          // Pigment never fades or vanishes on its own, like ink on a real canvas

          float nextWetness = mix(center.g, avgNeighbors.g, 0.45) * 0.972;

          // Mica flecks are solid particles: they settle where they land and never spread or fade
          float nextMica = center.b;

          float edgeGradient = max(0.0, avgNeighbors.r - center.r) * 2.2;
          float nextRidge = clamp(center.a * 0.9985 + edgeGradient * smoothstep(0.05, 0.4, localWetness) * 0.14, 0.0, 1.0);

          float addedPigment = 0.0;
          float addedWetness = 0.0;
          float addedMica = 0.0;
          float saltLift = 0.0;   // salt: bleached crystal stars
          float lift = 0.0;       // lifting: pigment taken up by a damp brush
          vec2 radialPush = vec2(0.0);   // water drops push damp ink outward from their centre
          for (int i = 0; i < 16; i++) {
            vec3 e = evalDrop(v_uv, u_drops[i], u_dropMeta[i]);
            float kind = u_dropMeta[i].z;
            if (kind > 4.5 && kind < 5.5) {
              // 光 light: how much mica lies here; the individual fine flecks are drawn at screen resolution
              addedMica += e.x * 0.6;
              continue;
            }
            if (kind > 5.5 && kind < 6.5) {
              if (e.z > 0.0) saltLift = max(saltLift, saltPattern(v_uv, u_dropMeta[i].y) * e.z);
              continue;
            }
            if (kind > 6.5) {
              lift = max(lift, e.z * u_drops[i].w);
              addedWetness = max(addedWetness, e.z * u_dropMeta[i].x);
              continue;
            }
            // Sustained feed is tinted water, not ink: it stops adding colour once the
            // paper there already holds a pale wash, so long notes never build up a dark core.
            // Every other kind simply adds its pigment: layers keep deepening, like real ink.
            float cap = kind > 0.5 && kind < 1.5 ? clamp(1.0 - center.r / 0.2, 0.0, 1.0) : 1.0;
            addedPigment += e.x * cap;
            addedWetness = max(addedWetness, e.y);
            if (kind > 2.5 && kind < 3.5 && e.z > 0.0) {
              vec2 d = (v_uv - u_drops[i].xy) * vec2(u_aspect, 1.0);
              float L = length(d);
              radialPush += (d / max(L, 1e-4)) * e.z * clamp(L / max(u_drops[i].z, 1e-3), 0.0, 1.0);
            }
          }

          float pushDisplace = addedWetness * 0.18;
          vec4 pushedSample = texture2D(u_prevState, v_uv - normalize(flowDir + vec2(0.001)) * u_texelSize * pushDisplace * 7.5);
          // A new drop only pushes ink that is still wet; dried ink is left exactly where it is
          float pushable = smoothstep(0.05, 0.4, center.g);
          diffusedPigment = mix(diffusedPigment, pushedSample.r, clamp(addedWetness * 0.38, 0.0, 0.55) * pushable);

          // Back-run (にじみの花): water dropped into damp ink drives the pigment outward,
          // leaving a pale centre and a darker, frilled rim. Dry ink is not moved.
          float pushLen = length(radialPush);
          if (pushLen > 0.0) {
            vec2 dirUv = radialPush / vec2(u_aspect, 1.0);
            vec4 radialSample = texture2D(u_prevState, v_uv - dirUv * u_texelSize * 9.0);
            diffusedPigment = mix(diffusedPigment, radialSample.r, clamp(pushLen, 0.0, 0.85) * pushable);
          }

          nextMica = clamp(nextMica + addedMica, 0.0, 1.0);

          // Salt only works on wet ink; lifting works on any ink (the brush brings its own water)
          diffusedPigment *= 1.0 - saltLift * 0.7 * pushable;
          diffusedPigment *= 1.0 - lift * 0.45;

          float finalPigment = clamp(diffusedPigment + addedPigment, 0.0, 1.0);
          float finalWetness = clamp(max(nextWetness, addedWetness), 0.0, 1.0);

          gl_FragColor = vec4(finalPigment, finalWetness, nextMica, nextRidge);
        }
      `,

  // Step 2: display (wet cotton paper + translucent, subtractively mixed ink)
  render: `
        precision highp float;
        varying vec2 v_uv;

        uniform sampler2D u_state;
        uniform vec2 u_resolution;
        uniform vec2 u_simTexel;
        uniform float u_time;
        uniform vec3 u_colWash;
        uniform vec3 u_colMid;
        uniform vec3 u_colDeep;
        uniform vec3 u_lightCol;   // mica / gold leaf colour

        float hash(vec2 p) {
          p = fract(p * vec2(127.1, 311.7));
          p += dot(p, p + 34.23);
          return fract(p.x * p.y);
        }

        float noise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
            mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
            u.y
          );
        }

        float fbm(vec2 p) {
          float v = 0.0;
          float a = 0.5;
          for (int i = 0; i < 4; i++) {
            v += a * noise(p);
            p = p * 2.01 + vec2(3.1, 7.4);
            a *= 0.5;
          }
          return v;
        }

        void main() {
          vec4 state = texture2D(u_state, v_uv);
          float pigment = state.r;
          float wetness = state.g;
          float ridge = state.a;

          // Damp warm white watercolor paper base texture
          vec2 aspectUV = v_uv * vec2(u_resolution.x / max(u_resolution.y, 1.0), 1.0);
          float grain = fbm(aspectUV * 18.0) * 0.55 + noise(aspectUV * 85.0) * 0.45;
          float dampSheen = fbm(aspectUV * 3.2 + vec2(u_time * 0.01, -u_time * 0.008));

          vec3 dryPaper = vec3(0.972, 0.964, 0.945) - (grain - 0.5) * 0.024;
          vec3 dampPaper = vec3(0.946, 0.948, 0.942) - (grain - 0.5) * 0.018;
          vec3 paperColor = mix(dryPaper, dampPaper, 0.35 + dampSheen * 0.35 + wetness * 0.3);

          // Pigment gradient (soft-blurred) -> edge darkening where ink pools at drying rims
          vec2 t = u_simTexel * 2.0;
          float pL = texture2D(u_state, v_uv - vec2(t.x, 0.0)).r;
          float pR = texture2D(u_state, v_uv + vec2(t.x, 0.0)).r;
          float pU = texture2D(u_state, v_uv + vec2(0.0, t.y)).r;
          float pD = texture2D(u_state, v_uv - vec2(0.0, t.y)).r;
          float blurP = (pL + pR + pU + pD) * 0.25;
          float gradMag = length(vec2(pR - pL, pU - pD));
          float rim = smoothstep(0.01, 0.12, gradMag) * smoothstep(0.03, 0.35, pigment);
          float rimDark = rim * (0.5 + 0.5 * smoothstep(0.1, 0.0, wetness));
          // Slight concentration where pigment is lower than surroundings' average (dried halo)
          float halo = clamp(blurP - pigment, 0.0, 0.2) * 2.5;

          // Paper fiber + granulation: pigment settles into grain valleys
          // Finer granulation: pigment settles into tiny paper pores rather than broad blotches
          float fineGrain = noise(aspectUV * 420.0) * 0.6 + noise(aspectUV * 760.0 + 3.1) * 0.4;
          float granule = (grain - 0.5) * 0.25 + (fineGrain - 0.5) * 0.6;
          float fiber = fbm(vec2(aspectUV.x * 60.0, aspectUV.y * 6.0) + 11.0);
          float settledPigment = clamp(
            pigment * (1.0 + granule * (0.35 + pigment * 0.5))
            + rimDark * 0.16 + halo * 0.10 + ridge * 0.12
            + (fiber - 0.5) * 0.05 * smoothstep(0.02, 0.3, pigment),
            0.0, 1.0);

          // Single-hue tonal transition from diluted water wash -> mid -> deep core
          vec3 inkTint = mix(u_colWash, u_colMid, smoothstep(0.14, 0.68, settledPigment));
          inkTint = mix(inkTint, u_colDeep, smoothstep(0.62, 1.0, settledPigment));

          // Subtractive (Beer-Lambert) transmittance: ink absorbs light like real translucent pigment
          vec3 absorb = -log(clamp(inkTint, 0.02, 1.0));
          float density = pow(settledPigment, 0.85) * 1.55;
          vec3 transmit = exp(-absorb * density);
          vec3 finalColor = paperColor * transmit;

          // Soft feathered fringe: faint pale tint beyond the visible edge
          float feather = smoothstep(0.0, 0.02, blurP) * (1.0 - smoothstep(0.02, 0.09, pigment));
          finalColor *= 1.0 - feather * 0.035 * (1.0 - u_colWash) ;

          // Subtle luminous water highlight on freshly dropped wet pools
          float wetGlow = smoothstep(0.25, 0.85, wetness) * (1.0 - settledPigment * 0.55);
          finalColor += vec3(0.016, 0.020, 0.024) * wetGlow;

          // 光: mica / gold flecks laid on top of the ink. Each fleck (one simulation texel) catches the
          // light at its own moment, so the sheet twinkles faintly, strongest on deep ink.
          float mica = state.b;
          if (mica > 0.002) {
            // Fine flecks at screen resolution (~1.5 px): the more mica, the more flecks
            vec2 cell = floor(gl_FragCoord.xy / 1.5);
            float present = step(1.0 - clamp(mica * 0.7, 0.0, 0.6), hash(cell * 0.173 + 3.1));
            float phase = hash(cell + 7.31) * 6.2831;
            float rate = 0.6 + hash(cell + 2.17) * 1.4;
            float twinkle = pow(0.5 + 0.5 * sin(u_time * rate + phase), 10.0);
            float glint = present * (0.5 + 0.5 * twinkle);
            finalColor = mix(finalColor, u_lightCol, glint * 0.8);
            finalColor += u_lightCol * present * twinkle * 0.2;
          }

          gl_FragColor = vec4(clamp(finalColor, 0.0, 1.0), 1.0);
        }
      `
};
