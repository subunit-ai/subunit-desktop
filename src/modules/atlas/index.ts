/**
 * Atlas module entrypoint.
 *
 * The shell's `routes/ModuleHost` lazy-loads this surface via a computed
 * specifier (`../modules/atlas/index` → `../modules/atlas`), expecting a default
 * export it can render. Re-export the console as that default.
 */
export { default } from "./AtlasModule";
