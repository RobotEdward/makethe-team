// Vite's `?raw` suffix imports a file's contents as a string. Vitest resolves
// it at run time; TypeScript needs telling. Used by
// `test/capacity/set-response.test.ts` to assert directly on the Durable
// Object's own source that it contains no network call — an assertion about
// the module's text, which a runtime spy could not make.
declare module "*?raw" {
  const content: string;
  export default content;
}
