"""Build the world outline of the `map` representation once, offline: world-110m.json.

The same file ships in voice-agent (app/static/world-110m.json) and in t2s-front
(html/data/world-110m.json); this script is kept in both repositories, identical, and gives the
same bytes from the same input. Neither front projects anything at run time and no page asks a
third-party host for a tile or a library: the outline is drawn from pre-projected SVG path data.

Source: the npm package world-atlas 2.0.2 (ISC licence, Mike Bostock), a TopoJSON redistribution
of Natural Earth 4.1.0 (public domain). countries-110m.json gives the shapes; countries-50m.json
only gives a dot for a country too small for the 1:110m scale (Singapore, Malta, Monaco, Bahrain,
Andorra...). Projection: Equal Earth (Savric, Patterson and Jenny, 2018), written below, no
library. ISO 3166-1 numeric to alpha-2: the iso-codes data carried by pycountry.

Usage (the two inputs are the files of the world-atlas 2.0.2 tarball):
    uv run --no-project --with pycountry==26.2.16 python tools/build-world-map.py \
        <countries-110m.json> <countries-50m.json> <out world-110m.json>

Output (JSON, keys sorted):
    width, height   the viewBox, 0 0 width height (Antarctica left out, so the south is cropped)
    shapes          {numeric: "M...Z"} one SVG path per country, absolute integer coordinates
                    after an M, relative after an l, every ring closed; fill-rule evenodd
    dots            {numeric: [x, y]} a country too small to see at 1:110m (the centre of its
                    largest part), one with no shape there (from the 50m file), or a territory
                    Natural Earth draws inside another country (MANUAL_DOTS, by hand)
    alpha2          {numeric: alpha-2} for every key of shapes and dots
    other           one path for the land with no ISO numeric code (Kosovo), drawn neutral
    about           source, version, licence, projection, build command
"""
import json
import math
import sys

import pycountry

WIDTH = 2000
# Natural Earth features with no ISO numeric code (id null in world-atlas). N. Cyprus and
# Somaliland are drawn with the country ISO 3166-1 files them under, as TMDb does; Kosovo (XK, a
# user-assigned code) has no numeric code and stays neutral land.
NO_ID_MERGE = {"N. Cyprus": "196", "Somaliland": "706"}
ANTARCTICA = "010"
# A country whose shape spans fewer viewBox units than this, both ways, also gets a dot (about
# 3 px on a 390 px phone): Luxembourg, Brunei, Qatar, Lebanon, Trinidad and Tobago...
DOT_SPAN = 16
# Territories with an ISO code that Natural Earth draws inside another country at both scales
# (the French overseas departments inside France, Gibraltar inside Spain...): a dot at an
# approximate centre, (longitude, latitude), entered by hand.
MANUAL_DOTS = {
    "GF": (-53.1, 3.9), "GP": (-61.55, 16.25), "MQ": (-61.0, 14.65), "RE": (55.53, -21.11),
    "YT": (45.15, -12.83), "GI": (-5.35, 36.14), "BQ": (-68.26, 12.18), "CX": (105.62, -10.49),
    "CC": (96.87, -12.16), "TK": (-171.85, -9.2), "TV": (179.2, -8.52), "SJ": (15.6, 78.2),
}

A1, A2, A3, A4 = 1.340264, -0.081106, 0.000893, 0.003796
M = math.sqrt(3) / 2


def equal_earth(lon, lat):
    """Equal Earth, unscaled: x in [-2.7066, 2.7066], y up."""
    lam, phi = math.radians(lon), math.radians(lat)
    theta = math.asin(M * math.sin(phi))
    t2 = theta * theta
    t6 = t2 * t2 * t2
    x = lam * math.cos(theta) / (M * (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2)))
    y = theta * (A1 + A2 * t2 + t6 * (A3 + A4 * t2))
    return x, y


X_MAX = equal_earth(180, 0)[0]
SCALE = WIDTH / (2 * X_MAX)


def decode_arcs(topo):
    """The arcs of a quantized TopoJSON, as lists of (lon, lat)."""
    (sx, sy), (tx, ty) = topo["transform"]["scale"], topo["transform"]["translate"]
    arcs = []
    for arc in topo["arcs"]:
        x = y = 0
        points = []
        for dx, dy in arc:
            x += dx
            y += dy
            points.append((x * sx + tx, y * sy + ty))
        arcs.append(points)
    return arcs


def ring(arcs, indexes):
    """One ring from its arc indexes (a negative index ~i is arc i reversed); shared points once."""
    points = []
    for i in indexes:
        arc = arcs[i] if i >= 0 else arcs[~i][::-1]
        points.extend(arc if not points else arc[1:])
    return points


def cut_antimeridian(points):
    """A ring that crosses the 180th meridian (Russia's Chukotka, Fiji) as one ring per side.

    On the sphere the step from 179.4 to -180 is short; on a flat map it is a line across the
    world. Each crossing ends a piece at the edge (latitude interpolated) and starts the next on
    the other edge; the last piece and the first are on one side and join. Each piece is closed
    by its z, along the edge.
    """
    pieces, current = [], []
    for (lon1, lat1), (lon2, lat2) in zip(points, points[1:] + points[:1]):
        current.append((lon1, lat1))
        if abs(lon2 - lon1) <= 180:
            continue
        unwrapped = lon2 + 360 if lon2 < lon1 else lon2 - 360
        edge = 180 if lon1 > 0 else -180
        t = (edge - lon1) / (unwrapped - lon1) if unwrapped != lon1 else 0
        lat = lat1 + t * (lat2 - lat1)
        current.append((edge, lat))
        pieces.append(current)
        current = [(-edge, lat)]
    if not pieces:
        return [points]
    pieces[0] = current + pieces[0]
    return pieces


def polygons(geometry, arcs):
    """A Polygon or MultiPolygon geometry as a list of polygons, each a list of rings."""
    if geometry["type"] == "Polygon":
        polys = [geometry["arcs"]]
    elif geometry["type"] == "MultiPolygon":
        polys = geometry["arcs"]
    else:
        return []
    return [[piece for r in poly for piece in cut_antimeridian(ring(arcs, r))] for poly in polys]


def project(lon, lat):
    x, y = equal_earth(lon, lat)
    return (x + X_MAX) * SCALE, -y * SCALE


def ring_area(points):
    return 0.5 * sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(points, points[1:] + points[:1]))


def centroid(points):
    """The area centroid of a projected ring (its mean point when degenerate)."""
    a = ring_area(points)
    if abs(a) < 1e-9:
        return sum(p[0] for p in points) / len(points), sum(p[1] for p in points) / len(points)
    cx = cy = 0.0
    for (x0, y0), (x1, y1) in zip(points, points[1:] + points[:1]):
        f = x0 * y1 - x1 * y0
        cx += (x0 + x1) * f
        cy += (y0 + y1) * f
    return cx / (6 * a), cy / (6 * a)


def path(polys, y0):
    """SVG path data: integer coordinates, the first point absolute, the rest relative."""
    out = []
    for poly in polys:
        for points in poly:
            pts = []
            for x, y in points:
                p = (round(x), round(y - y0))
                if not pts or p != pts[-1]:
                    pts.append(p)
            if len(pts) > 1 and pts[0] == pts[-1]:
                pts.pop()
            if len(pts) < 3:
                continue
            seg = [f"M{pts[0][0]} {pts[0][1]}l"]
            deltas = []
            for (ax, ay), (bx, by) in zip(pts, pts[1:]):
                deltas.append(f"{bx - ax} {by - ay}")
            seg.append(" ".join(deltas))
            seg.append("z")
            out.append("".join(seg))
    # "l-3" needs no separator before a minus sign
    return "".join(out).replace(" -", "-")


def features(topo):
    arcs = decode_arcs(topo)
    for g in topo["objects"]["countries"]["geometries"]:
        polys = [[[project(lon, lat) for lon, lat in r] for r in p] for p in polygons(g, arcs)]
        yield g.get("id"), (g.get("properties") or {}).get("name"), polys


def largest_part_centre(polys):
    best = max(polys, key=lambda p: abs(ring_area(p[0])))
    return centroid(best[0])


def main():
    src110, src50, out_path = sys.argv[1:4]
    topo110 = json.load(open(src110, encoding="utf-8"))
    topo50 = json.load(open(src50, encoding="utf-8"))
    by_id, other = {}, []
    for fid, name, polys in features(topo110):
        if fid == ANTARCTICA:
            continue
        fid = fid or NO_ID_MERGE.get(name)
        if fid:
            by_id.setdefault(fid, []).extend(polys)
        else:
            other.extend(polys)
    all_points = [pt for polys in list(by_id.values()) + [other] for poly in polys for r in poly for pt in r]
    y0 = math.floor(min(p[1] for p in all_points))
    height = math.ceil(max(p[1] for p in all_points)) - y0

    alpha2, shapes, dots = {}, {}, {}
    for fid, polys in by_id.items():
        country = pycountry.countries.get(numeric=fid)
        if country is None:
            raise SystemExit(f"no ISO 3166-1 entry for numeric {fid}")
        alpha2[fid] = country.alpha_2
        shapes[fid] = path(polys, y0)
        xs = [p[0] for poly in polys for r in poly for p in r]
        ys = [p[1] for poly in polys for r in poly for p in r]
        if max(xs) - min(xs) < DOT_SPAN and max(ys) - min(ys) < DOT_SPAN:
            cx, cy = largest_part_centre(polys)
            dots[fid] = [round(cx), round(cy - y0)]
    for fid, name, polys in features(topo50):
        if not fid or fid in by_id or fid == ANTARCTICA or not polys:
            continue
        country = pycountry.countries.get(numeric=fid)
        if country is None:
            continue
        cx, cy = largest_part_centre(polys)
        if not (0 <= cy - y0 <= height):
            continue
        alpha2[fid] = country.alpha_2
        dots[fid] = [round(cx), round(cy - y0)]
    for code, (lon, lat) in MANUAL_DOTS.items():
        fid = pycountry.countries.get(alpha_2=code).numeric
        if fid not in alpha2:
            x, y = project(lon, lat)
            alpha2[fid] = code
            dots[fid] = [round(x), round(y - y0)]

    data = {
        "about": ("Natural Earth 1:110m countries (public domain), from the npm package world-atlas 2.0.2 "
                  "(ISC, Mike Bostock); dots from its 1:50m file for countries too small at 1:110m. "
                  "Equal Earth projection, pre-projected, Antarctica left out. ISO 3166-1 codes from "
                  "iso-codes via pycountry. Built by tools/build-world-map.py."),
        "width": WIDTH,
        "height": height,
        "shapes": shapes,
        "dots": dots,
        "alpha2": alpha2,
        "other": path(other, y0),
    }
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        f.write("\n")
    print(f"{out_path}: {len(shapes)} shapes, {len(dots)} dots, {WIDTH}x{height}")


if __name__ == "__main__":
    main()
