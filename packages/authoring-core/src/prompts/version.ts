/**
 * Version of the prompts and authoring schemas. Stored with every draft (`unit_versions.prompt_version`) and
 * matched by `DEFAULT_AI_SETTINGS.prompt_version`. Bump it whenever a prompt, an authoring schema or the
 * mapping to the final unit changes in a way that could change the output.
 */
export const PROMPT_VERSION = 'm2-v1';
