// 写真を縮小して再エンコードする。Canvas を通すことで EXIF（撮影位置などのメタデータ）は削除される。
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('この画像は読み込めませんでした。HEIC 形式などは端末によって読み込めないことがあります。JPEG の写真を選んでください'));
    };
    img.src = url;
  });
}

function resize(img, maxSize, quality) {
  const scale = Math.min(1, maxSize / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(img, 0, 0, w, h);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('画像の変換に失敗しました'))), 'image/jpeg', quality)
  );
}

export async function processPhoto(file) {
  const img = await loadImage(file);
  const [photo, thumb] = await Promise.all([resize(img, 1600, 0.82), resize(img, 360, 0.75)]);
  return { photo, thumb };
}

export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function dataURLToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}
