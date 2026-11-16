/**
 * Read a whole-number option.
 *
 * @param name - Option name, for the error message.
 * @param value - The raw text, if the option was given.
 * @returns The number.
 */
export function integerOption(name: string, value: string | undefined): number {
  if (value === undefined || !/^-?\d+$/.test(value)) {
    throw new RangeError(`--${name} needs a whole number`);
  }
  return Number(value);
}
