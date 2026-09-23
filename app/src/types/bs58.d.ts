// bs58@4.x ships no type declarations at all (confirmed: no "types" field, no bundled
// .d.ts, no @types/bs58 published for this major). Minimal ambient declaration covering
// only what this codebase actually calls.
declare module "bs58" {
  function encode(buffer: Uint8Array | Buffer | number[]): string;
  function decode(s: string): Uint8Array;
  const bs58: { encode: typeof encode; decode: typeof decode };
  export default bs58;
}
