/**
 * The digit patterns and the digit folding every guard shares, in one leaf module that imports nothing: static content
 * (content/static.ts), the tool-boundary scrub (agent/tools.ts) and the reply scrubber (agent/scrub.ts) all read these
 * definitions. log.ts keeps its own inline check, since it must not import content.
 */

const DECIMAL_DIGIT = /\p{Nd}/u;

/**
 * The value of a decimal digit in any script. Unicode encodes every decimal digit set as a contiguous 0–9 run, so the
 * value is the distance from the start of the run (mod 10 where sets sit back to back, as the math digits do).
 */
function digitValue(ch: string): number {
  const cp = ch.codePointAt(0) as number;
  let start = cp;
  while (start > 0 && DECIMAL_DIGIT.test(String.fromCodePoint(start - 1))) start--;
  return (cp - start) % 10;
}

/** Every decimal digit, in any script (Devanagari, Gujarati, Bengali, Tamil, fullwidth, …), as its ASCII digit. */
export function asciiDigits(s: string): string {
  return s.replace(/\p{Nd}/gu, (ch) => (ch <= "9" ? ch : String(digitValue(ch))));
}

/**
 * A phone number inside static content or tool output: 7+ digits, an optional "+", at most one space or "-" between
 * two digits, never a line break or a spaced hyphen. Match it against text whose digits are ASCII. Global:
 * String.replace resets it on each call.
 */
export const PHONE_RUN_RE = /\+?\d(?:[ -]?\d){6,}/g;

/**
 * A phone-shaped run in a reply, as the digit scrubber reads it: 7+ digits, an optional leading "+", at most one
 * space, line break or "-" between two digits.
 *
 * Known residuals, each read as short groups and so never as a run: groups joined by a dot, slash, comma or spaced
 * hyphen ("98765.43210", "98765/43210", "98,765,43,210", "98765 - 43210"); a parenthesised group ("(98765) 43210");
 * the letter O written for a zero ("98765 432O0"); words between the groups ("98765 then 43210"); and a number split
 * across sentences or lines ("98765. 43210", "98765 \n43210", "98765\n\n43210").
 */
export const DIGIT_RUN_RE = /\+?\d(?:[\s-]?\d){6,}/g;
