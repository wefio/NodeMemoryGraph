export interface BoardDeliveryCheck {
  delivered?: readonly string[];
  acked?: readonly string[];
  inactive?: readonly string[];
  suppressed?: boolean;
}
/** A receipt and a current eligibility check are separate facts. Missing owner response fails closed. */
export function canDeliverBoardEntry(
  check: BoardDeliveryCheck | null | undefined,
  entryId: string,
): boolean {
  return (
    !!check &&
    !check.suppressed &&
    !check.delivered?.includes(entryId) &&
    !check.acked?.includes(entryId) &&
    !check.inactive?.includes(entryId)
  );
}
