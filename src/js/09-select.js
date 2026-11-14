// Picking several tab rows (ported from KASOGIT/vivarc#147, 515ca05): Ctrl+click (Cmd+click on a Mac) picks or unpicks a
// row, Shift+click picks every row from the last one picked to this one, and a right-click on a picked row then acts on
// all of them. Escape or a plain click lets go. Only the tab rows the sidebar lists in the space on screen can be picked,
// so whatever the menu does stays in this window and space. Pure helpers, shared by the sidebar and its tests.
(() => {
  // Every id in `order` (the rows as listed, top to bottom) from `from` to `to`, both included, in list order; [to] when
  // either is not listed.
  const range = (order, from, to) => {
    const a = order.indexOf(from), b = order.indexOf(to);
    if (a < 0 || b < 0) return [to];
    return order.slice(Math.min(a, b), Math.max(a, b) + 1);
  };

  // The selection after a picking click on row `id`. selected: the ids picked so far; anchor: the last row picked with
  // Ctrl/Cmd (where a Shift range starts); active: the tab on screen, when its row is listed; order: the rows listed.
  // extend: a Shift+click. The tab on screen counts as picked first, like Arc: the first Ctrl/Cmd+click on another row
  // picks both, and a Shift+click with nothing picked runs from it. -> { selected, anchor }
  const pick = ({ selected = [], anchor = null, active = null, order = [] } = {}, id, { extend = false } = {}) => {
    const now = new Set(selected.filter((x) => order.includes(x)));
    const start = anchor != null && order.includes(anchor) ? anchor : (active != null && order.includes(active) ? active : null);
    if (extend && start != null) {
      for (const x of range(order, start, id)) now.add(x);
      return { selected: order.filter((x) => now.has(x)), anchor: start };
    }
    if (!now.size && active != null && active !== id && order.includes(active)) now.add(active);
    if (now.has(id)) now.delete(id); else now.add(id);
    return { selected: order.filter((x) => now.has(x)), anchor: id };
  };

  // What is still picked once the list changes (a tab closed, moved, or another space shown).
  const prune = (selected, listed) => (selected || []).filter((id) => (listed || []).includes(id));

  // Does a click pick? Ctrl on Windows, Cmd on a Mac (Ctrl+click there is the right-click), Shift on both. Ctrl+Shift or
  // Cmd+Shift together is a Shift range too.
  const picking = (e, windows) => !!e && (!!e.shiftKey || (windows ? !!e.ctrlKey : !!e.metaKey));
  const plural = (n) => `${n} Tab${n === 1 ? "" : "s"}`;
  // The selection menu's labels.
  const labels = (n) => ({ stack: `Stack ${plural(n)}`, close: `Close ${plural(n)}`, move: (name) => `Move ${plural(n)} to ${name}` });

  // The folders (stack ids shown on screen) the picked tabs are in, each with its picked tabs: Remove from Folder takes
  // each group out on its own, since a folder's tabs sit side by side and two folders' do not.
  const byFolder = (tabs, stackOf, shown) => {
    const out = new Map();
    for (const t of tabs || []) {
      const id = stackOf(t);
      if (id && (shown || []).includes(id)) out.set(id, [...(out.get(id) || []), t]);
    }
    return [...out].map(([id, members]) => ({ id, tabs: members }));
  };

  window.__vm.select = { range, pick, prune, picking, labels, byFolder };
})();
