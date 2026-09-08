// lib/reorder.js — moving a row within a list, as arithmetic rather than as a drag.
//
// WHY THIS IS NOT IN THE COMPONENT. Reordering looks obviously right and is off by one. Pure
// function here, exercised by test/reorder.test.mjs against an independent reference
// implementation, so the component is left holding nothing but the pointer events.
//
// ONE FUNCTION, because one is all that is called. Earlier drafts also exported moveBy (move by a
// signed offset) and applyOrder/orderOf (apply a stored list of ids). Both turned out to be
// unnecessary: the buttons move a row past its VISIBLE neighbour, which is a drop and not an
// offset, and the order lives in the rows array itself rather than in a separate id list that
// could drift out of step with it. Shipping them anyway would have been three tested functions
// nothing calls.

// Drop `dragId` onto `overId`, taking that position. Returns a NEW array and never mutates its
// input — React state depends on identity changing, and an in-place reorder would show on screen
// only until the next render, which is the worst way for this to fail. Returns the input unchanged
// when there is nothing to do, so a caller can compare by identity to decide whether to save.
//
// THE OFF-BY-ONE LIVES HERE, and the first version of this function had it. It measured the target
// index in the ALREADY-SPLICED array, with a comment claiming that made the correction automatic.
// It does the opposite: removing the dragged row shifts everything above it down by one, so for a
// DOWNWARD move the target's index has already moved and inserting there puts the row back exactly
// where it started. Adjacent downward drags did nothing at all; upward drags were fine, which is
// how a bug like this survives being tried by hand.
//
// The fix is to measure against the ORIGINAL list. The target's index there is the position the
// dragged row should end up at, and that holds in both directions with no branch: moving down, the
// rows between have shifted into the gap; moving up, they have not moved at all.
export function moveOnto(list = [], dragId, overId) {
  const from = list.findIndex(r => r && r.id === dragId);
  const to = list.findIndex(r => r && r.id === overId);   // measured BEFORE the removal — see above
  if (from < 0 || to < 0 || dragId === overId) return list;
  const next = list.slice();
  const [row] = next.splice(from, 1);
  next.splice(to, 0, row);
  return next;
}
