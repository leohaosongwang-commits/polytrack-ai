// 自动驾驶引导线(车前方的发光赛车线)的浏览器侧:取游戏相机矩阵 + 叠加层渲染。数学部分在 scripts/lib/guide.mjs(构建时一起打进来)。
//
// 取相机:游戏用 three.js(WebGL2),每个物体 / 每遍渲染都会 uniformMatrix4fv 上传 projectionMatrix 和 viewMatrix。
// 这里在 WebGL2 原型上包一层,按"当前 program"记住最近一次上传的这两个矩阵;每次 draw 时,如果当前 program 的投影是透视的(m[11] === -1,阴影遍是正交的),
// 就把它当作主相机。每帧的最后一次 draw 之后(同一个任务结束时的微任务)再画我们的叠加层,所以用的是这一帧的相机,不会慢一拍。
// 叠加层是单独的一块 WebGL 画布(position:fixed,pointer-events:none,不碰游戏自己的 GL 状态),只在自动驾驶且开着"引导线"时才有开销。
// 不碰网络、不改游戏的任何绘制;只读矩阵。
(() => {
  const GL2 = window.WebGL2RenderingContext;
  const GM = window.__ptGuideMath; // { buildGuidePath, projectGuide, mulMat4 }
  const R = (window.__ptGuideRT = { cam: null, canvas: null, active: null, enabled: true, err: null, frames: 0 });
  if (!GL2 || !GM || R.hooked) return; R.hooked = true;

  const kindOf = new WeakMap(); const progs = new Map(); let cur = null, pending = false;
  const gUL = GL2.prototype.getUniformLocation;
  GL2.prototype.getUniformLocation = function (p, n) { const l = gUL.call(this, p, n); if (l && (n === 'projectionMatrix' || n === 'viewMatrix')) kindOf.set(l, n); return l; };
  const uP = GL2.prototype.useProgram;
  GL2.prototype.useProgram = function (p) { cur = p; return uP.call(this, p); };
  const uM = GL2.prototype.uniformMatrix4fv;
  GL2.prototype.uniformMatrix4fv = function (loc, tr, v, off) {
    const k = kindOf.get(loc);
    if (k && cur && v && v.length >= 16) { let s = progs.get(cur); if (!s) progs.set(cur, (s = {})); const m = new Float32Array(16), o = off | 0; for (let i = 0; i < 16; i++) m[i] = v[o + i]; s[k] = m; }
    return uM.apply(this, arguments);
  };
  const onDraw = function () {
    if (!R.active || (this.canvas && this.canvas.__ptaiOverlay)) return; // 叠加层自己的绘制不算(否则每画一帧又排一个微任务,死循环)
    const s = progs.get(cur);
    if (s && s.projectionMatrix && s.viewMatrix && s.projectionMatrix[11] === -1) { R.cam = { P: s.projectionMatrix, V: s.viewMatrix }; R.canvas = this.canvas; }
    if (pending) return; pending = true;
    queueMicrotask(() => { try { if (R.active) frame(); } catch (e) { R.err = String(e && e.message || e); } finally { pending = false; } });
  };
  for (const name of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
    const orig = GL2.prototype[name]; if (!orig) continue;
    GL2.prototype[name] = function () { onDraw.call(this); return orig.apply(this, arguments); };
  }

  // ---------- 叠加层渲染 ----------
  let ov = null; // { cv, gl, prog, vb, ib, loc }
  function makeOverlay() {
    const cv = document.createElement('canvas'); cv.id = 'ptai-guide'; cv.__ptaiOverlay = true;
    cv.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2;display:none;';
    const gl = cv.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: true, depth: false, stencil: false });
    if (!gl) return null;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('引导线着色器:' + gl.getShaderInfoLog(s)); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, '#version 300 es\nin vec2 a_pos; in vec4 a_col; out vec4 v_col; void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); v_col = a_col; }'));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, '#version 300 es\nprecision mediump float; in vec4 v_col; out vec4 o; void main(){ o = vec4(v_col.rgb * v_col.a, v_col.a); }'));
    gl.linkProgram(prog); if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('引导线着色器链接失败');
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const vb = gl.createBuffer(), ib = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    const lp = gl.getAttribLocation(prog, 'a_pos'), lc = gl.getAttribLocation(prog, 'a_col');
    gl.enableVertexAttribArray(lp); gl.vertexAttribPointer(lp, 2, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(lc); gl.vertexAttribPointer(lc, 4, gl.FLOAT, false, 24, 8);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    document.documentElement.appendChild(cv);
    return { cv, gl, prog, vao, vb, ib };
  }
  function clearOverlay() { if (!ov || ov.cleared) return; ov.gl.clearColor(0, 0, 0, 0); ov.gl.clear(ov.gl.COLOR_BUFFER_BIT); ov.cv.style.display = 'none'; ov.cleared = true; }

  function frame() {
    const A = R.active; if (!A || !R.cam || !R.canvas) return;
    if (!R.enabled) { clearOverlay(); return; }
    if (!ov) { ov = makeOverlay(); if (!ov) { R.err = '没有 WebGL2,画不了引导线'; R.active = null; return; } }
    const rect = R.canvas.getBoundingClientRect(); if (rect.width < 8 || rect.height < 8) { clearOverlay(); return; }
    const st = ov.cv.style;
    ov.cleared = false; st.display = 'block'; st.left = rect.left + 'px'; st.top = rect.top + 'px'; st.width = rect.width + 'px'; st.height = rect.height + 'px';
    const dpr = Math.min(2, window.devicePixelRatio || 1), w = Math.round(rect.width * dpr), h = Math.round(rect.height * dpr);
    if (ov.cv.width !== w || ov.cv.height !== h) { ov.cv.width = w; ov.cv.height = h; }
    const gl = ov.gl; gl.viewport(0, 0, w, h); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    const f = A.frames(); if (f == null) return;
    const VP = GM.mulMat4(R.cam.P, R.cam.V);
    const g = GM.projectGuide(A.path, f, VP, performance.now() / 1000, { minHalfNdc: 2.6 / (rect.width / 2) }); // 核心至少约 2.6 像素半宽
    R.frames++; R.lastRows = g.rows;
    if (!g.nIdx) return;
    gl.useProgram(ov.prog); gl.bindVertexArray(ov.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, ov.vb); gl.bufferData(gl.ARRAY_BUFFER, g.verts.subarray(0, g.nVerts * 6), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ov.ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, g.idx.subarray(0, g.nIdx), gl.DYNAMIC_DRAW);
    gl.drawElements(gl.TRIANGLES, g.nIdx, gl.UNSIGNED_INT, 0);
  }

  window.__ptGuideUI = {
    /** 开始画:path = buildGuidePath 的结果;frames() 返回车当前的物理帧 */
    start(path, frames) { R.active = { path, frames }; R.err = null; },
    stop() { R.active = null; R.cam = null; clearOverlay(); },
    setEnabled(on) { R.enabled = !!on; if (!on) clearOverlay(); },
    isEnabled: () => R.enabled,
    rt: R,
  };
})();
