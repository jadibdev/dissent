/** SHA-256 of UTF-8 text as lowercase hex, via Web Crypto only. */
export async function sha256Hex(text: string): Promise<string> {
  return bytesToHex(await digest(new TextEncoder().encode(text)));
}

/** SHA-256 of raw bytes as lowercase hex. */
export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  return bytesToHex(await digest(bytes));
}

async function digest(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await globalThis.crypto.subtle.digest(
      'SHA-256',
      bytes as Uint8Array<ArrayBuffer>,
    ),
  );
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}
