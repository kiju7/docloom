/**
 * OLE2 / 복합 문서 바이너리(MS-CFB) 리더·라이터 — 순수 TypeScript.
 *
 * HWP 5.0(.hwp)는 zip 이 아니라 CFB 컨테이너다. 내부에 명명 스트림(FileHeader,
 * DocInfo, BodyText/Section0 …)을 담는다. docx 의 zip(core/zip) 에 대응하는, hwp 용
 * "컨테이너 입출력 원시 연산"을 여기 둔다.
 *
 * 왕복 전략(docloom 철학과 동일): decode 는 readCfb 로 얻은 디렉터리 엔트리(이름·트리
 * 링크·메타)를 그대로 보존하고, 스트림 내용/크기만 갈아끼운 뒤 writeCfb 로 재조립한다.
 * → 트리 구조가 원본과 동일하게 유지되어 양식이 물리적으로 깨지지 않는다.
 *
 * 참고: MS-CFB 명세(섹터=512B v3, 미니섹터=64B, 미니컷오프=4096B).
 */

export const NOSTREAM = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;
const FATSECT = 0xfffffffd;
const DIFSECT = 0xfffffffc;
const SIG = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export type CfbEntryType = 0 | 1 | 2 | 5; // 0 미사용, 1 storage, 2 stream, 5 root

export interface CfbEntry {
  name: string;
  type: CfbEntryType;
  color: number; // 0 red, 1 black
  left: number;
  right: number;
  child: number;
  clsid: Uint8Array; // 16B
  state: number;
  ctime: bigint;
  mtime: bigint;
  start: number; // writeCfb 가 재계산
  size: number; // writeCfb 가 재계산
}

export interface CfbModel {
  /** 디렉터리 엔트리(인덱스 = 디렉터리 id). [0]은 항상 Root Entry. */
  entries: CfbEntry[];
  /** 엔트리 인덱스 → 스트림 바이트(type=2 만). */
  data: Map<number, Uint8Array>;
}

export interface ReadCfbResult extends CfbModel {
  /** 스트림/스토리지 경로("BodyText/Section0") → 엔트리 인덱스. */
  pathOf: Map<string, number>;
  /** 경로 → 스트림 바이트(편의). */
  streams: Record<string, Uint8Array>;
}

/** 이 바이트가 CFB 컨테이너인지(시그니처). */
export function isCfbBytes(bytes: Uint8Array): boolean {
  return SIG.every((b, i) => bytes[i] === b);
}

// ── 읽기 ────────────────────────────────────────────────────────────────────

export function readCfb(bytes: Uint8Array): ReadCfbResult {
  if (!isCfbBytes(bytes)) throw new Error("CFB: 시그니처 불일치(복합문서 아님)");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const sectorShift = dv.getUint16(30, true);
  const SS = 1 << sectorShift;
  const miniShift = dv.getUint16(32, true);
  const MSZ = 1 << miniShift;
  const numFat = dv.getUint32(44, true);
  const firstDir = dv.getUint32(48, true);
  const miniCutoff = dv.getUint32(56, true);
  const firstMiniFat = dv.getUint32(60, true);
  const numMiniFat = dv.getUint32(64, true);
  const firstDifat = dv.getUint32(68, true);
  const numDifat = dv.getUint32(72, true);

  const sectorOffset = (s: number) => (s + 1) * SS;

  // DIFAT → FAT 섹터 위치 목록
  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i++) {
    const v = dv.getUint32(76 + i * 4, true);
    if (v !== FREESECT && v !== ENDOFCHAIN) fatSectors.push(v);
  }
  let ds = firstDifat;
  let guard = 0;
  while (ds !== ENDOFCHAIN && ds !== FREESECT && guard++ < 1_000_000) {
    const base = sectorOffset(ds);
    for (let i = 0; i < SS / 4 - 1; i++) {
      const v = dv.getUint32(base + i * 4, true);
      if (v !== FREESECT && v !== ENDOFCHAIN) fatSectors.push(v);
    }
    ds = dv.getUint32(base + SS - 4, true);
  }
  void numFat; void numDifat;

  // FAT 조립
  const fat: number[] = [];
  for (const fs of fatSectors) {
    const base = sectorOffset(fs);
    for (let i = 0; i < SS / 4; i++) fat.push(dv.getUint32(base + i * 4, true));
  }

  const readChain = (start: number): Uint8Array => {
    const chunks: Uint8Array[] = [];
    let s = start;
    let g = 0;
    while (s !== ENDOFCHAIN && s !== FREESECT && g++ < fat.length + 16) {
      const off = sectorOffset(s);
      chunks.push(bytes.slice(off, off + SS));
      s = fat[s] ?? ENDOFCHAIN;
    }
    return concat(chunks);
  };

  // 디렉터리
  const dirBytes = readChain(firstDir);
  const count = Math.floor(dirBytes.length / 128);
  const ddv = new DataView(dirBytes.buffer, dirBytes.byteOffset, dirBytes.byteLength);
  const entries: CfbEntry[] = [];
  for (let i = 0; i < count; i++) {
    const o = i * 128;
    const nameLen = ddv.getUint16(o + 64, true);
    const chars = nameLen >= 2 ? nameLen / 2 - 1 : 0;
    let name = "";
    for (let k = 0; k < chars; k++) name += String.fromCharCode(ddv.getUint16(o + k * 2, true));
    entries.push({
      name,
      type: ddv.getUint8(o + 66) as CfbEntryType,
      color: ddv.getUint8(o + 67),
      left: ddv.getUint32(o + 68, true),
      right: ddv.getUint32(o + 72, true),
      child: ddv.getUint32(o + 76, true),
      clsid: dirBytes.slice(o + 80, o + 96),
      state: ddv.getUint32(o + 96, true),
      ctime: ddv.getBigUint64(o + 100, true),
      mtime: ddv.getBigUint64(o + 108, true),
      start: ddv.getUint32(o + 116, true),
      size: Number(ddv.getBigUint64(o + 120, true)),
    });
  }
  if (entries.length === 0) throw new Error("CFB: 디렉터리가 비어 있음");

  // 미니 스트림(루트) + 미니 FAT
  const root = entries[0]!;
  const miniStream = readChain(root.start).slice(0, root.size);
  const miniFat: number[] = [];
  if (numMiniFat > 0) {
    const mfb = readChain(firstMiniFat);
    const mdv = new DataView(mfb.buffer, mfb.byteOffset, mfb.byteLength);
    for (let i = 0; i < Math.floor(mfb.length / 4); i++) miniFat.push(mdv.getUint32(i * 4, true));
  }
  const readMiniChain = (start: number, size: number): Uint8Array => {
    const chunks: Uint8Array[] = [];
    let s = start;
    let g = 0;
    while (s !== ENDOFCHAIN && s !== FREESECT && g++ < miniFat.length + 16) {
      const off = s * MSZ;
      chunks.push(miniStream.slice(off, off + MSZ));
      s = miniFat[s] ?? ENDOFCHAIN;
    }
    return concat(chunks).slice(0, size);
  };

  const data = new Map<number, Uint8Array>();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.type !== 2) continue;
    data.set(i, e.size < miniCutoff ? readMiniChain(e.start, e.size) : readChain(e.start).slice(0, e.size));
  }

  // 경로 트리 순회
  const pathOf = new Map<string, number>();
  const streams: Record<string, Uint8Array> = {};
  const walk = (id: number, prefix: string): void => {
    if (id === NOSTREAM || id >= entries.length) return;
    const e = entries[id]!;
    walk(e.left, prefix);
    const p = prefix + e.name;
    if (e.type === 1) {
      pathOf.set(p, id);
      walk(e.child, p + "/");
    } else if (e.type === 2) {
      pathOf.set(p, id);
      streams[p] = data.get(id) ?? new Uint8Array(0);
    }
    walk(e.right, prefix);
  };
  walk(root.child, "");

  return { entries, data, pathOf, streams };
}

// ── 쓰기 ────────────────────────────────────────────────────────────────────

/** 디렉터리 엔트리 + 스트림 바이트 → CFB 바이트(v3, 512B 섹터로 표준화). */
export function writeCfb(model: CfbModel): Uint8Array {
  const SS = 512;
  const MSZ = 64;
  const cutoff = 4096;
  const EPS = SS / 4; // 섹터당 FAT 엔트리 수 = 128
  const E = model.entries.map((e) => ({ ...e }));
  const data = model.data;

  // 1) 미니 스트림 + 미니 FAT 구성
  const miniChunks: Uint8Array[] = [];
  const miniFat: number[] = [];
  let miniCount = 0;
  for (let idx = 0; idx < E.length; idx++) {
    const e = E[idx]!;
    if (e.type !== 2) continue;
    const d = data.get(idx) ?? new Uint8Array(0);
    if (d.length > 0 && d.length < cutoff) {
      const need = Math.ceil(d.length / MSZ);
      const startMini = miniCount;
      for (let k = 0; k < need; k++) {
        const chunk = new Uint8Array(MSZ);
        chunk.set(d.subarray(k * MSZ, Math.min(d.length, (k + 1) * MSZ)));
        miniChunks.push(chunk);
        miniFat.push(k < need - 1 ? startMini + k + 1 : ENDOFCHAIN);
      }
      miniCount += need;
      e.start = startMini;
      e.size = d.length;
    }
  }
  const miniStream = concat(miniChunks);

  // 2) 정규 섹터 할당기
  const sectorBytes: Uint8Array[] = [];
  const fat: number[] = [];
  const allocData = (buf: Uint8Array): number => {
    if (buf.length === 0) return ENDOFCHAIN;
    const n = Math.ceil(buf.length / SS);
    const start = sectorBytes.length;
    for (let i = 0; i < n; i++) {
      const chunk = new Uint8Array(SS);
      chunk.set(buf.subarray(i * SS, Math.min(buf.length, (i + 1) * SS)));
      sectorBytes.push(chunk);
      fat.push(i < n - 1 ? start + i + 1 : ENDOFCHAIN);
    }
    return start;
  };

  // 2a) 정규 스트림(>=cutoff 또는 size 0)
  for (let idx = 0; idx < E.length; idx++) {
    const e = E[idx]!;
    if (e.type !== 2) continue;
    const d = data.get(idx) ?? new Uint8Array(0);
    if (!(d.length > 0 && d.length < cutoff)) {
      if (d.length === 0) {
        e.start = ENDOFCHAIN;
        e.size = 0;
      } else {
        e.start = allocData(d);
        e.size = d.length;
      }
    }
  }
  // 2b) 미니 스트림 컨테이너 → 루트 엔트리
  const root = E[0]!;
  if (miniStream.length > 0) {
    root.start = allocData(miniStream);
    root.size = miniStream.length;
  } else {
    root.start = ENDOFCHAIN;
    root.size = 0;
  }
  // 2c) 스토리지/미사용 엔트리
  for (const e of E) {
    if (e.type === 1 || e.type === 0) {
      e.start = 0;
      e.size = 0;
    }
  }

  // 3) 미니 FAT 섹터
  let firstMiniFat = ENDOFCHAIN;
  let numMiniFat = 0;
  if (miniFat.length > 0) {
    const padCount = Math.ceil((miniFat.length * 4) / SS) * EPS;
    const arr = new Uint8Array(padCount * 4);
    const adv = new DataView(arr.buffer);
    for (let i = 0; i < padCount; i++) adv.setUint32(i * 4, i < miniFat.length ? miniFat[i]! : FREESECT, true);
    numMiniFat = arr.length / SS;
    firstMiniFat = allocData(arr);
  }

  // 4) 디렉터리 섹터
  const dirBytes = buildDirBytes(E);
  const firstDir = allocData(dirBytes);

  // 5) FAT 크기 산정(FAT/DIFAT 섹터 자신도 포함되도록 반복)
  const D = sectorBytes.length;
  let numFat = Math.max(1, Math.ceil(D / EPS));
  let numDifat = 0;
  for (;;) {
    numDifat = numFat <= 109 ? 0 : Math.ceil((numFat - 109) / (EPS - 1));
    const T = D + numFat + numDifat;
    const nf = Math.ceil(T / EPS);
    if (nf === numFat) break;
    numFat = nf;
  }
  const T = D + numFat + numDifat;

  // FAT 배열 확장 + FAT/DIFAT 섹터 표시
  while (fat.length < T) fat.push(FREESECT);
  const fatSectorLocs: number[] = [];
  for (let i = 0; i < numFat; i++) {
    fat[D + i] = FATSECT;
    fatSectorLocs.push(D + i);
  }
  for (let i = 0; i < numDifat; i++) fat[D + numFat + i] = DIFSECT;

  // 6) 파일 조립: 헤더(512) + T 섹터(512)
  const out = new Uint8Array(SS * (T + 1));
  const odv = new DataView(out.buffer);

  // 헤더
  for (let i = 0; i < 8; i++) out[i] = SIG[i]!;
  odv.setUint16(24, 0x003e, true); // minor
  odv.setUint16(26, 0x0003, true); // major(v3)
  odv.setUint16(28, 0xfffe, true); // byte order
  odv.setUint16(30, 9, true); // sector shift(512)
  odv.setUint16(32, 6, true); // mini shift(64)
  odv.setUint32(40, 0, true); // num dir sectors(v3=0)
  odv.setUint32(44, numFat, true);
  odv.setUint32(48, firstDir, true);
  odv.setUint32(52, 0, true); // transaction sig
  odv.setUint32(56, cutoff, true); // mini cutoff
  odv.setUint32(60, firstMiniFat, true);
  odv.setUint32(64, numMiniFat, true);
  odv.setUint32(68, numDifat > 0 ? D + numFat : ENDOFCHAIN, true);
  odv.setUint32(72, numDifat, true);
  for (let i = 0; i < 109; i++) odv.setUint32(76 + i * 4, i < numFat ? fatSectorLocs[i]! : FREESECT, true);

  // 데이터 섹터
  for (let i = 0; i < D; i++) out.set(sectorBytes[i]!, SS * (i + 1));

  // FAT 섹터
  const fatBuf = new Uint8Array(numFat * SS);
  const fdv = new DataView(fatBuf.buffer);
  for (let i = 0; i < numFat * EPS; i++) fdv.setUint32(i * 4, i < T ? fat[i]! : FREESECT, true);
  for (let i = 0; i < numFat; i++) out.set(fatBuf.subarray(i * SS, (i + 1) * SS), SS * (D + i + 1));

  // DIFAT 섹터(있으면)
  for (let j = 0; j < numDifat; j++) {
    const sec = new Uint8Array(SS);
    const sdv = new DataView(sec.buffer);
    for (let k = 0; k < EPS - 1; k++) {
      const locIdx = 109 + j * (EPS - 1) + k;
      sdv.setUint32(k * 4, locIdx < numFat ? fatSectorLocs[locIdx]! : FREESECT, true);
    }
    sdv.setUint32(SS - 4, j < numDifat - 1 ? D + numFat + j + 1 : ENDOFCHAIN, true);
    out.set(sec, SS * (D + numFat + j + 1));
  }

  return out;
}

/** 엔트리 배열 → 디렉터리 바이트(엔트리당 128B, 섹터당 4개로 패딩). */
function buildDirBytes(entries: CfbEntry[]): Uint8Array {
  const count = Math.max(1, Math.ceil(entries.length / 4) * 4);
  const buf = new Uint8Array(count * 128);
  const dv = new DataView(buf.buffer);
  for (let i = 0; i < count; i++) {
    const o = i * 128;
    const e = entries[i];
    if (!e || e.type === 0) {
      // 미사용 엔트리: 링크는 NOSTREAM
      dv.setUint32(o + 68, NOSTREAM, true);
      dv.setUint32(o + 72, NOSTREAM, true);
      dv.setUint32(o + 76, NOSTREAM, true);
      continue;
    }
    const chars = Math.min(e.name.length, 31);
    for (let k = 0; k < chars; k++) dv.setUint16(o + k * 2, e.name.charCodeAt(k), true);
    dv.setUint16(o + 64, (chars + 1) * 2, true);
    dv.setUint8(o + 66, e.type);
    dv.setUint8(o + 67, e.color);
    dv.setUint32(o + 68, e.left, true);
    dv.setUint32(o + 72, e.right, true);
    dv.setUint32(o + 76, e.child, true);
    buf.set(e.clsid.subarray(0, 16), o + 80);
    dv.setUint32(o + 96, e.state, true);
    dv.setBigUint64(o + 100, e.ctime, true);
    dv.setBigUint64(o + 108, e.mtime, true);
    dv.setUint32(o + 116, e.start, true);
    dv.setBigUint64(o + 120, BigInt(e.size >>> 0), true);
  }
  return buf;
}

// ── 빈 컨테이너 구성(테스트/신규 생성용) ────────────────────────────────────

/**
 * 경로→바이트 맵에서 CFB 모델을 구성(루트 + 스토리지 트리 + 스트림).
 * decode 경로는 readCfb 의 원본 엔트리를 재사용하므로 이 함수가 필요 없지만,
 * 신규 생성/테스트에는 유용하다. 형제 트리는 균형 BST 로 만든다.
 */
export function buildCfbModel(streams: Record<string, Uint8Array>): CfbModel {
  interface Node {
    name: string;
    storage: boolean;
    data?: Uint8Array;
    children: Map<string, Node>;
  }
  const rootNode: Node = { name: "Root Entry", storage: true, children: new Map() };
  for (const [path, bytes] of Object.entries(streams)) {
    const segs = path.split("/").filter(Boolean);
    let cur = rootNode;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]!;
      const last = i === segs.length - 1;
      let next = cur.children.get(seg);
      if (!next) {
        next = { name: seg, storage: !last, children: new Map() };
        cur.children.set(seg, next);
      }
      if (last) {
        next.storage = false;
        next.data = bytes;
      }
      cur = next;
    }
  }

  const entries: CfbEntry[] = [];
  const data = new Map<number, Uint8Array>();
  const mk = (name: string, type: CfbEntryType): number => {
    const idx = entries.length;
    entries.push({
      name,
      type,
      color: 1,
      left: NOSTREAM,
      right: NOSTREAM,
      child: NOSTREAM,
      clsid: new Uint8Array(16),
      state: 0,
      ctime: 0n,
      mtime: 0n,
      start: 0,
      size: 0,
    });
    return idx;
  };

  const rootIdx = mk("Root Entry", 5);

  // 컨테이너의 자식들을 만들고 균형 BST 로 연결 → child 포인터 반환
  const buildChildren = (node: Node): number => {
    const kids = [...node.children.values()].sort((a, b) => compareName(a.name, b.name));
    const idxs = kids.map((k) => {
      const id = mk(k.name, k.storage ? 1 : 2);
      if (!k.storage && k.data) data.set(id, k.data);
      if (k.storage) entries[id]!.child = buildChildren(k);
      return id;
    });
    return balancedTree(entries, idxs, 0, idxs.length - 1);
  };
  entries[rootIdx]!.child = buildChildren(rootNode);

  return { entries, data };
}

/** 정렬된 인덱스 배열 → 균형 BST 의 루트 인덱스(left/right 링크 설정). */
function balancedTree(entries: CfbEntry[], idxs: number[], lo: number, hi: number): number {
  if (lo > hi) return NOSTREAM;
  const mid = (lo + hi) >> 1;
  const node = entries[idxs[mid]!]!;
  node.left = balancedTree(entries, idxs, lo, mid - 1);
  node.right = balancedTree(entries, idxs, mid + 1, hi);
  return idxs[mid]!;
}

/** CFB 디렉터리 이름 비교: 길이 우선, 그다음 대문자 코드포인트. */
function compareName(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  const A = a.toUpperCase();
  const B = b.toUpperCase();
  return A < B ? -1 : A > B ? 1 : 0;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
