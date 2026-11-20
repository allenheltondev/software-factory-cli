/** A file imported as its text (`?raw`): Vite in tests, scripts/bundle.mjs in the Lambda bundles. */
declare module '*?raw' {
  const text: string;
  export default text;
}
