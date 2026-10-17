const SHORT_ESCAPES = new Set([0x08, 0x09, 0x0a, 0x0c, 0x0d, 0x22, 0x5c]);

/**
 * JSON.stringify(value).length, counted without building the escaped string,
 * which for control characters is six times the input. Counting stops once it
 * passes `budget`, so a result above the budget is only known to exceed it.
 */
export const jsonStringLength = (
  value: string,
  budget = Number.POSITIVE_INFINITY,
): number => {
  let length = 2;
  for (let index = 0; index < value.length && length <= budget; index += 1) {
    const unit = value.charCodeAt(index);
    if (SHORT_ESCAPES.has(unit)) length += 2;
    else if (unit < 0x20) length += 6;
    else if (unit >= 0xd800 && unit <= 0xdfff) {
      const next = value.charCodeAt(index + 1);
      if (unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        length += 2;
        index += 1;
      } else length += 6;
    } else length += 1;
  }
  return length;
};
