// Prompts and authoring schemas. Internal to the package: only PROMPT_VERSION is re-exported by the engine index.
export { PROMPT_VERSION } from './version';
export { buildSystem, buildSystemPrefix, type PrefixMode } from './system';
export { renderCastBible } from './cast';
export { renderExemplar, EXEMPLAR_SECTIONS, EXEMPLAR_WORKBOOK, EXEMPLAR_MANUAL } from './exemplar';
export {
  DATA_CLOSE,
  DATA_OPEN,
  contextBlock,
  dataBlock,
  dataText,
  parseContextBlocks,
  parseDataBlocks,
  stripDataBlocks,
} from './fence';
export { renderSection, renderUnit, renderQuestion } from './render';
export * from './schemas';
export * from './steps';
