import {
  parsePlistIntegerLiteral,
  type PlistNumberLiterals,
} from "../../domain/apple/plistNumbers.js";
import { decodeXmlText } from "../../domain/propertyListKeys.js";
import { hasBinaryPlistSignature } from "../../domain/apple/appleArchiveFormat.js";

const collector = () => {
  const integers = new Map<number, Set<string>>();
  const reals = new Set<number>();
  let unsafeIntegerLiterals = 0;
  let incompleteMetadata = false;
  return {
    integer: (literal: string) => {
      const exact = parsePlistIntegerLiteral(literal);
      if (exact === undefined) {
        incompleteMetadata = true;
        return;
      }
      if (
        exact >= BigInt(Number.MIN_SAFE_INTEGER) &&
        exact <= BigInt(Number.MAX_SAFE_INTEGER)
      )
        return;
      unsafeIntegerLiterals += 1;
      const rounded = Number(exact);
      integers.set(
        rounded,
        (integers.get(rounded) ?? new Set()).add(exact.toString()),
      );
    },
    real: (value: number) => {
      reals.add(value);
    },
    markIncomplete: () => {
      incompleteMetadata = true;
    },
    result: (incomplete = false): PlistNumberLiterals => ({
      incomplete: incomplete || incompleteMetadata,
      integers,
      reals,
      unsafeIntegerLiterals,
    }),
  };
};
// Consume quoted tag attributes and opaque comment/CDATA tokens whole.
const XML_TOKEN =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<(?:[^>"']|"[^"]*"|'[^']*')*>/gu;
const OPAQUE_ELEMENTS = new Set(["string", "key", "data", "date"]);

/** Observe plist number element types without interpreting strings or class code. */
export const xmlPlistNumberLiterals = (xml: string): PlistNumberLiterals => {
  const output = collector();
  const elements: string[] = [];
  let number:
    | {
        kind: "integer" | "real";
        text: string;
        depth: number;
        plainText: boolean;
      }
    | undefined;
  let cursor = 0;
  for (const match of xml.matchAll(XML_TOKEN)) {
    const index = match.index;
    if (number !== undefined) number.text += xml.slice(cursor, index);
    const token = match[0];
    cursor = index + token.length;
    if (token.startsWith("<!--") || token.startsWith("<![CDATA[")) {
      if (number !== undefined) {
        number.plainText = false;
        output.markIncomplete();
      }
      continue;
    }
    const tag = /^<\s*(\/?)\s*([\w:-]+)/u.exec(token);
    if (tag === null) {
      if (number !== undefined) {
        number.plainText = false;
        output.markIncomplete();
      }
      continue;
    }
    const closing = tag[1] === "/";
    const name = tag[2];
    if (name === undefined) continue;
    if (closing) {
      if (
        number !== undefined &&
        number.kind === name &&
        number.depth === elements.length
      ) {
        if (number.plainText) {
          const text = decodeXmlText(number.text).trim();
          if (number.kind === "integer") output.integer(text);
          else output.real(Number.parseFloat(text));
        }
        number = undefined;
      }
      elements.pop();
      continue;
    }
    // The pinned decoder reads only the first child for integers and only text
    // nodes for reals. Mixed content cannot establish an exact association.
    if (number !== undefined) {
      number.plainText = false;
      output.markIncomplete();
    }
    if (/\/\s*>$/u.test(token)) continue;
    if (
      number === undefined &&
      (name === "integer" || name === "real") &&
      !elements.some((parent) => OPAQUE_ELEMENTS.has(parent))
    )
      number = {
        kind: name,
        text: "",
        depth: elements.length + 1,
        plainText: true,
      };
    elements.push(name);
  }
  return output.result();
};

export interface BinaryPlistNumberMetadata {
  readonly literals: PlistNumberLiterals;
  /** 16-byte integers the pinned plist decoder cannot decode correctly. */
  readonly wideIntegers: readonly { offset: number; value: bigint }[];
}

const binaryObjectEnd = (
  bytes: Buffer,
  offset: number,
  objectEnd: number,
  referenceWidth: number,
): number | undefined => {
  const marker = bytes[offset];
  if (marker === undefined) return undefined;
  const type = marker >> 4;
  let length = marker & 0x0f;
  let cursor = offset + 1;
  if (length === 0x0f && type !== 0 && type !== 8) {
    const extendedMarker = bytes[cursor];
    if (extendedMarker === undefined || extendedMarker >> 4 !== 1)
      return undefined;
    const width = 1 << (extendedMarker & 0x0f);
    if (width > 8 || cursor + 1 + width > objectEnd) return undefined;
    cursor += 1;
    let extendedLength = 0n;
    for (let index = 0; index < width; index += 1)
      extendedLength =
        (extendedLength << 8n) | BigInt(bytes[cursor + index] ?? 0);
    if (extendedLength > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
    length = Number(extendedLength);
    cursor += width;
  }
  let payloadLength: number;
  if (type === 0) payloadLength = 0;
  else if (type === 1 || type === 2) {
    if ((marker & 0x0f) > 4) return undefined;
    payloadLength = 1 << (marker & 0x0f);
  } else if (type === 3) {
    if (marker !== 0x33) return undefined;
    payloadLength = 8;
  } else if (type === 4 || type === 5 || type === 7) {
    payloadLength = length;
  } else if (type === 6) {
    payloadLength = length * 2;
  } else if (type === 8) {
    payloadLength = (marker & 0x0f) + 1;
  } else if (type === 10 || type === 11 || type === 12) {
    payloadLength = length * referenceWidth;
  } else if (type === 13) {
    payloadLength = length * 2 * referenceWidth;
  } else return undefined;
  const end = cursor + payloadLength;
  return Number.isSafeInteger(end) && end <= objectEnd ? end : undefined;
};

/** Observe bounded binary number markers without changing primary decode acceptance. */
export const scanBinaryPlistNumberLiterals = (
  bytes: Buffer,
): BinaryPlistNumberMetadata => {
  const output = collector();
  const wideIntegers: { offset: number; value: bigint }[] = [];
  if (bytes.length < 40 || !hasBinaryPlistSignature(bytes))
    return { literals: output.result(true), wideIntegers };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const trailer = bytes.length - 32;
  const offsetWidth = bytes[trailer + 6] ?? 0;
  if (![1, 2, 4, 8].includes(offsetWidth))
    return { literals: output.result(true), wideIntegers };
  const countRaw = view.getBigUint64(trailer + 8);
  const tableRaw = view.getBigUint64(trailer + 24);
  const safeMaximum = BigInt(Number.MAX_SAFE_INTEGER);
  if (countRaw === 0n || countRaw > safeMaximum || tableRaw > safeMaximum)
    return { literals: output.result(true), wideIntegers };
  if (tableRaw < 8n || tableRaw >= BigInt(trailer))
    return { literals: output.result(true), wideIntegers };
  const offsetTable = Number(tableRaw);
  const capacity = Math.floor((trailer - offsetTable) / offsetWidth);
  if (countRaw > BigInt(capacity))
    return { literals: output.result(true), wideIntegers };
  const count = Number(countRaw);
  const referenceWidth = bytes[trailer + 7] ?? 0;
  if (![1, 2, 4, 8].includes(referenceWidth))
    return { literals: output.result(true), wideIntegers };
  const unsigned = (offset: number): number | undefined => {
    if (offset < offsetTable || offset + offsetWidth > trailer)
      return undefined;
    if (offsetWidth === 1) return view.getUint8(offset);
    if (offsetWidth === 2) return view.getUint16(offset);
    if (offsetWidth === 4) return view.getUint32(offset);
    const value = view.getBigUint64(offset);
    return value > safeMaximum ? undefined : Number(value);
  };
  const objectOffsets: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = unsigned(offsetTable + index * offsetWidth);
    if (offset === undefined || offset < 8 || offset >= offsetTable)
      return { literals: output.result(true), wideIntegers };
    objectOffsets.push(offset);
  }
  const sortedOffsets = [...new Set(objectOffsets)].sort((a, b) => a - b);
  for (let index = 0; index < sortedOffsets.length; index += 1) {
    const offset = sortedOffsets[index];
    if (offset === undefined) continue;
    const nextOffset = sortedOffsets[index + 1] ?? offsetTable;
    if (
      binaryObjectEnd(bytes, offset, nextOffset, referenceWidth) === undefined
    )
      return { literals: output.result(true), wideIntegers: [] };
  }
  for (const offset of objectOffsets) {
    const marker = bytes[offset] ?? 0;
    const type = marker >> 4;
    if (type !== 1 && type !== 2) continue;
    const width = 2 ** (marker & 0xf);
    if (offset + 1 + width > offsetTable)
      return { literals: output.result(true), wideIntegers };
    if (type === 1 && width === 8)
      output.integer(view.getBigInt64(offset + 1).toString());
    else if (type === 1 && width === 16) {
      const value = BigInt.asIntN(
        128,
        (view.getBigUint64(offset + 1) << 64n) | view.getBigUint64(offset + 9),
      );
      output.integer(value.toString());
      wideIntegers.push({ offset, value });
    } else if (type === 1 && width > 4)
      return { literals: output.result(true), wideIntegers };
    else if (type === 2 && width === 4)
      output.real(view.getFloat32(offset + 1));
    else if (type === 2 && width === 8)
      output.real(view.getFloat64(offset + 1));
    else if (type === 2) return { literals: output.result(true), wideIntegers };
  }
  return { literals: output.result(), wideIntegers };
};

/** Preserve 16-byte integers through plist@5's Number-only parser. */
export const decodeBinaryPlistNumbers = (
  bytes: Buffer,
  metadata: BinaryPlistNumberMetadata,
): Buffer => {
  if (metadata.wideIntegers.length === 0) return bytes;
  const compatible = Buffer.from(bytes);
  for (const { offset, value } of metadata.wideIntegers) {
    // Convert only the decoder's input copy to a double. Exact integer metadata
    // from the original bytes restores decimal text after the structural parse.
    compatible[offset] = 0x23;
    compatible.writeDoubleBE(Number(value), offset + 1);
  }
  return compatible;
};
