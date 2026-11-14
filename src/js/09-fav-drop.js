// Where a drop in a gap of the favorites grid lands (ported from KASOGIT/vivarc#138, 0369427): beside the nearest tile,
// before it when the pointer is left of the tile's middle, after it when right, as a drop on that tile's own half does.
// Before, a drop between tiles went to the end of the grid. Pure, shared by the sidebar and its tests.
(() => {
  // centers: each tile's middle ({ x, y }) in grid order; at: the drop point. -> { index, after } or null with no tile.
  const slot = (centers, at) => {
    if (!Array.isArray(centers) || !centers.length || !at) return null;
    let best = 0, bestD = Infinity;
    centers.forEach((c, i) => {
      const d = Math.hypot(c.x - at.x, c.y - at.y);
      if (d < bestD) { best = i; bestD = d; }
    });
    return { index: best, after: at.x > centers[best].x };
  };
  window.__vm.favDrop = { slot };
})();
