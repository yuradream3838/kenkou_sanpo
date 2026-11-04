#!/usr/bin/env python3
"""国土数値情報（鉄道 N02）の駅データから、指定した都道府県の駅一覧 JSON を作る。

使い方:
  python3 -I tools/build_stations.py N02-24_Station.geojson japan.geojson 14 data/stations/14.json

- N02-24_Station.geojson : 国土数値情報 鉄道データ（令和6年度）の駅 GeoJSON
- japan.geojson          : 都道府県境界（dataofjapan/land、地球地図日本ベース）。
                           絞り込みにのみ使い、リポジトリには含めない。
- 14                     : 都道府県コード（14 = 神奈川県）

同じ名前で 800m 以内にある駅（乗換駅）は 1 つにまとめ、路線を併記する。
境界付近は境界データが粗いため、OVERRIDES で個別に補正する。
"""
import json
import math
import sys

# 境界データの精度の都合で判定がずれる駅の補正: {駅名: True(含める)/False(除く)}
OVERRIDES = {
    '14': {
        '野島公園': True,   # 横浜市金沢区（海岸線が粗く県外判定される）
        '若葉台': False,    # 東京都稲城市
    },
}

OPERATOR_SHORT = {
    '東日本旅客鉄道': 'JR東日本',
    '東海旅客鉄道': 'JR東海',
    '東京地下鉄': '東京メトロ',
    '横浜市': '横浜市営地下鉄',
    '横浜高速鉄道': 'みなとみらい線',
    '横浜シーサイドライン': 'シーサイドライン',
    '小田急電鉄': '小田急',
    '京浜急行電鉄': '京急',
    '東急電鉄': '東急',
    '相模鉄道': '相鉄',
    '京王電鉄': '京王',
    '江ノ島電鉄': '江ノ電',
    '湘南モノレール': '湘南モノレール',
    '箱根登山鉄道': '箱根登山鉄道',
    '小田急箱根': '箱根登山鉄道',
    '伊豆箱根鉄道': '伊豆箱根鉄道',
}


# 一般に通じる路線名への言い換え: {(運営会社略称, 正式路線名): 表示名}
LINE_RENAME = {
    ('横浜市営地下鉄', '1号線'): 'ブルーライン',
    ('横浜市営地下鉄', '3号線'): 'ブルーライン',
    ('横浜市営地下鉄', '4号線'): 'グリーンライン',
    ('みなとみらい線', 'みなとみらい21線'): 'みなとみらい線',
    ('箱根登山鉄道', '鋼索線'): '箱根登山ケーブルカー',
    ('大山観光電鉄', '大山鋼索線'): '大山ケーブルカー',
}


def line_label(operator, line):
    op = OPERATOR_SHORT.get(operator, operator)
    renamed = LINE_RENAME.get((op, line))
    if renamed:
        return renamed if renamed == op else f'{op} {renamed}'
    return f'{op} {line}'


def point_in_ring(x, y, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def point_in_geometry(x, y, geom):
    polys = geom['coordinates'] if geom['type'] == 'MultiPolygon' else [geom['coordinates']]
    for poly in polys:
        if point_in_ring(x, y, poly[0]) and not any(point_in_ring(x, y, h) for h in poly[1:]):
            return True
    return False


def dist_m(a, b):
    r = 6371000
    p1, p2 = math.radians(a[1]), math.radians(b[1])
    dp = p2 - p1
    dl = math.radians(b[0] - a[0])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def dist_to_boundary_m(x, y, geom):
    """境界線までのおおよその距離（m）。境界付近の駅を確認するために使う。"""
    best = float('inf')
    polys = geom['coordinates'] if geom['type'] == 'MultiPolygon' else [geom['coordinates']]
    kx = 111320 * math.cos(math.radians(y))
    ky = 110540
    for poly in polys:
        for ring in poly:
            for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
                ax, ay = (x1 - x) * kx, (y1 - y) * ky
                bx, by = (x2 - x) * kx, (y2 - y) * ky
                dx, dy = bx - ax, by - ay
                L = dx * dx + dy * dy
                t = 0 if L == 0 else max(0, min(1, -(ax * dx + ay * dy) / L))
                px, py = ax + t * dx, ay + t * dy
                best = min(best, math.hypot(px, py))
    return best


def midpoint(coords):
    xs = [c[0] for c in coords]
    ys = [c[1] for c in coords]
    return (sum(xs) / len(xs), sum(ys) / len(ys))


def main(station_path, boundary_path, pref_code, out_path):
    stations = json.load(open(station_path, encoding='utf-8'))['features']
    boundary = json.load(open(boundary_path, encoding='utf-8'))
    pref = next(f for f in boundary['features'] if str(f['properties']['id']) == str(int(pref_code)))
    geom = pref['geometry']
    pref_name = pref['properties']['nam_ja']
    overrides = OVERRIDES.get(pref_code, {})

    # 都道府県の外接矩形（+5km）で先に粗く絞る
    all_pts = [p for poly in (geom['coordinates'] if geom['type'] == 'MultiPolygon' else [geom['coordinates']]) for p in poly[0]]
    minx = min(p[0] for p in all_pts) - 0.06
    maxx = max(p[0] for p in all_pts) + 0.06
    miny = min(p[1] for p in all_pts) - 0.05
    maxy = max(p[1] for p in all_pts) + 0.05

    picked = []
    near_border = []
    for f in stations:
        p = f['properties']
        g = f['geometry']
        coords = g['coordinates'] if g['type'] == 'LineString' else [c for part in g['coordinates'] for c in part]
        x, y = midpoint(coords)
        if not (minx <= x <= maxx and miny <= y <= maxy):
            continue
        name = p['N02_005']
        inside = point_in_geometry(x, y, geom)
        if name in overrides:
            inside = overrides[name]
        d = dist_to_boundary_m(x, y, geom)
        if d < 1500:
            near_border.append((round(d), inside, name, p['N02_004']))
        if inside:
            picked.append({'name': name, 'x': x, 'y': y, 'line': line_label(p['N02_004'], p['N02_003'])})

    # 同名・800m 以内の駅をまとめる
    merged = []
    for s in picked:
        for m in merged:
            if m['n'] == s['name'] and dist_m((m['_x'], m['_y']), (s['x'], s['y'])) < 800:
                m['_pts'].append((s['x'], s['y']))
                if s['line'] not in m['l']:
                    m['l'].append(s['line'])
                break
        else:
            merged.append({'n': s['name'], '_x': s['x'], '_y': s['y'], '_pts': [(s['x'], s['y'])], 'l': [s['line']]})

    out = []
    for m in merged:
        x = sum(p[0] for p in m['_pts']) / len(m['_pts'])
        y = sum(p[1] for p in m['_pts']) / len(m['_pts'])
        out.append({'n': m['n'], 'lat': round(y, 5), 'lng': round(x, 5), 'l': sorted(m['l'])})
    out.sort(key=lambda s: (s['lat'], s['lng']))

    data = {
        'prefCode': pref_code,
        'prefName': pref_name,
        'source': '国土数値情報（鉄道データ）令和6年度 国土交通省 を加工して作成',
        'sourceUrl': 'https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2024.html',
        'stations': out,
    }
    with open(out_path, 'w', encoding='utf-8') as fp:
        json.dump(data, fp, ensure_ascii=False, separators=(',', ':'))

    print(f'{pref_name}: {len(out)} 駅（路線別 {len(picked)} 件）を {out_path} に書き出しました')
    print('--- 境界から1.5km以内の駅（判定の確認用）---')
    for d, inside, name, op in sorted(set(near_border)):
        print(f'{d:>5}m {"含む" if inside else "除外"} {name} ({op})')


if __name__ == '__main__':
    if len(sys.argv) != 5:
        print(__doc__)
        sys.exit(1)
    main(*sys.argv[1:])
