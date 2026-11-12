# Vivarc rules: spaces and windows

**Status: APPROVED by Byron, 2026-11-06 (decisions in Part 3). Built 2026-11-07.** Every rule in Part 2 has unit tests (`tests/test_space_rules.py`) and a live check in a sandbox Vivaldi (`tools/sandbox-rules.mjs`, one PASS/FAIL line per rule). Byron added `Move to <Space>` (under "Tabs") on 2026-11-07. On 2026-11-08 he approved the split-space exception to invariant 4 (a plain click gathers a split space) and had Vivarc's own drag restamp removed (decision 4). His Dia sidebar button of the same day is not a spaces rule, so it is in `docs/HOW-IT-WORKS.md`, though the same script checks it. So are the Dia row's Shield, Copy link and Translate icons and the private-window behaviour (Task 8v, 2026-11-12: `D.row-icons`, `D.shield-panel*`, `D.private-window-*`, `D.fullscreen-row`). A change to these rules is a change to this file first.

**Why this exists.** A run of bugs (a space click that does nothing, links filed into the wrong space, a space that "moved on its own") all came from the same place. Vivaldi's own record of which space a window shows can disagree with what the window is actually showing. Vivaldi and Vivarc then each act on a different idea of where things are. Part 1 is how Vivaldi really behaves, as measured. Part 2 is the rules Vivarc promises, including where it deliberately overrides Vivaldi.

**Terms used below**
- **Space:** a Vivaldi workspace. A tab's space is `workspaceId` in its `vivExtData`. A tab with no key is in the **default** space.
- **Record:** Vivaldi's own map of which space is active in which window (`getActiveWorkspaces()`; per window, `getActiveWorkspaceId(windowId)`). A window with no entry is on its default space.
- **Parked:** a tab whose space is not the space its window shows. It is hidden from the sidebar but still open.
- **Lives in:** the window that holds a space's tabs.

## Part 1: how Vivaldi 8.2 behaves (measured)

Measured on 2026-11-06 in a sandbox Vivaldi 8.2.4133.96 with Vivarc loaded, each case run 3 times, in both the Dia and Arc layouts. Vivaldi's own behaviour was identical in both layouts; the only differences came from Vivarc's command bar. Case IDs refer to the spike logs.

### Switching: `setActiveWorkspace(window W, space X)`
| X is... | Result |
|---|---|
| already active in W | Nothing moves. W gets focus. (A1) |
| active in another window O | Nothing moves. **O** gets focus. Same whichever window's UI makes the call. (A2, A9c) |
| parked in W | W's record becomes X and X's most recent tab is activated. Nothing moves. (A3) |
| parked in O, whatever O shows | **All** of X's tabs move from O into W at the start of the tab strip, W's record becomes X, and W does **not** get focus. (A4, A5, A10) |
| split across W and O | All of X's tabs end up in W. The tab activated comes from the **first-created** window holding X; recency across windows is ignored. (A6, A6b, A6c) |
| empty (no tabs) | A start page tagged X is created and activated. (A7) |
| the default space (`undefined`) | W's record entry is removed and W's default tab is activated. If W has no default tab, a default start page is created. (A8a, A8b) |

### Changing the active tab without a switch
- Activating a tab of another space (`chrome.tabs.update(id, {active})`) **does not change the record**. The window then shows a tab of one space while recorded as another. (G1–G3)
- Changing the *active* tab's space **is** a switch: the record follows. If that space is active in another window, the record does not change and **focus jumps to that window**. (G4, G6)
- Changing an *inactive* tab's space does nothing to the record. (G5)

### New tabs
- **Every new tab goes into the window's recorded space**, stamped by Vivaldi at creation. This holds for `chrome.tabs.create` with no space, inactive tabs, tabs with an opener, and Vivaldi's own New Tab command. (B1, B1i, B2, B3c)
- **The opener is ignored:** a link opened from a tab of another space still goes into the recorded space. (B2b)
- **The record wins over what is shown:** a window recorded as X but showing a Y tab puts its new tab in X. (B7c)
- A tab created with an explicit space Y and `active: true` switches the window's record to Y. (B2c) *Not reproduced on re-test (2026-11-07, the sandbox checks for the repairs): such a tab left the record where it was, so setups that need the record switched now switch it explicitly.*
- Creating a tab in a window focuses that window. (B5)
- A tab created within about 0 ms of a switch is a race, with mixed outcomes. At 100 ms it reliably lands in the new space. (B4)

### Moving tabs between windows (`chrome.tabs.move`)
- A moved tab keeps its space and arrives parked. The target window's record does not change. (C1, C2, C4)
- Moving a space's only tab out of a window leaves that window recorded as the space while showing a default tab. No start page is created. (C3)

### Closing
- Closing a space's last tab with `tabs.remove` leaves the window recorded as that space while showing a default tab. Ctrl+W instead creates a start page tagged with the space. (D1, D1k)
- **Closing a window:**
  - Every named-space tab in it **moves to the most recently focused other window**, at the start of the tab strip, before the window closes. Default-space tabs close with the window. (D2–D7)
  - Spaces that were active in the closed window lose their record entry, so they arrive **parked**, even in a window showing another space. (D2c)
  - The rehoming follows focus history, not where the space lives, so it can **split a space** across windows. (D8)
- Quitting by closing windows one at a time rehomes everything into the last window, so only that window comes back. **File → Exit** keeps every window. (E3)

### Restart
- On startup each window's record is rebuilt from its active tab, and the **first-created** window wins when two windows' active tabs share a space. **Startup also pulls** that space's parked tabs from other windows into the winner. (E1, E2, E2b)

### Deleting a space (`removeWorkspace`)
- All of its tabs close, in every window. The calling window switches to default first. (F1)
- If the space was active in another window, that window **stays recorded on the deleted space**. (F2)
- **A window that held only that space's tabs closes.** (F3)

### Not Vivarc's business, but worth knowing
- Vivaldi's exit confirmation dialog, on by default, blocks quitting until it's answered.
- In 3 of 49 runs, tabs created in the last second or so before an immediate exit were lost on restart. None were lost with a 5 s pause.

## Part 2: the rules Vivarc keeps

### Invariants: true whenever no gesture is in progress
1. **One truth.** Which space a window shows is Vivaldi's record and nothing else. Vivarc reads the record and does not infer it from the active tab. The one exception is a Vivaldi whose record can't be read at all: the sidebar (its tiles and pins included) and the command bar then fall back to the active tab's space, while the repairs do nothing (they log one warning), since without the record they would be guessing.
2. **Record and screen agree.** A window's active tab always belongs to the space its record names (default when there is no entry). When something breaks that, Vivarc repairs it (see "Repairs").
3. **A space lives in one window.** All of a space's tabs are in one window. Vivaldi can split a space (a window close, a moved tab), and Vivarc repairs it (see "Repairs").
4. **A plain click never moves tabs between windows.** Moving tabs is always explicit: shift+click, ctrl+shift+click, or dragging. The one exception: a plain click on a space split across windows gathers it into the window it lives in, as repair 3 would (see the gesture table). Approved by Byron, 2026-11-08.
5. **Vivarc does not stamp spaces.** New tabs get the recorded space from Vivaldi (B1). Vivarc writes `workspaceId` only when it deliberately puts a tab into a space (a favorite or pin brought here, a tab torn off into a new window's default space). Its old new-tab stamping is removed: it was redundant, and it undid switches (A8b). A tab put into the default space is written with `workspaceId: 0`. `chrome.tabs.update` merges `vivExtData`, so leaving the key out would keep the old space, while Vivaldi drops the key when it is 0.
6. **Every window shows a space that exists and has a tab.** A record pointing at a deleted space, or at a space with no tab in that window, is repaired.

### Gestures on a space tile (named space X)
| X is... | Click | Shift+click | Ctrl+shift+click (Mac: cmd+shift) |
|---|---|---|---|
| shown in this window | nothing | nothing | move X to a new window |
| shown in another window | go to that window | bring X here | move X to a new window |
| parked in this window | show X here | show X here | move X to a new window |
| parked in another window | **go there: that window shows X and comes to the front** | bring X here | move X to a new window |
| split across windows | treated as living in the window it is shown in, otherwise the one with most of its tabs; shift+click and the move both gather every tab, and so does a plain click, into the window it lives in (as repair 3 would; the one exception to invariant 4, approved by Byron, 2026-11-08) | | |
| empty | show X here (Vivaldi makes a start page) | same as click | move X to a new window (opens with a start page) |

The default space can't be moved, because it belongs to each window. Clicking it shows this window's own default tabs.

**Dots.** A tile gets a dot when its space **lives in another window**, shown or parked there. The tooltip says what each click does.

### Tabs
- **`Move to <Space>`** (a tab's right-click menu) moves the tab into that space with Vivaldi's own move, as its keyboard shortcut does. The window stays on the space it shows (if the tab is the one on screen, another tab of the space takes the screen first, or a blank tab if there is none). If that space is shown in another window, the tab goes to that window. A space that is parked in another window cannot be reached (Vivaldi's move fails from here, and into that window it lands in the space shown there): the menu says so and nothing moves; show the space in its window first. A space with no tabs anywhere takes the tab in this window. If Vivaldi's move does not put the tab in that space and window, the menu says so and Vivarc undoes its own steps (the tab goes back on screen if it was, and a blank tab it opened closes). It does not undo Vivaldi's move: a tab Vivaldi put somewhere else stays there, and a space that leaves split is gathered by repair 3.
- **A tab picked in the command bar** (which lists every tab of the window, parked ones too) is shown with its space: a tab parked in this window's other space switches the window to that space first (A3), then is activated. A tab whose space is shown in another window (a split space's stray) goes to that window, as a tile click does, and repair 3 gathers it. Without the record or the switch, the tab is just activated.
- **New tabs** (Ctrl+T, + New Tab, palette pages, links) go into the window's recorded space (Vivaldi's own behaviour). Given invariant 2, that is always the space on screen.
- **New-tab position:** a new tab from Ctrl+T, + New Tab or the palette goes to the top of its space's list. A link opens next to the page it came from.
- **Favorites and pinned tabs** open in this window and **in the space on screen**. Activating a tab parked in another space breaks invariant 2 (G1–G3), so Vivarc never does it. A favorite's or pin's tab that is in another space or window is brought here and put into the space on screen before it is activated, so no second tab opens.
- **Dragging a tab into another window:** the tab joins the space that window shows. This is the explicit "move this tab" gesture. Vivaldi's own drop (a tab dragged between tab strips) puts the tab into the space the target window shows (H2), and Vivarc's sidebar does the same (Byron, 2026-11-08): a tab row dragged into another window's sidebar moves into that window at the drop position (above or below the row by the nearer edge, so no folder is made across windows; the New Tab row puts it last), into the space that window shows, and is activated there. It is the same write as a tear-off: out of its split view (its peers in the source window leave it too) and its folder. The source window keeps its space; if that was the space's last tab there, repair 1 handles it. The move runs under the repair busy mark, and a failure toasts and leaves the tab where it was. A drag inside one window is unchanged. The target accepts the drop (`dropEffect` move), so the source's tear-off stays quiet, and the tear-off also checks the tab is still in its window. A tab moved by other code (`chrome.tabs.move`) keeps its space and arrives parked (C1); the repairs take it from there.
- **Dragging a tab out of the sidebar beyond the window** (a tab row only: not a pin, favorite or folder, and not the window's only tab) opens it in a new window, in that window's default space (Byron, 2026-11-08); the source window keeps showing its space. The tab leaves its space on purpose: a space lives in one window, so a tab that kept a space still shown in the source window would be gathered straight back by repair 3. A deliberate move into the default space, so it is written with `workspaceId: 0` (invariant 5). Order: the window is created first (the tab moves into it), and only then is the tab restamped, because while it is still the source window's active tab, changing its space is a switch there (G4). The repair busy mark is held for the whole gesture. If the tab was its space's last one in the source window, that window is left recorded on a space with no tab and repair 1 switches it to default (C3/D1). If the window is made but the restamp fails, the tab stays in its old space in the new window, repair 3 gathers it home, and one `[vivarc]` warning is logged. The same write takes the tab out of its split view (`tiling`) and its folder (`group`), and its split-view peers in the source window lose their tiling too, as Close Split View does (a key leaves `vivExtData` only when written as null: omitted, undefined and "" keep it, measured). A drop onto another window's page (not a Vivarc drop target) tears off as well, since the browser reports it the same way as a drop on nothing. Escape does not cancel a drag that has left the window (the browser's drag loop takes the key, and a cancelled drag ends like a drop), so every tear-off shows "Opened in a new window" with **Undo** for 5 s, in the new window: Undo moves the tab back to its index in the window it came from, restores its original space (`workspaceId` as it was) and activates it again if it was active, under the same busy mark; the emptied window closes itself (measured). Undo does not restore a split view or a folder.

### Repairs: when Vivaldi breaks an invariant
Vivarc checks after the events that can break an invariant (tab activated, tab moved or attached, tab closed, window closed, space deleted, startup), waits for the browser to settle, then repairs in this order:
1. **Record points at a deleted space, or the window holds no tab of its space** (F2, C3, D1): switch that window to default.
2. **The active tab is in a different space from the record** (G1–G3): activate the window's most recent tab of the recorded space. If there is none, switch the record to the active tab's space, unless that space is shown in another window (G6), in which case switch to default. A window already on default is never switched to default, because that would only steal focus (A8c). Repair 3 gathers the stray tab, and the next pass settles the window.
3. **A space is split across windows** (D8, after a window close or a tab move): gather its tabs into the window where it is shown. If it is shown nowhere, gather them into the window that holds most of its tabs. Gathering uses `chrome.tabs.move`, so the moved tabs keep their space (C1). Vivaldi's switch can't gather here: it does nothing for a space already shown in the target window (A1).
4. **A window close leaves rehomed tabs parked** (D2): no change. They stay where Vivaldi put them, now in one window by repair 3, and a click on the space goes there.

### Deleting a space
The confirmation says how many tabs will close and in how many windows. After the delete, any window still recorded on it is switched to default (F2). If a window holds nothing but that space, the confirmation says the window will close too (F3).

## Part 3: decisions (Byron, 2026-11-06)
1. **A plain click on a space parked in another window: go there.** That window switches to the space and comes to the front. (Not chosen: Vivaldi's native "pull it here".)
2. **A window closes with spaces in it:** accept Vivaldi's rehoming to the last-focused window, then gather split spaces (repair 3). (Not chosen: routing each space to the window where it is shown.)
3. **Favorites and pinned tabs open in the space on screen, Favorites included.**
4. **Dragging a tab to another window** puts it into that window's shown space. Vivaldi's own drop delivers this for a drag between tab strips (H2), and Vivarc's sidebar does the same for a tab dragged into another window's sidebar (Part 2, Tabs). Vivarc had a restamp of its own for tabs moved any other way; Byron had it removed on 2026-11-08, because Vivaldi's drop already does the job and the restamp's one real risk was re-filing a heavy closing window's rehomed tabs (a 100-tab close took 2.5-2.9 s against its 1.5 s re-check). (Not chosen: keeping its space and arriving parked, for a real drag.)

## Confirmed in the sandbox (H1–H3)
The spike left these unmeasured. They were measured on 2026-11-06, before the build, in the sandbox (`tools/sandbox.ps1`: Vivaldi 8.2.4133.96 with this branch's Vivarc, Arc layout), 3 runs per case, all 3 identical. W shows X (`X1` active, `X2`) with `Y1` parked in W, unless a case says otherwise.
- **H1. Vivaldi's own tab bar, window panel and space switcher.** None of them leaves the record and the screen disagreeing.
  - Tab bar (H1-strip): Vivaldi's strip lists only the tabs of the window's recorded space (`X1`, `X2`), so a parked tab can't be clicked there. A control click on `X2` activated it and left the record on X.
  - Window panel (H1-panel): a single click on `Y1` (under Workspaces > Y) only selects the row. A double click calls Vivaldi's `setActiveWorkspace(W, Y)`: the record becomes Y and `Y1` is active (a switch, not G1).
  - Space switcher (H1-menu, the Workspaces button popup): choosing Y calls `setActiveWorkspace(W, Y)`, with the same result.
- **H2. Dropping a tab into another window.** A real drag is a native OS drag (`tabsPrivate.startDrag`), which CDP can't drive. The case runs the call Vivaldi's drop handler makes in the target window, `PageActions.moveDroppedTabs(O, [X2], X2, -1)`, which moves the tab with `workspaceId` set to **O's recorded space**. `X2` lands at the end of O's strip and becomes active there. It **joins the space O shows**: Z when O shows Z (H2-named), and the default space, with no `workspaceId` key, when O is on default (H2-default). Neither record changes. Vivarc made no calls in this case. So Vivaldi's own drop files the tab into O's shown space (Vivarc's sidebar drop is its own code and writes the same result); `chrome.tabs.move` keeps the space and parks the tab (C1).
- **H3. Favorites and pinned tabs whose tab is in another space.** Vivarc never activated the parked tab (no G1 drift), and the record stayed Y in every run.
  - A pin of X, opened while W showed X (tab bound in X), then W switched to Y (H3-pin): the sidebar shows Y's Pinned folder, so X's pin isn't on screen and can't be clicked.
  - A favorite opened in X, then W switched to Y (H3-fav): clicking it opens a **new** tab bound to the same favorite. Vivaldi puts it in Y and it is active. The X tab stays bound in X, so the favorite now has a tab in each space.
  - A pin of Y whose tab was moved to X (restamped while inactive, G5) (H3-pinmoved): same as H3-fav. A new tab opens in Y and the X tab stays.
