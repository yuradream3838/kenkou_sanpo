// JPEG の EXIF から撮影日時（と撮影位置）を読む。
// 保存する写真は image.js で再エンコードして EXIF を消すので、その前にここで読み取る。
// 読み取った値は端末内でフォームに入れるだけで、どこにも送らない。

const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_DATETIME = 0x0132; // IFD0: 更新日時
const TAG_DATETIME_ORIGINAL = 0x9003; // Exif IFD: 撮影日時
const TAG_DATETIME_DIGITIZED = 0x9004;

/**
 * @param {File|Blob} file
 * @returns {Promise<{ takenAt: string|null, location: {lat:number,lng:number}|null }>}
 *   takenAt は datetime-local 形式（"YYYY-MM-DDTHH:MM"、撮影した端末の時刻）
 */
export async function readExif(file) {
  const empty = { takenAt: null, location: null };
  try {
    // EXIF は先頭付近にあるので最初の 256KB だけ読む
    const buf = await file.slice(0, 256 * 1024).arrayBuffer();
    const v = new DataView(buf);
    if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return empty; // JPEG 以外
    let off = 2;
    while (off + 4 <= v.byteLength) {
      if (v.getUint8(off) !== 0xff) return empty;
      const marker = v.getUint8(off + 1);
      const size = v.getUint16(off + 2);
      if (marker === 0xe1 && off + 10 <= v.byteLength && v.getUint32(off + 4) === 0x45786966) {
        return parseTiff(v, off + 10) || empty; // "Exif\0\0" の後ろが TIFF ヘッダ
      }
      if (marker === 0xda) return empty; // 画像データ本体に到達
      off += 2 + size;
    }
  } catch {
    /* 読めなければ何もしない */
  }
  return empty;
}

function parseTiff(v, start) {
  const order = v.getUint16(start);
  const le = order === 0x4949;
  if (!le && order !== 0x4d4d) return null;
  const u16 = (o) => v.getUint16(o, le);
  const u32 = (o) => v.getUint32(o, le);
  const inRange = (o, n = 1) => o >= 0 && o + n <= v.byteLength;

  function readIfd(ifdOff) {
    const tags = new Map();
    const base = start + ifdOff;
    if (!inRange(base, 2)) return tags;
    const n = u16(base);
    for (let i = 0; i < n; i++) {
      const e = base + 2 + i * 12;
      if (!inRange(e, 12)) break;
      tags.set(u16(e), { type: u16(e + 2), count: u32(e + 4), valueOff: e + 8 });
    }
    return tags;
  }

  function ascii(tag) {
    if (!tag || tag.type !== 2) return null;
    const p = tag.count > 4 ? start + u32(tag.valueOff) : tag.valueOff;
    if (!inRange(p, tag.count)) return null;
    let s = '';
    for (let i = 0; i < tag.count; i++) {
      const c = v.getUint8(p + i);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  function rationals(tag) {
    if (!tag || tag.type !== 5) return null;
    const p = start + u32(tag.valueOff);
    if (!inRange(p, tag.count * 8)) return null;
    const out = [];
    for (let i = 0; i < tag.count; i++) {
      const den = u32(p + i * 8 + 4);
      out.push(den ? u32(p + i * 8) / den : 0);
    }
    return out;
  }

  const ifd0 = readIfd(u32(start + 4));
  let takenAt = null;
  const exifPtr = ifd0.get(TAG_EXIF_IFD);
  if (exifPtr) {
    const exif = readIfd(u32(exifPtr.valueOff));
    takenAt = toLocalInput(ascii(exif.get(TAG_DATETIME_ORIGINAL)) || ascii(exif.get(TAG_DATETIME_DIGITIZED)));
  }
  if (!takenAt) takenAt = toLocalInput(ascii(ifd0.get(TAG_DATETIME)));

  let location = null;
  const gpsPtr = ifd0.get(TAG_GPS_IFD);
  if (gpsPtr) {
    const gps = readIfd(u32(gpsPtr.valueOff));
    const lat = rationals(gps.get(2));
    const lng = rationals(gps.get(4));
    if (lat?.length === 3 && lng?.length === 3) {
      let la = lat[0] + lat[1] / 60 + lat[2] / 3600;
      let lo = lng[0] + lng[1] / 60 + lng[2] / 3600;
      if (ascii(gps.get(1)) === 'S') la = -la;
      if (ascii(gps.get(3)) === 'W') lo = -lo;
      if (Number.isFinite(la) && Number.isFinite(lo) && (la || lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180) {
        location = { lat: +la.toFixed(6), lng: +lo.toFixed(6) };
      }
    }
  }
  return { takenAt, location };
}

// "2026:11:03 14:22:05" → "2026-11-03T14:22"
function toLocalInput(s) {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})/.exec(s || '');
  if (!m || m[1] === '0000') return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
}
