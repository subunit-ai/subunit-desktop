/**
 * Synapse module entrypoint.
 *
 * The shell's `routes/ModuleHost` lazy-loads this surface via a computed
 * specifier (`../modules/synapse/index` → `../modules/synapse`), expecting a
 * default export it can render. Re-export the ingest funnel as that default.
 */
export { default } from "./SynapseModule";
