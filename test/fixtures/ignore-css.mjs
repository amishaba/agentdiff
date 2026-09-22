// The rendered-page checks exercise React markup; CSS is verified by the build.
export async function load(url, context, nextLoad) {
  if (url.endsWith(".css")) return { format: "module", source: "export {};", shortCircuit: true };
  return nextLoad(url, context);
}
