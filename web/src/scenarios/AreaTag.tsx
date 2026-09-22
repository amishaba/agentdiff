import { AREA_LABEL, type CoverageArea } from "../../../src/scenarios/types.ts";

/** A coverage area as a small coloured label. */
export function AreaTag({ area }: { area: CoverageArea }) {
  return (
    <span className="area-tag" data-area={area}>
      <i className="area-dot" data-area={area} />
      {AREA_LABEL[area]}
    </span>
  );
}
