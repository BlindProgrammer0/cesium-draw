import * as Cesium from "cesium";

export type ValidationIssue = {
  code: "TOO_FEW_POINTS" | "SELF_INTERSECTION" | "DUPLICATE_VERTEX";
  message: string;
  details?: any;
};

export type ValidationResult = {
  ok: boolean;
  issues: ValidationIssue[];
};

function toLonLat(p: Cesium.Cartesian3): [number, number] {
  const c = Cesium.Cartographic.fromCartesian(p);
  return [Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude)];
}

function almostEq(a: number, b: number, eps = 1e-12) {
  return Math.abs(a - b) <= eps;
}

function segIntersect(a:[number,number], b:[number,number], c:[number,number], d:[number,number]) {
  // Proper intersection test for segments in 2D (excluding collinear overlaps for simplicity).
  const ax=a[0], ay=a[1], bx=b[0], by=b[1], cx=c[0], cy=c[1], dx=d[0], dy=d[1];
  const orient = (px:number,py:number,qx:number,qy:number,rx:number,ry:number) => (qx-px)*(ry-py) - (qy-py)*(rx-px);
  const o1 = orient(ax,ay,bx,by,cx,cy);
  const o2 = orient(ax,ay,bx,by,dx,dy);
  const o3 = orient(cx,cy,dx,dy,ax,ay);
  const o4 = orient(cx,cy,dx,dy,bx,by);

  // General case
  if ((o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0)) return true;

  // Collinear / touching cases: treat as intersection only if they are not sharing endpoints.
  const onSeg = (px:number,py:number,qx:number,qy:number,rx:number,ry:number) =>
    Math.min(px,qx) <= rx && rx <= Math.max(px,qx) && Math.min(py,qy) <= ry && ry <= Math.max(py,qy);

  const eps = 1e-12;
  const isZero = (v:number)=>Math.abs(v)<=eps;

  if (isZero(o1) && onSeg(ax,ay,bx,by,cx,cy)) return true;
  if (isZero(o2) && onSeg(ax,ay,bx,by,dx,dy)) return true;
  if (isZero(o3) && onSeg(cx,cy,dx,dy,ax,ay)) return true;
  if (isZero(o4) && onSeg(cx,cy,dx,dy,bx,by)) return true;

  return false;
}

export function validatePolygonPositions(positions: Cesium.Cartesian3[]): ValidationResult {
  const issues: ValidationIssue[] = [];
  // We treat positions as an open ring (last != first) in the editor.
  if (positions.length < 3) {
    issues.push({ code: "TOO_FEW_POINTS", message: "多边形至少需要 3 个点。" });
    return { ok: false, issues };
  }

  const pts = positions.map(toLonLat);

  // Duplicate adjacent vertex check
  for (let i=0;i<pts.length;i++){
    const j=(i+1)%pts.length;
    const a=pts[i], b=pts[j];
    if (almostEq(a[0],b[0]) && almostEq(a[1],b[1])) {
      issues.push({ code:"DUPLICATE_VERTEX", message:"存在重复顶点（相邻点重合）。", details:{ index:i }});
      break;
    }
  }

  // Self-intersection check (O(n^2), fine for editor)
  const n=pts.length;
  for (let i=0;i<n;i++){
    const a=pts[i], b=pts[(i+1)%n];
    for (let j=i+1;j<n;j++){
      // segments (i,i+1) and (j,j+1)
      // skip adjacent segments and the same segment
      if (j===i) continue;
      if ((j+1)%n===i) continue;
      if ((i+1)%n===j) continue;
      const c=pts[j], d=pts[(j+1)%n];
      if (segIntersect(a,b,c,d)) {
        issues.push({ code:"SELF_INTERSECTION", message:"多边形存在自相交（蝴蝶形/交叉边）。", details:{ segA:[i,(i+1)%n], segB:[j,(j+1)%n] }});
        return { ok:false, issues };
      }
    }
  }

  return { ok: issues.length===0, issues };
}
