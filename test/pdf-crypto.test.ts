/**
 * PDF 암호 프리미티브 — AES(복호/암호) + SHA-2 를 FIPS 표준 테스트벡터로 고정.
 * (실제 암호화 PDF 복호는 mutool 로 만든 AESV2/AESV3 파일로 수동검증; 여기선 코어를 고정.)
 */
import { describe, it, expect } from "vitest";
import { aesCbcDecrypt, aesCbcEncrypt, sha256, sha384, sha512 } from "../src/core/pdf/pdfAes.js";

const hex = (s: string): Uint8Array => new Uint8Array(s.match(/../g)!.map((h) => parseInt(h, 16)));
const toHex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

describe("AES 복호 (FIPS-197 벡터)", () => {
  const PT = "00112233445566778899aabbccddeeff";
  it("AES-128", () => {
    const out = aesCbcDecrypt(hex("000102030405060708090a0b0c0d0e0f"), hex("69c4e0d86a7b0430d8cdb78070b4c55a"), { iv: new Uint8Array(16) });
    expect(toHex(out)).toBe(PT);
  });
  it("AES-192", () => {
    const out = aesCbcDecrypt(hex("000102030405060708090a0b0c0d0e0f1011121314151617"), hex("dda97ca4864cdfe06eaf70a0ec0d7191"), { iv: new Uint8Array(16) });
    expect(toHex(out)).toBe(PT);
  });
  it("AES-256", () => {
    const out = aesCbcDecrypt(hex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"), hex("8ea2b7ca516745bfeafc49904b496089"), { iv: new Uint8Array(16) });
    expect(toHex(out)).toBe(PT);
  });
  it("CBC 다중블록 암복호 왕복(PKCS7)", () => {
    const key = hex("000102030405060708090a0b0c0d0e0f");
    const iv = hex("0f0e0d0c0b0a09080706050403020100");
    const msg = new TextEncoder().encode("docloom AES round-trip 한글 테스트!");
    // PKCS7 패딩 후 암호화 → IV 붙여 복호.
    const pad = 16 - (msg.length % 16);
    const padded = new Uint8Array(msg.length + pad); padded.set(msg); padded.fill(pad, msg.length);
    const ct = aesCbcEncrypt(key, padded, iv);
    const framed = new Uint8Array(16 + ct.length); framed.set(iv); framed.set(ct, 16);
    const dec = aesCbcDecrypt(key, framed, { removePadding: true });
    expect(toHex(dec)).toBe(toHex(msg));
  });
});

describe("SHA-2 (FIPS-180 벡터, 'abc')", () => {
  const abc = new TextEncoder().encode("abc");
  it("SHA-256", () => expect(toHex(sha256(abc))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
  it("SHA-384", () => expect(toHex(sha384(abc))).toBe("cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7"));
  it("SHA-512", () => expect(toHex(sha512(abc))).toBe("ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f"));
});
