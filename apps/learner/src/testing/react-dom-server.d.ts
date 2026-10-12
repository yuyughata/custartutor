// react-dom ships without types here (no @types/react-dom): the tests only need this one function.
declare module 'react-dom/server' {
  export function renderToStaticMarkup(node: unknown): string;
}
