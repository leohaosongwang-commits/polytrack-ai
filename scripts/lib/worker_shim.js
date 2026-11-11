// 在物理 Worker 脚本最前面注入(由 harness 在浏览器侧、内存中拼接,不落盘、不分发游戏文件)。
// 作用:把 Worker 里的 performance.now / Date.now / requestAnimationFrame / setTimeout / setInterval
// 换成由主线程消息驱动的"虚拟时钟"。游戏自己的物理循环代码保持原样,只是时间由我们推进。
(() => {
  const g = self;
  let vnow = 0;
  const T0 = 1.7e12;
  let nid = 1;
  let rafQ = [];
  const timers = new Map(); // id -> {fn, due, every}
  Object.defineProperty(g.performance, 'now', { value: () => vnow, configurable: true, writable: true });
  Date.now = () => Math.floor(T0 + vnow);
  g.requestAnimationFrame = (cb) => { const id = nid++; rafQ.push([id, cb]); return id; };
  g.cancelAnimationFrame = (id) => { rafQ = rafQ.filter((e) => e[0] !== id); };
  g.setTimeout = (fn, ms = 0, ...a) => { const id = nid++; timers.set(id, { fn: () => fn(...a), due: vnow + Math.max(0, ms), every: 0 }); return id; };
  g.setInterval = (fn, ms = 0, ...a) => { const id = nid++; const e = Math.max(1e-3, ms); timers.set(id, { fn: () => fn(...a), due: vnow + e, every: e }); return id; };
  g.clearTimeout = g.clearInterval = (id) => { timers.delete(id); };

  function tick() {
    for (const [id, t] of [...timers]) {
      if (!timers.has(id) || t.due > vnow) continue;
      if (t.every) t.due = vnow + t.every; else timers.delete(id);
      t.fn();
    }
    const q = rafQ; rafQ = [];
    for (const [, cb] of q) cb(vnow);
  }
  g.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || typeof d !== 'object' || !d.__vt) return;
    ev.stopImmediatePropagation();
    if (d.__vt === 'advance') {
      // 以固定步长 d.step(ms)推进 d.ms 毫秒虚拟时间;每个步长触发一次到期定时器 + 一轮 rAF 回调
      let rem = d.ms;
      const step = d.step > 0 ? d.step : 1000 / 60;
      while (rem > 1e-9) { const dt = Math.min(step, rem); vnow += dt; rem -= dt; tick(); }
      g.postMessage({ __vt: 'done', id: d.id, vnow });
    } else if (d.__vt === 'track') {
      // 仅在 harness 以 exposeTrack 打补丁时可用:self.__Ko / self.__ho 由补丁暴露
      const Ko = g.__Ko, ho = g.__ho;
      if (!Ko || !ho) { g.postMessage({ __vt: 'track', id: d.id, error: 'internals not exposed' }); return; }
      const tr = Ko.fromSaveString(d.trackData);
      const parts = [];
      tr.forEachPart((x, y, z, partId, rotation, axis, color, cpOrder, startOrder) => {
        const cfg = ho.find((c) => c.id === partId); const cells = [];
        if (cfg) cfg.tiles.rotated(rotation, axis).forEach((a, b, c2) => cells.push([x + a, y + b, z + c2]));
        parts.push({ x, y, z, partId, rotation, axis, color, cpOrder, startOrder, category: cfg?.category, cells });
      });
      const st = tr.getStartTransform();
      const info = {};
      for (const p of parts) {
        if (info[p.partId]) continue;
        const cfg = ho.find((c) => c.id === p.partId);
        const tiles = []; if (cfg) cfg.tiles.rotated(0, 0).forEach((a, b, c2) => tiles.push([a, b, c2]));
        info[p.partId] = { category: cfg?.category, detector: cfg?.detector ? JSON.parse(JSON.stringify(cfg.detector)) : null, startOffset: cfg?.startOffset ? JSON.parse(JSON.stringify(cfg.startOffset)) : null, tilesUnrotated: tiles };
      }
      g.postMessage({ __vt: 'track', id: d.id, parts, info, start: st ? { position: { x: st.position.x, y: st.position.y, z: st.position.z }, quaternion: { x: st.quaternion.x, y: st.quaternion.y, z: st.quaternion.z, w: st.quaternion.w } } : null });
    } else if (d.__vt === 'catalog') {
      // 仅在 exposeTrack 补丁下可用:列出全部部件配置(id、类别、未旋转的占格、检测器、起点偏移),用于设计赛道
      const ho = g.__ho;
      if (!ho) { g.postMessage({ __vt: 'catalog', id: d.id, error: 'internals not exposed' }); return; }
      const parts = ho.map((cfg) => { const tiles = []; cfg.tiles.rotated(0, 0).forEach((a, b, c) => tiles.push([a, b, c])); const rot = [1, 2, 3].map((r) => { const o = []; cfg.tiles.rotated(r, 0).forEach((a, b, c) => o.push([a, b, c])); return o; }); return { id: cfg.id, category: cfg.category, tiles, rot, detector: cfg.detector ? JSON.parse(JSON.stringify(cfg.detector)) : null, startOffset: cfg.startOffset ? JSON.parse(JSON.stringify(cfg.startOffset)) : null }; });
      g.postMessage({ __vt: 'catalog', id: d.id, parts });
    } else if (d.__vt === 'build') {
      // 用游戏自己的赛道类生成一条我们自己设计的测试赛道,返回存档串与导出串(PolyTrack2...)
      const Ko = g.__Ko;
      if (!Ko) { g.postMessage({ __vt: 'build', id: d.id, error: 'internals not exposed' }); return; }
      const base = Ko.fromSaveString(d.baseTrackData);
      const tr = new Ko(base.environment, base.sunDirection);
      for (const p of d.parts) tr.addPart(p.x, p.y, p.z, p.partId, p.rotation, p.axis ?? 0, p.color ?? 0, p.cpOrder ?? null, p.startOrder ?? null);
      g.postMessage({ __vt: 'build', id: d.id, save: tr.toSaveString(), exportString: tr.toExportString({ name: d.name, author: null, lastModified: null }), start: (() => { const s = tr.getStartTransform(); return s ? { position: { x: s.position.x, y: s.position.y, z: s.position.z }, quaternion: { x: s.quaternion.x, y: s.quaternion.y, z: s.quaternion.z, w: s.quaternion.w } } : null; })() });
    } else if (d.__vt === 'now') {
      g.postMessage({ __vt: 'now', id: d.id, vnow });
    }
  });
})();
