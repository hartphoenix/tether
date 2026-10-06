/** Map only local image destinations; keep authored Markdown and remote URLs intact. */
export function imageDisplayUrl(source: string, locationVersion?: number): string {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(source)) return source;
  const fragment = source.indexOf("#");
  return `api/image?src=${encodeURIComponent(source)}${locationVersion === undefined ? "" : `&locationVersion=${locationVersion}`}${fragment < 0 ? "" : source.slice(fragment)}`;
}
