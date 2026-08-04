// The cost-model probes, packed into ONE source string a page can install with
// an indirect eval.
//
// Playwright serialises a page-function standalone: it cannot close over an
// import, so a probe that wants to share `bucketFor` with three other probes has
// to either duplicate it (and drift) or be installed as a named function in the
// page first. This does the second. `(0, eval)(src)` runs at global scope, so the
// helper declarations below become globals the probes can call by name — and the
// probes themselves land on `window.__cost`, where a driver can compose them
// freely inside ONE task (which is what a particle burst measured by a census
// that blocks the frame loop for seconds requires).
import {
  BUCKET_FN, FRUSTUM_FN, BLENDED_FN, PART_FN,
  LOAD_THREE, TAG_BUCKETS, FRAME_INVENTORY, PASS_SPLIT, RESOURCE_CENSUS, STENCIL_OVERDRAW,
  SKY_OCCLUSION, TIME_FRAMES, FRUSTUM_ENTITIES, PIN_RATIO_AT, INSTALL_HITCH_SAMPLER, ALLOCATION_RATE,
  BUCKET_PARTS, WHAT_IF,
} from './cost-model-probes.mjs';

export const COST_PRELUDE = [
  BUCKET_FN,
  FRUSTUM_FN,
  BLENDED_FN,
  PART_FN,
  `window.__cost = {
    loadThree: ${LOAD_THREE.toString()},
    tagBuckets: ${TAG_BUCKETS.toString()},
    frameInventory: ${FRAME_INVENTORY.toString()},
    bucketParts: ${BUCKET_PARTS.toString()},
    whatIf: ${WHAT_IF.toString()},
    passSplit: ${PASS_SPLIT.toString()},
    resourceCensus: ${RESOURCE_CENSUS.toString()},
    stencilOverdraw: ${STENCIL_OVERDRAW.toString()},
    skyOcclusion: ${SKY_OCCLUSION.toString()},
    timeFrames: ${TIME_FRAMES.toString()},
    frustumEntities: ${FRUSTUM_ENTITIES.toString()},
    pinRatio: ${PIN_RATIO_AT.toString()},
    installHitch: ${INSTALL_HITCH_SAMPLER.toString()},
    allocationRate: ${ALLOCATION_RATE.toString()},
  };`,
].join('\n');
