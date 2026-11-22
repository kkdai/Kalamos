import type { ChangeDesc } from "@codemirror/state";

/**
 * Safe position mapping for positions kept in StateFields / plugins (#56).
 *
 * `ChangeDesc.mapPos` throws a RangeError when the position is outside the
 * document the changes apply to. A stored position can only be outside if
 * some earlier transaction failed to map it (e.g. a code path that copied it
 * unchanged), so every stored position is clamped to the old document before
 * mapping and to the new document after mapping.
 */
export function clampPos(pos: number, length: number): number {
  if (!Number.isFinite(pos) || pos < 0) return 0;
  return pos > length ? length : pos;
}

/** `changes.mapPos(pos, assoc)`, clamped before and after. */
export function mapPosClamped(
  changes: ChangeDesc,
  pos: number,
  assoc = -1,
): number {
  return clampPos(
    changes.mapPos(clampPos(pos, changes.length), assoc),
    changes.newLength,
  );
}
