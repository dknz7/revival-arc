// Tab folders: Vivaldi's own tab stacks, shown as folders in the sidebar's tab list. Vivaldi keeps a stacked tab's stack
// id in its vivExtData ("group") and the stack's name there too ("fixedGroupTitle"), and shows a stack only from two tabs.
// Pure helpers, shared by the sidebar and its tests; the sidebar makes the Vivaldi calls.
(() => {
  const ext = (tab) => {
    try { return JSON.parse(tab?.vivExtData || "{}"); } catch (_) { return {}; }
  };
  const stackOf = (tab) => ext(tab).group || "";

  // The tab list's entries, highest tab index first as the list shows them: a loose tab, or a folder of a stack's tabs
  // (in tab order) placed where its top tab is.
  const entries = (tabs) => {
    const stacks = new Map();
    for (const tab of tabs) {
      const id = stackOf(tab);
      if (id) stacks.set(id, [...(stacks.get(id) || []), tab]);
    }
    for (const [id, members] of stacks) if (members.length < 2) stacks.delete(id);
    const out = [];
    for (const tab of tabs) {
      const id = stackOf(tab);
      if (!stacks.has(id)) { out.push({ type: "tab", tab, index: tab.index }); continue; }
      if (out.some((e) => e.type === "stack" && e.id === id)) continue;
      const members = [...stacks.get(id)].sort((a, b) => a.index - b.index);
      out.push({ type: "stack", id, tabs: members, index: Math.max(...members.map((t) => t.index)) });
    }
    return out.sort((a, b) => b.index - a.index);
  };

  // A folder's name: the stack's name in Vivaldi, else "Folder".
  const titleOf = (tabs) => tabs.map((t) => ext(t).fixedGroupTitle).find(Boolean) || "Folder";

  // What dropping `dragged` (a tab) does. target: { tab } (a tab row, loose or in a folder) or { stack } (a folder's head);
  // zone: "into" (the middle of the row) or "before" / "after"; `shown`: the folders on screen (their stack ids). A tab
  // counts as in a folder only when that folder is shown: Vivaldi can leave a stack id on a tab it shows loose.
  // ops: create (a new folder with target.tab, id `with`), join (folder `stack`), leave (its folder, then move),
  // move (only reorder), none.
  const dropAction = (dragged, target, zone, shown) => {
    const folderOf = (tab) => (shown.includes(stackOf(tab)) ? stackOf(tab) : "");
    const mine = folderOf(dragged);
    const theirs = target.stack ?? folderOf(target.tab);
    if (target.tab?.id === dragged.id) return { op: "none" };
    if (zone === "into") {
      if (theirs) return theirs === mine ? { op: "none" } : { op: "join", stack: theirs };
      return { op: "create", with: target.tab.id };
    }
    // Beside a folder's head is outside the folder; beside a tab inside a folder is inside it.
    const lands = target.stack ? "" : theirs;
    if (mine && lands !== mine) return { op: "leave" };
    if (!mine && lands) return { op: "join", stack: lands };
    return { op: "move" };
  };

  // Vivaldi only ungroups tabs it really moves ("nothing to move" at their own place). For `count` side-by-side tabs from
  // `start`, of `total` in the window: a move target one step along, over one neighbour, and that neighbour's index before
  // the step, so a plain move of that one tab puts the order back. Measured on Vivaldi 8.2: stepping right over the next
  // tab takes the target start + count (start + 1 is inside the block: nothing to move); stepping left, start - 1.
  // Null when there is nowhere else to go (they are all the window's tabs).
  // `to`: where the block starts after the step (for Vivaldi 8.3, which takes a tab to land before, not an index).
  const nudge = (start, count, total) => {
    if (start + count < total) return { target: start + count, neighbour: start + count, to: start + 1 };
    if (start - 1 >= 0) return { target: start - 1, neighbour: start - 1, to: start - 1 };
    return null;
  };

  // Vivaldi 8.3's move target for tabs to start at `index`: the tab they land before, among the window's other tabs
  // in order (`others`, their ids), or "last" past the end. 8.3 reads a number only as a tab id, never as an index.
  const anchor = (others, index) => others[index] ?? "last";

  // The index a tab moved beside `tab` lands at. The list shows the highest tab index first, so "before" (above) is the
  // higher index. Beside itself it stays where it is.
  const indexBeside = (moving, tab, zone) => {
    if (moving.id === tab.id) return tab.index;
    const below = moving.index < tab.index;
    return zone === "before" ? (below ? tab.index : tab.index + 1) : (below ? tab.index - 1 : tab.index);
  };

  window.__vm.stacks = { stackOf, entries, titleOf, dropAction, nudge, anchor, indexBeside, ext };
})();
