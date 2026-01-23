export type HandleKind = "vertex" | "midpoint" | "point";

export type ResolvedHit =
  | { type: "none" }
  | {
      type: "handle";
      ownerId: string; // feature id
      handleKind: HandleKind;
      index?: number;
    }
  | { type: "feature"; featureId: string; kind: "point" | "polyline" | "polygon" };
