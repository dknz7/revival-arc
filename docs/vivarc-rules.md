# Vivarc rules: spaces and windows

**Status: APPROVED by Byron, 2026-11-06 (decisions in Part 3).** Not built yet: every rule in Part 2 gets a test, and the code changes to pass them. A change to these rules is a change to this file first.

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
- A tab created with an explicit space Y and `active: true` switches the window's record to Y. (B2c)
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

## Part 2: the rules Vivarc keeps (proposed)

### Invariants: true whenever no gesture is in progress
1. **One truth.** Which space a window shows is Vivaldi's record and nothing else. Vivarc reads the record and never infers it from the active tab.
2. **Record and screen agree.** A window's active tab always belongs to the space its record names (default when there is no entry). When something breaks that, Vivarc repairs it (see "Repairs").
3. **A space lives in one window.** All of a space's tabs are in one window. Vivaldi can split a space (a window close, a moved tab), and Vivarc repairs it (see "Repairs").
4. **A plain click never moves tabs between windows.** Moving tabs is always explicit: shift+click, ctrl+shift+click, or dragging.
5. **Vivarc does not stamp spaces.** New tabs get the recorded space from Vivaldi (B1). Vivarc writes `workspaceId` only when it deliberately puts a tab into a space. Its old new-tab stamping is removed: it was redundant, and it undid switches (A8b).
6. **Every window shows a space that exists and has a tab.** A record pointing at a deleted space, or at a space with no tab in that window, is repaired.

### Gestures on a space tile (named space X)
| X is... | Click | Shift+click | Ctrl+shift+click (Mac: cmd+shift) |
|---|---|---|---|
| shown in this window | nothing | nothing | move X to a new window |
| shown in another window | go to that window | bring X here | move X to a new window |
| parked in this window | show X here | show X here | move X to a new window |
| parked in another window | **go there: that window shows X and comes to the front** | bring X here | move X to a new window |
| split across windows | treated as living in the window it is shown in, otherwise the one with most of its tabs; shift+click and the move both gather every tab | | |
| empty | show X here (Vivaldi makes a start page) | same as click | move X to a new window (opens with a start page) |

The default space can't be moved, because it belongs to each window. Clicking it shows this window's own default tabs.

**Dots.** A tile gets a dot when its space **lives in another window**, shown or parked there. The tooltip says what each click does.

### Tabs
- **New tabs** (Ctrl+T, + New Tab, palette pages, links) go into the window's recorded space (Vivaldi's own behaviour). Given invariant 2, that is always the space on screen.
- **New-tab position:** a new tab from Ctrl+T, + New Tab or the palette goes to the top of its space's list. A link opens next to the page it came from.
- **Favorites and pinned tabs** open in this window and **in the space on screen**. Activating a tab parked in another space breaks invariant 2 (G1–G3), so Vivarc never does it.
- **Dragging a tab into another window:** the tab joins the space that window shows (Vivarc restamps it). This is the explicit "move this tab" gesture.

### Repairs: when Vivaldi breaks an invariant
Vivarc checks after the events that can break an invariant (tab activated, tab moved or attached, tab closed, window closed, space deleted, startup), waits for the browser to settle, then repairs in this order:
1. **Record points at a deleted space, or the window holds no tab of its space** (F2, C3, D1): switch that window to default.
2. **The active tab is in a different space from the record** (G1–G3): activate the window's most recent tab of the recorded space. If there is none, switch the record to the active tab's space, unless that space is shown in another window (G6), in which case switch to default.
3. **A space is split across windows** (D8, after a window close or a tab move): gather its tabs into the window where it is shown. If it is shown nowhere, gather them into the window that holds most of its tabs. Gathering uses Vivaldi's own switch, which moves every tab of the space.
4. **A window close leaves rehomed tabs parked** (D2): no change. They stay where Vivaldi put them, now in one window by repair 3, and a click on the space goes there.

### Deleting a space
The confirmation says how many tabs will close and in how many windows. After the delete, any window still recorded on it is switched to default (F2). If a window holds nothing but that space, the confirmation says the window will close too (F3).

## Part 3: decisions (Byron, 2026-11-06)
1. **A plain click on a space parked in another window: go there.** That window switches to the space and comes to the front. (Not chosen: Vivaldi's native "pull it here".)
2. **A window closes with spaces in it:** accept Vivaldi's rehoming to the last-focused window, then gather split spaces (repair 3). (Not chosen: routing each space to the window where it is shown.)
3. **Favorites and pinned tabs open in the space on screen, Favorites included.**
4. **Dragging a tab to another window** restamps it into that window's shown space. (Not chosen: keeping its space and arriving parked.)

## Still to confirm before the tests are written
These weren't measured in the spike. Confirming them may sharpen a rule but shouldn't change the decisions above.
- Clicks in Vivaldi's own tab bar, window panel and space switcher: do they call the switch, or only activate the tab (G1)?
- Real drag and drop of a tab between windows, against `chrome.tabs.move` (C).
- What Vivarc's Favorites and pinned tabs do today when their tab is parked in another space.
