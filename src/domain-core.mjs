// Compatibility shim for internal imports. All project create/classify/update/
// sync logic lives exclusively in domain.mjs; reusable non-project workbench
// functions live in workbench-core.mjs.
export * from './workbench-core.mjs';
