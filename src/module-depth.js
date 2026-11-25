// Dimensions in mm. Catalog depth is the carcass depth, without the facade.
export const FACADE_THICKNESS_MM=16;
export const FRONT_TECH_GAP_MM=4;
export const LOWER_WALL_GAP_MM=30;
export const WORKTOP_DEPTH_MM=600;
export const moduleDepthMM=m=>m.isAppliance?m.depth:m.depth+FACADE_THICKNESS_MM+FRONT_TECH_GAP_MM;
export const bodyWallGapMM=m=>m.isAppliance?m.backGap:m.category==='lower'&&m.worktop!==false?LOWER_WALL_GAP_MM:0;
export const installedFrontMM=m=>bodyWallGapMM(m)+moduleDepthMM(m);
export const facadeCenterMM=m=>bodyWallGapMM(m)+m.depth+FRONT_TECH_GAP_MM+FACADE_THICKNESS_MM/2;
// Reference dimensions are distinct from placement dimensions; handles are excluded.
