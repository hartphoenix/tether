/** Map only local image destinations; keep authored Markdown and remote URLs intact. */
export function imageDisplayUrl(source: string): string {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(source)) return source;
  const fragment = source.indexOf("#");
  return `api/image?src=${encodeURIComponent(source)}${fragment < 0 ? "" : source.slice(fragment)}`;
}
