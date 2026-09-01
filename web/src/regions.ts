export type BBox4 = [number, number, number, number];

export function unionBboxes(bboxes: BBox4[]): [[number, number], [number, number]] {
  return [
    [Math.min(...bboxes.map((b) => b[0])), Math.min(...bboxes.map((b) => b[1]))],
    [Math.max(...bboxes.map((b) => b[2])), Math.max(...bboxes.map((b) => b[3]))],
  ];
}

function bboxContains(box: BBox4, lng: number, lat: number): boolean {
  return lng >= box[0] && lng <= box[2] && lat >= box[1] && lat <= box[3];
}

/** Nearby boxes stay together; distant ones (Berlin vs Lörrach) split. */
export function clusterBboxes(bboxes: BBox4[], gap = 1.5): BBox4[][] {
  const clusters: BBox4[][] = [];
  for (const box of bboxes) {
    const cx = (box[0] + box[2]) / 2;
    const cy = (box[1] + box[3]) / 2;
    const hit = clusters.find((cl) => {
      const [sw, ne] = unionBboxes(cl);
      const mx = (sw[0] + ne[0]) / 2;
      const my = (sw[1] + ne[1]) / 2;
      return Math.hypot(cx - mx, cy - my) < gap;
    });
    if (hit) hit.push(box);
    else clusters.push([box]);
  }
  return clusters;
}

export function regionLabel(bboxes: BBox4[]): string {
  const lats = bboxes.flatMap((b) => [b[1], b[3]]);
  const mid = (Math.min(...lats) + Math.max(...lats)) / 2;
  if (mid > 51) return "Berlin";
  if (mid < 49) return "Lörrach";
  return "Gebiet";
}

/** Initial camera: cluster that contains the default center, else the first. */
export function initialFitBboxes(bboxes: BBox4[] | undefined, center: [number, number]): BBox4[] | undefined {
  if (!bboxes?.length) return undefined;
  const clusters = clusterBboxes(bboxes);
  const home =
    clusters.find((cl) => cl.some((box) => bboxContains(box, center[0], center[1]))) ?? clusters[0];
  return home;
}
